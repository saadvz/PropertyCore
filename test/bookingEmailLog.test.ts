import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAirbnbEmail } from "../src/hub/airbnbEmail";
import { appendBookingEmail, BOOKING_EMAILS_FILE, bodyHash, bookingKey, isDuplicate, readBookingEmails, rebuildBookings, stayForNight, waitingStays, type BookingEmailOutcome, type BookingEmailRecord } from "../src/hub/bookingEmails";
import type { ParsedBookingEmail } from "../src/hub/airbnbEmail";
import { PROPERTY_FILES } from "../src/cleaner-core/hosted/migrate";
import { sampleEmail } from "./airbnbEmails";

/** Made-up emails only. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "booking-emails-"));
  roots.push(root);
  return root;
}

function record(name: string, outcome: BookingEmailOutcome = "applied", at = "2026-10-14T15:00:00.000Z"): BookingEmailRecord {
  const email = sampleEmail(name, at);
  const read = parseAirbnbEmail(email, new Date(at));
  return {
    at,
    receivedAt: at,
    ...(email.messageId ? { messageId: email.messageId } : {}),
    from: email.from,
    subject: email.subject,
    body: email.body,
    ...(read.ok ? { parsed: read.parsed } : { refused: read.reason }),
    outcome,
  };
}

describe("the booking email log", () => {
  it("keeps each email on its own line, in the order it came, and reads them back", () => {
    const root = folder();
    appendBookingEmail(root, record("confirmed-stacked"));
    appendBookingEmail(root, record("changed", "applied", "2026-10-15T15:00:00.000Z"));
    expect(readFileSync(join(root, BOOKING_EMAILS_FILE), "utf8").trim().split("\n")).toHaveLength(2);
    expect(readBookingEmails(root).map((item) => item.subject)).toEqual([
      "Reservation confirmed - Jamie Rivera arrives Oct 18",
      "Reservation altered: HMXK4Q2Z9R",
    ]);
    expect(readBookingEmails(folder())).toEqual([]);
  });

  it("is a property file, so moves, backups and exports carry it", () => {
    expect(PROPERTY_FILES).toContain(BOOKING_EMAILS_FILE);
  });

  it("knows a second copy by its message id, or by its sender, subject and body", () => {
    const records = [record("confirmed-stacked")];
    const email = sampleEmail("confirmed-stacked");
    expect(isDuplicate(records, email)).toBe(true);
    const { messageId: _id, ...noId } = email;
    expect(isDuplicate(records, noId)).toBe(true);
    expect(isDuplicate(records, sampleEmail("changed"))).toBe(false);
  });

  it("rebuilds each booking from the emails: a change replaces the times, a cancellation drops the stay", () => {
    const confirmed = rebuildBookings([record("confirmed-stacked")]);
    expect(confirmed.get("HMXK4Q2Z9R")).toMatchObject({ checkIn: "2026-10-18", checkout: "2026-10-22", checkInTime: "15:00", checkoutTime: "12:00", guests: 3, cancelled: false });
    const changed = rebuildBookings([record("confirmed-stacked"), record("changed", "applied", "2026-10-15T15:00:00.000Z")]);
    expect(changed.get("HMXK4Q2Z9R")).toMatchObject({ checkoutTime: "14:00", guests: 2 });
    const cancelled = rebuildBookings([record("confirmed-stacked"), record("cancelled-bare", "applied", "2026-10-16T15:00:00.000Z")]);
    expect(cancelled.get("HMXK4Q2Z9R")).toMatchObject({ checkIn: "2026-10-18", checkout: "2026-10-22", cancelled: true });
  });

  it("goes by when Airbnb sent each email, not the order they were passed in", () => {
    const later = record("changed", "applied", "2026-10-15T15:00:00.000Z");
    const earlier = { ...record("confirmed-stacked"), at: "2026-10-16T15:00:00.000Z" };
    expect(rebuildBookings([later, earlier]).get("HMXK4Q2Z9R")).toMatchObject({ checkoutTime: "14:00", guests: 2 });
  });

  it("doesn't count a cancellation the host hasn't said yes to", () => {
    const asked = rebuildBookings([record("confirmed-stacked"), record("cancelled-range", "asked", "2026-10-16T15:00:00.000Z")]);
    expect(asked.get("HMXK4Q2Z9R")?.cancelled).toBe(false);
  });

  it("keeps no body for an email it couldn't read, and still knows a second copy of it", () => {
    const root = folder();
    const forwarded = sampleEmail("forwarded");
    const { body: _body, ...rest } = record("forwarded", "refused");
    appendBookingEmail(root, { ...rest, bodyHash: bodyHash(forwarded.body) });
    expect(readFileSync(join(root, BOOKING_EMAILS_FILE), "utf8")).not.toContain(forwarded.body.split("\n")[0]!.slice(0, 20));
    expect(isDuplicate(readBookingEmails(root), forwarded)).toBe(true);
    const { messageId: _id, ...noId } = forwarded;
    expect(isDuplicate(readBookingEmails(root), noId)).toBe(true);
  });

  it("leaves out an email that changed nothing: a refusal, a mismatch, a disagreement, a duplicate, or one a later email replaced", () => {
    for (const outcome of ["mismatch", "disagrees", "duplicate", "refused", "superseded"] as const) {
      expect(rebuildBookings([record("confirmed-stacked", outcome)]).size).toBe(0);
    }
  });

  it("gives the stay covering a night: its check-in night yes, its checkout night no, a cancelled one never", () => {
    const root = folder();
    appendBookingEmail(root, record("confirmed-stacked"));
    expect(stayForNight(root, "2026-10-18")).toEqual({ checkIn: "2026-10-18", checkout: "2026-10-22", checkInTime: "15:00", checkoutTime: "12:00", guests: 3, infants: 1, confirmationCode: "HMXK4Q2Z9R", platform: "airbnb", vouchedBy: "reader" });
    expect(stayForNight(root, "2026-10-21")?.confirmationCode).toBe("HMXK4Q2Z9R");
    expect(stayForNight(root, "2026-10-22")).toBeUndefined();
    appendBookingEmail(root, record("cancelled-range", "applied", "2026-10-16T15:00:00.000Z"));
    expect(stayForNight(root, "2026-10-18")).toBeUndefined();
  });
});

/** A booking from the host's own site (#263), as the agent extracted it. Made-up reference. */
function direct(outcome: BookingEmailOutcome, parsed: Partial<ParsedBookingEmail> = {}, at = "2026-10-14T15:00:00.000Z", more: Partial<BookingEmailRecord> = {}): BookingEmailRecord {
  return {
    at,
    receivedAt: at,
    messageId: `<direct-${at}@example.test>`,
    from: "My Place <bookings@example.test>",
    subject: "New Booking Notification",
    body: "Booking #DB-4417, Oct 18 to Oct 22, 3 guests.",
    parsed: { kind: "confirmed", platform: "direct", confirmationCode: "DB-4417", checkIn: { date: "2026-10-18", time: "16:00" }, checkout: { date: "2026-10-22", time: "10:00" }, guests: { adults: 3, children: 0, infants: 0, total: 3 }, ...parsed },
    outcome,
    ...more,
  };
}

describe("stays from every platform (#263)", () => {
  it("keys Airbnb bookings by their bare code, as before, and every other platform's by platform", () => {
    expect(bookingKey({ kind: "confirmed", confirmationCode: "HMXK4Q2Z9R" })).toBe("HMXK4Q2Z9R");
    expect(bookingKey({ kind: "confirmed", platform: "airbnb", confirmationCode: "HMXK4Q2Z9R" })).toBe("HMXK4Q2Z9R");
    expect(bookingKey({ kind: "confirmed", platform: "vrbo", confirmationCode: "HA-1A2B3C" })).toBe("vrbo:HA-1A2B3C");
    expect(bookingKey({ kind: "confirmed", platform: "direct", confirmationCode: "", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22" } })).toBe("direct:2026-10-18:2026-10-22");
  });

  it("rebuilds an Airbnb log written before #263 exactly as before, now marked Airbnb and read by its reader", () => {
    const booking = rebuildBookings([record("confirmed-stacked")]).get("HMXK4Q2Z9R");
    expect(booking).toMatchObject({ checkIn: "2026-10-18", checkout: "2026-10-22", checkInTime: "15:00", checkoutTime: "12:00", guests: 3, cancelled: false, platform: "airbnb", vouchedBy: "reader" });
  });

  it("never counts a booking still waiting on the host's yes", () => {
    const root = folder();
    appendBookingEmail(root, direct("awaiting-host"));
    expect(rebuildBookings(readBookingEmails(root)).size).toBe(0);
    expect(stayForNight(root, "2026-10-19")).toBeUndefined();
  });

  it("after the host's yes, gives the stay with its platform, vouched for by the host", () => {
    const root = folder();
    appendBookingEmail(root, direct("awaiting-host"));
    appendBookingEmail(root, direct("applied", {}, "2026-10-14T15:00:00.000Z", { at: "2026-10-14T15:05:00.000Z", hostConfirmed: true }));
    expect(stayForNight(root, "2026-10-19")).toEqual({ checkIn: "2026-10-18", checkout: "2026-10-22", checkInTime: "16:00", checkoutTime: "10:00", guests: 3, confirmationCode: "DB-4417", platform: "direct", vouchedBy: "host" });
  });

  it("leaves out the reference when the email gave none", () => {
    const root = folder();
    appendBookingEmail(root, direct("applied", { confirmationCode: "" }, undefined, { hostConfirmed: true }));
    const stay = stayForNight(root, "2026-10-19");
    expect(stay).toMatchObject({ platform: "direct", vouchedBy: "host" });
    expect(stay).not.toHaveProperty("confirmationCode");
  });

  it("lets a change with no reference replace the overlapping stay it changes, from the same platform", () => {
    const root = folder();
    appendBookingEmail(root, direct("applied", { confirmationCode: "" }, undefined, { hostConfirmed: true }));
    appendBookingEmail(root, direct("applied", { kind: "changed", confirmationCode: "", checkout: { date: "2026-10-23", time: "11:00" } }, "2026-10-15T15:00:00.000Z", { hostConfirmed: true }));
    expect([...rebuildBookings(readBookingEmails(root)).values()].filter((booking) => !booking.cancelled)).toHaveLength(1);
    expect(stayForNight(root, "2026-10-19")).toMatchObject({ checkout: "2026-10-23", checkoutTime: "11:00" });
  });

  it("lists what waits on the host, and drops it once the host said yes", () => {
    const root = folder();
    appendBookingEmail(root, direct("awaiting-host"));
    expect(waitingStays(root)).toEqual([{ checkIn: "2026-10-18", checkout: "2026-10-22", checkInTime: "16:00", checkoutTime: "10:00", guests: 3, confirmationCode: "DB-4417", platform: "direct", vouchedBy: "none", kind: "confirmed" }]);
    appendBookingEmail(root, direct("applied", {}, "2026-10-14T15:00:00.000Z", { at: "2026-10-14T15:05:00.000Z", hostConfirmed: true }));
    expect(waitingStays(root)).toEqual([]);
  });
});
