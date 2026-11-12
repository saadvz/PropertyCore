import { afterEach, describe, expect, it, vi } from "vitest";
import type { Property } from "../src/cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../src/cleaner-core/hosted/registry";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { peopleFor } from "../src/hub/people";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** Calls to an account's line: voicemail for known callers only. 555 numbers and made-up pros; Twilio is stubbed. */

const LINE = "+15555550150";
const HOST = "+15555550100";
const JOE = "+15555550142";
const MARIA = "+15555550143";
const STRANGER = "+15555550177";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-12T15:00:00.000Z");
const GREETING = "Hi, you've reached the repairs and cleaning line. This call is recorded. Please leave your message after the tone, then hang up.";
const NO_CALLS = "This number doesn't take calls. Please text it.";
const LANDLORD = "This line is for your pros and cleaner. Talk to your assistant in chat.";

let open: MultiTenantApp | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
});

/** An account whose one property runs Fixer Core with Joe saved, Maria as its cleaner, and the host's phone. */
async function setup() {
  open = await multiTenantApp({ env: { FIXER_CORE: "1" }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LINE });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  const token = await m.joinAt(tenant.id, "grok", PATH);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await m.toolAt(PATH, token, name, { property: property.id, ...args });
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply;
  };
  await call("set_flows", { fixer: true });
  await call("save_fixer_property", { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  await call("save_fixer_sources", { done: true });
  await call("save_pro", { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE } });
  const people = peopleFor(tenantFolder(m.app.root, tenant.id), { now: () => NOW });
  people.savePropertyPeople(property.id, HOST, [{ phone: MARIA, role: "cleaner", name: "Maria" }]);
  return { m, tenant: tenant as Tenant, property: property as Property };
}

const ring = (m: MultiTenantApp, from: string, sid = `CA${Math.random().toString(16).slice(2, 12)}`) => m.twilio("/webhooks/twilio/voice", { CallSid: sid, From: from, To: LINE, CallStatus: "ringing" });

describe("a call to the line", () => {
  it("refuses a forged call with 403", SLOW, async () => {
    const { m } = await setup();
    const forged = await m.twilio("/webhooks/twilio/voice", { CallSid: "CAforged", From: JOE, To: LINE }, "/somewhere-else");
    expect(forged.status).toBe(403);
  });

  it("an unknown caller hears the no-calls line and nothing is recorded", SLOW, async () => {
    const { m } = await setup();
    const res = await ring(m, STRANGER);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(NO_CALLS);
    expect(body).not.toContain("<Record");
  });

  it("the landlord hears the chat line and nothing is recorded", SLOW, async () => {
    const { m } = await setup();
    const body = await (await ring(m, HOST)).text();
    expect(body).toContain(LANDLORD);
    expect(body).not.toContain("<Record");
  });

  it("a saved pro hears the greeting and is recorded for up to 2 minutes with a transcript", SLOW, async () => {
    const { m } = await setup();
    const body = await (await ring(m, JOE)).text();
    expect(body).toContain(GREETING);
    expect(body).toContain('<Record maxLength="120" timeout="5" playBeep="true" transcribe="true"');
    expect(body).toContain('transcribeCallback="https://');
    expect(body).toContain('/webhooks/twilio/voice/transcript"');
  });

  it("the cleaner saved on the property is recorded too", SLOW, async () => {
    const { m } = await setup();
    expect(await (await ring(m, MARIA)).text()).toContain("<Record");
  });

  it("the greeting names no address or business", SLOW, async () => {
    const { m } = await setup();
    const body = await (await ring(m, JOE)).text();
    expect(body).not.toContain("Scratch");
    expect(body).not.toContain("Teaneck");
  });

  it("a sixth call in an hour is not recorded", SLOW, async () => {
    const { m } = await setup();
    for (let i = 0; i < 5; i++) expect(await (await ring(m, JOE)).text()).toContain("<Record");
    const sixth = await (await ring(m, JOE)).text();
    expect(sixth).toContain(NO_CALLS);
    expect(sixth).not.toContain("<Record");
  });
});
