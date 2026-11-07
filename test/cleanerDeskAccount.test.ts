import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks, liveDeskFor, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { peopleFor, type PersonChange } from "../src/hub/people";
import { cleanupDesks, LOCK, ok, openDeskAt, PIN_KEY, ROUTINE, ZONE } from "./cleanerDeskHarness";
import { BUSINESS, CALENDAR_URL, CLEANER, DOOR_CODE, fakeSms, HOST } from "./wiringProof";

/**
 * A desk on an account reads the account's opt-in and STOP, and reports its own (saadvz/TourCore#190).
 * One cleaner on two properties of one account. Only 555 numbers; the door code is made up.
 */

const LANE = "12 Practice Lane, Teaneck, NJ 07666";
const COURT = "8 Practice Court, Teaneck, NJ 07666";
const A = "prp_aaaaaaaaaa";
const B = "prp_bbbbbbbbbb";
const INVITE = "Reply YES to get cleaning texts";

afterEach(() => cleanupDesks());

async function setUpAt(desk: LiveDesk, address: string) {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, address, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
}

/** Two properties of one account, with the cleaner on both in the account list (or only on Lane). */
async function account(options: { both?: boolean; skipCourt?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "account-desks-"));
  const accountRoot = join(base, "tenants", "tnt_lane000001");
  const rootA = join(accountRoot, "properties", A);
  const rootB = join(accountRoot, "properties", B);
  const people = peopleFor(accountRoot, { now: () => new Date("2026-10-14T13:00:00.000Z") });
  people.savePropertyPeople(A, HOST, [{ phone: CLEANER, role: "cleaner", name: "Ana" }]);
  if (options.both !== false) people.savePropertyPeople(B, HOST, [{ phone: CLEANER, role: "cleaner", name: "Ana" }]);
  const sms = fakeSms();
  const a = openDeskAt(rootA, [HOST, CLEANER], "0", undefined, sms);
  await setUpAt(a.desk, LANE);
  const b = openDeskAt(rootB, [HOST, CLEANER], "0", undefined, sms);
  if (!options.skipCourt) await setUpAt(b.desk, COURT);
  return { people, sms, a, b, rootA, rootB };
}

const toCleaner = (sms: ReturnType<typeof fakeSms>) => sms.sent.filter((s) => s.to === CLEANER).map((s) => s.body);

describe("a desk on an account", () => {
  it("holds its invite while another property's is out", async () => {
    const s = await account();
    const invites = toCleaner(s.sms).filter((body) => body.includes(INVITE));
    expect(invites).toHaveLength(1);
    expect(invites[0]).toContain("12 Practice Lane");
  });

  it("reports the cleaner's YES to the account, for every property they're on", async () => {
    const s = await account();
    const seen: PersonChange[] = [];
    s.people.onChange(async (change) => void seen.push(change));
    await s.a.desk.inbound({ id: "SM-yes", from: CLEANER, text: "YES" });
    expect(s.people.optedIn(CLEANER)).toBe(true);
    expect(seen).toEqual([{ phone: CLEANER, kind: "opted-in", from: A, properties: [A, B] }]);
  });

  it("a desk opened after the YES finds the cleaner opted in, with no invite of its own", async () => {
    const s = await account();
    await s.a.desk.inbound({ id: "SM-yes", from: CLEANER, text: "YES" });
    const before = toCleaner(s.sms).length;
    resetLiveDesks();
    const court = liveDeskFor(s.rootB, () => s.b.env, s.b.now);
    ok(await court.checkNow());
    const after = toCleaner(s.sms).slice(before);
    expect(after.some((body) => body.includes(INVITE))).toBe(false);
    expect(after.some((body) => body.includes("8 Practice Court"))).toBe(true);
    expect(after.some((body) => body.includes("12 Practice Lane") && !body.startsWith("8 Practice Court: "))).toBe(false);
  });

  it("a STOP on the account blocks every text to the cleaner, and the door code throws", async () => {
    const s = await account();
    await s.a.desk.inbound({ id: "SM-yes", from: CLEANER, text: "YES" });
    await s.a.desk.inbound({ id: "SM-take", from: CLEANER, text: "YES" });
    s.people.stop(CLEANER);
    const before = toCleaner(s.sms).length;
    await s.a.desk.inbound({ id: "SM-hi", from: CLEANER, text: "what time?" });
    await s.a.desk.markGuestsLeft({ confirmed: true }, PIN_KEY);
    ok(await s.b.desk.checkNow());
    expect(toCleaner(s.sms).slice(before)).toEqual([]);
    expect(toCleaner(s.sms).some((body) => body.includes(DOOR_CODE))).toBe(false);
  });

  it("until the account's move runs, a STOP kept in the desk's older list still blocks every text", async () => {
    const s = await account();
    await s.a.desk.inbound({ id: "SM-yes", from: CLEANER, text: "YES" });
    expect(s.people.moved()).toBe(false);
    const file = join(s.rootA, "cleaner-live.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...doc, lineOptOuts: [CLEANER] }));
    resetLiveDesks();
    const lane = liveDeskFor(s.rootA, () => s.a.env, s.a.now);
    const before = toCleaner(s.sms).length;
    await lane.inbound({ id: "SM-take", from: CLEANER, text: "running late" });
    await lane.markGuestsLeft({ confirmed: true }, PIN_KEY);
    expect(toCleaner(s.sms).slice(before)).toEqual([]);
  });

  it("a desk opened after a STOP sends nothing to the cleaner", async () => {
    const s = await account();
    s.people.stop(CLEANER);
    const before = toCleaner(s.sms).length;
    resetLiveDesks();
    const court = liveDeskFor(s.rootB, () => s.b.env, s.b.now);
    ok(await court.checkNow());
    expect(toCleaner(s.sms).slice(before)).toEqual([]);
  });

  it("a one-to-one text to someone on two properties starts with the street of the property it's about", async () => {
    const s = await account();
    const lane = toCleaner(s.sms).filter((body) => body.includes(INVITE));
    expect(lane[0]!.startsWith("12 Practice Lane: ")).toBe(true);
    for (const body of s.sms.sent.filter((t) => t.to === HOST).map((t) => t.body)) expect(body.startsWith("12 Practice Lane: ")).toBe(false);
  });

  it("someone on one property gets no prefix", async () => {
    const s = await account({ both: false, skipCourt: true });
    const lane = toCleaner(s.sms).filter((body) => body.includes(INVITE));
    expect(lane).toHaveLength(1);
    expect(lane[0]!.startsWith("12 Practice Lane: ")).toBe(false);
  });

  it("moveSource lists the desk's people and the engine's consent", async () => {
    const s = await account();
    await s.a.desk.inbound({ id: "SM-yes", from: CLEANER, text: "YES" });
    expect(await s.a.desk.moveSource()).toEqual({ propertyId: A, host: HOST, people: [{ phone: CLEANER, role: "cleaner", name: "Ana" }], stopped: [], optedIn: [CLEANER], optedOut: [] });
  });
});
