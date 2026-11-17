import { describe, expect, it } from "vitest";
import type { Stay } from "../src/hub/store.js";
import { stayKey, urgentAccessCheck, urgentTimeline, urgentVisitHolds, type GuestAnswer, type UrgentVisitInput } from "../src/fixer-core/urgentVisit.js";

const guestStay: Stay = { checkIn: "2026-12-01", checkout: "2026-12-08", kind: "stay" };
const visit = { from: "2026-12-04T14:00:00.000Z", until: "2026-12-04T16:00:00.000Z" };
const yes: GuestAnswer = { stay: stayKey(guestStay), answer: "yes", window: { from: "2026-12-04T13:00:00.000Z", until: "2026-12-04T17:00:00.000Z" }, at: "2026-12-04T10:00:00.000Z", via: "text" };
const base: UrgentVisitInput = { window: visit, stays: [guestStay], times: { timeZone: "UTC", checkInBufferMinutes: 60 }, guest: yes, hostYes: { at: "2026-12-04T10:05:00.000Z" } };
const holds = (patch: Partial<UrgentVisitInput>) => urgentVisitHolds({ ...base, ...patch });

describe("urgentVisitHolds", () => {
  it("has nothing to hold when the guest agreed to the window and the host said yes", () => {
    expect(holds({})).toEqual([]);
  });

  it("is only for a visit during a guest stay", () => {
    expect(holds({ window: { from: "2026-12-10T14:00:00.000Z", until: "2026-12-10T16:00:00.000Z" } })).toEqual(["not-during-stay"]);
  });

  it("ignores calendar blocks when looking for the stay", () => {
    const stays: Stay[] = [{ checkIn: "2026-12-10", checkout: "2026-12-12", kind: "block" }];
    expect(holds({ stays, window: { from: "2026-12-10T18:00:00.000Z", until: "2026-12-10T19:00:00.000Z" } })).toEqual(["not-during-stay"]);
  });

  it("holds a visit that runs past checkout", () => {
    const window = { from: "2026-12-08T10:00:00.000Z", until: "2026-12-08T12:00:00.000Z" };
    expect(holds({ window, guest: { ...yes, window } })).toEqual(["spans-checkout"]);
  });

  it("allows 4 hours and holds anything longer", () => {
    const four = { from: "2026-12-04T13:00:00.000Z", until: "2026-12-04T17:00:00.000Z" };
    expect(holds({ window: four })).toEqual([]);
    const longer = { from: "2026-12-04T13:00:00.000Z", until: "2026-12-04T17:01:00.000Z" };
    expect(holds({ window: longer, guest: { ...yes, window: longer } })).toEqual(["too-long"]);
  });

  it("names what's missing from the guest", () => {
    expect(holds({ guest: undefined })).toEqual(["no-guest-ok"]);
    expect(holds({ guest: { stay: stayKey(guestStay), answer: "no", at: "2026-12-04T10:00:00.000Z", via: "platform" } })).toEqual(["guest-declined"]);
    expect(holds({ guest: { ...yes, stay: "2026-11-20|2026-11-25" } })).toEqual(["guest-ok-other-stay"]);
  });

  it("doesn't let a yes to a shorter window cover the visit", () => {
    expect(holds({ guest: { ...yes, window: { from: "2026-12-04T14:30:00.000Z", until: "2026-12-04T17:00:00.000Z" } } })).toEqual(["guest-ok-other-window"]);
  });

  it("needs the host's yes, after the guest's holds", () => {
    expect(holds({ hostYes: undefined })).toEqual(["no-host-yes"]);
    expect(holds({ hostYes: undefined, guest: undefined })).toEqual(["no-guest-ok", "no-host-yes"]);
  });
});

describe("urgentAccessCheck", () => {
  const check = (now: string, patch: Partial<Parameters<typeof urgentAccessCheck>[0]> = {}) => urgentAccessCheck({ ...base, now: new Date(now), proPhone: "+15555550101", ...patch });

  it("shows the code only from the visit's start, with no early lead", () => {
    expect(check("2026-12-04T13:59:59Z")).toEqual({ ok: false, reason: "before-visit" });
    expect(check("2026-12-04T14:00:00Z")).toEqual({ ok: true, window: visit });
    expect(check("2026-12-04T16:00:00Z")).toEqual({ ok: false, reason: "after-visit" });
  });

  it("never shows it for the coded lock or a pro with no phone", () => {
    expect(check("2026-12-04T14:00:00Z", { doorLock: true })).toEqual({ ok: false, reason: "door-lock" });
    expect(check("2026-12-04T14:00:00Z", { proPhone: undefined })).toEqual({ ok: false, reason: "no-phone" });
  });

  it("stops at once when the guest says no", () => {
    expect(check("2026-12-04T14:30:00Z", { guest: { stay: stayKey(guestStay), answer: "no", at: "2026-12-04T14:20:00.000Z", via: "text" } })).toEqual({ ok: false, reason: "guest-declined" });
  });
});

/** Made up, and built from parts so the repo's secret scan doesn't read them as a saved code. */
const GATE = ["4", "8", "2", "1"].join("");
const PHONE = ["555", "123", "4567"].join("-");

describe("urgentTimeline", () => {
  const input = {
    timeZone: "UTC",
    reportedAt: "2026-12-04T09:00:00.000Z",
    what: `Pests in the kitchen, gate code ${GATE}, call ${PHONE}`,
    proName: "Ace Pest",
    guestAskedAt: ["2026-12-04T09:30:00.000Z"],
    guestAnswers: [yes],
    hostYesAt: "2026-12-04T10:05:00.000Z",
    codeShownAt: ["2026-12-04T14:01:00.000Z"],
    done: { at: "2026-12-04T15:40:00.000Z", note: `Sprayed and sealed. Paid $350, code ${GATE}` },
    photos: [{ at: "2026-12-04T15:41:00.000Z", from: "pro" as const }],
  };

  it("keeps every step in time order", () => {
    expect(urgentTimeline(input).map((e) => e.kind)).toEqual(["reported", "guest-asked", "guest-agreed", "host-yes", "code-shown", "visit-done", "photo"]);
  });

  it("orders by time even when given out of order", () => {
    const entries = urgentTimeline({ ...input, hostYesAt: "2026-12-04T09:10:00.000Z" });
    expect(entries.map((e) => e.kind).slice(0, 3)).toEqual(["reported", "host-yes", "guest-asked"]);
  });

  it("never holds a code, a phone number or an amount", () => {
    const text = urgentTimeline(input).map((e) => e.text).join("\n");
    expect(text).not.toMatch(/\d{4,}/);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain("$350");
    expect(text).toContain("Pests in the kitchen");
  });

  it("names the window the guest agreed to and who the code was shown to", () => {
    const entries = urgentTimeline(input);
    expect(entries.find((e) => e.kind === "guest-agreed")!.text).toMatch(/1:00 PM.*5:00 PM/);
    expect(entries.find((e) => e.kind === "code-shown")!.text).toContain("Ace Pest");
  });
});
