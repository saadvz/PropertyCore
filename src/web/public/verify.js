// Basic identity form opened from a text message. The link holds only a
// random token; everything else stays on the server. Standalone on purpose:
// this is the only page a phone can reach through the public address.

const root = document.getElementById("verify");
const token = location.pathname.split("/").pop();
// Relative, so the page also works under a shared service's /t/<id>/ prefix.
const api = `../api/verify/${encodeURIComponent(token)}`;

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}

function done(title, message) {
  root.replaceChildren(h("div", { class: "phone-body" }, h("h1", { text: title }), h("p", { text: message })));
}

async function load() {
  const res = await fetch(api);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return done("This link can't be used", data.message ?? "Text the property to get a new link.");

  const field = (label, name, type = "text", autocomplete = "") => {
    const input = h("input", { name, type, required: "", autocomplete });
    return { input, node: h("label", {}, label, input) };
  };
  const first = field("Legal first name", "firstName", "text", "given-name");
  const last = field("Legal last name", "lastName", "text", "family-name");
  const email = field("Email", "email", "email", "email");
  const phone = field("Phone (the number you're texting from)", "phone", "tel", "tel");
  const error = h("p", { class: "form-error", role: "alert" });
  error.hidden = true;
  const button = h("button", { type: "submit", class: "primary" }, "Confirm my details");

  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        error.hidden = true;
        const body = { firstName: first.input.value, lastName: last.input.value, email: email.input.value, phone: phone.input.value };
        const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        button.disabled = false;
        if (res.status === 400) {
          error.textContent = out.message ?? "Please check the form.";
          error.hidden = false;
          return;
        }
        done(out.ok ? "You're all set" : "Thanks", out.message ?? "Check your messages.");
      },
    },
    first.node,
    last.node,
    email.node,
    phone.node,
    error,
    button,
  );

  root.replaceChildren(
    h(
      "div",
      { class: "phone-body" },
      h("h1", { text: "Confirm your details" }),
      h("p", { class: "muted", text: `For your self-guided tour at ${data.property}. This link works for about ${data.expiresInMinutes} more minutes.` }),
      form,
      h("p", { class: "hint", text: "This records who you say you are for the property's tour records. No ID photos are collected." }),
    ),
  );
}

load().catch(() => done("Something went wrong", "Please try the link again, or text the property."));
