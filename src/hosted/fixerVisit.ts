import type { Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner, HostedRequest } from "../cleaner-core/hosted/router";
import { answerVisit, FIXER_VISIT_PREFIX, openVisit, visitBodyCap, visitReadsBody, visitRouteRefusal, type VisitResponse } from "../fixer-core/visitPage";
import { FIXER_PRO_CODE_PREFIX } from "../fixer-core/desk";
import { fixerDesk } from "./fixer";
import { CODE_PENDING, serveCodePage } from "./locks";

/**
 * The pro's visit page on a property's own path, /t/<id>[/p/<pid>]/fixer-core/visit/<token>[/<sub>].
 * The desk is the path's property, never one a token points to. Nothing here logs the path, the
 * token or a response body: the door's answer holds the code.
 */

/** Lookups of links not yet found live (each reads a fixer.json), per property in a minute. */
export const VISIT_LOOKUPS_PER_PROPERTY = 30;
/** The same, across every account in this process. */
export const VISIT_LOOKUPS_PER_MINUTE = 120;
const MINUTE_MS = 60_000;

/** One fixed minute for every count, so the per-property counts clear with the total. */
let lookups = { start: 0, total: 0, byProperty: new Map<string, number>() };

/** Counts one lookup for the property. False once its minute's, or everyone's, are used up. */
function takeLookup(key: string, now: number): boolean {
  if (now - lookups.start >= MINUTE_MS || now < lookups.start) lookups = { start: now, total: 0, byProperty: new Map() };
  const mine = lookups.byProperty.get(key) ?? 0;
  if (lookups.total >= VISIT_LOOKUPS_PER_MINUTE || mine >= VISIT_LOOKUPS_PER_PROPERTY) return false;
  lookups.total += 1;
  lookups.byProperty.set(key, mine + 1);
  return true;
}

/** Tests only: a fresh minute. */
export function resetVisitLookups(): void {
  lookups = { start: 0, total: 0, byProperty: new Map() };
}

/** True when the property path is the visit page's. */
export function isVisitPath(rest: string): boolean {
  return rest.startsWith(FIXER_VISIT_PREFIX);
}

/**
 * Answers one visit page request for the property. The caller has checked Fixer Core is on there.
 * The link is checked before any body is read: only a live visit's POST to one of its actions is
 * read, and only up to its cap. Every other request is answered without reading what it sent.
 */
export async function serveFixerVisit(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, rest: string): Promise<void> {
  const tail = rest.slice(FIXER_VISIT_PREFIX.length);
  const slash = tail.indexOf("/");
  const token = slash < 0 ? tail : tail.slice(0, slash);
  const sub = slash < 0 ? "" : tail.slice(slash + 1);
  // A POST answered before its body is read closes the connection, so the rest is never taken in.
  const unread = (response: VisitResponse) => write(r, r.method === "POST" ? { ...response, headers: { ...response.headers, Connection: "close" } } : response);
  try {
    const desk = fixerDesk(h, tenant, property);
    if (desk.visitNeedsLookup(token) && !takeLookup(`${tenant.id}/${property.id}`, h.now().getTime())) return unread(visitRouteRefusal(sub, "busy"));
    const opened = openVisit(desk, { sub, token });
    if ("refusal" in opened) return unread(opened.refusal);
    let body: Buffer = Buffer.alloc(0);
    const contentType = String(r.req.headers["content-type"] ?? "");
    const reads = visitReadsBody(r.method, sub);
    if (reads) {
      const read = await r.readCapped(visitBodyCap(sub));
      if (!read) return write(r, visitRouteRefusal(sub, "too-large"));
      body = read;
    }
    const answer = await answerVisit(desk, { method: r.method, sub, token, contentType, body }, opened.view);
    return reads ? write(r, answer) : unread(answer);
  } catch {
    h.log(`Fixer Core's visit page couldn't answer a request for ${tenant.id}/${property.id}.`);
    if (!r.res.headersSent) unread(visitRouteRefusal(sub, "failed"));
  }
}

function write(r: HostedRequest, response: VisitResponse): void {
  const body = typeof response.body === "string" ? Buffer.from(response.body, "utf8") : response.body;
  r.res.writeHead(response.status, { ...response.headers, "Content-Length": String(body.length) });
  r.res.end(body);
}

/** True when the property path is the host's page with a pro's door code (#243 ruling). */
export function isProCodePath(rest: string): boolean {
  return rest.startsWith(FIXER_PRO_CODE_PREFIX);
}

/**
 * The host's single-use page with a pro's own door code, for a pro who doesn't take texts (#243 ruling): a button,
 * then the code once, for the host to read to the pro. The same code page as guest codes. Never logs the path or code.
 */
export async function serveProCodePage(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, rest: string): Promise<void> {
  const [token = "", sub = ""] = rest.slice(FIXER_PRO_CODE_PREFIX.length).split("/");
  try {
    const desk = fixerDesk(h, tenant, property);
    const open = r.method === "GET" && sub === "" ? desk.proCodeOpen(token) : undefined;
    const page = open ? { heading: `Door code for ${open.proName} at ${open.street}`, intro: `Tap to see ${open.proName}'s code, to read to them. It shows only once, and it works only in their visit's hours.`, button: "Show the code", shownAs: "Door code: " } : undefined;
    await serveCodePage(r, sub, page, () => desk.showProCode(token), {
      gone: "This link has ended. Ask me for a new one.",
      pending: CODE_PENDING,
      failed: "The code couldn't be added to the lock yet. This link still works once it's there.",
    });
  } catch {
    h.log(`Fixer Core's door code page couldn't answer a request for ${tenant.id}/${property.id}.`);
    if (!r.res.headersSent) r.send(500, "text/plain", "Something went wrong.");
  }
}
