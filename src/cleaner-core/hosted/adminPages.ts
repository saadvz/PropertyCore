import type { Tenant } from "./registry";

/**
 * Saad's admin pages. Server-rendered, no script, everything escaped. They never show a door code,
 * a calendar link, a routine address or key, a secret, or any phone number but a tenant's own
 * Twilio number.
 */

export const ADMIN_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 16px;line-height:1.5}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #ddd}
.error{color:#a40000}.code{font-family:ui-monospace,monospace;font-size:1.3rem;letter-spacing:.08em}
form.inline{display:inline}input{font:inherit;padding:.25rem}button{font:inherit;padding:.25rem .6rem}`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>${escape(title)}</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>`;
}

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}" />`;
const errorLine = (error?: string) => (error ? `<p class="error">${escape(error)}</p>` : "");
const action = (path: string, csrf: string, label: string, fields = "") =>
  `<form class="inline" method="post" action="${escape(path)}">${csrfField(csrf)}${fields}<button type="submit">${escape(label)}</button></form>`;

export function loginPage(error?: string): string {
  return shell(
    "Cleaner Core admin",
    `      <h1>Cleaner Core admin</h1>
      ${errorLine(error)}
      <form method="post" action="/admin/login">
        <p><label for="password">Password</label><br /><input id="password" name="password" type="password" autocomplete="current-password" /></p>
        <p><button type="submit">Sign in</button></p>
      </form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return shell(title, `      <h1>${escape(title)}</h1>\n      <p>${escape(message)}</p>\n      <p><a href="/admin">Back to tenants</a></p>`);
}

/** What the admin page shows about a tenant's service. Nothing secret. */
export interface TenantHealth {
  service: string;
  process: "up" | "down" | "—";
  restartsLastDay: number;
  queuedTexts: number;
}

const NO_HEALTH: TenantHealth = { service: "not chosen", process: "—", restartsLastDay: 0, queuedTexts: 0 };

export function tenantsPage(tenants: Tenant[], csrf: string, error?: string, healthOf: (t: Tenant) => TenantHealth = () => NO_HEALTH): string {
  const rows = tenants
    .map((t) => {
      const primary = t.connections.find((c) => c.grantId === t.primaryGrantId);
      const health = healthOf(t);
      return `<tr><td><a href="/admin/tenants/${escape(t.id)}">${escape(t.label)}</a></td><td>${escape(t.twilioNumber)}</td><td>${escape(health.service)}</td><td>${escape(health.process)}</td><td>${escape(primary?.assistant ?? "none")}</td><td>${t.connections.length}</td><td>${escape(t.lastActivityAt ?? "never")}</td><td>${t.disabled ? "off" : "on"}</td></tr>`;
    })
    .join("\n");
  return shell(
    "Cleaner Core tenants",
    `      <h1>Cleaner Core tenants</h1>
      ${errorLine(error)}
      <table>
        <tr><th>Host</th><th>Number</th><th>Service</th><th>Touring process</th><th>Primary</th><th>Connections</th><th>Last activity</th><th>Status</th></tr>
        ${rows || '<tr><td colspan="8">No tenants yet.</td></tr>'}
      </table>
      <h2>Add a host</h2>
      <form method="post" action="/admin/tenants">
        ${csrfField(csrf)}
        <p><label for="label">Label</label><br /><input id="label" name="label" autocomplete="off" /></p>
        <p><label for="number">Twilio number</label><br /><input id="number" name="number" autocomplete="off" /></p>
        <p><button type="submit">Create tenant</button></p>
      </form>
      ${action("/admin/logout", csrf, "Sign out")}`,
  );
}

/**
 * Nothing to set before the host chooses: their chat picks touring or cleaning when it connects to
 * /mcp. After that, the admin can only switch the number to the other service.
 */
function serviceSection(t: Tenant, base: string, csrf: string): string {
  if (!t.service) return "<p>Not chosen yet. The host's chat picks touring or cleaning when it connects with the invite code.</p>";
  const other = t.service === "touring" ? "cleaning" : "touring";
  return `<form method="post" action="${escape(`${base}/service`)}">
        ${csrfField(csrf)}
        <input type="hidden" name="to" value="${other}" />
        <p>This number answers texts for ${t.service}. Switch it only if the host asks you to.</p>
        <p><label><input type="checkbox" name="force" value="1" /> Force: switch even if something is live. Nothing is sent, and what was live stays frozen in the old service's setup.</label></p>
        <p><button type="submit">Switch to ${other}</button></p>
      </form>`;
}

export function tenantPage(t: Tenant, csrf: string, error?: string, health: TenantHealth = NO_HEALTH): string {
  const base = `/admin/tenants/${t.id}`;
  const connections = t.connections
    .map((c) => {
      const grant = `<input type="hidden" name="grantId" value="${escape(c.grantId)}" />`;
      const primary = c.grantId === t.primaryGrantId ? "<strong>primary</strong>" : action(`${base}/primary`, csrf, "Make primary", grant);
      return `<tr><td>${escape(c.assistant)}</td><td>${escape(c.connectedAt)}</td><td>${primary}</td><td>${action(`${base}/disconnect`, csrf, "Disconnect", grant)}</td></tr>`;
    })
    .join("\n");
  return shell(
    t.label,
    `      <h1>${escape(t.label)}</h1>
      ${errorLine(error)}
      <p>Number: ${escape(t.twilioNumber)}. Status: ${t.disabled ? "off" : "on"}. Last activity: ${escape(t.lastActivityAt ?? "never")}.</p>
      <p>Service: ${escape(health.service)}. Touring process: ${escape(health.process)}. Restarts in the last day: ${health.restartsLastDay}. Texts waiting: ${health.queuedTexts}.</p>
      <h2>Service</h2>
      ${serviceSection(t, base, csrf)}
      <h2>Connections</h2>
      <table>
        <tr><th>Chat</th><th>Connected</th><th></th><th></th></tr>
        ${connections || '<tr><td colspan="4">No connections yet.</td></tr>'}
      </table>
      <h2>Actions</h2>
      <p>${action(`${base}/invite`, csrf, "New invite code")} ${t.disabled ? action(`${base}/enable`, csrf, "Turn on") : action(`${base}/disable`, csrf, "Turn off")}</p>
      <h2>Delete</h2>
      <form method="post" action="${escape(`${base}/delete`)}">
        ${csrfField(csrf)}
        <p><label for="confirm">Type the label to delete this tenant, its connections and its data</label><br /><input id="confirm" name="confirm" autocomplete="off" /></p>
        <p><button type="submit">Delete</button></p>
      </form>
      <p><a href="/admin">Back to tenants</a></p>`,
  );
}

/** The invite code and the connector URL, shown once. */
export function invitePage(t: Tenant, code: string, connectorUrl: string): string {
  return shell(
    `Invite for ${t.label}`,
    `      <h1>Invite for ${escape(t.label)}</h1>
      <p>Send the host this invite code. They type it on the Cleaner Core page that opens when they connect.</p>
      <p class="code" data-invite="${escape(code)}">${escape(code)}</p>
      <p>Connector URL: <span class="code">${escape(connectorUrl)}</span></p>
      <p><strong>This code is shown once.</strong> It works for 7 days.</p>
      <p><a href="/admin/tenants/${escape(t.id)}">Back to ${escape(t.label)}</a></p>`,
  );
}
