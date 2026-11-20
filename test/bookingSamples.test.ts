import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBookingEmail, type BookingEmailRecord } from "../src/hub/bookingEmails";
import { redactSample, sampleRecords, writeSamples } from "../src/hub/bookingSamples";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Samples for the Vrbo and Booking.com readers (#263): only with the host's okay, with personal details replaced. Made-up details only. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetHubs();
});
const folder = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const VRBO_BODY = [
  "Instant Booking confirmed",
  "Reservation ID: HA-1A2B3C",
  "Traveler: Jordan Testperson",
  "Phone: +1 (555) 555-0199",
  "Email: jordan.testperson@example.test",
  "Guest name",
  "Jordan Testperson",
  "Arrive: Sun, Oct 18, 2026 4:00 PM",
  "Depart: Thu, Oct 22, 2026 10:00 AM",
  "Guests: 2 adults",
].join("\n");

function vrbo(outcome: BookingEmailRecord["outcome"], hostConfirmed: boolean, at = "2026-10-14T15:00:00.000Z"): BookingEmailRecord {
  return {
    at,
    receivedAt: at,
    messageId: `<vrbo-${at}-${outcome}@example.test>`,
    from: "Vrbo <sender@messages.homeaway.com>",
    subject: "Instant Booking from Jordan Testperson: HA-1A2B3C",
    body: VRBO_BODY,
    parsed: { kind: "confirmed", platform: "vrbo", confirmationCode: "HA-1A2B3C", checkIn: { date: "2026-10-18", time: "16:00" }, checkout: { date: "2026-10-22", time: "10:00" } },
    outcome,
    ...(hostConfirmed ? { hostConfirmed: true } : {}),
  };
}

describe("redactSample", () => {
  it("replaces email addresses, phone numbers and labeled names, and keeps the dates, times and reference", () => {
    const out = redactSample(VRBO_BODY);
    expect(out).not.toContain("Jordan");
    expect(out).not.toContain("Testperson");
    expect(out).not.toContain("555-0199");
    expect(out).not.toContain("jordan.testperson@example.test");
    expect(out).toContain("HA-1A2B3C");
    expect(out).toContain("Oct 18, 2026 4:00 PM");
    expect(out).toContain("Guests: 2 adults");
  });

  it("keeps a long booking number with no separators", () => {
    expect(redactSample("Booking number: 4417203391")).toContain("4417203391");
  });
});

describe("sampleRecords", () => {
  it("gives nothing without the host's okay", () => {
    const root = folder("samples-");
    appendBookingEmail(root, vrbo("applied", true));
    expect(sampleRecords(root)).toEqual([]);
  });

  it("with the okay, gives only Vrbo and Booking.com emails the host said yes to", () => {
    const root = folder("samples-");
    expect(hubFor(root, { now: () => new Date() }).setShareSamples(true).ok).toBe(true);
    appendBookingEmail(root, vrbo("awaiting-host", false));
    appendBookingEmail(root, vrbo("applied", true));
    appendBookingEmail(root, { ...vrbo("applied", true, "2026-10-15T15:00:00.000Z"), from: "My Place <bookings@example.test>", parsed: { kind: "confirmed", platform: "direct", confirmationCode: "DB-1" } });
    const samples = sampleRecords(root);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.subject).not.toContain("Jordan");
    expect(samples[0]!.body).not.toContain("Jordan");
  });

  it("writes them in the fixtures' shape to a folder for Saad to read first", () => {
    const root = folder("samples-");
    hubFor(root, { now: () => new Date() }).setShareSamples(true);
    appendBookingEmail(root, vrbo("applied", true));
    const out = join(folder("samples-out-"), "vrbo");
    expect(writeSamples(root, out)).toBe(1);
    const [file] = readdirSync(out);
    expect(file).toBe("vrbo-confirmed-1.txt");
    const text = readFileSync(join(out, file!), "utf8");
    expect(text.startsWith("From: Vrbo <sender@messages.homeaway.com>\nSubject: ")).toBe(true);
    expect(text).not.toContain("Jordan");
    expect(existsSync(join(root, "booking-emails.jsonl"))).toBe(true);
  });
});
