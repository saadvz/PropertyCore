import { afterEach, describe, expect, it, vi } from "vitest";
import { propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../src/cleaner-core/hosted/registry";
import { readFixer, writeFixer } from "../src/fixer-core/store";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { routeVoicemail } from "../src/hosted/voice";
import { peopleFor } from "../src/hub/people";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** A voicemail's transcript, from Twilio, into news. 555 numbers and made-up pros; Twilio is stubbed. */

const LINE = "+15555550150";
const HOST = "+15555550100";
const JOE = "+15555550142";
const MARIA = "+15555550143";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-12T15:00:00.000Z");

let open: MultiTenantApp | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
});

/** An account with two Fixer Core properties; Joe is saved on both, Maria is the first one's cleaner. */
async function setup() {
  open = await multiTenantApp({ env: { FIXER_CORE: "1" }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LINE });
  const a = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  const b = m.registry.addProperty(tenant.id, "14 Scratch Lane");
  const token = await m.joinAt(tenant.id, "grok", PATH);
  const proIds: Record<string, string> = {};
  for (const [property, street] of [[a, "12"], [b, "14"]] as const) {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await m.toolAt(PATH, token, name, { property: property.id, ...args });
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply;
    };
    await call("set_flows", { fixer: true });
    await call("save_fixer_property", { address: `${street} Scratch Lane, Teaneck, NJ 07666`, timeZone: "America/New_York" });
    await call("save_fixer_sources", { done: true });
    const saved = await call("save_pro", { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, ...(property === b ? { shared: true } : {}) });
    proIds[property.id] = saved.structured!.proId as string;
    await call("save_fixer_settings", { prosDone: true });
    await call("save_fixer_settings", { upkeepDone: true });
    await call("activate_fixer");
  }
  peopleFor(tenantFolder(m.app.root, tenant.id), { now: () => NOW }).savePropertyPeople(a.id, HOST, [{ phone: MARIA, role: "cleaner", name: "Maria" }]);
  const current = m.registry.get(tenant.id)!;
  return { m, tenant: current as Tenant, a: current.properties[0] as Property, b: current.properties[1] as Property, proIds };
}

const transcript = (m: MultiTenantApp, fields: Record<string, string>) =>
  m.twilio("/webhooks/twilio/voice/transcript", { AccountSid: "ACtest", CallSid: "CAtest", To: LINE, TranscriptionStatus: "completed", ...fields });

describe("a voicemail's transcript", () => {
  it("refuses a forged transcript with 403", SLOW, async () => {
    const { m } = await setup();
    const forged = await m.twilio("/webhooks/twilio/voice/transcript", { From: JOE, To: LINE, RecordingSid: "REforged", TranscriptionText: "hi" }, "/elsewhere");
    expect(forged.status).toBe(403);
  });

  it("a pro on two properties: the voicemail goes to the one with their live visit", SLOW, async () => {
    const { m, tenant, b, proIds } = await setup();
    const root = propertyFolder(m.app.root, tenant.id, b);
    const file = readFixer(root);
    file.jobs.push({
      id: "job_livevisit1", trade: "plumbing", what: "Sink leaks", source: "host", photos: [], urgency: "soon", state: "booked",
      hostGo: { at: NOW.toISOString() }, candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString(),
      booking: { proId: proIds[b.id]!, from: new Date(NOW.getTime() - 10 * 60_000).toISOString(), until: new Date(NOW.getTime() + 110 * 60_000).toISOString(), access: "host", hostYes: { at: NOW.toISOString() }, fingerprint: "fp" },
    });
    writeFixer(root, file);
    const res = await transcript(m, { From: JOE, RecordingSid: "REtwoprops01", TranscriptionText: "Running ten minutes late" });
    expect(res.status).toBe(200);
    expect(readFixer(root).jobs[0]!.news.at(-1)).toMatchObject({ kind: "pro-voicemail", text: `Joe's Plumbing left a voicemail: "Running ten minutes late"` });
  });

  it("a cleaner's voicemail is a Cleaner Core note and nothing else", SLOW, async () => {
    const { m, tenant, a, b } = await setup();
    const notes: { property: string; id: string; text: string }[] = [];
    await routeVoicemail(m.hosted(), tenant, { recordingSid: "REcleaner01", from: MARIA, text: "The dryer is broken", status: "completed" }, async (property, id, text) => {
      notes.push({ property: property.id, id, text });
    });
    expect(notes).toEqual([{ property: a.id, id: "voicemail:REcleaner01", text: 'Maria left a voicemail: "The dryer is broken"' }]);
    for (const property of [a, b]) expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).news ?? []).toEqual([]);
  });

  it("someone nobody saved: nothing is kept", SLOW, async () => {
    const { m, tenant, a } = await setup();
    const notes: unknown[] = [];
    await routeVoicemail(m.hosted(), tenant, { recordingSid: "REstranger1", from: "+15555550177", text: "Hello", status: "completed" }, async (...args) => void notes.push(args));
    expect(notes).toEqual([]);
    expect(readFixer(propertyFolder(m.app.root, tenant.id, a)).news ?? []).toEqual([]);
  });
});
