import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedBookingEmail } from "../src/hub/airbnbEmail";
import { appendBookingEmail, type BookingEmailOutcome } from "../src/hub/bookingEmails";
import { appendGuestMessage } from "../src/guest-messages/store";
import { emptyGuestCodes, guestStays, stayLabel, wantedGuestCodes, type GuestCodesFile } from "../src/locks/guestCodes";

/**
 * Which guest codes a property wants (#262): bookings from the booking-email log, 7 days ahead, for
 * their check-in to checkout; the host's choice; late checkouts; leases. Made-up confirmation codes.
 */

const TZ = "America/New_York";
const NOW = new Date("2026-12-10T12:00:00Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "guest-wanted-"));
  roots.push(root);
  return root;
}

let sent = 0;
function email(root: string, parsed: ParsedBookingEmail, outcome: BookingEmailOutcome = "applied", hostConfirmed = false): void {
  sent += 1;
  const at = new Date(Date.parse("2026-12-01T00:00:00Z") + sent * 60_000).toISOString();
  appendBookingEmail(root, { at, receivedAt: at, from: "automated@airbnb.com", subject: "Reservation", parsed, outcome, ...(hostConfirmed ? { hostConfirmed: true } : {}) });
}

const booked = (code: string, checkIn: string, checkout: string, times: { in?: string; out?: string } = {}): ParsedBookingEmail => ({
  kind: "confirmed",
  confirmationCode: code,
  checkIn: { date: checkIn, ...(times.in ? { time: times.in } : {}) },
  checkout: { date: checkout, ...(times.out ? { time: times.out } : {}) },
});

const mode = (value: GuestCodesFile["mode"], extra: Partial<GuestCodesFile> = {}): GuestCodesFile => ({ ...emptyGuestCodes(), mode: value, ...extra });
const input = { now: NOW, timeZone: TZ };

describe("stays from the booking-email log", () => {
  it("wants a code for each booking within 7 days, for exactly its check-in to checkout", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15", { in: "15:00", out: "11:00" }));
    email(root, booked("HMSCRATCHBB", "2026-12-20", "2026-12-22"));
    const wanted = wantedGuestCodes(root, mode("automatic"), input);
    expect(wanted).toEqual([
      {
        jobId: "stay:HMSCRATCHAA",
        person: "guest:HMSCRATCHAA",
        window: { from: "2026-12-12T20:00:00.000Z", until: "2026-12-15T16:00:00.000Z" },
        label: "the guest on 12–15 Dec",
        who: { role: "guest" },
      },
    ]);
    // Eight days later the second booking is inside 7 days too.
    const later = wantedGuestCodes(root, mode("automatic"), { ...input, now: new Date("2026-12-14T12:00:00Z") });
    expect(later.map((item) => item.jobId)).toEqual(["stay:HMSCRATCHAA", "stay:HMSCRATCHBB"]);
  });

  it("takes the property's times when the email gives none, else 4:00 PM and 11:00 AM", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    expect(wantedGuestCodes(root, mode("automatic"), input)[0]!.window).toEqual({ from: "2026-12-12T21:00:00.000Z", until: "2026-12-15T16:00:00.000Z" });
    expect(wantedGuestCodes(root, mode("automatic"), { ...input, checkInTime: "14:00", checkoutTime: "10:00" })[0]!.window).toEqual({ from: "2026-12-12T19:00:00.000Z", until: "2026-12-15T15:00:00.000Z" });
  });

  it("moves with a changed booking and ends with a counted cancellation, but not one waiting on the host", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    email(root, { ...booked("HMSCRATCHAA", "2026-12-13", "2026-12-16"), kind: "changed" });
    expect(wantedGuestCodes(root, mode("automatic"), input)[0]!.window.until).toBe("2026-12-16T16:00:00.000Z");
    email(root, { kind: "cancelled", confirmationCode: "HMSCRATCHAA", checkIn: { date: "2026-12-13" }, checkout: { date: "2026-12-16" } }, "asked");
    expect(wantedGuestCodes(root, mode("automatic"), input)).toHaveLength(1);
    email(root, { kind: "cancelled", confirmationCode: "HMSCRATCHAA", checkIn: { date: "2026-12-13" }, checkout: { date: "2026-12-16" } }, "called-off");
    expect(wantedGuestCodes(root, mode("automatic"), input)).toEqual([]);
  });

  it("moves the end to a late checkout the host allowed", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15", { out: "11:00" }));
    appendGuestMessage(root, { id: "lc_scratch", at: NOW.toISOString(), event: "late-checkout", lateCheckout: { checkout: "2026-12-15", time: "13:00" } });
    expect(wantedGuestCodes(root, mode("automatic"), input)[0]!.window.until).toBe("2026-12-15T18:00:00.000Z");
  });

  it("drops a stay once its checkout has passed", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-05", "2026-12-08"));
    expect(wantedGuestCodes(root, mode("automatic"), input)).toEqual([]);
    expect(guestStays(root, input)).toEqual([]);
  });
});

describe("the host's choice", () => {
  it("wants nothing when unset or off", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    expect(wantedGuestCodes(root, emptyGuestCodes(), input)).toEqual([]);
    expect(wantedGuestCodes(root, mode("off"), input)).toEqual([]);
  });

  it("under ask, wants only the bookings the host said yes to", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    email(root, booked("HMSCRATCHBB", "2026-12-15", "2026-12-17"));
    expect(wantedGuestCodes(root, mode("ask"), input)).toEqual([]);
    const file = mode("ask", { stays: { HMSCRATCHBB: { yesAt: NOW.toISOString() } } });
    expect(wantedGuestCodes(root, file, input).map((item) => item.jobId)).toEqual(["stay:HMSCRATCHBB"]);
  });

  it("leaves out a booking that still needs the host's yes for its platform", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    expect(wantedGuestCodes(root, mode("automatic"), { ...input, needsHostYes: () => true })).toEqual([]);
  });
});

describe("stays from other platforms (#263)", () => {
  const other = (platform: "vrbo" | "booking" | "direct", code: string, checkIn: string, checkout: string): ParsedBookingEmail => ({ ...booked(code, checkIn, checkout), platform });

  it("wants no code for a booking still waiting on the host's yes, and one after it", () => {
    const root = folder();
    email(root, other("direct", "DB-4417", "2026-12-12", "2026-12-15"), "awaiting-host");
    expect(guestStays(root, input)).toEqual([]);
    expect(wantedGuestCodes(root, mode("automatic"), input)).toEqual([]);
    email(root, other("direct", "DB-4417", "2026-12-12", "2026-12-15"), "applied", true);
    expect(wantedGuestCodes(root, mode("automatic"), input).map((code) => code.jobId)).toEqual(["stay:direct:DB-4417"]);
  });

  it("gives the same reference on two platforms its own code each", () => {
    const root = folder();
    email(root, other("vrbo", "44172033", "2026-12-12", "2026-12-14"), "applied", true);
    email(root, other("booking", "44172033", "2026-12-14", "2026-12-16"), "applied", true);
    expect(wantedGuestCodes(root, mode("automatic"), input).map((code) => code.jobId)).toEqual(["stay:vrbo:44172033", "stay:booking:44172033"]);
  });

  it("gives two bookings with no reference their own code each", () => {
    const root = folder();
    email(root, other("direct", "", "2026-12-12", "2026-12-14"), "applied", true);
    email(root, other("direct", "", "2026-12-14", "2026-12-16"), "applied", true);
    const jobs = wantedGuestCodes(root, mode("automatic"), input).map((code) => code.jobId);
    expect(jobs).toEqual(["stay:direct:2026-12-12:2026-12-14", "stay:direct:2026-12-14:2026-12-16"]);
  });

  it("keeps an Airbnb booking's code named by its bare code, as before", () => {
    const root = folder();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    expect(wantedGuestCodes(root, mode("automatic"), input).map((code) => code.jobId)).toEqual(["stay:HMSCRATCHAA"]);
  });
});

describe("leases", () => {
  const lease = { id: "lease_scratch", name: "Sam", phone: "+15555550155", start: "2026-12-01", moveOut: "2027-06-30", addedAt: NOW.toISOString() };

  it("wants a code from the start to the end of move-out day, only after the tenant's YES, whatever the choice", () => {
    const root = folder();
    expect(wantedGuestCodes(root, { ...emptyGuestCodes(), leases: [lease] }, input)).toEqual([]);
    const yes = { ...lease, yesAt: NOW.toISOString() };
    expect(wantedGuestCodes(root, { ...emptyGuestCodes(), leases: [yes] }, input)).toEqual([
      { jobId: "lease:lease_scratch", person: "+15555550155", window: { from: "2026-12-01T05:00:00.000Z", until: "2027-07-01T03:59:00.000Z" }, label: "Sam", who: { role: "guest" } },
    ]);
    for (const ended of [{ ...yes, stoppedAt: NOW.toISOString() }, { ...yes, removedAt: NOW.toISOString() }, { ...yes, moveOut: "2026-12-09" }]) {
      expect(wantedGuestCodes(root, { ...emptyGuestCodes(), leases: [ended] }, input)).toEqual([]);
    }
  });
});

describe("labels", () => {
  it("names a stay by its dates, never by the guest", () => {
    expect(stayLabel("2026-12-12", "2026-12-15")).toBe("the guest on 12–15 Dec");
    expect(stayLabel("2026-12-30", "2027-01-02")).toBe("the guest on 30 Dec–2 Jan");
  });
});
