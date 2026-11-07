import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lineStartText, lineStopText, whichPropertyText } from "../src/hosted/sharedRoute";
import { closeHostedApps } from "./cleanerOauthHarness";
import { filesUnder } from "./files";
import { CLEANER, COURT, INVITE, LANDLORD, LANE, LINE, sharedAccount, type SharedAccount } from "./sharedHarness";

/**
 * The issue's done-when (saadvz/TourCore#190): one cleaner on two properties of one account, after the
 * host's shared: true, through a whole turnover on each. Nothing they receive names, hints at, or
 * carries the other property's address, label or door code. Only 555 numbers; the door codes are the
 * made-up Scratch pins. The labels are the host's own names, so no text to the cleaner may use them.
 */

const SLOW = 300_000;
const LANE_LABEL = "Beach House";
const COURT_LABEL = "Cottage";
const LANE_STREET = "12 Scratch Lane";
const COURT_STREET = "8 Scratch Court";
const ASK = whichPropertyText([
  { id: "lane", label: LANE_LABEL, address: LANE.property.address },
  { id: "court", label: COURT_LABEL, address: COURT.property.address },
]);

let s: SharedAccount;
let lane: string;
let court: string;
/** Texts to the cleaner before Court shared them, and after. */
let before: string[];
let after: string[];
let laneStopped: boolean;

beforeAll(async () => {
  s = await sharedAccount();
  lane = await s.liveProperty(LANE_LABEL, LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  court = await s.add(COURT_LABEL);
  await s.startProperty(court, COURT);
  await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only", shared: true });
  before = s.bodiesTo(CLEANER);
  await s.finishProperty(court, COURT);

  // The YES to Lane's invite opts Ana in on both; each property's offer goes out.
  await s.m.text(LINE, CLEANER, "YES", "SM-opt-in");
  // Both offers wait on Ana: her YES is asked about, and her answer takes Lane's.
  await s.m.text(LINE, CLEANER, "YES", "SM-take-1");
  await s.m.text(LINE, CLEANER, "1", "SM-answer-1");
  // Only Court's offer waits now: her YES goes there.
  await s.m.text(LINE, CLEANER, "YES", "SM-take-2");
  // The landlord says the guests left, through the agent, one property at a time.
  for (const property of [lane, court]) await s.tool("mark_guests_left", { property, confirmed: true });
  // Both cleanings are under way: DONE is asked about, the answer finishes Court, then DONE finishes Lane.
  await s.m.text(LINE, CLEANER, "DONE", "SM-done-1");
  await s.m.text(LINE, CLEANER, "8 Scratch Court", "SM-answer-2");
  await s.m.text(LINE, CLEANER, "DONE", "SM-done-2");
  await s.m.text(LINE, CLEANER, "HELP", "SM-help");
  await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
  laneStopped = s.peopleFile()!.people.find((p) => p.phone === CLEANER)?.stopped !== undefined;
  await s.m.text(LINE, CLEANER, "START", "SM-start");
  after = s.bodiesTo(CLEANER).slice(before.length);
}, SLOW);

afterAll(() => {
  s?.m.close();
  closeHostedApps();
});

describe("one cleaner on two properties of one account", () => {
  it("each turnover is taken and finished on its own property", () => {
    expect(s.seen(lane)).toEqual(expect.arrayContaining(["SM-opt-in", "SM-take-1", "SM-done-2"]));
    expect(s.seen(court)).toEqual(expect.arrayContaining(["SM-take-2", "SM-done-1"]));
    for (const id of ["SM-take-2", "SM-done-1"]) expect(s.seen(lane)).not.toContain(id);
    for (const id of ["SM-opt-in", "SM-take-1", "SM-done-2"]) expect(s.seen(court)).not.toContain(id);
    for (const id of ["SM-answer-1", "SM-answer-2", "SM-help", "SM-stop", "SM-start"]) {
      expect(s.seen(lane)).not.toContain(id);
      expect(s.seen(court)).not.toContain(id);
    }
  });

  it("one invite only, from Lane, before Court shared them", () => {
    expect([...before, ...after].filter((b) => b.includes(INVITE))).toHaveLength(1);
    expect(before.some((b) => b.includes(INVITE))).toBe(true);
  });

  it("every text after sharing names its own property, or is the ask or the line's own reply", () => {
    const allowed = new Set([ASK, lineStopText("Scratch"), lineStartText("Scratch")]);
    for (const body of after) expect(body.startsWith(`${LANE_STREET}: `) || body.startsWith(`${COURT_STREET}: `) || allowed.has(body), body).toBe(true);
    expect(after.filter((b) => b === ASK)).toHaveLength(2);
    expect(after.filter((b) => b === lineStopText("Scratch"))).toHaveLength(1);
    expect(after.filter((b) => b === lineStartText("Scratch"))).toHaveLength(1);
    expect(laneStopped).toBe(true);
  });

  it("no text about one property carries the other's address, street or door code", () => {
    for (const body of after) {
      if (body.startsWith(`${LANE_STREET}: `)) {
        for (const other of [COURT.pin, COURT_STREET, "Scratch Court", COURT.property.address]) expect(body, body).not.toContain(other);
      }
      if (body.startsWith(`${COURT_STREET}: `)) {
        for (const other of [LANE.pin, LANE_STREET, "Scratch Lane", LANE.property.address]) expect(body, body).not.toContain(other);
      }
    }
  });

  it("no text to the cleaner uses either label, and the ask names only their own two properties", () => {
    for (const body of [...before, ...after]) {
      expect(body).not.toContain(LANE_LABEL);
      expect(body).not.toContain(COURT_LABEL);
    }
    expect(ASK).toBe("Which property is this about? Reply 1 for 12 Scratch Lane or 2 for 8 Scratch Court.");
  });

  it("each door code goes once, to the cleaner, about its own property", () => {
    const lanePins = after.filter((b) => b.includes(LANE.pin));
    const courtPins = after.filter((b) => b.includes(COURT.pin));
    expect(lanePins).toHaveLength(1);
    expect(courtPins).toHaveLength(1);
    expect(lanePins[0]!.startsWith(`${LANE_STREET}: `)).toBe(true);
    expect(courtPins[0]!.startsWith(`${COURT_STREET}: `)).toBe(true);
    for (const sent of s.m.sms.sent.filter((x) => x.body.includes(LANE.pin) || x.body.includes(COURT.pin))) expect(sent.to).toBe(CLEANER);
  });

  it("neither door code is in any saved file", () => {
    for (const file of filesUnder(s.m.app.root)) {
      const text = readFileSync(file, "utf8").replace(/[A-Za-z0-9+/]{16,}={0,2}/g, " ").replace(/[0-9a-f-]{16,}/gi, " ").replace(/\d{10,}/g, " ");
      expect(text.includes(`"${LANE.pin}"`) || text.includes(`"${COURT.pin}"`), file).toBe(false);
    }
  });
});
