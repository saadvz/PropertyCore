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
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  can: string[];
  cannot: string[];
}

const CLEANER_WORDS: ConsentWords = {
  product: "Cleaner Core",
  asking: "is asking to run your cleaning schedule.",
  can: ["save your property, calendars, people and schedule", "read new bookings", "text your cleaner when you say so", "tell you what your cleaner says"],
  cannot: ["read back your door code", "send the door code before you say the guests have left", "read Tour Core or its tours", "read provider secrets"],
};

/** The one address on the multi-tenant service: the host picks touring or cleaning after connecting. */
const SHARED_WORDS: ConsentWords = {
  product: "Property Core",
  asking: "is asking to run touring or cleaning on your number.",
  can: ["set your number up for touring or cleaning", "save your properties, calendars, people and schedule", "text visitors or your cleaner as that service does", "tell you what they say"],
  cannot: ["read back a door code", "reach another host's number or records", "read provider secrets"],
};

/** The same approval, worded for Cleaner Core, or for the shared address. */
function cleanerConsentPage(p: { requestId: string; matchCode: string; clientName: string; redirectHost: string; hosted?: boolean; firstClaim?: boolean; invite?: boolean; account?: AccountForms }, who: ConsentWho, words: ConsentWords = CLEANER_WORDS): string {
  // A multi-tenant Cleaner Core: the invite code says whose Cleaner Core this connection joins.
  const inviteField = `<p><label for="oauth-invite">Invite code from Saad</label><br /><input id="oauth-invite" autocomplete="off" autocapitalize="characters" spellcheck="false" /></p>`;
  const invite = p.invite && p.account ? accountForms(p.account, inviteField) : p.invite ? inviteField : "";
  const decision = p.hosted
    ? `${invite}
          <p><button type="button" class="primary" id="oauth-allow" data-code="${escape(p.matchCode)}">Allow</button></p>`
    : `<p><strong>Approve on the ${words.product} computer.</strong> Open <em>${who.connect}</em> there, check it shows this code, then choose Allow:</p>`;
  const list = (items: string[]) => items.map((item) => `          <li>${item}</li>`).join("\n");
  return shell(
    `Connect ${who.chat} to ${words.product}`,
    `        <h1>Connect ${who.chat} to ${words.product}</h1>
        <p><strong>${escape(p.clientName)}</strong> ${words.asking}</p>
        <p class="hint">After you decide, you'll be sent back to ${escape(p.redirectHost)}.</p>
        <p>It will be able to:</p>
        <ul>
${list(words.can)}
        </ul>
        <p>It will <strong>not</strong> be able to:</p>
        <ul>
${list(words.cannot)}
        </ul>
        <div class="card highlight">
          ${decision}
          <p class="match-code">${escape(p.matchCode)}</p>
          <p id="oauth-status" class="muted" data-request="${escape(p.requestId)}">Waiting for approval…</p>
        </div>
        <button type="button" id="oauth-deny">Deny</button>`,
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
function accountForms(account: AccountForms, inviteField: string): string {
  return `<fieldset id="oauth-modes"><legend>Your Property Core account</legend>
            <p><label><input type="radio" name="oauth-mode" value="sign-in" checked /> Sign in</label></p>
            <p><label><input type="radio" name="oauth-mode" value="sign-up" /> Create account</label></p>
            <p><label><input type="radio" name="oauth-mode" value="invite" /> I have an invite code</label></p>
          </fieldset>
          <div id="oauth-phone-part">
            <p><label for="oauth-phone">Your mobile number</label><br /><input id="oauth-phone" type="tel" autocomplete="tel" inputmode="tel" /></p>
            <p><button type="button" id="oauth-send-code">Text me a code</button></p>
            <p><label for="oauth-phone-code">Code from the text</label><br /><input id="oauth-phone-code" autocomplete="one-time-code" inputmode="numeric" spellcheck="false" /></p>
          </div>
          <div id="oauth-signup-part" hidden>
            <p><label for="oauth-email">Email</label><br /><input id="oauth-email" type="email" autocomplete="email" spellcheck="false" /></p>
            <p><label><input type="checkbox" id="oauth-terms" /> I accept the <a href="${escape(account.termsUrl)}" target="_blank" rel="noopener noreferrer">terms</a></label></p>
            <p class="hint">Your account gets its own text line for your cleaner. You'll keep using your chat, not texts.</p>
          </div>
          <div id="oauth-invite-part" hidden>
            ${inviteField}
          </div>`;
}

export function problemPage(title: string, message: string): string {
  return shell(title, `        <h1>${escape(title)}</h1>\n        <p>${escape(message)}</p>`);
}
