import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CleanerAssistant } from "../src/cleaner-core/assistant";
import { tenantFolder, type Tenant } from "../src/cleaner-core/hosted/registry";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { filesUnder } from "./files";
import { MULTI_AUTH, multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { CALENDAR_URL, FROZEN } from "./wiringProof";

/**
 * The hosted tenants gate: two tenants on one running multi-tenant service, each with its own
 * number, chat, cleaner and door code. Nothing one tenant does reaches the other. Only 555 numbers;
 * the door codes are the made-up Scratch pins.
 */

const [LANE, COURT] = SCRATCH_TENANTS as [(typeof SCRATCH_TENANTS)[number], (typeof SCRATCH_TENANTS)[number]];
const LANE_LINE = "+15555550150";
const COURT_LINE = "+15555550151";
const ZONE = "America/New_York";

interface Side {
  tenant: Tenant;
  token: string;
  line: string;
  scratch: typeof LANE;
}

let m: MultiTenantApp;
let lane: Side;
let court: Side;
let pinSends: { to: string; body: string }[];

/**
 * Saved files hold random-looking runs: UUIDs, hex hashes and ids, millisecond and second
 * timestamps, and base64 keys, IVs and sealed pins. A 4-digit door code turns up inside one
 * of those by chance now and then (a CI run once failed on runtime/oauth/grok-access.json).
 * Those runs are blanked before the scan. Everything else in every file (desk files, logs,
 * outboxes) is still checked with a plain substring match, so a code in any readable context
 * ("pin":"4821", code 4821, ?code=4821, pin4821) still fails the test.
 */
function withoutRandomRuns(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
    .replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (run) => (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) ? " " : run))
    .replace(/[0-9a-f]{16,}/g, " ")
    .replace(/\d{10,}/g, " ");
}

function holdsPin(text: string, pin: string): boolean {
  return withoutRandomRuns(text).includes(pin);
}

/** Setup through the door code upload link, then the cleaner's YES and the host's go-ahead. */
async function setUp(side: Omit<Side, "token">, assistant: CleanerAssistant): Promise<Side> {
  const token = await m.join(side.tenant.id, assistant);
  const call = (name: string, args: Record<string, unknown> = {}) => m.tool(token, name, args);
  await call("get_state", { choice: "cleaners" });
  await call("save_property", { business: "Scratch", address: side.scratch.property.address, timeZone: ZONE });
  await call("save_people", { host: side.scratch.ownerPhone, cleaner: side.scratch.cleanerPhone });
  await call("save_calendar_link", { url: CALENDAR_URL });
  const link = await call("save_door_code", {});
  const uploadUrl = String(link.structured?.uploadUrl);
  expect(new URL(uploadUrl).pathname.startsWith(`/t/${side.tenant.id}/cleaner-core/door-code/`)).toBe(true);
  const upload = await m.app.http(new URL(uploadUrl).pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: side.scratch.pin }) });
  expect(upload.status).toBe(200);
  await call("set_up_texting");
  await call("run_checks");
  expect((await call("confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
  await m.text(side.line, side.scratch.cleanerPhone, "YES", `SM-${side.tenant.id}-yes-1`);
  await m.text(side.line, side.scratch.cleanerPhone, "YES", `SM-${side.tenant.id}-yes-2`);
  return { ...side, token };
}

beforeAll(async () => {
  m = await multiTenantApp({ now: () => new Date(FROZEN) });
  const laneTenant = m.registry.create({ label: "Scratch Lane", twilioNumber: LANE_LINE }).tenant;
  const courtTenant = m.registry.create({ label: "Scratch Court", twilioNumber: COURT_LINE }).tenant;
  lane = await setUp({ tenant: laneTenant, line: LANE_LINE, scratch: LANE }, "grok");
  court = await setUp({ tenant: courtTenant, line: COURT_LINE, scratch: COURT }, "claude");
  // The other house's cleaner and host text Lane's number. Nothing is scheduled or sent to them.
  const before = m.sms.sent.length;
  await m.text(LANE_LINE, COURT.cleanerPhone, "YES", "SM-cross-yes");
  await m.text(LANE_LINE, COURT.ownerPhone, "The guests have left", "SM-cross-left");
  crossSends = m.sms.sent.slice(before);
  for (const side of [lane, court]) {
    const sent = await m.tool(side.token, "mark_guests_left", { confirmed: true });
    expect(sent.isError).toBe(false);
  }
  pinSends = m.sms.sent.filter((s) => s.body.includes(LANE.pin) || s.body.includes(COURT.pin));
});

let crossSends: { to: string; body: string }[] = [];

describe("hosted tenants gate", () => {
  it("a text to Lane's number from Court's people schedules nothing and sends nothing to Court", () => {
    const courtPhones = new Set([COURT.ownerPhone, COURT.cleanerPhone, COURT.unapprovedPhone]);
    expect(crossSends.filter((s) => courtPhones.has(s.to))).toEqual([]);
    expect(m.sms.sent.filter((s) => courtPhones.has(s.to) && s.body.includes(LANE.property.address))).toEqual([]);
    expect(m.sms.sent.filter((s) => s.to === LANE.cleanerPhone && s.body.includes(COURT.property.address))).toEqual([]);
  });

  it("Court's grant only ever sees Court", async () => {
    const state = await m.tool(court.token, "get_state");
    expect(state.raw).toContain(COURT.property.address);
    expect(state.raw).not.toContain(LANE.property.address);
    const laneState = await m.tool(lane.token, "get_state");
    expect(laneState.raw).not.toContain(COURT.property.address);
  });

  it("a group webhook signed for Lane's prefix is refused at Court's", async () => {
    const fields = { EventType: "onMessageAdded", ConversationSid: "CHcross", Author: COURT.cleanerPhone, Body: "hello", MessageSid: "IMcross" };
    const signature = twilioSignature(MULTI_AUTH, `${BASE}/t/${lane.tenant.id}/webhooks/twilio/cleaner-core/conversation`, fields);
    const before = m.sms.sent.length;
    const res = await m.app.http(`/t/${court.tenant.id}/webhooks/twilio/cleaner-core/conversation`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body: new URLSearchParams(fields).toString(),
    });
    expect(res.status).not.toBe(200);
    expect(m.sms.sent.length).toBe(before);
  });

  it("a link with the tenant id swapped is 404", async () => {
    const link = await m.tool(lane.token, "save_alert_routine", {});
    const path = new URL(String(link.structured?.uploadUrl)).pathname;
    expect(path.startsWith(`/t/${lane.tenant.id}/`)).toBe(true);
    const swapped = path.replace(lane.tenant.id, court.tenant.id);
    const res = await m.app.http(swapped, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://grok.example/hook", token: "routine-key-1234" }) });
    expect(res.status).toBe(404);
    expect((await m.app.http(`/t/${court.tenant.id}/cleaner-core/photos/not-a-token`)).status).toBe(404);
  });

  it("each door code goes once, to its own approved cleaner, and neither code is in any saved file", () => {
    expect(pinSends.filter((s) => s.body.includes(LANE.pin)).map((s) => s.to)).toEqual([LANE.cleanerPhone]);
    expect(pinSends.filter((s) => s.body.includes(COURT.pin)).map((s) => s.to)).toEqual([COURT.cleanerPhone]);
    for (const file of filesUnder(m.app.root)) {
      const text = readFileSync(file, "utf8");
      expect(holdsPin(text, LANE.pin) || holdsPin(text, COURT.pin), file).toBe(false);
    }
  });

  it("the saved-file scan still finds a readable door code and skips one only inside a random run", () => {
    const pin = LANE.pin;
    for (const leak of [`{"pin":"${pin}"}`, `door code ${pin}.`, `?code=${pin}&x=1`, `pin${pin}`, `code-${pin}-lane`, `"pinCode": ${pin}`]) {
      expect(holdsPin(leak, pin), leak).toBe(true);
    }
    for (const noise of [
      `"accessHash": "09a${pin}56855623595901a2ccbe5e5af1360511c6c6a21995a8f33982cfd92344"`,
      `"id": "3e1e087c-${pin}-4e0a-93b5-a17a0d88fd46"`,
      `"registeredAt": 179${pin}607173`,
      `"iv": "BldRc${pin}G+/DiOh3"`,
    ]) {
      expect(holdsPin(noise, pin), noise).toBe(false);
    }
  });

  it("the process env's per-tenant values reach neither tenant", async () => {
    const leak = "https://leak.example/routine/hook";
    m.app.env.CLEANER_CORE_MCP_TOKEN = "static-cleaner-token-leak";
    m.app.env.CLEANER_CORE_ROUTINE_URL = leak;
    m.app.env.CLEANER_CORE_ROUTINE_KEY = "leaked-routine-key";
    try {
      expect((await m.tool("static-cleaner-token-leak", "get_state")).status).toBe(401);
      expect((await m.tool(lane.token, "save_alert_routine", { url: "https://grok.example/routine/hook", token: "lane-routine-key-1" })).isError).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(m.wakes.length).toBeGreaterThan(0);
      expect(m.wakes.some((wake) => wake.url === leak)).toBe(false);
      const link = await m.tool(court.token, "save_alert_routine", {});
      expect(String(link.structured?.uploadUrl).startsWith(`${BASE}/t/${court.tenant.id}/`)).toBe(true);
    } finally {
      for (const name of ["CLEANER_CORE_MCP_TOKEN", "CLEANER_CORE_ROUTINE_URL", "CLEANER_CORE_ROUTINE_KEY"]) delete m.app.env[name];
    }
  });

  it("each tenant's desk and engine store are under its own folder, and nothing is at the data root", () => {
    for (const side of [lane, court]) expect(filesUnder(tenantFolder(m.app.root, side.tenant.id)).some((f) => f.endsWith("cleaner-live.json"))).toBe(true);
    expect(filesUnder(m.app.root).some((f) => f === join(m.app.root, "cleaner-live.json"))).toBe(false);
  });
});

afterAll(() => {
  m?.close();
  closeHostedApps();
});
