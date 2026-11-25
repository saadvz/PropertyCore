import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDay } from "../src/oversight/check";
import { entryNamesFrom, standingNames } from "../src/oversight/evidence";
import type { OversightFile } from "../src/oversight/store";
import { visitWindow, wantedVisitCodes } from "../src/oversight/visitCodes";
import type { ExpectedVisit } from "../src/oversight/visits";
import { entryEventsFrom, type VisitEvent } from "../src/visits/events";

/** #280 item 17: which expected visits want their own door code now, and how its unlocks are named. Pure; 555 numbers only. */

const NY = "America/New_York";
const MIKE = "+15555550161";
const OCCUPY = { timeZone: NY, checkInTime: "16:00", checkoutTime: "11:00", checkInBufferMinutes: 60 };
const iso = (local: string, day = "19") => new Date(`2026-11-${day}T${local}:00.000-05:00`).toISOString();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function visit(extra: Partial<ExpectedVisit> = {}): ExpectedVisit {
  return { id: "v-0000aaaa", who: "Mike Doyle", date: "2026-11-19", from: "12:00", to: "17:00", source: "text", savedAt: iso("09:00", "17"), phone: MIKE, ...extra };
}

const file = (...visits: ExpectedVisit[]): OversightFile => ({ visits, visitors: [{ phone: MIKE, name: "Mike Doyle", addedAt: iso("09:00", "17"), yesAt: iso("09:05", "17") }] });
const base = { now: new Date(iso("08:00")), timeZone: NY, stays: [], occupy: OCCUPY, mayHaveCode: () => true };

describe("visitWindow", () => {
  it("a timed visit's code runs from 30 minutes before to its end", () => {
    expect(visitWindow(visit(), { timeZone: NY, stays: [], occupy: OCCUPY })).toEqual({ from: iso("11:30"), until: iso("17:00") });
  });

  it("an all-day visit's code runs 8 AM to 8 PM", () => {
    const allDay = visit({ from: undefined, to: undefined });
    expect(visitWindow(allDay, { timeZone: NY, stays: [], occupy: OCCUPY })).toEqual({ from: iso("08:00"), until: iso("20:00") });
  });

  it("no code inside a guest stay, and the end is cut at the next check-in", () => {
    // A guest checks in on the 19th at 16:00, buffer 60 minutes: busy from 15:00.
    const arriving = [{ checkIn: "2026-11-19", checkout: "2026-11-21", kind: "stay" as const }];
    expect(visitWindow(visit(), { timeZone: NY, stays: arriving, occupy: OCCUPY })).toEqual({ from: iso("11:30"), until: iso("15:00") });
    // Inside the stay: no code at all.
    expect(visitWindow(visit({ date: "2026-11-20" }), { timeZone: NY, stays: arriving, occupy: OCCUPY })).toBe("during-stay");
    // A guest who checks out at 11:00 that day: the all-day code starts once they're gone.
    const leaving = [{ checkIn: "2026-11-16", checkout: "2026-11-19", kind: "stay" as const }];
    expect(visitWindow(visit({ from: undefined, to: undefined }), { timeZone: NY, stays: leaving, occupy: OCCUPY })).toEqual({ from: iso("11:00"), until: iso("20:00") });
  });
});

describe("wantedVisitCodes", () => {
  it("wants the visitor's own code for the visit, named as a visitor's", () => {
    expect(wantedVisitCodes(file(visit()), base)).toEqual({
      wanted: [{ jobId: "v-0000aaaa", person: MIKE, window: { from: iso("11:30"), until: iso("17:00") }, label: "Mike Doyle", who: { role: "visitor" } }],
      duringStay: [],
    });
  });

  it("none for a cancelled visit, a visit with no phone, a visit that's over, or a person who can't have one", () => {
    expect(wantedVisitCodes(file(visit({ cancelledAt: iso("10:00", "18") })), base).wanted).toEqual([]);
    expect(wantedVisitCodes(file(visit({ phone: undefined })), base).wanted).toEqual([]);
    expect(wantedVisitCodes(file(visit()), { ...base, now: new Date(iso("17:00")) }).wanted).toEqual([]);
    expect(wantedVisitCodes(file(visit()), { ...base, mayHaveCode: (item) => item.phone !== MIKE }).wanted).toEqual([]);
  });

  it("asks per visit, so a host's yes for one visit never opens another for the same phone", () => {
    const yes = visit({ id: "v-0000bbbb", confirmed: { at: iso("09:10", "17"), by: "host", via: "call" } });
    const other = visit({ id: "v-0000cccc", date: "2026-11-20" });
    const wanted = wantedVisitCodes(file(yes, other), { ...base, mayHaveCode: (item) => Boolean(item.confirmed) }).wanted;
    expect(wanted.map((item) => item.jobId)).toEqual(["v-0000bbbb"]);
  });

  it("a visit that falls inside a stay is listed, with no code", () => {
    const stays = [{ checkIn: "2026-11-18", checkout: "2026-11-21", kind: "stay" as const }];
    expect(wantedVisitCodes(file(visit()), { ...base, stays })).toEqual({ wanted: [], duringStay: ["v-0000aaaa"] });
    // Once the visit's day is over it isn't listed again.
    expect(wantedVisitCodes(file(visit()), { ...base, stays, now: new Date(iso("17:30")) }).duringStay).toEqual([]);
  });
});

describe("the visitor's unlocks are named (#240's same-day check)", () => {
  it("an unlock with a visit code names the visitor for the same-day check", () => {
    const root = mkdtempSync(join(tmpdir(), "visit-codes-"));
    roots.push(root);
    writeFileSync(join(root, "door-grants.json"), JSON.stringify({ grants: [{ flow: "visit", codeName: "Visit abcdefgh", label: "Mike Doyle" }] }));
    const events: VisitEvent[] = [{ type: "lock", id: "u1", at: iso("12:10"), device: "Front door", action: "unlock", codeName: "Visit abcdefgh" }];
    const entries = entryEventsFrom(events, { "Visit abcdefgh": { role: "visitor" } }, entryNamesFrom(events, standingNames(root)));
    expect(entries).toEqual([expect.objectContaining({ person: "Mike Doyle" })]);
    const day = checkDay({ label: "the test property", visits: [visit()], date: "2026-11-19", timeZone: NY, now: new Date(iso("18:30")), entries });
    expect(day.status).toBe("ok");
    expect(day.status === "ok" && day.visits[0]!.outcome).toBe("came");
  });
});
