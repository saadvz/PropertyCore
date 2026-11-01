import { afterEach, describe, expect, it } from "vitest";
import { testEvent, timeRequestedEvent, tourEvent } from "../src/alerts/operatorEvents";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { hostTextBody, saveHostTexts, sendHostText } from "../src/hosted/hostTexts";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** Texts to a touring host's own phone. Only 555 numbers; Twilio is faked. */

const LANE = "+15555550150";
const HOST = "+15555550151";
const SLOW = { timeout: 90_000 };
const TIME_LINE = "Tour Core: a visitor asked for a tour time. Open your chat to answer.";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

const at = "2026-11-01T15:00:00.000Z";
const timeRequest = (id = "ttr_0123456789ab") => timeRequestedEvent({ propertyId: "prop_lane", tourTimeRequestId: id, occurredAt: at });
const booked = () => tourEvent({ eventType: "tour.booked", propertyId: "prop_lane", tourRef: "prop_lane~T1", reservationId: "R1", occurredAt: at });

async function touring(env: NodeJS.ProcessEnv = {}) {
  const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1", ...env } }));
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
  return { m, tenant: m.registry.get(tenant.id)!, token };
}

describe("which events a host is texted about", () => {
  it("texts urgent events on urgent, adds routine ones on everything, and never the setup test", () => {
    expect(hostTextBody("tour.time_requested", "urgent")).toBe(TIME_LINE);
    expect(hostTextBody("exception.created", "urgent")).toBe("Tour Core: something on a tour needs you. Open your chat.");
    expect(hostTextBody("access.problem", "urgent")).toBe("Tour Core: something on a tour needs you. Open your chat.");
    expect(hostTextBody("tour.booked", "urgent")).toBeUndefined();
    expect(hostTextBody("tour.booked", "all")).toBe("Tour Core: a tour was booked.");
    expect(hostTextBody("tour.completed", "all")).toBe("Tour Core: a tour was finished.");
    expect(hostTextBody("tour.cancelled", "all")).toBe("Tour Core: a tour was cancelled.");
    for (const which of ["urgent", "all", "off"] as const) {
      expect(hostTextBody("installation.test", which)).toBeUndefined();
      expect(hostTextBody("cleaning.update", which)).toBeUndefined();
    }
    expect(hostTextBody("tour.time_requested", "off")).toBeUndefined();
  });
});

describe("save_host_texts", () => {
  it("takes a 555 host phone on a Scratch tenant, and refuses the number's own, a non-phone, a missing phone, or a real number", SLOW, async () => {
    const { m, token } = await touring();
    const save = (args: Record<string, unknown>) => m.toolAt("/mcp", token, "save_host_texts", args);
    expect((await save({ which: "urgent", phone: HOST })).isError).toBe(false);
    expect((await save({ which: "urgent", phone: LANE })).isError).toBe(true);
    expect((await save({ which: "urgent", phone: "call me" })).isError).toBe(true);
    expect((await save({ which: "urgent" })).isError).toBe(true);
    expect((await save({ which: "urgent", phone: "+12025550300" })).isError).toBe(true);
    expect((await save({ which: "off" })).isError).toBe(false);
  });

  it("refuses a 555 phone for a host whose number is real", SLOW, async () => {
    const { m, tenant } = await touring();
    const live: Tenant = { ...tenant, twilioNumber: "+12025550200" };
    expect(saveHostTexts(m.hosted(), live, { which: "urgent", phone: HOST }).ok).toBe(false);
  });
});

describe("sending host texts", () => {
  it("texts a time request once on urgent, skips a booking, and carries no visitor number", SLOW, async () => {
    const { m, tenant, token } = await touring({ CLEANER_CORE_LIVE_SMS: "1", CLEANER_CORE_SMS_ALLOWLIST: HOST });
    expect((await m.toolAt("/mcp", token, "save_host_texts", { which: "urgent", phone: HOST })).isError).toBe(false);
    const h = m.hosted();
    await sendHostText(h, tenant, timeRequest(), { scratch: false });
    await sendHostText(h, tenant, timeRequest(), { scratch: false });
    await sendHostText(h, tenant, booked(), { scratch: false });
    await sendHostText(h, tenant, testEvent(new Date(at)), { scratch: false });
    expect(m.sms.sent.map((s) => ({ to: s.to, body: s.body }))).toEqual([{ to: HOST, body: TIME_LINE }]);
  });

  it("texts routine events too on everything", SLOW, async () => {
    const { m, tenant, token } = await touring({ CLEANER_CORE_LIVE_SMS: "1", CLEANER_CORE_SMS_ALLOWLIST: HOST });
    await m.toolAt("/mcp", token, "save_host_texts", { which: "all", phone: HOST });
    await sendHostText(m.hosted(), tenant, booked(), { scratch: false });
    expect(m.sms.sent.map((s) => s.body)).toEqual(["Tour Core: a tour was booked."]);
  });

  it("puts a Scratch tenant's host texts in its test outbox, never on a phone", SLOW, async () => {
    const { m, tenant, token } = await touring({ CLEANER_CORE_LIVE_SMS: "1", CLEANER_CORE_SMS_ALLOWLIST: "*" });
    await m.toolAt("/mcp", token, "save_host_texts", { which: "urgent", phone: HOST });
    await sendHostText(m.hosted(), tenant, timeRequest());
    expect(m.sms.sent).toEqual([]);
    const outbox = (await m.toolAt("/mcp", token, "read_outbox")).structured?.texts;
    expect(outbox).toEqual([{ to: HOST, text: TIME_LINE }]);
  });
});
