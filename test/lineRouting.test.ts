import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCaller } from "../src/cleaner-core/callerContext";
import type { Property } from "../src/cleaner-core/hosted/properties";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { hostedCleaner, propertyContext } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { liveDeskFor } from "../src/cleaner-core/liveDesk";
import { LANDLORD_USE_AGENT, routeLineText } from "../src/hosted/lineRouter";
import { sharedRefusal } from "../src/hosted/sharedRoute";
import type { PeopleFile } from "../src/hub/people";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { ROUTINE, setUp } from "./cleanerDeskHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { CLEANER, HOST, TEST_PIN_KEY } from "./wiringProof";

/** Texts on one account's line, shared by two properties with their own cleaners. Only 555 numbers. */

const LINE = "+15555550150";
const COURT_CLEANER = "+15555550141";
const STRANGER = "+15555550199";
const SLOW = { timeout: 120_000 };
const PATH = "/mcp/cleaner-core";
const LANE_ADDRESS = "12 Practice Lane, Teaneck, NJ 07666";

let open: MultiTenantApp | undefined;
let at = Date.parse("2026-10-14T13:00:00.000Z");
const clock = () => new Date(at);
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

const property = (id: string, label: string): Property => ({ id, label, createdAt: "2026-11-01T00:00:00.000Z", flows: { cleaning: { on: true }, supplies: { on: false }, fixer: { on: false } } });
const account = (properties: Property[]): Tenant => ({ id: "tnt_lane000001", label: "Lane", twilioNumber: LINE, connections: [], invites: [], properties, createdAt: "2026-11-01T00:00:00.000Z" });

describe("routeLineText", () => {
  const lane = property("prp_lane000001", "12 Scratch Lane");
  const court = property("prp_court00001", "8 Scratch Court");
  /** The account's people: Ana on Lane, Bea on Court, the landlord the host on both. */
  const people = (on: Record<string, string[]> = { [CLEANER]: [lane.id], [COURT_CLEANER]: [court.id] }) => ({
    propertiesOf: (phone: string) => on[phone] ?? [],
    hostOf: () => HOST,
  });

  it("one property takes every sender", () => {
    const one = account([lane]);
    for (const from of [HOST, CLEANER, STRANGER]) expect(routeLineText(one, from, "hello", people())).toEqual({ kind: "property", property: lane });
  });

  it("a person on one property goes to that property", () => {
    const two = account([lane, court]);
    expect(routeLineText(two, CLEANER, "YES", people())).toEqual({ kind: "property", property: lane });
    expect(routeLineText(two, COURT_CLEANER, "STOP", people())).toEqual({ kind: "property", property: court });
  });

  it("the landlord's STOP and START go to every property where they're the host", () => {
    const two = account([lane, court]);
    expect(routeLineText(two, HOST, "STOP", people())).toEqual({ kind: "host-all", properties: [lane, court] });
    expect(routeLineText(two, HOST, "start", people())).toEqual({ kind: "host-all", properties: [lane, court] });
  });

  it("the landlord's bare YES is not a START: it changes nothing on any property", () => {
    const two = account([lane, court]);
    expect(routeLineText(two, HOST, "YES", people())).toEqual({ kind: "host-unused", property: lane });
    expect(routeLineText(two, HOST, "yes", people())).toEqual({ kind: "host-unused", property: lane });
  });

  it("the landlord's HELP gets nothing; anything else is unused, for the oldest property", () => {
    const two = account([lane, court]);
    expect(routeLineText(two, HOST, "HELP", people())).toEqual({ kind: "host-help" });
    expect(routeLineText(two, HOST, "guests left", people())).toEqual({ kind: "host-unused", property: lane });
  });

  it("anyone else is unknown", () => {
    expect(routeLineText(account([lane, court]), STRANGER, "STOP", people())).toEqual({ kind: "unknown" });
  });

  it("a property with cleaning off doesn't count", () => {
    const off = { ...court, flows: { ...court.flows, cleaning: { on: false } } };
    expect(routeLineText(account([lane, off]), STRANGER, "hi", people())).toEqual({ kind: "property", property: lane });
  });

  it("a person on both: STOP and START to both, HELP to none, anything else to be worked out (saadvz/TourCore#190)", () => {
    const two = account([lane, court]);
    const both = people({ [CLEANER]: [lane.id, court.id] });
    expect(routeLineText(two, CLEANER, "STOP", both)).toEqual({ kind: "person-all", properties: [lane, court] });
    expect(routeLineText(two, CLEANER, "start", both)).toEqual({ kind: "person-all", properties: [lane, court] });
    expect(routeLineText(two, CLEANER, "HELP", both)).toEqual({ kind: "person-help" });
    expect(routeLineText(two, CLEANER, "YES", both)).toEqual({ kind: "shared", properties: [lane, court] });
  });

  it("a person on both whose other property has cleaning off goes straight to the one left", () => {
    const off = { ...court, flows: { ...court.flows, cleaning: { on: false } } };
    const both = people({ [CLEANER]: [lane.id, court.id] });
    expect(routeLineText(account([lane, off]), CLEANER, "YES", both)).toEqual({ kind: "property", property: lane });
    const third = property("prp_annex00001", "9 Scratch Annex");
    expect(routeLineText(account([lane, off, third]), CLEANER, "YES", both)).toEqual({ kind: "property", property: lane });
  });
});

/** An account with Lane (cleaner Ana) and Court (cleaner Bea), both set up and live, the landlord on both. */
async function twoProperties() {
  at = Date.parse("2026-10-14T13:00:00.000Z");
  open = await multiTenantApp({ now: clock });
  const m = open;
  const made = m.registry.create({ label: "Lane", twilioNumber: LINE }).tenant;
  const token = await m.join(made.id, "grok");
  const lane = m.registry.addProperty(made.id, "12 Scratch Lane");
  const court = m.registry.addProperty(made.id, "8 Scratch Court");
  m.registry.setFlow(made.id, lane.id, "cleaning", true);
  m.registry.setFlow(made.id, court.id, "cleaning", true);
  const h = hostedCleaner({ registry: m.registry, secrets: new TenantSecrets(m.app.root), dataRoot: m.app.root, origin: () => BASE, baseEnv: () => m.app.inst.env(), grantLive: () => true, now: clock, log: () => undefined });
  const primary = m.registry.primary(made.id, () => true)!;
  h.secrets.setForConnection(made.id, primary.grantId, { CLEANER_CORE_ROUTINE_URL: ROUTINE.url, CLEANER_CORE_ROUTINE_KEY: ROUTINE.token });
  h.secrets.set(made.id, { CLEANER_CORE_PIN_KEY: TEST_PIN_KEY });
  const desk = (p: Property) => {
    const ctx = propertyContext(h, m.registry.get(made.id)!, m.registry.get(made.id)!.properties.find((x) => x.id === p.id)!);
    return { desk: liveDeskFor(ctx.root, ctx.env, clock), root: ctx.root };
  };
  await withCaller({ assistant: "grok", connectionId: primary.grantId }, async () => {
    await setUp(desk(lane).desk, { groupChat: "cleaner-only" });
    await setUp(desk(court).desk, { cleaner: COURT_CLEANER, cleanerName: "Bea", groupChat: "cleaner-only" });
  });
  return { m, h, token, account: made, lane, court, desk };
}

const seen = (root: string) => (JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { seenInbound?: string[] }).seenInbound ?? [];
const bodiesTo = (m: MultiTenantApp, phone: string) => m.sms.sent.filter((s) => s.to === phone).map((s) => s.body);

describe("texts on the shared line", () => {
  it("each cleaner's YES, DONE and STOP reach only their own property", SLOW, async () => {
    const s = await twoProperties();
    await s.m.text(LINE, CLEANER, "YES", "SM-ana-yes");
    await s.m.text(LINE, COURT_CLEANER, "YES", "SM-bea-yes");
    await s.m.text(LINE, COURT_CLEANER, "STOP", "SM-bea-stop");
    expect(seen(s.desk(s.lane).root)).toContain("SM-ana-yes");
    expect(seen(s.desk(s.lane).root)).not.toContain("SM-bea-yes");
    expect(seen(s.desk(s.court).root)).toEqual(expect.arrayContaining(["SM-bea-yes", "SM-bea-stop"]));
    expect(seen(s.desk(s.court).root)).not.toContain("SM-ana-yes");
  });

  it("the landlord's STOP reaches both properties; one confirmation per property, each starting with its label", SLOW, async () => {
    const s = await twoProperties();
    const before = bodiesTo(s.m, HOST).length;
    await s.m.text(LINE, HOST, "STOP", "SM-host-stop");
    expect(seen(s.desk(s.lane).root)).toContain("SM-host-stop");
    expect(seen(s.desk(s.court).root)).toContain("SM-host-stop");
    const replies = bodiesTo(s.m, HOST).slice(before);
    expect(replies).toHaveLength(2);
    expect(replies.some((b) => b.startsWith("12 Scratch Lane: "))).toBe(true);
    expect(replies.some((b) => b.startsWith("8 Scratch Court: "))).toBe(true);
  });

  it("the landlord's one-to-one departure text releases nothing and gets the one reply, once in 12 hours", SLOW, async () => {
    const s = await twoProperties();
    await s.m.text(LINE, CLEANER, "YES", "SM-ana-yes");
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, HOST, "guests left", "SM-host-left");
    const after = s.m.sms.sent.slice(before);
    expect(after).toEqual([expect.objectContaining({ to: HOST, body: LANDLORD_USE_AGENT })]);
    expect(seen(s.desk(s.lane).root)).not.toContain("SM-host-left");
    expect(seen(s.desk(s.court).root)).not.toContain("SM-host-left");
    const check = JSON.stringify(await s.m.toolAt(PATH, s.token, "check_now", { property: s.lane.id }));
    expect(check).toContain("The host texted the line");
    await s.m.text(LINE, HOST, "guests left", "SM-host-left-2");
    expect(s.m.sms.sent.length).toBe(before + 1);
    at += 12 * 60 * 60_000 + 1;
    await s.m.text(LINE, HOST, "guests left", "SM-host-left-3");
    expect(s.m.sms.sent.slice(before + 1)).toEqual([expect.objectContaining({ to: HOST, body: LANDLORD_USE_AGENT })]);
  });

  it("an unknown sender gets nothing; their STOP holds when the phone is later saved", SLOW, async () => {
    const s = await twoProperties();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, STRANGER, "hello", "SM-stranger-hi");
    await s.m.text(LINE, STRANGER, "STOP", "SM-stranger-stop");
    expect(s.m.sms.sent.length).toBe(before);
    const saved = await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: HOST, cleaner: STRANGER, cleanerName: "Cy" });
    expect(saved.isError).toBe(false);
    await s.m.toolAt(PATH, s.token, "check_now", { property: s.court.id });
    expect(bodiesTo(s.m, STRANGER)).toEqual([]);
  });

  it("a cleaner's START lifts the line opt-out for good: saving people again doesn't bring it back", SLOW, async () => {
    const s = await twoProperties();
    await s.m.text(LINE, STRANGER, "STOP", "SM-stranger-stop");
    expect((await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: HOST, cleaner: STRANGER, cleanerName: "Cy" })).isError).toBe(false);
    await s.m.text(LINE, STRANGER, "START", "SM-stranger-start");
    expect((await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: HOST, cleaner: STRANGER, cleanerName: "Cy B" })).isError).toBe(false);
    const file = JSON.parse(readFileSync(join(s.desk(s.court).root, "cleaner-live.json"), "utf8")) as { lineOptOuts?: string[] };
    expect(file.lineOptOuts ?? []).not.toContain(STRANGER);
  });

  it("check_now with no property on a two-property account checks each property and names it", SLOW, async () => {
    const s = await twoProperties();
    const check = await s.m.toolAt(PATH, s.token, "check_now", {});
    expect(check.isError).toBe(false);
    const results = check.structured?.properties as { id: string; label: string }[];
    expect(results.map((r) => [r.id, r.label])).toEqual([
      [s.lane.id, "12 Scratch Lane"],
      [s.court.id, "8 Scratch Court"],
    ]);
  });

  it("check_now with Google events but no property is refused: one calendar belongs to one property", SLOW, async () => {
    const s = await twoProperties();
    const check = await s.m.toolAt(PATH, s.token, "check_now", { googleEvents: { timeZone: "America/New_York", items: [] } });
    expect(check.isError).toBe(true);
    expect(check.text).toContain("Which property?");
  });

  it("the landlord's STOP reaches a property added later, and START lifts it there too", SLOW, async () => {
    const s = await twoProperties();
    await s.m.text(LINE, HOST, "STOP", "SM-host-stop");
    const added = await s.m.toolAt(PATH, s.token, "add_property", { label: "9 Scratch Annex" });
    const id = (added.structured?.property as { id: string }).id;
    await s.m.toolAt(PATH, s.token, "set_flows", { property: id, cleaning: true });
    await s.m.toolAt(PATH, s.token, "get_state", { property: id, choice: "cleaners" });
    await s.m.toolAt(PATH, s.token, "save_property", { property: id, business: "Annex", address: "9 Scratch Annex, Teaneck, NJ 07666", timeZone: "America/New_York" });
    expect((await s.m.toolAt(PATH, s.token, "save_people", { property: id, host: HOST, cleaner: "+15555550142", cleanerName: "Dee" })).isError).toBe(false);
    const annex = s.m.registry.get(s.account.id)!.properties.find((p) => p.id === id)!;
    const optOuts = () => (JSON.parse(readFileSync(join(s.desk(annex).root, "cleaner-live.json"), "utf8")) as { lineOptOuts?: string[] }).lineOptOuts ?? [];
    expect(optOuts()).toContain(HOST);
    await s.m.text(LINE, HOST, "START", "SM-host-start");
    expect(optOuts()).not.toContain(HOST);
  });

  it("a stranger's STOP on a one-property account holds when a second property saves the phone", SLOW, async () => {
    at = Date.parse("2026-10-14T13:00:00.000Z");
    open = await multiTenantApp({ now: clock });
    const m = open;
    const made = m.registry.create({ label: "Lane", twilioNumber: LINE }).tenant;
    const token = await m.join(made.id, "grok");
    const lane = m.registry.addProperty(made.id, "12 Scratch Lane");
    m.registry.setFlow(made.id, lane.id, "cleaning", true);
    await m.text(LINE, STRANGER, "STOP", "SM-stranger-stop-1");
    const court = m.registry.addProperty(made.id, "8 Scratch Court");
    m.registry.setFlow(made.id, court.id, "cleaning", true);
    await m.toolAt(PATH, token, "get_state", { property: court.id, choice: "cleaners" });
    await m.toolAt(PATH, token, "save_property", { property: court.id, business: "Court", address: "8 Scratch Court, Teaneck, NJ 07666", timeZone: "America/New_York" });
    const savedCy = await m.toolAt(PATH, token, "save_people", { property: court.id, host: HOST, cleaner: STRANGER, cleanerName: "Cy" });
    expect(savedCy.isError, savedCy.text).toBe(false);
    // The account's people list keeps the STOP, for every property that saves the phone (saadvz/TourCore#190).
    const people = JSON.parse(readFileSync(join(m.app.root, "tenants", made.id, "people.json"), "utf8")) as PeopleFile;
    expect(people.people.find((p) => p.phone === STRANGER)?.stopped).toBeDefined();
    expect(people.people.find((p) => p.phone === STRANGER)?.where).toEqual([{ propertyId: court.id, role: "cleaner" }]);
  });

  it("a forged text changes nothing", SLOW, async () => {
    const s = await twoProperties();
    const fields = { MessageSid: "SM-forged", From: STRANGER, To: LINE, Body: "STOP", SmsStatus: "received" };
    const res = await s.m.twilio("/webhooks/twilio/cleaner-core", fields, "/somewhere-else");
    expect(res.status).toBe(403);
  });

  it("saving one property's cleaner on the other is refused, however the phone is typed", SLOW, async () => {
    const s = await twoProperties();
    // Without the host's shared: true (saadvz/TourCore#190).
    const taken = sharedRefusal([{ label: "12 Scratch Lane", role: "cleaner" }]);
    for (const cleaner of [CLEANER, "(555) 555-0131"]) {
      const refused = await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: HOST, cleaner, cleanerName: "Ana" });
      expect(refused).toMatchObject({ isError: true, text: taken });
    }
    const contact = await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: HOST, cleaner: COURT_CLEANER, cleanerName: "Bea", contacts: [{ name: "Ana", role: "observer", phone: CLEANER }] });
    expect(contact).toMatchObject({ isError: true, text: taken });
    const landlord = await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: COURT_CLEANER, cleaner: HOST, cleanerName: "Lou" });
    expect(landlord.isError).toBe(true);
    expect((await s.m.toolAt(PATH, s.token, "save_people", { property: s.court.id, host: HOST, cleaner: COURT_CLEANER, cleanerName: "Bea" })).isError).toBe(false);
  });

  it("no text to a cleaner contains the other property's label or address", SLOW, async () => {
    const s = await twoProperties();
    await s.m.text(LINE, CLEANER, "YES", "SM-ana-yes");
    await s.m.text(LINE, COURT_CLEANER, "YES", "SM-bea-yes");
    await s.m.text(LINE, HOST, "STOP", "SM-host-stop");
    await s.m.text(LINE, CLEANER, "YES", "SM-ana-yes-2");
    for (const body of bodiesTo(s.m, COURT_CLEANER)) {
      expect(body).not.toContain("12 Scratch Lane");
    }
    for (const body of bodiesTo(s.m, CLEANER)) expect(body).not.toContain("8 Scratch Court");
    expect(bodiesTo(s.m, CLEANER).length).toBeGreaterThan(0);
    expect(bodiesTo(s.m, COURT_CLEANER).length).toBeGreaterThan(0);
  });

  it("a new property starts with the account's routine connected", SLOW, async () => {
    const s = await twoProperties();
    const added = await s.m.toolAt(PATH, s.token, "add_property", { label: "9 Scratch Annex" });
    const id = (added.structured?.property as { id: string }).id;
    await s.m.toolAt(PATH, s.token, "set_flows", { property: id, cleaning: true });
    const annex = s.m.registry.get(s.account.id)!.properties.find((p) => p.id === id)!;
    expect(s.desk(annex).desk.routineConnectionIds()).toEqual(s.desk(s.lane).desk.routineConnectionIds());
    expect(s.desk(annex).desk.routineConnectionIds().length).toBeGreaterThan(0);
  });
});

void LANE_ADDRESS;
