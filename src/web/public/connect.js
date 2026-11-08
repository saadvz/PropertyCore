// Hosted approval. The owner cookie is sent with the request. The request id
// in the query selects which connection is waiting. Neither one alone is enough.

const root = document.getElementById("connect");
const requestId = new URLSearchParams(location.search).get("request") || "";

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

function csrf() {
  const match = document.cookie.match(/(?:^|; )tourcore_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "X-TourCore-Csrf": csrf(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function finish(request) {
  location.replace(`/oauth/requests/${encodeURIComponent(request)}/continue`);
}

async function render() {
  const body = h("div", { class: "phone-body" }, h("h1", { text: "Connect to Tour Core" }));
  if (!requestId) {
    body.append(h("p", { text: "This approval link is missing or was opened without its code. Go back to the chat and start again." }));
    root.replaceChildren(body);
    return;
  }
  const loaded = await api("GET", `/api/connect?request=${encodeURIComponent(requestId)}`);
  if (loaded.status === 401) {
    // There is no owner-claim page any more: a connection is approved on the page the chat opens.
    body.append(h("p", { text: "Approve this connection on the page your chat opened, where the pairing code and Allow are. Go back to the chat and connect again." }));
    root.replaceChildren(body);
    return;
  }
  if (loaded.status !== 200) {
    body.append(h("p", { text: loaded.data.error?.message || "That connection isn't waiting any more." }));
    root.replaceChildren(body);
    return;
  }
  const request = loaded.data.request;
  body.append(h("p", { text: "Make sure this matches the sign-in page:" }));
  body.append(h("p", { class: "match-code", text: request.matchCode }));
  body.append(h("p", { class: "hint", text: `${request.clientName} is asking to connect. It can set up your property and see tours. It cannot open doors or read saved credentials.` }));
  const decide = async (path) => {
    const result = await api("POST", path, { requestId: request.id, matchCode: request.matchCode });
    if (!result.data.ok) {
      body.replaceChildren(h("h1", { text: "Connect to Tour Core" }), h("p", { text: result.data.error?.message || "That didn't go through." }));
      return;
    }
    finish(request.id);
  };
  body.append(
    h("div", { class: "actions" }, h("button", { type: "button", class: "primary", onclick: () => decide("/api/connect/approve") }, "Allow"), h("button", { type: "button", onclick: () => decide("/api/connect/deny") }, "Deny")),
  );
  root.replaceChildren(body);
}

render();
