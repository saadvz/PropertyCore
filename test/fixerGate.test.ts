import { describe, expect, it } from "vitest";
import {
  accessCheck,
  bookingFingerprint,
  bookingHolds,
  contactAllowed,
  costNews,
  defaultAccess,
  liveBooking,
  raisedPriceHeld,
} from "../src/fixer-core/gate.js";
import type { Booking, Job, Pro } from "../src/fixer-core/store.js";
import type { VisitWindow } from "../src/fixer-core/window.js";

const pro = (patch: Partial<Pro> = {}): Pro => ({
  id: "pro1",
  name: "Sample Plumbing",
  trades: ["plumbing"],
  preferredFor: [{ trade: "plumbing", rank: 1 }],
  reach: { phone: "+15555550101" },
  status: "saved",
  source: "host",
  addedAt: "2026-11-01T00:00:00Z",
  ...patch,
});

const job = (patch: Partial<Job> = {}): Job => ({
  id: "job1",
  trade: "plumbing",
  what: "leaking tap",
  source: "host",
  photos: [],
  urgency: "soon",
  state: "booked",
  candidates: [],
  picked: [],
  contacts: [],
  news: [],
  createdAt: "2026-11-01T00:00:00Z",
  ...patch,
});

const candidate = (id: string): Job["candidates"][number] => ({
  id,
  name: "Example Pipes",
  trade: "plumbing",
  source: "search",
  licensed: "unknown",
  reach: { email: "pipes@example.com" },
});

describe("contactAllowed", () => {
  it("allows a saved preferred pro on a job with the host's go", () => {
    expect(contactAllowed(job({ hostGo: { at: "2026-11-02T00:00:00Z" } }), "pro1", [pro()])).toEqual({ ok: true });
  });
  it("holds a preferred pro without the go", () => {
    expect(contactAllowed(job(), "pro1", [pro()])).toEqual({ ok: false, reason: "no-go" });
  });
  it("never allows a draft pro, even when picked", () => {
    const j = job({ picked: ["pro1"], hostGo: { at: "x" } });
    expect(contactAllowed(j, "pro1", [pro({ status: "draft" })])).toEqual({ ok: false, reason: "not-approved" });
  });
  it("allows a picked candidate", () => {
    expect(contactAllowed(job({ candidates: [candidate("c1")], picked: ["c1"] }), "c1", [])).toEqual({ ok: true });
  });
  it("allows a picked saved pro that is not preferred", () => {
    const p = pro({ preferredFor: [] });
    expect(contactAllowed(job({ picked: ["pro1"] }), "pro1", [p])).toEqual({ ok: true });
  });
  it("refuses a saved pro that is neither preferred nor picked", () => {
    expect(contactAllowed(job({ hostGo: { at: "x" } }), "pro1", [pro({ preferredFor: [] })])).toEqual({ ok: false, reason: "not-approved" });
  });
  it("refuses a candidate that was not picked", () => {
    expect(contactAllowed(job({ candidates: [candidate("c1")] }), "c1", [])).toEqual({ ok: false, reason: "not-approved" });
  });
  it("refuses an unknown id", () => {
    expect(contactAllowed(job(), "nobody", [pro()])).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("bookingHolds", () => {
  const w: VisitWindow[] = [{ from: "2026-12-01T09:00:00.000Z", until: "2026-12-01T17:00:00.000Z" }];
  const span = { from: "2026-12-01T10:00:00.000Z", until: "2026-12-01T12:00:00.000Z" };
  const input = { span, windows: w, overlaps: false };
  it("holds nothing for a clean booking", () => {
    expect(bookingHolds(input)).toEqual([]);
  });
  it("holds outside-window alone", () => {
    expect(bookingHolds({ ...input, span: { from: "2026-12-01T16:00:00.000Z", until: "2026-12-01T18:00:00.000Z" } })).toEqual(["outside-window"]);
  });
  it("holds overlaps-stay alone", () => {
    expect(bookingHolds({ ...input, overlaps: true })).toEqual(["overlaps-stay"]);
  });
  it("holds cost over a line, not at or below it", () => {
    expect(bookingHolds({ ...input, costLineCents: 20000, estimateCents: 20001 })).toEqual(["cost"]);
    expect(bookingHolds({ ...input, costLineCents: 20000, estimateCents: 20000 })).toEqual([]);
    expect(bookingHolds({ ...input, costLineCents: 20000, estimateCents: 15000 })).toEqual([]);
  });
  it("holds no-estimate with a line only", () => {
    expect(bookingHolds({ ...input, costLineCents: 20000 })).toEqual(["no-estimate"]);
    expect(bookingHolds(input)).toEqual([]);
    expect(bookingHolds({ ...input, estimateCents: 999999 })).toEqual([]);
  });
  it("returns holds in type order", () => {
    const out = bookingHolds({ span: { from: "2026-12-02T10:00:00.000Z", until: "2026-12-02T11:00:00.000Z" }, windows: w, overlaps: true, costLineCents: 100 });
    expect(out).toEqual(["outside-window", "overlaps-stay", "no-estimate"]);
  });
});

describe("bookingFingerprint", () => {
  const base = { proId: "pro1", from: "2026-12-01T10:00:00.000Z", until: "2026-12-01T12:00:00.000Z", estimateCents: 10000, access: "code" as const, cleaningOrder: "before" };
  const same = bookingFingerprint(base);
  it("is a sha256 hex string and stable", () => {
    expect(same).toMatch(/^[0-9a-f]{64}$/);
    expect(bookingFingerprint({ ...base })).toBe(same);
  });
  it("changes with each field", () => {
    const variants = [
      { ...base, proId: "pro2" },
      { ...base, from: "2026-12-01T10:30:00.000Z" },
      { ...base, until: "2026-12-01T13:00:00.000Z" },
      { ...base, estimateCents: 10001 },
      { ...base, access: "host" as const },
      { ...base, cleaningOrder: "after" },
    ];
    for (const v of variants) expect(bookingFingerprint(v)).not.toBe(same);
  });
  it("treats missing values as null", () => {
    const { estimateCents: _e, cleaningOrder: _c, ...rest } = base;
    expect(bookingFingerprint(rest)).not.toBe(same);
    expect(bookingFingerprint(rest)).toBe(bookingFingerprint({ ...rest }));
  });
});

describe("defaultAccess", () => {
  it("is code for a normal job with a phone and a saved code", () => {
    expect(defaultAccess(job(), pro(), true)).toBe("code");
  });
  it("is host for a doorLock job, no phone, no pro or no saved code", () => {
    expect(defaultAccess(job({ doorLock: true }), pro(), true)).toBe("host");
    expect(defaultAccess(job(), pro({ reach: {} }), true)).toBe("host");
    expect(defaultAccess(job(), undefined, true)).toBe("host");
    expect(defaultAccess(job(), pro(), false)).toBe("host");
  });
});

describe("accessCheck", () => {
  const booking = (patch: Partial<Booking> = {}): Booking => ({
    proId: "pro1",
    from: "2026-12-01T10:00:00.000Z",
    until: "2026-12-01T12:00:00.000Z",
    access: "code",
    hostYes: { at: "2026-11-30T00:00:00Z" },
    fingerprint: "f",
    ...patch,
  });
  const at = (iso: string) => new Date(iso);
  const run = (j: Job, over: Partial<Parameters<typeof accessCheck>[0]> = {}) =>
    accessCheck({ job: j, pro: pro(), now: at("2026-12-01T10:00:00.000Z"), checkoutDay: false, cleared: false, ...over });

  it("allows within the visit and returns the window", () => {
    expect(run(job({ booking: booking() }))).toEqual({ ok: true, window: { from: "2026-12-01T09:30:00.000Z", until: "2026-12-01T12:00:00.000Z" } });
  });
  it("uses extendedUntil for the end", () => {
    const j = job({ booking: booking({ extendedUntil: "2026-12-01T14:00:00.000Z" }) });
    expect(run(j, { now: at("2026-12-01T13:00:00.000Z") })).toEqual({ ok: true, window: { from: "2026-12-01T09:30:00.000Z", until: "2026-12-01T14:00:00.000Z" } });
  });
  it("refuses while the stays are unread", () => {
    expect(run(job({ booking: booking() }), { staysUnread: true })).toEqual({ ok: false, reason: "stays-unread" });
  });
  it("refuses without a live booking", () => {
    expect(run(job())).toEqual({ ok: false, reason: "not-booked" });
    expect(run(job({ booking: booking(), state: "done" }))).toEqual({ ok: false, reason: "not-booked" });
  });
  it("refuses without the host's yes", () => {
    expect(run(job({ booking: booking({ hostYes: undefined }) }))).toEqual({ ok: false, reason: "no-yes" });
  });
  it("refuses host access", () => {
    expect(run(job({ booking: booking({ access: "host" }) }))).toEqual({ ok: false, reason: "host-access" });
  });
  it("refuses a doorLock locksmith via defaultAccess", () => {
    const j = job({ trade: "locksmith", doorLock: true });
    const p = pro({ trades: ["locksmith"] });
    const b = booking({ access: defaultAccess(j, p, true) });
    expect(run({ ...j, booking: b }, { pro: p })).toEqual({ ok: false, reason: "host-access" });
  });
  it("allows a locksmith on another lock", () => {
    const j = job({ trade: "locksmith" });
    const p = pro({ trades: ["locksmith"] });
    const b = booking({ access: defaultAccess(j, p, true) });
    expect(run({ ...j, booking: b }, { pro: p }).ok).toBe(true);
  });
  it("refuses with no pro phone", () => {
    expect(run(job({ booking: booking() }), { pro: pro({ reach: {} }) })).toEqual({ ok: false, reason: "no-phone" });
    expect(run(job({ booking: booking() }), { pro: undefined })).toEqual({ ok: false, reason: "no-phone" });
  });
  it("refuses before from minus 30 minutes, allows at it", () => {
    const j = job({ booking: booking() });
    expect(run(j, { now: at("2026-12-01T09:29:59.000Z") })).toEqual({ ok: false, reason: "before-visit" });
    expect(run(j, { now: at("2026-12-01T09:30:00.000Z") }).ok).toBe(true);
  });
  it("refuses at and after the end", () => {
    const j = job({ booking: booking() });
    expect(run(j, { now: at("2026-12-01T11:59:59.000Z") }).ok).toBe(true);
    expect(run(j, { now: at("2026-12-01T12:00:00.000Z") })).toEqual({ ok: false, reason: "after-visit" });
  });
  it("refuses on a checkout day before guests are cleared", () => {
    const j = job({ booking: booking() });
    expect(run(j, { checkoutDay: true })).toEqual({ ok: false, reason: "guests-not-left" });
    expect(run(j, { checkoutDay: true, cleared: true }).ok).toBe(true);
  });
});

describe("liveBooking", () => {
  it("is true for booked and in-progress only", () => {
    expect(liveBooking(job({ state: "booked" }))).toBe(true);
    expect(liveBooking(job({ state: "in-progress" }))).toBe(true);
    expect(liveBooking(job({ state: "contacted" }))).toBe(false);
    expect(liveBooking(job({ state: "done" }))).toBe(false);
  });
});

describe("raisedPriceHeld and costNews", () => {
  it("holds over the line", () => {
    expect(raisedPriceHeld(20000, undefined, 20001)).toBe(true);
    expect(raisedPriceHeld(20000, undefined, 20000)).toBe(false);
  });
  it("holds over 120% of the estimate when a line is set", () => {
    expect(raisedPriceHeld(100000, 10000, 12001)).toBe(true);
    expect(raisedPriceHeld(100000, 10000, 12000)).toBe(false);
  });
  it("never holds without a line, but is news", () => {
    expect(raisedPriceHeld(undefined, 10000, 50000)).toBe(false);
    expect(costNews(undefined, 10000, 12001)).toBe(true);
    expect(costNews(undefined, 10000, 12000)).toBe(false);
    expect(costNews(undefined, undefined, 99999999)).toBe(false);
  });
  it("is news over the line", () => {
    expect(costNews(20000, undefined, 20001)).toBe(true);
    expect(costNews(20000, undefined, 20000)).toBe(false);
  });
});
