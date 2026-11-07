import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetAdminSessions } from "../src/cleaner-core/hosted/admin";
import { liveDeskFor } from "../src/cleaner-core/liveDesk";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { setTwilioNumbersFetch } from "../src/cleaner-core/hosted/twilioNumbers";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

const PASSWORD = "admin-test-password-1";
const LANE_LINE = "+15555550150";
const FORM = "application/x-www-form-urlencoded";

let open: MultiTenantApp | undefined;
afterEach(() => {
  resetAdminSessions();
  setTwilioNumbersFetch(undefined);
  open?.close();
  open = undefined;
  closeHostedApps();
});

interface TwilioCall {
  method: string;
  url: string;
  body?: string;
}

/** A fake Twilio REST API that owns `owned`. */
function fakeTwilio(owned: Record<string, string> = { [LANE_LINE]: "PN1" }) {
  const calls: TwilioCall[] = [];
  setTwilioNumbersFetch(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: String(init.body) } : {}) });
    if ((init?.method ?? "GET") === "GET") {
      const number = new URL(url).searchParams.get("PhoneNumber") ?? "";
      const sid = owned[number];
      return new Response(JSON.stringify({ incoming_phone_numbers: sid ? [{ sid, phone_number: number }] : [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  return calls;
}

/** The page escapes apostrophes. */
const html = (text: string) => text.replaceAll("'", "&#39;");

async function start(options: { password?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const password = options.password === null ? undefined : (options.password ?? PASSWORD);
  open = await multiTenantApp({ env: { ...(password ? { CLEANER_CORE_ADMIN_PASSWORD: password } : {}), ...options.env } });
  return open;
}

/** A touring tenant whose touring process is running. */
async function touringTenant(m: MultiTenantApp, label: string, number: string) {
  const { tenant } = m.registry.create({ label, twilioNumber: number });
  m.registry.setTouring(tenant.id);
  await m.touring()!.start(m.registry.get(tenant.id)!);
  return m.registry.get(tenant.id)!;
}

const TOURING = { env: { TOUR_CORE_TENANTS: "1" } };
const SLOW = { timeout: 120_000 };

/** Signs in and returns a browser-like client carrying the session cookie and the page's CSRF token. */
async function signIn(m: MultiTenantApp) {
  const login = await m.app.http("/admin/login", { method: "POST", headers: { "content-type": FORM }, body: new URLSearchParams({ password: PASSWORD }).toString() });
  expect(login.status).toBe(303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const page = async (path: string) => {
    const res = await m.app.http(path, { headers: { cookie } });
    return { status: res.status, html: await res.text() };
  };
  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = csrfOf((await page("/admin")).html);
  const post = async (path: string, fields: Record<string, string>, withCsrf = true) => {
    const res = await m.app.http(path, { method: "POST", headers: { "content-type": FORM, cookie }, body: new URLSearchParams({ ...fields, ...(withCsrf ? { csrf } : {}) }).toString() });
    return { status: res.status, html: await res.text(), location: res.headers.location };
  };
  return { cookie, page, post, csrf };
}

describe("the admin page", () => {
  it("is 404 everywhere when no password is set", async () => {
    const m = await start({ password: null });
    for (const path of ["/admin", "/admin/tenants"]) expect((await m.app.http(path)).status).toBe(404);
    expect((await m.app.http("/admin/login", { method: "POST", headers: { "content-type": FORM }, body: "password=x" })).status).toBe(404);
  });

  it("shows the sign-in form, and locks out after 5 wrong passwords", async () => {
    const m = await start();
    expect(await (await m.app.http("/admin")).text()).toContain('name="password"');
    const wrong = () => m.app.http("/admin/login", { method: "POST", headers: { "content-type": FORM }, body: "password=nope" });
    for (let i = 0; i < 5; i++) expect((await wrong()).status).toBe(401);
    const locked = await wrong();
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many tries. Wait 15 minutes.");
    // Even the right password waits out the lockout.
    expect((await m.app.http("/admin/login", { method: "POST", headers: { "content-type": FORM }, body: new URLSearchParams({ password: PASSWORD }).toString() })).status).toBe(429);
  });

  it("sets a strict, http-only session cookie scoped to /admin", async () => {
    const m = await start();
    const login = await m.app.http("/admin/login", { method: "POST", headers: { "content-type": FORM }, body: new URLSearchParams({ password: PASSWORD }).toString() });
    const cookie = String(login.headers["set-cookie"]);
    for (const part of ["Path=/admin", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=43200"]) expect(cookie).toContain(part);
  });

  it("refuses a form without the session's CSRF token, and a form with no session", async () => {
    const m = await start();
    fakeTwilio();
    const admin = await signIn(m);
    const res = await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE }, false);
    expect(res.status).toBe(403);
    expect(res.html).toContain("That form expired. Reload the page.");
    const anonymous = await m.app.http("/admin/tenants", { method: "POST", headers: { "content-type": FORM }, body: new URLSearchParams({ label: "Lane", number: LANE_LINE, csrf: admin.csrf }).toString() });
    expect(anonymous.status).toBe(403);
    expect(m.registry.list()).toHaveLength(0);
  });

  it("creates a tenant: checks the number on Twilio, points its webhook, and shows the invite once", async () => {
    const m = await start();
    const calls = fakeTwilio();
    const admin = await signIn(m);
    const res = await admin.post("/admin/tenants", { label: "Lane", number: "(555) 555-0150" });
    expect(res.status).toBe(200);
    const code = /data-invite="([^"]+)"/.exec(res.html)?.[1];
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // The shared address, not Cleaner Core's own: the host's chat picks the service.
    expect(res.html).toContain(`Connector URL: <span class="code">${BASE}/mcp</span>`);
    expect(res.html).toContain("This code is shown once.");
    const tenant = m.registry.list()[0]!;
    expect(tenant).toMatchObject({ label: "Lane", twilioNumber: LANE_LINE });
    expect(calls[0]).toMatchObject({ method: "GET", url: `https://api.twilio.com/2010-04-01/Accounts/ACmultitenant/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(LANE_LINE)}` });
    expect(calls[1]).toEqual({ method: "POST", url: "https://api.twilio.com/2010-04-01/Accounts/ACmultitenant/IncomingPhoneNumbers/PN1.json", body: new URLSearchParams({ SmsUrl: `${BASE}/webhooks/twilio/cleaner-core`, SmsMethod: "POST" }).toString() });
    expect((await admin.page("/admin")).html).not.toContain(code!);
    expect((await admin.page(`/admin/tenants/${tenant.id}`)).html).not.toContain(code!);
    expect(m.registry.claimInvite(code!)).toEqual({ tenantId: tenant.id });
  });

  it("explains a number that isn't on Twilio, a taken number, and a missing label", async () => {
    const m = await start();
    fakeTwilio({ [LANE_LINE]: "PN1", "+15555550151": "PN2" });
    const admin = await signIn(m);
    expect((await admin.post("/admin/tenants", { label: "Lane", number: "+15555550199" })).html).toContain(html("That number isn't on the Twilio account."));
    expect((await admin.post("/admin/tenants", { label: "Lane", number: "12" })).html).toContain(html("That isn't a phone number."));
    expect((await admin.post("/admin/tenants", { label: " ", number: LANE_LINE })).html).toContain("Add a label.");
    await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE });
    expect((await admin.post("/admin/tenants", { label: "Court", number: LANE_LINE })).html).toContain("Another tenant already uses that number.");
    expect(m.registry.list()).toHaveLength(1);
  });

  it("makes a new invite, changes the primary, disables and enables", async () => {
    const m = await start();
    fakeTwilio();
    const admin = await signIn(m);
    await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE });
    const lane = m.registry.list()[0]!;
    await m.join(lane.id, "grok");
    await m.join(lane.id, "claude");
    const [, claude] = m.registry.get(lane.id)!.connections;
    const invite = await admin.post(`/admin/tenants/${lane.id}/invite`, {});
    expect(invite.html).toMatch(/data-invite="[0-9A-Z-]{14}"/);
    await admin.post(`/admin/tenants/${lane.id}/primary`, { grantId: claude!.grantId });
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(claude!.grantId);
    await admin.post(`/admin/tenants/${lane.id}/disable`, {});
    expect(m.registry.get(lane.id)!.disabled).toBe(true);
    await admin.post(`/admin/tenants/${lane.id}/enable`, {});
    expect(m.registry.get(lane.id)!.disabled).toBeUndefined();
  });

  it("disconnect revokes the grant and its routine secrets", async () => {
    const m = await start();
    fakeTwilio();
    const admin = await signIn(m);
    await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE });
    const lane = m.registry.list()[0]!;
    const token = await m.join(lane.id, "grok");
    const grant = new OAuthGrantStore(m.app.inst.runtime).findByAccessHash(hashSecret(token))!;
    const secrets = new TenantSecrets(m.app.root);
    secrets.setForConnection(lane.id, grant.id, { CLEANER_CORE_ROUTINE_KEY: "routine-key-123" });
    await admin.post(`/admin/tenants/${lane.id}/disconnect`, { grantId: grant.id });
    expect(new OAuthGrantStore(m.app.inst.runtime).get(grant.id)).toBeUndefined();
    expect(secrets.connection(lane.id, grant.id)).toEqual({});
    expect(m.registry.get(lane.id)!.connections).toHaveLength(0);
    expect((await m.tool(token, "get_state")).status).toBe(401);
  });

  it("drops a connection whose grant is gone when the list loads", async () => {
    const m = await start();
    fakeTwilio();
    const admin = await signIn(m);
    await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE });
    const lane = m.registry.list()[0]!;
    const token = await m.join(lane.id, "grok");
    new OAuthGrantStore(m.app.inst.runtime).revokeGrant(new OAuthGrantStore(m.app.inst.runtime).findByAccessHash(hashSecret(token))!.id);
    await admin.page("/admin");
    expect(m.registry.get(lane.id)!.connections).toHaveLength(0);
  });

  it("deletes only with the typed label, then clears the webhook, the grants, the folder and the cached desk", async () => {
    const m = await start();
    const calls = fakeTwilio();
    const admin = await signIn(m);
    await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE });
    const lane = m.registry.list()[0]!;
    const property = m.registry.addProperty(lane.id, "12 Scratch Lane");
    m.registry.setFlow(lane.id, property.id, "cleaning", true);
    const token = await m.join(lane.id, "grok");
    await m.tool(token, "get_state", { choice: "cleaners" });
    expect(existsSync(propertyFolder(m.app.root, lane.id, property))).toBe(true);
    const cached = liveDeskFor(propertyFolder(m.app.root, lane.id, property), () => ({}), () => new Date());
    const refused = await admin.post(`/admin/tenants/${lane.id}/delete`, { confirm: "lane" });
    expect(refused.html).toContain("Type the label to delete.");
    expect(m.registry.get(lane.id)).toBeDefined();
    await admin.post(`/admin/tenants/${lane.id}/delete`, { confirm: "Lane" });
    expect(m.registry.get(lane.id)).toBeUndefined();
    expect(existsSync(tenantFolder(m.app.root, lane.id))).toBe(false);
    expect(calls.at(-1)).toEqual({ method: "POST", url: "https://api.twilio.com/2010-04-01/Accounts/ACmultitenant/IncomingPhoneNumbers/PN1.json", body: new URLSearchParams({ SmsUrl: "", SmsMethod: "POST" }).toString() });
    expect((await m.tool(token, "get_state")).status).toBe(401);
    expect((await m.app.http(`/t/${lane.id}/cleaner-core/photos/x`)).status).toBe(404);
    // Nothing recreates the deleted folder on the next drain, and no desk for its property stays cached.
    expect(existsSync(tenantFolder(m.app.root, lane.id))).toBe(false);
    expect(liveDeskFor(propertyFolder(m.app.root, lane.id, property), () => ({}), () => new Date())).not.toBe(cached);
  });

  it("never renders a routine key, a cleaner phone, or a door-code key", async () => {
    const m = await start();
    fakeTwilio();
    const admin = await signIn(m);
    await admin.post("/admin/tenants", { label: "Lane", number: LANE_LINE });
    const lane = m.registry.list()[0]!;
    await m.join(lane.id, "grok");
    new TenantSecrets(m.app.root).set(lane.id, { CLEANER_CORE_PIN_KEY: "pin-key-secret-value" });
    mkdirSync(tenantFolder(m.app.root, lane.id), { recursive: true });
    writeFileSync(join(tenantFolder(m.app.root, lane.id), "cleaner-live.json"), JSON.stringify({ host: "+15555550100", cleaner: "+15555550101" }));
    for (const path of ["/admin", `/admin/tenants/${lane.id}`]) {
      const { html } = await admin.page(path);
      expect(html).not.toContain("pin-key-secret-value");
      expect(html).not.toContain("+15555550101");
      expect(html).not.toContain("+15555550100");
    }
  });

  it("escapes a label", async () => {
    const m = await start();
    fakeTwilio();
    const admin = await signIn(m);
    await admin.post("/admin/tenants", { label: "<script>x</script>", number: LANE_LINE });
    const { html } = await admin.page("/admin");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows each account's properties and the touring process", SLOW, async () => {
    const m = await start(TOURING);
    const admin = await signIn(m);
    await touringTenant(m, "Mill", "+15555550170");
    const court = m.registry.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    m.registry.addProperty(court.id, "8 Scratch Court");
    m.registry.addProperty(court.id, "9 Scratch Annex");
    m.registry.create({ label: "Lane", twilioNumber: LANE_LINE });
    const list = (await admin.page("/admin")).html;
    expect(list).toContain("<th>Properties</th><th>Touring process</th>");
    expect(list).toMatch(/Mill<\/a>.*<td>touring<\/td><td>up<\/td>/);
    expect(list).toMatch(/Court<\/a>.*<td>2 properties<\/td><td>—<\/td>/);
    expect(list).toMatch(/Lane<\/a>.*<td>no properties<\/td><td>—<\/td>/);
  });

  it("shows whether a property's wake-ups reach its alert routine, without its token", async () => {
    const m = await start();
    const admin = await signIn(m);
    const court = m.registry.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    const property = m.registry.addProperty(court.id, "8 Scratch Court");
    m.registry.setFlow(court.id, property.id, "cleaning", true);
    expect((await admin.page("/admin")).html).toMatch(/Court<\/a>.*<td>1 property<\/td><td>—<\/td><td>—<\/td>/);
    // The refusal a Claude task's wrong token leaves, as the outbox records it.
    const refused = "The Claude scheduled task refused its token. Make a new token and save it again.";
    new FileRuntimeStore(join(propertyFolder(m.app.root, court.id, property), "cleaner-alerts")).put("operator-events", "evt_madeupwakehealth01", {
      schemaVersion: 1,
      event: { schemaVersion: 1, eventId: "evt_madeupwakehealth01", eventType: "cleaning.update", occurredAt: "2026-11-03T18:36:58.000Z" },
      status: "failed",
      attempts: 20,
      createdAt: "2026-11-03T18:36:58.000Z",
      nextAttemptAt: "2026-11-03T22:00:00.000Z",
      lastAttemptAt: "2026-11-03T21:45:00.000Z",
      lastError: refused,
    });
    expect((await admin.page("/admin")).html).toContain(`<td>failing: ${refused}</td>`);
    expect((await admin.page(`/admin/tenants/${court.id}`)).html).toContain(`Alerts: failing: ${refused}.`);
  });

  it("shows a touring tenant's restarts and waiting texts on its page", SLOW, async () => {
    const m = await start(TOURING);
    const admin = await signIn(m);
    const mill = await touringTenant(m, "Mill", "+15555550170");
    const page = (await admin.page(`/admin/tenants/${mill.id}`)).html;
    expect(page).toContain("Service: touring. Touring process: up. Restarts in the last day: 0. Texts waiting: 0.");
  });

  it("admin page lists properties and never shows a phone or door code", SLOW, async () => {
    const m = await start();
    const admin = await signIn(m);
    const court = m.registry.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    const property = m.registry.addProperty(court.id, "8 Scratch Court");
    m.registry.setFlow(court.id, property.id, "cleaning", true);
    mkdirSync(propertyFolder(m.app.root, court.id, property), { recursive: true });
    writeFileSync(join(propertyFolder(m.app.root, court.id, property), "cleaner-live.json"), JSON.stringify({ address: "8 Scratch Court", host: "+15555550100", cleaner: "+15555550101" }));
    const page = (await admin.page(`/admin/tenants/${court.id}`)).html;
    expect(page).toContain("8 Scratch Court");
    expect(page).toContain(property.id);
    expect(page).toContain("Cleaner Core: on");
    expect(page).toContain("Supply Core: off");
    expect(page).toContain("Turn off Cleaner Core");
    expect(page).not.toContain("+15555550100");
    expect(page).not.toContain("+15555550101");
  });

  it("admin force-off sends nothing and records it", SLOW, async () => {
    const m = await start();
    const admin = await signIn(m);
    const court = m.registry.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    const property = m.registry.addProperty(court.id, "8 Scratch Court");
    m.registry.setFlow(court.id, property.id, "cleaning", true);
    const off = await admin.post(`/admin/tenants/${court.id}/flows`, { property: property.id, flow: "cleaning" });
    expect(off.status).toBe(303);
    expect(m.registry.get(court.id)?.properties[0]?.flows.cleaning.on).toBe(false);
    expect(m.sms.sent).toEqual([]);
    const audit = readFileSync(join(tenantFolder(m.app.root, court.id), "service-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({ actor: "admin", property: property.id, flow: "cleaning", on: false, forced: true });
    expect((await admin.post(`/admin/tenants/${court.id}/flows`, { property: "prp_nothere000", flow: "cleaning" })).status).toBe(400);
  });

  it("refuses a turn-off that names no property, and changes nothing", SLOW, async () => {
    const m = await start();
    const admin = await signIn(m);
    const court = m.registry.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    const property = m.registry.addProperty(court.id, "8 Scratch Court");
    m.registry.setFlow(court.id, property.id, "cleaning", true);
    const refused = await admin.post(`/admin/tenants/${court.id}/flows`, { property: "", flow: "cleaning" });
    expect(refused.status).toBe(400);
    expect(refused.html).toContain("That property doesn&#39;t exist.");
    expect(m.registry.get(court.id)?.properties[0]?.flows.cleaning.on).toBe(true);
  });

  it("makes an account with no properties a touring account, and refuses one with properties", SLOW, async () => {
    const m = await start(TOURING);
    const admin = await signIn(m);
    const lane = m.registry.create({ label: "Lane", twilioNumber: LANE_LINE }).tenant;
    expect((await admin.page(`/admin/tenants/${lane.id}`)).html).toContain("Make touring");
    expect((await admin.post(`/admin/tenants/${lane.id}/touring`, {})).status).toBe(303);
    expect(m.registry.get(lane.id)?.service).toBe("touring");
    expect(m.touring()!.supervisor.target(lane.id)).toBeDefined();
    const court = m.registry.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    m.registry.addProperty(court.id, "8 Scratch Court");
    expect((await admin.page(`/admin/tenants/${court.id}`)).html).not.toContain("Make touring");
    expect((await admin.post(`/admin/tenants/${court.id}/touring`, {})).status).toBe(400);
    expect(m.registry.get(court.id)?.service).toBeUndefined();
  });

  it("stops a touring process when its tenant is turned off, and starts it when turned on", SLOW, async () => {
    const m = await start(TOURING);
    const admin = await signIn(m);
    const mill = await touringTenant(m, "Mill", "+15555550170");
    await admin.post(`/admin/tenants/${mill.id}/disable`, {});
    expect(m.touring()!.supervisor.target(mill.id)).toBeUndefined();
    await admin.post(`/admin/tenants/${mill.id}/enable`, {});
    expect(m.touring()!.supervisor.target(mill.id)).toBeDefined();
  });

  it("stops a touring process before deleting its tenant", SLOW, async () => {
    const m = await start(TOURING);
    fakeTwilio({ "+15555550170": "PN7" });
    const admin = await signIn(m);
    const mill = await touringTenant(m, "Mill", "+15555550170");
    expect((await admin.post(`/admin/tenants/${mill.id}/delete`, { confirm: "Mill" })).status).toBe(303);
    expect(m.touring()!.supervisor.target(mill.id)).toBeUndefined();
    expect(m.touring()!.supervisor.health(mill.id).up).toBe(false);
    expect(existsSync(tenantFolder(m.app.root, mill.id))).toBe(false);
  });
});
