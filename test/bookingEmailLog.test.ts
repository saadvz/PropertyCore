import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAirbnbEmail } from "../src/hub/airbnbEmail";
import { appendBookingEmail, BOOKING_EMAILS_FILE, bodyHash, isDuplicate, readBookingEmails, rebuildBookings, stayForNight, type BookingEmailOutcome, type BookingEmailRecord } from "../src/hub/bookingEmails";
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
    expect(stayForNight(root, "2026-10-18")).toEqual({ checkIn: "2026-10-18", checkout: "2026-10-22", checkInTime: "15:00", checkoutTime: "12:00", guests: 3, confirmationCode: "HMXK4Q2Z9R" });
    expect(stayForNight(root, "2026-10-21")?.confirmationCode).toBe("HMXK4Q2Z9R");
    expect(stayForNight(root, "2026-10-22")).toBeUndefined();
    appendBookingEmail(root, record("cancelled-range", "applied", "2026-10-16T15:00:00.000Z"));
    expect(stayForNight(root, "2026-10-18")).toBeUndefined();
  });
});
