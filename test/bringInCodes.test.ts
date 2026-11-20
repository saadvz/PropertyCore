import { describe, expect, it } from "vitest";
import { bringInWindow, wantedBringInCodes } from "../src/package-arrivals/codes";
import type { PackagesFile } from "../src/package-arrivals/store";
import { order } from "./packageFixture";

/** #241: which bring-in codes a property wants now. Pure; made-up orders and 555 numbers only. */

const ANA = "+15555550111";
const RAY = "+15555550122";
const NY = "America/New_York";
const at = (local: string, day = "17") => new Date(`2026-11-${day}T${local}:00.000-05:00`);
const iso = (local: string, day = "17") => at(local, day).toISOString();
const OCCUPY = { timeZone: NY, checkInTime: "16:00", checkoutTime: "11:00", checkInBufferMinutes: 60 };

function file(arrival: PackagesFile["arrivals"][string]): PackagesFile {
  return { settings: { bringInHours: 4 }, arrivals: { "supply:ord_a": arrival } };
}

const visit = { person: ANA, name: "Ana", role: "cleaner" as const, plannedAt: iso("10:00"), hours: 4 };
const base = { now: at("10:00"), stays: [], occupy: OCCUPY, canPick: () => true };

describe("bringInWindow", () => {
  it("runs from the later of the drop and the planning to the deadline", () => {
    expect(bringInWindow({ seenAt: iso("09:30"), plannedAt: iso("10:00"), hours: 4 }, [], OCCUPY)).toEqual({ from: iso("10:00"), until: iso("13:30") });
    expect(bringInWindow({ seenAt: iso("11:00"), plannedAt: iso("10:00"), hours: 4 }, [], OCCUPY)).toEqual({ from: iso("11:00"), until: iso("15:00") });
  });

  it("stops at the next check-in's buffer, and gives none inside a stay or its buffer", () => {
    // Check-in 17 Nov 16:00 local, buffer 60 minutes: busy from 15:00.
    const stays = [{ checkIn: "2026-11-17", checkout: "2026-11-19", kind: "stay" as const }];
    expect(bringInWindow({ seenAt: iso("12:00"), plannedAt: iso("12:00"), hours: 8 }, stays, OCCUPY)).toEqual({ from: iso("12:00"), until: iso("15:00") });
    expect(bringInWindow({ seenAt: iso("15:30"), plannedAt: iso("15:30"), hours: 8 }, stays, OCCUPY)).toBe("during-stay");
    expect(bringInWindow({ seenAt: iso("12:00", "18"), plannedAt: iso("12:00", "18"), hours: 8 }, stays, OCCUPY)).toBe("during-stay");
    // After checkout, a code again.
    expect(bringInWindow({ seenAt: iso("11:30", "19"), plannedAt: iso("11:30", "19"), hours: 2 }, stays, OCCUPY)).toEqual({ from: iso("11:30", "19"), until: iso("13:30", "19") });
  });
});

describe("wantedBringInCodes", () => {
  const orders = [order("ord_a", { expectedBy: "2026-11-17" })];

  it("wants the person's code once the drop is seen and a visit is planned, named as a package helper's", () => {
    const out = wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" }, visit }), orders, base);
    expect(out.wanted).toEqual([{ jobId: "supply:ord_a", person: ANA, window: { from: iso("10:00"), until: iso("13:30") }, label: "Ana", who: { role: "package" } }]);
    expect(out.duringStay).toEqual([]);
  });

  it("uses the carrier's tracking time when nothing else saw the drop", () => {
    const tracked = [order("ord_a", { expectedBy: "2026-11-17", deliveredAt: iso("09:00"), status: "delivered" })];
    expect(wantedBringInCodes(file({ visit }), tracked, base).wanted[0]!.window).toEqual({ from: iso("10:00"), until: iso("13:00") });
  });

  it("wants nothing before the drop, without a visit, after it's inside, after the deadline, or for someone who can't be picked", () => {
    expect(wantedBringInCodes(file({ visit }), orders, base).wanted).toEqual([]);
    expect(wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" } }), orders, base).wanted).toEqual([]);
    expect(wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" }, visit, broughtIn: { at: iso("10:30") } }), orders, { ...base, now: at("10:40") }).wanted).toEqual([]);
    expect(wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" }, visit }), orders, { ...base, now: at("13:30") }).wanted).toEqual([]);
    expect(wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" }, visit }), orders, { ...base, canPick: (phone) => phone !== ANA }).wanted).toEqual([]);
  });

  it("follows the host's new pick", () => {
    const out = wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" }, visit: { ...visit, person: RAY, name: "Ray", role: "co-host" } }), orders, base);
    expect(out.wanted.map((w) => [w.person, w.label])).toEqual([[RAY, "Ray"]]);
  });

  it("lists a visit whose window falls in a stay, with no code", () => {
    const stays = [{ checkIn: "2026-11-16", checkout: "2026-11-19", kind: "stay" as const }];
    const out = wantedBringInCodes(file({ seen: { at: iso("09:30"), how: "host" }, visit }), orders, { ...base, stays });
    expect(out.wanted).toEqual([]);
    expect(out.duringStay).toEqual(["ord_a"]);
  });
});
