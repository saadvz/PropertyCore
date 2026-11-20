import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAirbnbEmail } from "../src/hub/airbnbEmail";
import { appendBookingEmail } from "../src/hub/bookingEmails";
import { stayCheckDeskFor } from "../src/stay-check/desk";
import type { StayEvent } from "../src/stay-check/events";
import type { HouseRule } from "../src/stay-check/rules";
import { readStayCheck, writeStayCheck } from "../src/stay-check/store";

/** #239: one property's desk picks the night, the booking and the window. Made-up property, made-up booking. */

const NOW = new Date("2026-11-17T15:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Stay = { checkIn: string; checkout: string; kind: "stay" | "block" };
const STAY: Stay = { checkIn: "2026-11-20", checkout: "2026-11-23", kind: "stay" };

function property(opts: { stays?: Stay[]; timeZone?: string | null; rules?: HouseRule[]; checkTime?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stay-check-desk-"));
  roots.push(root);
  const timeZone = opts.timeZone === null ? {} : { timeZone: opts.timeZone ?? "America/New_York" };
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Lake House", ...timeZone, checkInTime: "15:00", checkoutTime: "10:00" }, calendars: [], stays: opts.stays ?? [STAY] }));
  if (opts.rules) writeStayCheck(root, { rules: opts.rules, ...(opts.checkTime ? { checkTime: opts.checkTime } : {}), sightings: {}, allowances: [] });
  return { root, desk: stayCheckDeskFor(root, { now: () => NOW }) };
}

function booking(root: string, opts: { checkIn: string; checkInTime: string; checkout: string; guests: string }) {
  const at = "2026-11-10T15:00:00.000Z";
  const body = [
    "New booking confirmed! Robin arrives soon.",
    "",
    "Robin Example",
    "",
    "Lake House on the Pond",
    "Entire home/apt",
    "",
    "Check-in",
    opts.checkIn,
    opts.checkInTime,
    "",
    "Checkout",
    opts.checkout,
    "10:00 AM",
    "",
    "Guests",
    opts.guests,
    "",
    "Confirmation code",
    "HMTEST5550",
    "",
  ].join("\n");
  const email = { from: "Airbnb <automated@airbnb.com>", subject: "Reservation confirmed - Robin Example arrives Nov 20", body, messageId: "<desk@example.test>", receivedAt: at };
  const read = parseAirbnbEmail(email, new Date(at));
  if (!read.ok) throw new Error(`sample email didn't parse: ${read.reason}`);
  appendBookingEmail(root, { at, receivedAt: at, messageId: email.messageId, from: email.from, subject: email.subject, body, parsed: read.parsed, outcome: "applied" });
}

const MAX6: HouseRule = { text: "No more than 6 guests", check: { kind: "people", max: 6 } };
const BOOKED: HouseRule = { text: "Only the guests on the booking", check: { kind: "people" } };
const camera = (at: string, people: number): StayEvent => ({ id: at, at, source: "camera", device: "Front door", counts: { people } });

describe("the stay check desk", () => {
  it("skips with no rules", () => {
    const { desk } = property({ rules: [{ text: "No smoking" }] });
    expect(desk.runNight("2026-11-21", [camera("2026-11-22T01:00:00Z", 12)], "Lake House").status).toBe("skipped");
    expect(property().desk.runNight("2026-11-21", [], "Lake House").status).toBe("skipped");
  });

  it("skips with no stay that night", () => {
    const { desk } = property({ rules: [MAX6] });
    expect(desk.runNight("2026-11-23", [camera("2026-11-24T01:00:00Z", 12)], "Lake House").status).toBe("skipped");
    expect(desk.nightWindow("2026-11-23")).toBeUndefined();
  });

  it("skips with no time zone", () => {
    const { desk } = property({ rules: [MAX6], timeZone: null });
    expect(desk.runNight("2026-11-21", [camera("2026-11-22T01:00:00Z", 12)], "Lake House").status).toBe("skipped");
  });

  it("skips a block", () => {
    const { desk } = property({ rules: [MAX6], stays: [{ ...STAY, kind: "block" }] });
    expect(desk.runNight("2026-11-21", [camera("2026-11-22T01:00:00Z", 12)], "Lake House").status).toBe("skipped");
  });

  it("the window runs check time to check time", () => {
    const { desk } = property({ rules: [MAX6] });
    expect(desk.nightWindow("2026-11-21")).toEqual({ from: "2026-11-21T04:00:00.000Z", to: "2026-11-22T04:00:00.000Z" });
    const flagged = desk.runNight("2026-11-21", [camera("2026-11-22T01:00:00Z", 9)], "Lake House");
    expect(flagged.status).toBe("flags");
    expect(desk.runNight("2026-11-21", [camera("2026-11-22T05:00:00Z", 9)], "Lake House").status).toBe("clean");
  });

  it("check-in night starts at check-in", () => {
    const { root, desk } = property({ rules: [MAX6] });
    expect(desk.nightWindow("2026-11-20")?.from).toBe("2026-11-20T20:00:00.000Z");
    booking(root, { checkIn: "Fri, Nov 20", checkInTime: "4:30 PM", checkout: "Mon, Nov 23", guests: "4 adults" });
    expect(desk.nightWindow("2026-11-20")?.from).toBe("2026-11-20T21:30:00.000Z");
  });

  it("the last night ends at checkout", () => {
    const { desk } = property({ rules: [MAX6] });
    expect(desk.nightWindow("2026-11-22")).toEqual({ from: "2026-11-22T04:00:00.000Z", to: "2026-11-23T15:00:00.000Z" });
  });

  it("one-night stay starts at check-in and ends at checkout", () => {
    const { desk } = property({ rules: [MAX6], stays: [{ checkIn: "2026-11-20", checkout: "2026-11-21", kind: "stay" }] });
    expect(desk.nightWindow("2026-11-20")).toEqual({ from: "2026-11-20T20:00:00.000Z", to: "2026-11-21T15:00:00.000Z" });
  });

  it("a check time before noon belongs to the night before", () => {
    const { desk } = property({ rules: [MAX6], checkTime: "02:00" });
    expect(desk.nightWindow("2026-11-21")).toEqual({ from: "2026-11-21T07:00:00.000Z", to: "2026-11-22T07:00:00.000Z" });
  });

  it("a check time between noon and check-in never counts turnover", () => {
    const { desk } = property({ rules: [MAX6], checkTime: "14:00" });
    expect(desk.nightWindow("2026-11-21")?.from).toBe("2026-11-20T20:00:00.000Z");
    const first = desk.nightWindow("2026-11-20");
    expect(first && first.from <= first.to).toBe(true);
    expect(desk.runNight("2026-11-21", [camera("2026-11-20T19:30:00Z", 12)], "Lake House").status).toBe("clean");
  });

  it("a check is saved with its known fields only", () => {
    const { root, desk } = property();
    expect(desk.saveRules({ rules: [{ text: "No pets", check: { kind: "pets", note: "kept out" } }, { text: "Two cars", check: { kind: "vehicles", max: 2, extra: 1 } }] }).isError).toBe(false);
    expect(readStayCheck(root).rules.map((rule) => rule.check)).toEqual([{ kind: "pets" }, { kind: "vehicles", max: 2 }]);
  });

  it("allowForStay refuses an impossible date and notes a stay it can't find", () => {
    const { desk } = property();
    expect(desk.allowForStay({ checkIn: "2026-02-31", allow: ["pets"] }).isError).toBe(true);
    const unmatched = desk.allowForStay({ checkIn: "2026-12-05", allow: ["pets"] });
    expect(unmatched.isError).toBe(false);
    expect(String(unmatched.structured?.next)).toContain("No stay on the calendar checks in");
    expect(String(desk.allowForStay({ checkIn: "2026-11-20", allow: ["pets"] }).structured?.next)).not.toContain("No stay on the calendar");
  });

  it("the booking's guests and infants reach the check", () => {
    const { root, desk } = property({ rules: [BOOKED] });
    booking(root, { checkIn: "Fri, Nov 20", checkInTime: "3:00 PM", checkout: "Mon, Nov 23", guests: "2 adults, 1 infant" });
    expect(desk.runNight("2026-11-21", [camera("2026-11-22T01:00:00Z", 3)], "Lake House").status).toBe("clean");
    const result = desk.runNight("2026-11-21", [camera("2026-11-22T01:00:00Z", 4)], "Lake House");
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ kind: "people", allowed: 3, basis: "booking" });
  });

  it("a pet on the booking reaches the check", () => {
    const { root, desk } = property({ rules: [{ text: "No pets", check: { kind: "pets" } }] });
    booking(root, { checkIn: "Fri, Nov 20", checkInTime: "3:00 PM", checkout: "Mon, Nov 23", guests: "2 adults, 1 pet" });
    const dog: StayEvent = { id: "d", at: "2026-11-22T01:00:00Z", source: "camera", device: "Back deck", counts: { animals: 1 } };
    expect(desk.runNight("2026-11-21", [dog], "Lake House")).toMatchObject({ status: "clean", unchecked: [{ kind: "pets", why: "The stay was booked with a pet." }] });
  });

  it("a flag the host marks false needs one more sighting, up to 3, and never changes an allowed number", () => {
    const { root, desk } = property({ rules: [MAX6] });
    expect(desk.markFlagFalse({ kind: "people" })).toMatchObject({ isError: false, structured: { kind: "people", sightingsNeeded: 2 } });
    desk.markFlagFalse({ kind: "people" });
    expect(desk.markFlagFalse({ kind: "people" }).structured).toMatchObject({ sightingsNeeded: 3 });
    expect(readStayCheck(root).sightings).toEqual({ people: 3 });
    expect(readStayCheck(root).rules).toEqual([MAX6]);
    expect(desk.markFlagFalse({ kind: "parties" }).isError).toBe(true);
  });

  it("an allowance for the stay reaches the check", () => {
    const { root, desk } = property({ rules: [{ text: "No pets", check: { kind: "pets" } }] });
    const dog: StayEvent = { id: "d", at: "2026-11-22T01:00:00Z", source: "camera", device: "Back deck", counts: { animals: 1 } };
    expect(desk.runNight("2026-11-21", [dog], "Lake House").status).toBe("flags");
    expect(desk.allowForStay({ checkIn: "2026-11-20", allow: ["pets"] }).isError).toBe(false);
    expect(desk.runNight("2026-11-21", [dog], "Lake House")).toMatchObject({ status: "clean", unchecked: [{ kind: "pets" }] });
    expect(readStayCheck(root).allowances).toEqual([{ checkIn: "2026-11-20", allow: ["pets"] }]);
  });

  it("getRules asks with examples when none are saved", () => {
    const reply = property().desk.getRules();
    expect(reply.isError).toBe(false);
    expect(reply.structured?.rules).toEqual([]);
    expect(String(reply.structured?.ask)).toContain("No more than 6 guests");
    expect(String(reply.structured?.ask)).toContain("No pets");
  });

  it("saves and reads the host's rules and check time", () => {
    const { root, desk } = property();
    const saved = desk.saveRules({ rules: [MAX6, { text: "No smoking" }], checkTime: "22:30" });
    expect(saved.isError).toBe(false);
    expect(readStayCheck(root)).toMatchObject({ rules: [MAX6, { text: "No smoking" }], checkTime: "22:30", rulesSavedAt: NOW.toISOString() });
    expect(desk.getRules().structured).toMatchObject({ rules: [MAX6, { text: "No smoking" }], checkTime: "22:30", allowances: [] });
    expect(desk.saveRules({ rules: [{ text: `Gate ${["4", "8", "2", "1"].join("")}` }] }).isError).toBe(true);
    expect(readStayCheck(root).rules).toHaveLength(2);
    expect(desk.saveRules({ checkTime: "11 PM" }).isError).toBe(true);
    expect(desk.saveRules({}).isError).toBe(true);
  });

  it("allowForStay saves and removes", () => {
    const { root, desk } = property();
    expect(desk.allowForStay({ checkIn: "2026-11-20", allow: ["pets"] }).isError).toBe(false);
    expect(desk.allowForStay({ checkIn: "2026-11-20", allow: ["pets", "people"] }).isError).toBe(false);
    expect(readStayCheck(root).allowances).toEqual([{ checkIn: "2026-11-20", allow: ["pets", "people"] }]);
    expect(desk.allowForStay({ checkIn: "2026-11-20", allow: [] }).isError).toBe(false);
    expect(readStayCheck(root).allowances).toEqual([]);
    expect(desk.allowForStay({ checkIn: "Nov 20", allow: ["pets"] }).isError).toBe(true);
    expect(desk.allowForStay({ checkIn: "2026-11-20", allow: ["smoke"] }).isError).toBe(true);
  });

  it("a broken record is a plain refusal and stays as it was", () => {
    const { root, desk } = property();
    writeFileSync(join(root, "stay-check.json"), "{not json");
    expect(desk.getRules().isError).toBe(true);
    expect(desk.saveRules({ rules: [MAX6] }).isError).toBe(true);
    expect(desk.runNight("2026-11-21", [], "Lake House").status).toBe("skipped");
  });
});
