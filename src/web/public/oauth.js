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
const mode = () => document.querySelector('input[name="oauth-mode"]:checked')?.value;
const phone = document.getElementById("oauth-phone");
const phoneCode = document.getElementById("oauth-phone-code");
const sendCode = document.getElementById("oauth-send-code");
const parts = {
  phone: document.getElementById("oauth-phone-part"),
  signUp: document.getElementById("oauth-signup-part"),
  invite: document.getElementById("oauth-invite-part"),
};
const base = `/oauth/requests/${encodeURIComponent(status.dataset.request)}`;
let finished = false;

function finish(message) {
  if (finished) return;
  finished = true;
  status.textContent = message;
  deny.disabled = true;
  if (allow) allow.disabled = true;
  location.replace(`${base}/continue`);
}

async function poll() {
  if (finished) return;
  try {
    const res = await fetch(base, { cache: "no-store" });
    const { status: state } = await res.json();
    if (state === "approved") return finish("Approved. Taking you back...");
    if (state === "denied") return finish("Not approved. Taking you back...");
    if (state === "expired") {
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

function showMode() {
  if (!mode()) return;
  parts.phone.hidden = mode() === "invite";
  parts.signUp.hidden = mode() !== "sign-up";
  parts.invite.hidden = mode() !== "invite";
}

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

for (const choice of document.querySelectorAll('input[name="oauth-mode"]')) choice.addEventListener("change", showMode);
showMode();

if (sendCode) {
  sendCode.addEventListener("click", async () => {
    sendCode.disabled = true;
    const res = await fetch(`${base}/phone-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchCode: allow.dataset.code || "", phone: phone.value }),
    }).catch(() => null);
    const said = res && !res.ok ? await res.json().then((body) => body?.error?.message).catch(() => undefined) : undefined;
    status.textContent = res?.ok ? "Code sent. Type it in, then choose Allow." : said || "The code couldn't be sent. Try again.";
    // The server holds the real limit; this only stops a double tap.
    setTimeout(() => (sendCode.disabled = false), res?.ok ? 30_000 : 1_000);
    if (res?.ok) phoneCode.focus();
  });
}

if (allow) {
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    deny.disabled = true;
    const res = await fetch(`${base}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approval()),
    }).catch(() => null);
    if (!res || !res.ok) {
      const said = (invite || mode()) && res ? await res.json().then((body) => body?.error?.message).catch(() => undefined) : undefined;
      status.textContent = said || "That didn't go through. Start connecting again from Grok.";
      allow.disabled = false;
      deny.disabled = false;
      return;
    }
    finish("Approved. Taking you back...");
  });
}

deny.addEventListener("click", async () => {
  deny.disabled = true;
  if (allow) allow.disabled = true;
  await fetch(`${base}/deny`, { method: "POST" }).catch(() => {});
  finish("Not approved. Taking you back...");
});

poll();
