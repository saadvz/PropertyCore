import { formatDay, formatTime } from "../core/timezone";
import { refuseCards } from "../hub/cards";
import { CARD_REFUSAL, FIXER_VISIT_PREFIX, type FixerDesk, type RevealRefusal, type VisitView } from "./desk";
import { letterToken, tokenHash } from "./store";
import { dollars, VISIT_ENDED, VISIT_NOT_STARTED } from "./texts";

export { FIXER_VISIT_PREFIX };

/**
 * The pro's visit page: one private link per booked job (Decision 5). A GET shows the visit and never
 * the door code, so a link preview or a second device sees no code. Only the POST behind "I'm at the
 * door", inside the visit, answers with the code, and the host hears of each reveal. The page also
 * takes photos (location data removed), done with the amount, and a raised price. Every response is
 * no-store, sends no referrer, isn't indexed, and loads nothing from outside.
 */

export interface VisitRequest {
  method: string;
  /** "" for the page, or "door", "photo", "done", "quote". */
  sub: string;
  token: string;
  contentType: string;
  body: Buffer;
}

export interface VisitResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export const MAX_VISIT_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_VISIT_JSON_BYTES = 4096;
const MAX_CENTS = 2_000_000;

/** MMS photo types the page keeps, by extension. HEIC, HEIF and GIF are refused: their metadata isn't stripped here. */
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };

const STRICT: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const BARE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const COPY = {
  title: "Your repair visit",
  tooMany: "Too many requests for this page. Try again in an hour.",
  notFound: "Not found.",
  sendJson: "Send JSON with Content-Type: application/json.",
  tooLarge: "That request is too large.",
  photoType: "Send the photo as a JPEG, PNG or WebP. On an iPhone, pick Most Compatible in Camera settings.",
  photoTooBig: "That photo is over 5 MB. Send a smaller one.",
  photoUnreadable: "That photo couldn't be read. Try another one.",
  codeSoon: "The door code shows here from 30 minutes before the visit.",
  codeNotYet: "The door code shows from 30 minutes before the visit.",
  codeOver: "The visit's time is up, so the door code no longer shows.",
  hostLetsIn: "The host will let you in.",
  codeRefused: "The door code can't be shown. Ask the host to let you in.",
  guestsHere: "The guests haven't left yet. Try again in a few minutes.",
  notSaved: "That couldn't be saved. Tell the host.",
  amount: "An amount is $0 to $20,000, in cents.",
  note: "Keep the note under 300 characters.",
  done: "Thanks. The host is told the job is done.",
  heldQuote: "The host is asked about the new price. Wait for their answer before you go on.",
  toldQuote: "The host is told about the new price. You can go ahead.",
  addressSoon: "The address shows here from 24 hours before the visit.",
  busy: "Too many requests right now. Try again in a minute.",
  failed: "Something went wrong. Try again in a few minutes.",
};

/** The most a request to this sub may send: 5 MB for a photo, 4096 bytes for everything else. */
export function visitBodyCap(sub: string): number {
  return sub === "photo" ? MAX_VISIT_PHOTO_BYTES : MAX_VISIT_JSON_BYTES;
}

/** A refusal in the page's shape: HTML for the page itself, JSON for its actions. Always the strict headers. */
function refusal(sub: string, status: number, message: string, extra: Record<string, string> = {}): VisitResponse {
  return sub === "" ? html(status, (nonce) => shell(`<p>${escape(message)}</p>`, nonce, ""), false, extra) : json(status, { error: message }, extra);
}

/**
 * What the route around the page answers itself, with the page's strict headers: "busy" when too many
 * new links are looked up, "too-large" when the body is over its cap (nothing more is read), and
 * "failed" when the desk threw. A failure's body is plain and carries no error text.
 */
export function visitRouteRefusal(sub: string, kind: "busy" | "too-large" | "failed"): VisitResponse {
  if (kind === "failed") return { status: 500, headers: { ...STRICT, "Content-Security-Policy": BARE_CSP, "Content-Type": "text/plain; charset=utf-8" }, body: COPY.failed };
  if (kind === "busy") return refusal(sub, 429, COPY.busy, { "Retry-After": "60" });
  return refusal(sub, 413, sub === "photo" ? COPY.photoTooBig : COPY.tooLarge, { Connection: "close" });
}

/** The plain reason a door POST got no code. */
function doorReason(reason: RevealRefusal): string {
  if (reason === "before-visit") return COPY.codeNotYet;
  if (reason === "after-visit" || reason === "window-over") return COPY.codeOver;
  if (reason === "guests-not-left") return COPY.guestsHere;
  if (reason === "host-access" || reason === "overlaps-stay") return COPY.hostLetsIn;
  return COPY.codeRefused;
}

const ACTIONS = ["door", "photo", "done", "quote"];

/** True when the request is one whose body the page reads: a POST to one of its actions. */
export function visitReadsBody(method: string, sub: string): boolean {
  return method === "POST" && ACTIONS.includes(sub);
}

/**
 * A request's first step, before any body is read: the link is counted and its live visit found, or
 * the page's refusal (a malformed, unknown or ended link, or too many requests to it).
 */
export function openVisit(desk: FixerDesk, req: { sub: string; token: string }): { view: VisitView } | { refusal: VisitResponse } {
  // Every request to a known link counts, the page and its 404s included.
  const hit = desk.visitHit(req.token);
  if (hit === "limited") return { refusal: refusal(req.sub, 429, COPY.tooMany, { "Retry-After": "3600" }) };
  const view = hit === "ok" ? desk.visitByToken(req.token) : undefined;
  return view ? { view } : { refusal: refusal(req.sub, 404, VISIT_ENDED) };
}

export async function handleVisitRequest(desk: FixerDesk, req: VisitRequest): Promise<VisitResponse> {
  const opened = openVisit(desk, req);
  return "refusal" in opened ? opened.refusal : answerVisit(desk, req, opened.view);
}

/** The rest of a request to a live visit, with its body read. */
export async function answerVisit(desk: FixerDesk, req: VisitRequest, view: VisitView): Promise<VisitResponse> {
  const page = req.sub === "";
  const refuse = (status: number, message: string, extra: Record<string, string> = {}) => refusal(req.sub, status, message, extra);
  if (page) {
    if (req.method !== "GET") return refuse(405, COPY.notFound, { Allow: "GET" });
    return html(200, (nonce) => visitPage(view, nonce), view.phase === "during");
  }
  if (!ACTIONS.includes(req.sub)) return refuse(404, COPY.notFound);
  if (req.method !== "POST") return refuse(405, COPY.notFound, { Allow: "POST" });
  const hash = tokenHash(req.token);
  if (req.sub === "door") {
    // JSON only: a form on another site can't send it without a preflight, which this page never allows.
    if (!isJson(req.contentType)) return refuse(415, COPY.sendJson);
    const result = await desk.revealCode(view.jobId, hash);
    if (result.ok) return json(200, { code: result.code, ...(result.lockLocation ? { lockLocation: result.lockLocation } : {}) });
    return result.reason === "no-job" ? refuse(404, VISIT_ENDED) : refuse(409, doorReason(result.reason));
  }
  if (view.phase === "before") return refuse(409, VISIT_NOT_STARTED);
  if (req.sub === "photo") return photo(desk, req, refuse);
  if (!isJson(req.contentType)) return refuse(415, COPY.sendJson);
  if (req.body.length > MAX_VISIT_JSON_BYTES) return refuse(413, COPY.tooLarge);
  const parsed = jsonObject(req.body);
  if (!parsed) return refuse(400, COPY.sendJson);
  if (refuseCards(parsed)) return refuse(400, CARD_REFUSAL);
  if (req.sub === "done") {
    const input = amountAndNote(parsed);
    if (typeof input === "string") return refuse(400, input);
    const reply = await desk.pageDone(req.token, input);
    if (reply.isError) return reply.structured?.ended ? refuse(404, VISIT_ENDED) : refuse(409, reply.text);
    return json(200, { done: true, message: COPY.done });
  }
  const price = priceOnly(parsed);
  if (typeof price === "string") return refuse(400, price);
  if (view.estimateCents !== undefined && price.cents <= view.estimateCents) return refuse(400, `That isn't more than the ${dollars(view.estimateCents)} estimate. Put what you charged with Done instead.`);
  const reply = await desk.raisePrice(view.jobId, price.cents, "pro", hash);
  if (reply.isError) return reply.structured?.ended ? refuse(404, VISIT_ENDED) : refuse(409, COPY.notSaved);
  const held = reply.structured?.held === true;
  return json(200, { held, message: held ? COPY.heldQuote : COPY.toldQuote });
}

async function photo(desk: FixerDesk, req: VisitRequest, refuse: (status: number, message: string) => VisitResponse): Promise<VisitResponse> {
  const ext = PHOTO_TYPES[mediaType(req.contentType)];
  if (!ext) return refuse(415, COPY.photoType);
  if (req.body.length > MAX_VISIT_PHOTO_BYTES) return refuse(413, COPY.photoTooBig);
  const bytes = stripPhotoMetadata(req.body, ext);
  if (!bytes) return refuse(415, COPY.photoUnreadable);
  const reply = await desk.pagePhoto(req.token, { bytes, ext });
  if (reply.isError) return reply.structured?.ended ? refuse(404, VISIT_ENDED) : refuse(409, reply.text);
  const count = Number(reply.structured?.photos ?? 0);
  return json(200, { saved: true, photos: count, message: `${count} ${count === 1 ? "photo" : "photos"} saved.` });
}

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_CENTS;

/** A raised price is `{ cents }` and nothing else. */
function priceOnly(body: Record<string, unknown>): { cents: number } | string {
  if (Object.keys(body).some((key) => key !== "cents")) return "Send only the new price.";
  return isCents(body.cents) ? { cents: body.cents } : COPY.amount;
}

/** Done is `{ cents?, note? }` and nothing else. A blank note is no note. */
function amountAndNote(body: Record<string, unknown>): { cents?: number; note?: string } | string {
  if (Object.keys(body).some((key) => key !== "cents" && key !== "note")) return "Send only the amount and a note.";
  const { cents, note } = body;
  if (cents !== undefined && !isCents(cents)) return COPY.amount;
  if (note !== undefined && (typeof note !== "string" || note.length > 300)) return COPY.note;
  const trimmed = typeof note === "string" ? note.trim() : "";
  return { ...(cents !== undefined ? { cents: cents as number } : {}), ...(trimmed ? { note: trimmed } : {}) };
}

function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isJson(contentType: string): boolean {
  return mediaType(contentType) === "application/json";
}

function jsonObject(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): VisitResponse {
  return { status, headers: { ...STRICT, "Content-Security-Policy": BARE_CSP, "Content-Type": "application/json; charset=utf-8", ...extra }, body: JSON.stringify(body) };
}

/**
 * An HTML answer. Its style, and its script when `scripted`, run by a fresh nonce for this response;
 * nothing else runs or loads, and the script may only call this server.
 */
function html(status: number, render: (nonce: string) => string, scripted: boolean, extra: Record<string, string> = {}): VisitResponse {
  const nonce = letterToken(16);
  const csp = `default-src 'none'; ${scripted ? `script-src 'nonce-${nonce}'; connect-src 'self'; ` : ""}style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  return { status, headers: { ...STRICT, "Content-Security-Policy": csp, "Content-Type": "text/html; charset=utf-8", ...extra }, body: render(nonce) };
}

function when(view: VisitView): string {
  return `${formatDay(new Date(view.from), view.timeZone)}, ${formatTime(new Date(view.from), view.timeZone)} to ${formatTime(new Date(view.until), view.timeZone)}`;
}

function visitPage(view: VisitView, nonce: string): string {
  const lines = [
    `<p class="when">${escape(when(view))}</p>`,
    `<p>For ${escape(view.proName)}: ${escape(view.what)}</p>`,
    `<p>${view.address ? escape(view.address) : escape(COPY.addressSoon)}</p>`,
  ];
  if (view.estimateCents !== undefined) lines.push(`<p class="hint">Estimate: ${escape(dollars(view.estimateCents))}</p>`);
  if (view.raised) lines.push(`<p class="hint">New price: ${escape(dollars(view.raised.cents))}${view.raised.waiting ? ", waiting for the host's answer" : ""}.</p>`);
  if (view.phase === "before") {
    lines.push(`<p>${escape(view.access === "host" ? COPY.hostLetsIn : COPY.codeSoon)}</p>`);
    return shell(lines.join("\n      "), nonce, "");
  }
  lines.push(
    view.access === "host"
      ? `<p>${escape(COPY.hostLetsIn)}</p>`
      : view.phase === "after"
        ? `<p>${escape(COPY.codeOver)}</p>`
        : `<section>
        <button id="door" type="button">I'm at the door</button>
        <p class="hint">Tap when you're at the door. The host is told each time the code is shown.</p>
        <div id="code-box" hidden><p class="code" id="code"></p><p id="lock"></p></div>
        <p class="error" id="door-msg" role="alert"></p>
      </section>`,
    `<section>
        <label for="photo">Photos of the work (up to 10)</label>
        <input id="photo" type="file" accept="image/jpeg,image/png,image/webp" multiple>
        <p class="hint" id="photo-msg">${view.photos} ${view.photos === 1 ? "photo" : "photos"} saved.</p>
      </section>`,
    `<form id="done">
        <h2>Done</h2>
        <label for="done-amount">Amount charged, in dollars (optional)</label>
        <input id="done-amount" inputmode="decimal" autocomplete="off">
        <label for="done-note">Note (optional)</label>
        <textarea id="done-note" maxlength="300"></textarea>
        <button type="submit">Mark done</button>
        <p class="error" id="done-msg" role="alert"></p>
      </form>`,
    `<form id="quote">
        <h2>Costs more than the estimate?</h2>
        <label for="quote-amount">New price, in dollars</label>
        <input id="quote-amount" inputmode="decimal" autocomplete="off" required>
        <button type="submit">Ask the host</button>
        <p class="error" id="quote-msg" role="alert"></p>
      </form>`,
  );
  return shell(lines.join("\n      "), nonce, SCRIPT);
}

/** The page's only script: it posts to this link's own paths and writes answers with textContent. */
const SCRIPT = `(() => {
  const base = location.pathname.replace(/\\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const say = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const offline = "That didn't go through. Check your connection and try again.";
  async function send(sub, body, type) {
    try {
      const res = await fetch(base + "/" + sub, { method: "POST", headers: { "Content-Type": type }, body, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      return { ok: res.ok, data };
    } catch (e) {
      return { ok: false, data: { error: offline } };
    }
  }
  const cents = (text) => {
    const t = text.trim().replace(/^\\$/, "").replace(/,/g, "");
    return /^\\d{1,5}(\\.\\d{1,2})?$/.test(t) ? Math.round(parseFloat(t) * 100) : undefined;
  };
  const door = $("door");
  if (door) door.addEventListener("click", async () => {
    door.disabled = true;
    const { ok, data } = await send("door", "{}", "application/json");
    door.disabled = false;
    if (ok && data.code) {
      say("code", data.code);
      say("lock", data.lockLocation ? "At " + data.lockLocation + "." : "");
      $("code-box").hidden = false;
      say("door-msg", "");
    } else say("door-msg", data.error || offline);
  });
  const photo = $("photo");
  if (photo) photo.addEventListener("change", async () => {
    for (const file of Array.from(photo.files || [])) {
      say("photo-msg", "Sending…");
      const { ok, data } = await send("photo", file, file.type || "application/octet-stream");
      say("photo-msg", (ok ? data.message : data.error) || offline);
      if (!ok) break;
    }
    photo.value = "";
  });
  function form(id, sub, needAmount, finish) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = {};
      const amount = $(id + "-amount").value;
      if (amount.trim() || needAmount) {
        const c = cents(amount);
        if (c === undefined) return say(id + "-msg", "Type the amount in dollars, like 180 or 180.50.");
        body.cents = c;
      }
      const noteBox = $(id + "-note");
      const note = noteBox ? noteBox.value.trim() : "";
      if (note) body.note = note;
      const { ok, data } = await send(sub, JSON.stringify(body), "application/json");
      if (!ok) return say(id + "-msg", data.error || offline);
      finish(data);
    });
  }
  form("done", "done", false, (data) => {
    const main = $("visit");
    const p = document.createElement("p");
    p.textContent = data.message || "";
    main.replaceChildren(p);
  });
  form("quote", "quote", true, (data) => say("quote-msg", data.message || ""));
})();`;

function shell(body: string, nonce: string, script: string): string {
  const title = COPY.title;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta name="robots" content="noindex, nofollow">
    <title>${escape(title)}</title>
    <style nonce="${nonce}">
      :root { color-scheme: light dark; --bg: #f7f7f5; --card: #ffffff; --ink: #1f1f1d; --muted: #5f5f5a; --line: #d9d9d4; --accent: #1f5f4a; --error: #a3261c; }
      @media (prefers-color-scheme: dark) { :root { --bg: #171716; --card: #222220; --ink: #ececea; --muted: #a6a6a0; --line: #3a3a37; --accent: #7cc4a8; --error: #f08a80; } }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { max-width: 30rem; margin: 2rem auto; padding: 0 16px; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
      h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
      h2 { font-size: 1.1rem; margin: 1.5rem 0 0.25rem; }
      section, form { border-top: 1px solid var(--line); margin-top: 1.25rem; padding-top: 0.5rem; }
      label { display: block; font-weight: 600; margin: 0.9rem 0 0.35rem; }
      input, textarea { width: 100%; font: inherit; padding: 0.6rem 0.7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
      button { margin-top: 1rem; font: inherit; font-weight: 600; padding: 0.6rem 1.2rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--card); cursor: pointer; }
      .when { font-weight: 600; }
      .code { font-size: 2rem; font-weight: 700; letter-spacing: 0.15em; margin: 0.75rem 0 0; }
      .hint { color: var(--muted); font-size: 0.9rem; }
      .error { color: var(--error); font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <div class="card" id="visit">
      <h1>${escape(title)}</h1>
      ${body}
      </div>
    </main>${script ? `\n    <script nonce="${nonce}">${script}</script>` : ""}
  </body>
</html>
`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * The photo without its location and text metadata, or undefined when it isn't the type it claims
 * or can't be walked. JPEG: APP1 (EXIF, XMP), APP13 (IPTC), comments, and anything after the end of
 * the image. PNG: eXIf, tEXt, iTXt and zTXt. WebP: EXIF and XMP, with the VP8X flags cleared to match.
 */
export function stripPhotoMetadata(bytes: Buffer, ext: string): Buffer | undefined {
  if (ext === "jpg") return stripJpeg(bytes);
  if (ext === "png") return stripPng(bytes);
  if (ext === "webp") return stripWebp(bytes);
  return undefined;
}

/** APP1, APP13 and COM. */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

/** Walks the JPEG's segments, and the entropy-coded data of each scan, up to the end of image. */
function stripJpeg(b: Buffer): Buffer | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return undefined;
    let m = i + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) return undefined;
    const marker = b[m]!;
    const at = m + 1;
    if (marker === 0xd9) {
      parts.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(parts);
    }
    // A restart or TEM marker belongs inside a scan's data; out here the file is malformed.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return undefined;
    if (at + 2 > b.length) return undefined;
    const length = b.readUInt16BE(at);
    const end = at + length;
    if (length < 2 || end > b.length) return undefined;
    if (!JPEG_DROP.has(marker)) parts.push(Buffer.from([0xff, marker]), b.subarray(at, end));
    i = end;
    if (marker === 0xda) {
      const j = scanEnd(b, i);
      parts.push(b.subarray(i, j));
      // A file cut off inside the scan keeps what it has.
      if (j >= b.length) return Buffer.concat(parts);
      i = j;
    }
  }
  return undefined;
}

/** Where a scan's entropy-coded data ends: the next marker that isn't a stuffed zero, fill or a restart. */
function scanEnd(b: Buffer, from: number): number {
  for (let j = from; j + 1 < b.length; j++) {
    if (b[j] !== 0xff) continue;
    const next = b[j + 1]!;
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) continue;
    return j;
  }
  return b.length;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);

function stripPng(b: Buffer): Buffer | undefined {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  const parts: Buffer[] = [PNG_SIGNATURE];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    const end = i + 12 + length;
    if (end > b.length) return undefined;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return Buffer.concat(parts);
  }
  return undefined;
}

const WEBP_DROP = new Set(["EXIF", "XMP "]);
/** VP8X flag bits for EXIF and XMP. */
const VP8X_METADATA = 0x08 | 0x04;

function stripWebp(b: Buffer): Buffer | undefined {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return undefined;
  const riffEnd = 8 + b.readUInt32LE(4);
  if (riffEnd < 12 || riffEnd > b.length) return undefined;
  const parts: Buffer[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = b.toString("latin1", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const dataEnd = i + 8 + size;
    if (dataEnd > riffEnd) return undefined;
    const end = Math.min(dataEnd + (size % 2), riffEnd);
    if (!WEBP_DROP.has(type)) {
      let chunk = b.subarray(i, end);
      if (type === "VP8X" && size >= 1) {
        chunk = Buffer.from(chunk);
        chunk[8] = chunk[8]! & ~VP8X_METADATA;
      }
      parts.push(chunk);
    }
    i = end;
  }
  if (i !== riffEnd) return undefined;
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...parts]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
