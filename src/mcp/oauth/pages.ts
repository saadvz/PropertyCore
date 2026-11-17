/**
 * The two small pages the public address serves during OAuth. Server-rendered
 * with everything escaped; the only script is /oauth.js (no inline code), and
 * the pages can't be framed or leak their URL through a referrer.
 */
import { ASSISTANT_PROFILES, type CleanerAssistant, type ConsentWho } from "../../cleaner-core/assistant";
import type { InviteRefusal } from "../../cleaner-core/hosted/registry";

/** What the multi-tenant Cleaner Core's Allow page says when an invite code is refused. */
export const INVITE_REFUSALS: Record<InviteRefusal, string> = {
  invalid: "That invite code isn't right. Check it with Saad and try again.",
  expired: "That invite code has expired. Ask Saad for a new one.",
  used: "That invite code was already used. Ask Saad for a new one.",
  disabled: "This Cleaner Core account is turned off. Ask Saad.",
};

export const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const shell = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>${escape(title)}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="visitor-page">
    <main class="phone verify-page" aria-live="polite">
      <div class="phone-body">
${body}
      </div>
    </main>${script}
  </body>
</html>
`;

export function consentPage(p: { requestId: string; matchCode: string; clientName: string; redirectHost: string; hosted?: boolean; firstClaim?: boolean; label?: "Tour Core" | "Cleaner Core" | "Property Core"; assistant?: CleanerAssistant; invite?: boolean; account?: AccountForms }): string {
  if (p.label === "Cleaner Core") return cleanerConsentPage(p, ASSISTANT_PROFILES[p.assistant ?? "grok"].consent);
  if (p.label === "Property Core") return cleanerConsentPage(p, ASSISTANT_PROFILES[p.assistant ?? "grok"].consent, SHARED_WORDS);
  const requestId = escape(p.requestId);
  const decision = p.hosted
    ? `${p.firstClaim ? "<p>Approving this first connection will make this Grok connection the owner of this Tour Core demo.</p>" : ""}
          <p><button type="button" class="primary" id="oauth-allow" data-code="${escape(p.matchCode)}">Allow</button></p>`
    : `<p><strong>Approve on the Tour Core computer.</strong> A Tour Core window opens there (or open <em>Connect Grok</em> in Tour Core). Check it shows this code, then choose Allow:</p>`;
  return shell(
    "Connect to Tour Core",
    `        <h1>Tour Core</h1>
        <p><strong>${escape(p.clientName)}</strong> is requesting permission to manage this Tour Core installation.</p>
        <p class="hint">After you decide, you'll be sent back to ${escape(p.redirectHost)}.</p>
        <p>It will be able to:</p>
        <ul>
          <li>configure properties</li>
          <li>run readiness checks</li>
          <li>run practice tours</li>
          <li>inspect active tours</li>
          <li>work exceptions</li>
          <li>export records</li>
        </ul>
        <p>It will <strong>not</strong> be able to:</p>
        <ul>
          <li>directly unlock doors</li>
          <li>bypass Tour Core access policy</li>
          <li>read provider secrets</li>
        </ul>
        <p class="hint">Publishing, pausing, resuming, revoking tours and changing approved facts still ask you first, every time.</p>
        <div class="card highlight">
          ${decision}
          <p class="match-code">${escape(p.matchCode)}</p>
          <p id="oauth-status" class="muted" data-request="${requestId}">Waiting for approval…</p>
        </div>
        <button type="button" id="oauth-deny">Deny</button>`,
    `\n    <script type="module" src="/oauth.js"></script>`,
  );
}

interface ConsentWords {
  product: string;
  asking: string;
  /** The trust panel's paragraph under the headline. */
  lede: string;
  can: string[];
  cannot: string[];
  /** The phone layout's one-line summaries of `can` and `cannot`. */
  canShort: string;
  cannotShort: string;
  /** Approved: the line after "<chat> is now connected to". */
  connected: string;
  /** Approved: what to say in the chat next. */
  next?: (name: string) => string;
}

const CLEANER_WORDS: ConsentWords = {
  product: "Cleaner Core",
  asking: "is asking to run your cleaning schedule.",
  lede: "Cleaner Core holds the rules in code: who gets the door code, and who gets texted. Your assistant's words can't change them.",
  can: ["save your property, calendars, people and schedule", "read new bookings", "text your cleaner when you say so", "tell you what your cleaner says"],
  cannot: ["read back your door code", "send the door code before you say the guests have left", "read Tour Core or its tours", "read provider secrets"],
  canShort: "Save your property, calendars, people and schedule · Read new bookings · Text your cleaner when you say so · Tell you what your cleaner says",
  cannotShort: "read back your door code, send it before you say the guests have left, or read provider secrets.",
  connected: "Cleaner Core.",
};

/** The one address on the multi-tenant service: the host picks touring or cleaning after connecting. */
const SHARED_WORDS: ConsentWords = {
  product: "Property Core",
  asking: "is asking to run cleanings, supplies, or tours at your properties.",
  lede: "Property Core holds the rules in code: who gets the door code, who gets texted, and go or hold on every supply cart. Your assistant's words can't change them.",
  can: ["set your number up for touring or cleaning", "save your properties, calendars, people and schedule", "text visitors or your cleaner as that service does", "tell you what they say"],
  cannot: ["read back a door code", "reach another host's number or records", "read provider secrets"],
  canShort: "Set your number up for touring or cleaning · Save your properties, calendars, people and schedule · Text visitors or your cleaner · Tell you what they say",
  cannotShort: "read back a door code, reach another host's records, or read provider secrets.",
  connected: "your Property Core account.",
  next: (name) => `In ${name}, say "Set up Property Core". It adds your property and asks whether you want Cleaner Core, Supply Core, or Fixer Core there.`,
};

// ---- Icons: inline SVG, drawn with stroke so they take the page's colors ----

const svg = (box: string, size: number, stroke: string, width: number, body: string, cls = "") =>
  `<svg${cls ? ` class="${cls}"` : ""} width="${size}" height="${size}" viewBox="${box}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const HOME = `<path d="M4 12.5 14 4l10 8.5V24H4z"/><rect x="10.5" y="13.5" width="7" height="7" rx="1.5"/>`;
const CHECK = `<path d="M5 12.5 10 17 19 7"/>`;
const LOCK = `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`;
const ALERT = `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>`;
const CHAT = `<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>`;
const CROSS = `<path d="M7 7l10 10M17 7 7 17"/>`;
const CLOCK = `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`;
const WARNING = `<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17v.01"/>`;

/** What a finished page shows: Approved, Not approved, expired, or a problem. */
export type ResultTone = "ok" | "no" | "wait" | "bad";
const BADGES: Record<ResultTone, string> = {
  ok: svg("0 0 24 24", 30, "#1D5A43", 2.6, CHECK),
  no: svg("0 0 24 24", 30, "#55635B", 2.2, CROSS),
  wait: svg("0 0 24 24", 30, "#8A5A00", 2.2, CLOCK),
  bad: svg("0 0 24 24", 30, "#B42318", 2, WARNING),
};

const pcShell = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>${escape(title)}</title>
    <link rel="stylesheet" href="/connect.css" />
  </head>
  <body class="pc-page">
${body}${script}
  </body>
</html>
`;

interface Result {
  id?: string;
  brand: string;
  tone: ResultTone;
  title: string;
  message: string;
  next?: string;
  leaving?: string;
}

/** The centered card every finished page uses. Hidden ones wait on the consent page for /oauth.js. */
function resultBlock(r: Result): string {
  const next = r.next
    ? `
        <div class="pc-next"><span class="pc-next-title">What's next</span><span class="pc-next-body">${escape(r.next)}</span></div>`
    : "";
  const leaving = r.leaving
    ? `
        <div class="pc-leaving"><span class="pc-dot"></span><span>${escape(r.leaving)}</span></div>`
    : "";
  return `    <div class="pc-result"${r.id ? ` id="${r.id}" hidden` : ""}>
      <div class="pc-result-brand">${svg("0 0 28 28", 28, "#183F30", 2, HOME)}<span>${escape(r.brand)}</span></div>
      <main class="pc-card"${r.id ? "" : ' aria-live="polite"'}>
        <div class="pc-badge ${r.tone}">${BADGES[r.tone]}</div>
        <div class="pc-card-text">
          <h1>${escape(r.title)}</h1>
          <p>${escape(r.message)}</p>
        </div>${next}${leaving}
      </main>
    </div>`;
}

/** A message under a field. /oauth.js fills it and turns it green or red. */
const fieldMessage = (id: string, short = false) =>
  `<p class="pc-msg" id="${id}" aria-live="polite" hidden>${svg("0 0 24 24", 18, "currentColor", 2.2, CHECK, "pc-i-good")}${svg("0 0 24 24", 18, "currentColor", 2, ALERT, "pc-i-bad")}${
    short ? `<span class="pc-msg-text pc-wide"></span><span class="pc-msg-short pc-narrow"></span>` : `<span class="pc-msg-text"></span>`
  }</p>`;

/** The chat's name as the page says it: "your Grok Bot" reads "Grok Bot" at the start of a line. */
const chatName = (who: ConsentWho) => who.chat.replace(/^your /, "");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The same approval, worded for Cleaner Core, or for the shared address. */
function cleanerConsentPage(p: { requestId: string; matchCode: string; clientName: string; redirectHost: string; hosted?: boolean; firstClaim?: boolean; invite?: boolean; account?: AccountForms }, who: ConsentWho, words: ConsentWords = CLEANER_WORDS): string {
  const name = escape(chatName(who));
  const product = escape(words.product);
  const list = (items: string[], icon: string) => items.map((item) => `            <li>${icon}<span>${escape(capital(item))}</span></li>`).join("\n");
  const tick = svg("0 0 24 24", 20, "#8FD3AE", 2.2, CHECK);
  const lock = svg("0 0 24 24", 20, "#B7C8BC", 2, LOCK);
  const neverAsks = `${name} never asks for a sign-in code, a password, or a door code in chat.`;

  // A multi-tenant Cleaner Core: the invite code says whose Cleaner Core this connection joins.
  const inviteField = `<div class="pc-field">
            <label for="oauth-invite">Invite code from Saad</label>
            <input id="oauth-invite" class="pc-input pc-invite" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" />
            ${fieldMessage("oauth-msg-invite")}
          </div>`;
  const general = fieldMessage("oauth-msg-general");
  let heading: string;
  let fields: string;
  if (!p.hosted) {
    heading = "Approve on your computer";
    fields = `<div class="pc-note">${svg("0 0 24 24", 20, "#1D5A43", 2, CHAT)}<span><strong>Approve on the ${product} computer.</strong> Open <em>${escape(who.connect)}</em> there, check it shows this code, then choose Allow.</span></div>`;
  } else if (p.invite && p.account) {
    heading = "Sign in to approve";
    fields = accountForms(p.account, inviteField, general);
  } else if (p.invite) {
    heading = "Use your invite code";
    fields = `<div class="pc-fields">
          ${inviteField}
          ${general}
        </div>`;
  } else {
    heading = "Approve this connection";
    fields = general;
  }
  const allow = p.hosted ? `\n          <button type="button" class="pc-primary" id="oauth-allow" data-code="${escape(p.matchCode)}">Allow access</button>` : "";
  const leaving = `Taking you back to ${chatName(who)}…`;

  return pcShell(
    `Connect ${who.chat} to ${words.product}`,
    `    <div class="pc-split" id="oauth-page">
      <section class="pc-trust">
        <div class="pc-brand">${svg("0 0 28 28", 32, "#F1F4EF", 2, HOME)}<span>${product}</span></div>
        <div class="pc-intro">
          <p class="pc-eyebrow pc-wide">Connect your assistant</p>
          <h1>Let ${name} run the day-to-day. You keep the keys.</h1>
          <p class="pc-lede pc-wide">${escape(words.lede)}</p>
          <p class="pc-ask pc-narrow">${name} ${escape(words.asking)}</p>
        </div>
        <div class="pc-perm pc-wide">
          <div class="pc-perm-group">
            <p class="pc-perm-title">${name} will be able to</p>
            <ul class="pc-perm-list">
${list(words.can, tick)}
            </ul>
          </div>
          <div class="pc-rule"></div>
          <div class="pc-perm-group">
            <p class="pc-perm-title">It will never be able to</p>
            <ul class="pc-perm-list">
${list(words.cannot, lock)}
            </ul>
          </div>
        </div>
        <p class="pc-trust-note pc-wide">${neverAsks}</p>
      </section>
      <section class="pc-form-side">
        <div class="pc-form">
          <div class="pc-pair pc-wide" aria-hidden="true">
            <div class="pc-avatar">${escape(chatName(who).charAt(0).toUpperCase())}</div>
            <svg class="pc-pair-line" width="40" height="12" viewBox="0 0 40 12" fill="none" stroke="#9AA59F" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="2 4" aria-hidden="true" focusable="false"><path d="M2 6h36"/></svg>
            <div class="pc-avatar pc-home">${svg("0 0 28 28", 22, "#FFFFFF", 2.2, HOME)}</div>
          </div>
          <div class="pc-head">
            <h2 id="oauth-heading">${heading}</h2>
            <p class="pc-sub pc-wide"><strong>${escape(p.clientName)}</strong> ${escape(words.asking)} After you decide, you'll be sent back to ${escape(p.redirectHost)}.</p>
          </div>
          ${fields}
          <div class="pc-mini pc-narrow">
            <p class="pc-mini-title">${name} will be able to</p>
            <p class="pc-mini-text">${escape(words.canShort)}</p>
            <div class="pc-mini-rule"></div>
            <div class="pc-mini-never">${svg("0 0 24 24", 18, "#1D5A43", 2, LOCK)}<p class="pc-mini-text"><strong>Never:</strong> ${escape(words.cannotShort)}</p></div>
          </div>
          <div class="pc-match">
            <div class="pc-match-text pc-wide"><span class="pc-match-label">Connection code</span><span>Check it matches the one in ${name}.</span></div>
            <span class="pc-match-short pc-narrow">Connection code — check it matches ${name}</span>
            <span class="match-code">${escape(p.matchCode)}</span>
          </div>
          <div class="pc-actions">${allow}
            <button type="button" class="pc-link" id="oauth-deny">Deny</button>
          </div>
          <div class="pc-status"><span class="pc-dot"></span><span id="oauth-status" data-request="${escape(p.requestId)}">Waiting for your approval…</span></div>
        </div>
      </section>
      <p class="pc-foot pc-narrow">${neverAsks}</p>
    </div>
${resultBlock({ id: "oauth-done-approved", brand: words.product, tone: "ok", title: "Approved", message: `${chatName(who)} is now connected to ${words.connected}`, next: words.next?.(chatName(who)), leaving })}
${resultBlock({ id: "oauth-done-denied", brand: words.product, tone: "no", title: "Not approved", message: `Nothing was connected. You can connect again from ${chatName(who)} any time.`, leaving })}
${resultBlock({ id: "oauth-done-expired", brand: words.product, tone: "wait", title: "This request expired", message: `Start connecting again from ${chatName(who)}. It will open a fresh page for you.` })}`,
    `\n    <script type="module" src="/oauth.js"></script>`,
  );
}

/** Sign in and Create account on the multi-tenant service's connect page (saadvz/PropertyCore#162). */
export interface AccountForms {
  termsUrl: string;
}

/**
 * Sign in, Create account, and the invite code, one at a time. /oauth.js shows the chosen one;
 * the phone and its code are shared by Sign in and Create account.
 */
function accountForms(account: AccountForms, inviteField: string, general: string): string {
  const tab = (mode: string, label: string, on: boolean) => `<button type="button" class="pc-tab" data-oauth-mode="${mode}" aria-pressed="${on}">${label}</button>`;
  return `<div class="pc-seg" id="oauth-modes" role="group" aria-label="Your Property Core account">
            ${tab("sign-in", "Sign in", true)}
            ${tab("sign-up", "Create account", false)}
            ${tab("invite", "Invite code", false)}
          </div>
          <div class="pc-fields">
            <div class="pc-part" id="oauth-phone-part">
              <div class="pc-field">
                <label for="oauth-phone">Mobile number</label>
                <div class="pc-phone-row">
                  <input id="oauth-phone" class="pc-input" type="tel" autocomplete="tel" inputmode="tel" placeholder="(555) 123-4567" />
                  <button type="button" class="pc-ghost pc-send" id="oauth-send-code">Text me a code</button>
                  ${fieldMessage("oauth-msg-phone", true)}
                </div>
              </div>
              <div class="pc-field">
                <label for="oauth-phone-code">Code from the text</label>
                <input id="oauth-phone-code" class="pc-input pc-otp" autocomplete="one-time-code" inputmode="numeric" spellcheck="false" placeholder="6-digit code" />
                ${fieldMessage("oauth-msg-code")}
              </div>
            </div>
            <div class="pc-part" id="oauth-signup-part" hidden>
              <div class="pc-field">
                <label for="oauth-email">Email</label>
                <input id="oauth-email" class="pc-input" type="email" autocomplete="email" spellcheck="false" placeholder="you@example.com" />
                ${fieldMessage("oauth-msg-email")}
              </div>
              <div class="pc-field">
                <label class="pc-check"><input type="checkbox" id="oauth-terms" /><span>I accept the <a href="${escape(account.termsUrl)}" target="_blank" rel="noopener noreferrer">terms</a>.</span></label>
                ${fieldMessage("oauth-msg-terms")}
              </div>
              <div class="pc-note">${svg("0 0 24 24", 20, "#1D5A43", 2, CHAT)}<span>Your account gets its own text line for your cleaner. You'll keep using your chat, not texts.</span></div>
            </div>
            <div class="pc-part" id="oauth-invite-part" hidden>
              ${inviteField}
            </div>
            ${general}
          </div>`;
}

/** A page that ends the connection attempt. `tone` picks the badge: a problem by default. */
export function problemPage(title: string, message: string, tone: ResultTone = "bad"): string {
  return pcShell(title, resultBlock({ brand: "Property Core", tone, title, message }));
}
