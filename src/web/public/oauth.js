// The consent page Grok opens. On the hosted demo the human can Allow the
// first connection, which also claims that Grok client as owner. Other
// installs can only say no here; approval stays on the Tour Core computer.
// Once a decision is made, the page hands off to the server, which sends the
// browser back to Grok exactly once.

const status = document.getElementById("oauth-status");
const deny = document.getElementById("oauth-deny");
const allow = document.getElementById("oauth-allow");
// A multi-tenant Cleaner Core asks for the invite code from Saad, unless the host signs in instead.
const invite = document.getElementById("oauth-invite");
// With sign-up open, the page offers Sign in, Create account, and the invite code, one at a time.
const tabs = [...document.querySelectorAll("[data-oauth-mode]")];
const mode = () => tabs.find((tab) => tab.getAttribute("aria-pressed") === "true")?.dataset.oauthMode;
const heading = document.getElementById("oauth-heading");
const phone = document.getElementById("oauth-phone");
const phoneCode = document.getElementById("oauth-phone-code");
const sendCode = document.getElementById("oauth-send-code");
const parts = {
  phone: document.getElementById("oauth-phone-part"),
  signUp: document.getElementById("oauth-signup-part"),
  invite: document.getElementById("oauth-invite-part"),
};
// The Property Core page shows how it ended in place of the form; the Tour Core page says it in the status line.
const page = document.getElementById("oauth-page");
const ended = {
  approved: document.getElementById("oauth-done-approved"),
  denied: document.getElementById("oauth-done-denied"),
  expired: document.getElementById("oauth-done-expired"),
};
const base = `/oauth/requests/${encodeURIComponent(status.dataset.request)}`;
let finished = false;

const HEADINGS = { "sign-in": "Sign in to approve", "sign-up": "Create your account", invite: "Use your invite code" };
const INPUTS = { phone, code: phoneCode, email: document.getElementById("oauth-email"), invite };

/** Swaps the form for the card that says how it ended. False on a page without those cards. */
function showEnd(kind) {
  const card = ended[kind];
  if (!page || !card) return false;
  page.hidden = true;
  card.hidden = false;
  return true;
}

function finish(kind, message) {
  if (finished) return;
  finished = true;
  status.textContent = message;
  deny.disabled = true;
  if (allow) allow.disabled = true;
  // A moment on the card, so the person sees what happened before leaving.
  const shown = showEnd(kind);
  setTimeout(() => location.replace(`${base}/continue`), shown ? 1200 : 0);
}

async function poll() {
  if (finished) return;
  try {
    const res = await fetch(base, { cache: "no-store" });
    const { status: state } = await res.json();
    if (state === "approved") return finish("approved", "Approved. Taking you back...");
    if (state === "denied") return finish("denied", "Not approved. Taking you back...");
    if (state === "expired") {
      if (showEnd("expired")) return;
      status.textContent = "This request expired. Start connecting again from Grok.";
      deny.hidden = true;
      if (allow) allow.hidden = true;
      return;
    }
  } catch {
    // Keep waiting; the Tour Core computer may be busy.
  }
  setTimeout(poll, 1500);
}

/** Hides the messages under the fields (only the red ones when `errorsOnly`) and clears the red borders. */
function clearMessages(errorsOnly = false) {
  for (const node of document.querySelectorAll(errorsOnly ? ".pc-msg.bad" : ".pc-msg")) node.hidden = true;
  for (const input of Object.values(INPUTS)) {
    if (!input) continue;
    input.classList.remove("err");
    input.removeAttribute("aria-invalid");
  }
}

/**
 * Says something under the field it's about: green with a check, or red with an icon and a red
 * border on the field. A message about no one field goes under the form, or in the status line.
 */
function say(field, text, { good = false, short } = {}) {
  const node = (field && document.getElementById(`oauth-msg-${field}`)) || document.getElementById("oauth-msg-general");
  if (!node) {
    status.textContent = text;
    return;
  }
  node.classList.toggle("bad", !good);
  node.setAttribute("role", good ? "status" : "alert");
  node.querySelector(".pc-msg-text").textContent = text;
  const brief = node.querySelector(".pc-msg-short");
  if (brief) brief.textContent = short || text;
  node.hidden = false;
  const input = INPUTS[field];
  if (input && !good && node.id === `oauth-msg-${field}`) {
    input.classList.add("err");
    input.setAttribute("aria-invalid", "true");
  }
}

for (const [field, input] of Object.entries(INPUTS)) {
  if (!input) continue;
  input.addEventListener("input", () => {
    if (!input.classList.contains("err")) return;
    input.classList.remove("err");
    input.removeAttribute("aria-invalid");
    const node = document.getElementById(`oauth-msg-${field}`);
    if (node) node.hidden = true;
  });
}

function showMode() {
  if (!mode()) return;
  parts.phone.hidden = mode() === "invite";
  parts.signUp.hidden = mode() !== "sign-up";
  parts.invite.hidden = mode() !== "invite";
  if (heading) heading.textContent = HEADINGS[mode()];
  if (allow) allow.textContent = mode() === "sign-up" ? "Create account & allow" : "Allow access";
}

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const other of tabs) other.setAttribute("aria-pressed", String(other === tab));
    clearMessages();
    showMode();
  });
}
showMode();

/** What Allow sends: the phone and its code, the new account's details, or the invite code. */
function approval() {
  const body = { matchCode: allow.dataset.code || "" };
  if (mode() === "sign-in") return { ...body, signIn: { phone: phone.value, code: phoneCode.value } };
  if (mode() === "sign-up") {
    return {
      ...body,
      signUp: { phone: phone.value, code: phoneCode.value, email: document.getElementById("oauth-email").value, terms: document.getElementById("oauth-terms").checked },
    };
  }
  return { ...body, ...(invite ? { inviteCode: invite.value } : {}) };
}

/** After a code is sent the button counts down to Resend. The server holds the real limit. */
function countDown(seconds) {
  const tick = () => {
    if (seconds <= 0) {
      sendCode.textContent = "Resend";
      sendCode.disabled = false;
      return;
    }
    sendCode.textContent = `Resend in 0:${String(seconds).padStart(2, "0")}`;
    seconds -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

if (sendCode) {
  sendCode.addEventListener("click", async () => {
    sendCode.disabled = true;
    clearMessages();
    const res = await fetch(`${base}/phone-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchCode: allow.dataset.code || "", phone: phone.value }),
    }).catch(() => null);
    if (res?.ok) {
      say("phone", "Code sent. Type it in, then choose Allow.", { good: true, short: "Code sent" });
      countDown(30);
      phoneCode.focus();
      return;
    }
    const error = res ? await res.json().then((body) => body?.error).catch(() => undefined) : undefined;
    say(error?.field || (error ? undefined : "phone"), error?.message || "The code couldn't be sent. Try again.");
    // Only stops a double tap.
    setTimeout(() => (sendCode.disabled = false), 1_000);
  });
}

if (allow) {
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    deny.disabled = true;
    // "Code sent" stays; only what Allow answers replaces the red ones.
    clearMessages(true);
    const res = await fetch(`${base}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approval()),
    }).catch(() => null);
    if (!res || !res.ok) {
      const error = (invite || mode()) && res ? await res.json().then((body) => body?.error).catch(() => undefined) : undefined;
      say(error?.field, error?.message || "That didn't go through. Start connecting again from your chat.");
      allow.disabled = false;
      deny.disabled = false;
      return;
    }
    finish("approved", "Approved. Taking you back...");
  });
}

deny.addEventListener("click", async () => {
  deny.disabled = true;
  if (allow) allow.disabled = true;
  await fetch(`${base}/deny`, { method: "POST" }).catch(() => {});
  finish("denied", "Not approved. Taking you back...");
});

poll();
