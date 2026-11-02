// The consent page Grok opens. On the hosted demo the human can Allow the
// first connection, which also claims that Grok client as owner. Other
// installs can only say no here; approval stays on the Tour Core computer.
// Once a decision is made, the page hands off to the server, which sends the
// browser back to Grok exactly once.

const status = document.getElementById("oauth-status");
const deny = document.getElementById("oauth-deny");
const allow = document.getElementById("oauth-allow");
// A multi-tenant Cleaner Core asks for the invite code from Saad.
const invite = document.getElementById("oauth-invite");
// The shared address's service pick, when the page offers one. None picked: the chat asks instead.
const picked = () => document.querySelector('input[name="oauth-service"]:checked')?.value;
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

if (allow) {
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    deny.disabled = true;
    const res = await fetch(`${base}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchCode: allow.dataset.code || "", ...(invite ? { inviteCode: invite.value } : {}), ...(picked() ? { service: picked() } : {}) }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const said = invite && res ? await res.json().then((body) => body?.error?.message).catch(() => undefined) : undefined;
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
