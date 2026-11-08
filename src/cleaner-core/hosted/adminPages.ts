import { POOL_LOW_AT, type PoolState, type PoolSummary } from "./numberPool";
import type { Tenant } from "./registry";

/**
 * Saad's admin pages. Server-rendered, no script, everything escaped. They never show a door code,
 * a calendar link, a routine address or key, a secret, or any phone number but the service's own
 * Twilio numbers: each tenant's line and the pool's.
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
  /** The account's wake-ups to its alert routine: "working", "failing: <why>", or "—". */
  alerts: string;
  /** Each property's wake-ups, by property id. */
  perProperty?: Record<string, string>;
}

const NO_HEALTH: TenantHealth = { service: "no properties", process: "—", restartsLastDay: 0, queuedTexts: 0, alerts: "—" };

/** The pool's counts, and the low alert once ready numbers are at or below POOL_LOW_AT. */
function poolLines(pool: PoolSummary, link = true): string {
  const alert = pool.low ? `<p class="error" data-pool-low>The number pool is low: ${pool.ready} ready. Add registered numbers before sign-ups run out.</p>\n      ` : "";
  return `${alert}<p>Number pool: ${pool.ready} ready, ${pool.resting} resting, ${pool.inUse} in use.${link ? ' <a href="/admin/pool">Manage the pool</a>' : ""}</p>`;
}

export function tenantsPage(tenants: Tenant[], csrf: string, error: string | undefined, healthOf: (t: Tenant) => TenantHealth = () => NO_HEALTH, pool: PoolSummary): string {
  const rows = tenants
    .map((t) => {
      const primary = t.connections.find((c) => c.grantId === t.primaryGrantId);
      const health = healthOf(t);
      return `<tr><td><a href="/admin/tenants/${escape(t.id)}">${escape(t.label)}</a></td><td>${escape(t.twilioNumber)}</td><td>${escape(health.service)}</td><td>${escape(health.process)}</td><td>${escape(health.alerts)}</td><td>${escape(primary?.assistant ?? "none")}</td><td>${t.connections.length}</td><td>${escape(t.lastActivityAt ?? "never")}</td><td>${t.disabled ? "off" : "on"}</td></tr>`;
    })
    .join("\n");
  return shell(
    "Cleaner Core tenants",
    `      <h1>Cleaner Core tenants</h1>
      ${errorLine(error)}
      ${poolLines(pool)}
      <table>
        <tr><th>Host</th><th>Number</th><th>Properties</th><th>Touring process</th><th>Alerts</th><th>Primary</th><th>Connections</th><th>Last activity</th><th>Status</th></tr>
        ${rows || '<tr><td colspan="9">No tenants yet.</td></tr>'}
      </table>
      <h2>Add a host</h2>
      <form method="post" action="/admin/tenants">
        ${csrfField(csrf)}
        <p><label for="label">Label</label><br /><input id="label" name="label" autocomplete="off" /></p>
        <p><label for="number">Twilio number. Leave it blank to take one from the pool</label><br /><input id="number" name="number" autocomplete="off" /></p>
        <p><button type="submit">Create tenant</button></p>
      </form>
      ${action("/admin/logout", csrf, "Sign out")}`,
  );
}

const FLOW_TITLES = { cleaning: "Cleaner Core", supplies: "Supply Core", fixer: "Fixer Core" } as const;

/**
 * Each property, its flows, and a force-off for each flow that's on: it sends nothing, and what was live
 * stays frozen in the setup. The host's chat adds properties and turns flows on.
 */
function propertiesSection(t: Tenant, base: string, csrf: string, health: TenantHealth, touringOffered: boolean): string {
  if (t.service === "touring") return "<p>This account runs touring.</p>";
  if (t.properties.length === 0) {
    const touring = touringOffered ? action(`${base}/touring`, csrf, "Make touring") : "";
    return `<p>No properties yet. The host's chat adds them.</p>${touring ? `\n      <p>${touring}</p>` : ""}`;
  }
  const rows = t.properties
    .map((p) => {
      const flows = (["cleaning", "supplies", "fixer"] as const).map((flow) => `${FLOW_TITLES[flow]}: ${p.flows[flow].on ? "on" : "off"}`).join(". ");
      const offs = (["cleaning", "supplies"] as const)
        .filter((flow) => p.flows[flow].on)
        .map((flow) => action(`${base}/flows`, csrf, `Turn off ${FLOW_TITLES[flow]}`, `<input type="hidden" name="property" value="${escape(p.id)}" /><input type="hidden" name="flow" value="${flow}" />`))
        .join(" ");
      return `<tr><td>${escape(p.label)}</td><td>${escape(p.id)}</td><td>${escape(flows)}.</td><td>${escape(health.perProperty?.[p.id] ?? "—")}</td><td>${offs}</td></tr>`;
    })
    .join("\n");
  return `<p>Turn off sends nothing. What was live stays frozen in the setup. Only do it if the host asks you to.</p>
      <table>
        <tr><th>Property</th><th>Id</th><th>Flows</th><th>Alerts</th><th></th></tr>
        ${rows}
      </table>`;
}

export function tenantPage(t: Tenant, csrf: string, error: string | undefined, health: TenantHealth, touringOffered: boolean): string {
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
      <p>Service: ${escape(health.service)}. Touring process: ${escape(health.process)}. Restarts in the last day: ${health.restartsLastDay}. Texts waiting: ${health.queuedTexts}. Alerts: ${escape(health.alerts)}.</p>
      <h2>Properties</h2>
      ${propertiesSection(t, base, csrf, health, touringOffered)}
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
        <p>Its number goes back to the pool and rests 30 days before another account gets it.</p>
        <p><label><input type="checkbox" name="release" value="1" /> Release the number from Twilio instead. Its texting registration goes with it.</label></p>
        <p><button type="submit">Delete</button></p>
      </form>
      <p><a href="/admin">Back to tenants</a></p>`,
  );
}

/** The invite code and the connector URL, shown once. */
export function invitePage(t: Tenant, code: string, connectorUrl: string, warning?: string): string {
  return shell(
    `Invite for ${t.label}`,
    `      <h1>Invite for ${escape(t.label)}</h1>
      ${errorLine(warning)}
      <p>Text line: ${escape(t.twilioNumber)}.</p>
      <p>Send the host this invite code. They type it on the Cleaner Core page that opens when they connect.</p>
      <p class="code" data-invite="${escape(code)}">${escape(code)}</p>
      <p>Connector URL: <span class="code">${escape(connectorUrl)}</span></p>
      <p><strong>This code is shown once.</strong> It works for 7 days.</p>
      <p><a href="/admin/tenants/${escape(t.id)}">Back to ${escape(t.label)}</a></p>`,
  );
}

/** One pooled number as the pool page shows it. */
export interface PoolRow {
  number: string;
  state: PoolState;
  /** When a resting number is handed out again. */
  readyAt?: string;
  tenant?: { id: string; label: string };
  webhookOk?: boolean;
  addedAt: string;
}

/**
 * The pool of registered numbers: what's ready, resting and in use, a top-up form, and a release.
 * Add only numbers already registered for business texting.
 */
export function poolPage(rows: PoolRow[], summary: PoolSummary, csrf: string, notice?: string, error?: string): string {
  const stateOf = (row: PoolRow) => (row.state === "resting" ? `resting until ${row.readyAt ?? ""}` : row.state === "in-use" ? "in use" : "ready");
  const body = rows
    .map((row) => {
      const account = row.tenant ? `<a href="/admin/tenants/${escape(row.tenant.id)}">${escape(row.tenant.label)}</a>` : "—";
      const webhook =
        row.state !== "in-use" ? "—" : row.webhookOk === false ? `not pointed${row.tenant ? ` ${action(`/admin/tenants/${row.tenant.id}/line`, csrf, "Point again")}` : ""}` : row.webhookOk ? "pointed" : "—";
      return `<tr><td>${escape(row.number)}</td><td>${escape(stateOf(row))}</td><td>${account}</td><td>${webhook}</td><td>${escape(row.addedAt)}</td></tr>`;
    })
    .join("\n");
  return shell(
    "Number pool",
    `      <h1>Number pool</h1>
      ${errorLine(error)}
      ${notice ? `<p>${escape(notice)}</p>` : ""}
      ${poolLines(summary, false)}
      <p>Each new account takes the ready number that has waited longest. A closed account's number rests 30 days, so its old cleaner stops texting it, before anyone else gets it. The alert shows at ${POOL_LOW_AT} or fewer ready.</p>
      <table>
        <tr><th>Number</th><th>State</th><th>Account</th><th>Webhook</th><th>Added</th></tr>
        ${body || '<tr><td colspan="5">No numbers yet.</td></tr>'}
      </table>
      <h2>Add numbers</h2>
      <form method="post" action="/admin/pool">
        ${csrfField(csrf)}
        <p><label for="numbers">Numbers already on the Twilio account and registered for business texting (10DLC or verified toll-free), one per line</label><br /><textarea id="numbers" name="numbers" rows="5" cols="30"></textarea></p>
        <p><button type="submit">Add to the pool</button></p>
      </form>
      <h2>Release a number</h2>
      <form method="post" action="/admin/pool/release">
        ${csrfField(csrf)}
        <p><label for="release">Type a ready or resting number to release it from Twilio. This can't be undone, and its registration goes with it</label><br /><input id="release" name="number" autocomplete="off" /></p>
        <p><button type="submit">Release</button></p>
      </form>
      <p><a href="/admin">Back to tenants</a></p>`,
  );
}
