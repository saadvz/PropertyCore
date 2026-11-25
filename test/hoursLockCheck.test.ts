import { afterEach, describe, expect, it } from "vitest";
import { buildMonth, type Month } from "../src/hours-log/month";
import { readRecords } from "../src/hours-log/sources";
import type { LockEvent } from "../src/visits/events";
import { VisitLog } from "../src/visits/store";
import { octoberFolder, type Fixture } from "./hoursFixture";

/**
 * #238: the month checked against the lock events, both ways. Fake lock events and made-up code names only;
 * no door code anywhere.
 */

let open: Fixture | undefined;
afterEach(() => {
  open?.cleanup();
  open = undefined;
});

const CODES = {
  "Ana cleaning": { role: "cleaner" },
  "Drip Plumbing": { role: "pro", proId: "pro_drip" },
  "Sam standing": { role: "host" },
  "Guest Lee": { role: "guest" },
  "Visitor Kim": { role: "visitor" },
  "Packages": { role: "package" },
  "Family": { role: "shared" },
};

let n = 0;
const unlock = (at: string, codeName?: string, extra: Partial<LockEvent> = {}): LockEvent => ({ type: "lock", id: `evt-${++n}`, at, device: "Front door", action: "unlock", side: "outside", ...(codeName ? { codeName } : {}), ...extra });

/** October with a lock connected since Sep 30, the code names above, and these lock events. */
function october(events: LockEvent[], options: { connected?: boolean } = {}): Month {
  open = octoberFolder();
  open.write("visit-codes.json", { codes: CODES });
  const log = new VisitLog(open.root, () => new Date("2026-11-01T12:00:00.000Z"));
  log.append({ type: "lock-connection", id: "conn-1", at: "2026-09-30T12:00:00.000Z", connected: options.connected ?? true });
  for (const event of events) log.append(event);
  return buildMonth(readRecords(open.root), "2026-10", {});
}

const checked = (month: Month) => {
  if (month.reconcile.lockEvents.status !== "checked") throw new Error("not checked");
  return month.reconcile.lockEvents;
};

// The Oct 4 cleaning runs 15:05Z to 17:35Z; the Oct 12 one 15:00Z to 17:00Z; Drip Plumbing's Oct 8 visit 13:00Z to 15:00Z.
const AT_VISITS = [unlock("2026-10-04T15:00:00.000Z", "Ana cleaning"), unlock("2026-10-12T14:55:00.000Z", "Ana cleaning"), unlock("2026-10-08T12:50:00.000Z", "Drip Plumbing"), unlock("2026-10-15T12:58:00.000Z")];

describe("the month against the lock events", () => {
  it("is no-lock on a property with no visit log", () => {
    open = octoberFolder();
    const month = buildMonth(readRecords(open.root), "2026-10", {});
    expect(month.reconcile.lockEvents).toEqual({ status: "no-lock" });
    expect(month.needs.some((line) => line.includes("lock"))).toBe(false);
  });

  it("counts every entry covered when each visit has its own person's unlock", () => {
    const month = october(AT_VISITS);
    expect(checked(month)).toMatchObject({ entries: 4, covered: 4, notWork: 0, uncovered: [], visitsWithoutEntry: [] });
  });

  it("lists the cleaner's unlock on a day with no cleaning, by name and in local time", () => {
    const month = october([...AT_VISITS, unlock("2026-10-06T18:05:00.000Z", "Ana cleaning")]);
    expect(checked(month).uncovered).toEqual([{ eventId: expect.any(String), date: "2026-10-06", time: "14:05", device: "Front door", who: "cleaner" }]);
    expect(month.needs).toContain("2026-10-06 14:05, Front door: Ana's code opened it, and no row in the log covers that time. Ask the host what it was.");
  });

  it("matches a code to its own person's rows: the cleaner's code isn't covered by the plumber's visit", () => {
    const month = october([...AT_VISITS, unlock("2026-10-08T13:30:00.000Z", "Ana cleaning")]);
    expect(checked(month).uncovered.map((gap) => gap.who)).toEqual(["cleaner"]);
  });

  it("covers an unlock up to an hour before a row starts and an hour after it ends, and no further", () => {
    const month = october([
      ...AT_VISITS,
      unlock("2026-10-04T14:05:00.000Z", "Ana cleaning"),
      unlock("2026-10-04T18:35:00.000Z", "Ana cleaning"),
      unlock("2026-10-04T14:04:00.000Z", "Ana cleaning"),
      unlock("2026-10-04T18:36:00.000Z", "Ana cleaning"),
    ]);
    expect(checked(month).uncovered.map((gap) => gap.time)).toEqual(["10:04", "14:36"]);
  });

  it("counts a guest's or a visitor's code as not work, any time", () => {
    const month = october([...AT_VISITS, unlock("2026-10-06T18:00:00.000Z", "Guest Lee"), unlock("2026-10-07T18:00:00.000Z", "Visitor Kim")]);
    expect(checked(month)).toMatchObject({ entries: 6, covered: 4, notWork: 2, uncovered: [] });
  });

  it("counts a no-code, unnamed or shared unlock during a guest stay as the guests', and lists it outside one", () => {
    const month = october([
      ...AT_VISITS,
      // Oct 1 at 9 PM New York: the Oct 1 to 4 stay began at 4 PM.
      unlock("2026-10-02T01:00:00.000Z", undefined, { method: "app" }),
      unlock("2026-10-02T02:00:00.000Z", "Family"),
      unlock("2026-10-02T03:00:00.000Z", "Old code"),
      // Oct 6: no one is staying.
      unlock("2026-10-06T05:13:00.000Z", undefined, { method: "app" }),
      // Oct 1 at 10 AM New York, before that stay's 4 PM check-in.
      unlock("2026-10-01T14:00:00.000Z", "Family"),
    ]);
    expect(checked(month).uncovered.map((gap) => [gap.date, gap.who])).toEqual([
      ["2026-10-01", "shared"],
      ["2026-10-06", "none"],
    ]);
    expect(month.needs).toContain("2026-10-06 01:13, Front door: it was opened without a code (app), and no row in the log or guest stay covers that time. Ask the host what it was.");
  });

  it("doesn't count the cleaner's own code during a stay as the guests'", () => {
    const month = october([...AT_VISITS, unlock("2026-10-02T15:00:00.000Z", "Ana cleaning")]);
    expect(checked(month).uncovered.map((gap) => gap.who)).toEqual(["cleaner"]);
  });

  it("covers the host's standing-code entry with its own owner row", () => {
    const month = october([...AT_VISITS, unlock("2026-10-17T14:00:00.000Z", "Sam standing")]);
    expect(month.rows.some((row) => row.kind === "owner-on-site")).toBe(true);
    expect(checked(month)).toMatchObject({ entries: 5, covered: 5, uncovered: [] });
  });

  it("leaves out unlocks from inside", () => {
    const month = october([...AT_VISITS, unlock("2026-10-06T18:05:00.000Z", "Ana cleaning", { side: "inside" })]);
    expect(checked(month)).toMatchObject({ entries: 4, uncovered: [] });
  });

  it("lists an on-site visit with no entry near it", () => {
    const month = october(AT_VISITS.filter((event) => event.codeName !== "Drip Plumbing"));
    const sink = month.rows.find((row) => row.log === "pro:pro_drip" && row.date === "2026-10-08" && row.where === "On site");
    expect(sink).toBeDefined();
    expect(checked(month).visitsWithoutEntry).toEqual([sink!.id]);
    expect(month.needs).toContain(`2026-10-08, ${sink!.task} (Drip Plumbing): no one opened the door at the lock during it. Ask the host how they got in.`);
  });

  it("doesn't check visits while the lock was disconnected", () => {
    const month = october([], { connected: false });
    expect(month.reconcile.lockEvents).toEqual({ status: "no-lock" });
  });

  it("never puts a code name's digits in a line", () => {
    // Built at run time, so no digit run sits in this file.
    const digits = String(7 * 1111);
    const month = october([...AT_VISITS, unlock("2026-10-06T18:05:00.000Z", `Spare ${digits}`)]);
    expect(month.needs.join("\n")).not.toContain(digits);
    expect(checked(month).uncovered.map((gap) => gap.who)).toEqual(["unnamed"]);
  });

  it("adds lines but changes no row, so the month's fingerprint stays the same", () => {
    const clean = october(AT_VISITS);
    open?.cleanup();
    const gaps = october([...AT_VISITS, unlock("2026-10-06T18:05:00.000Z", "Ana cleaning"), unlock("2026-10-06T19:00:00.000Z", undefined, { method: "app" })]);
    expect(gaps.needs.length).toBeGreaterThan(clean.needs.length);
    expect(gaps.rows).toEqual(clean.rows);
    expect(gaps.fingerprint).toBe(clean.fingerprint);
  });
});
