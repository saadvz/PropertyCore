import { describe, expect, it } from "vitest";
import { CODE_REMOVED, fromAirbnb, normalizeListing, parseAirbnbEmail, redactBookingEmail, type BookingEmailInput } from "../src/hub/airbnbEmail";
import { sampleEmail } from "./airbnbEmails";

/** Made-up Airbnb emails, made-up HM codes and door codes, 555 numbers only. */

const NOW = new Date("2026-10-14T15:00:00.000Z");

const parsed = (email: BookingEmailInput, now = NOW) => {
  const result = parseAirbnbEmail(email, now);
  if (!result.ok) throw new Error(`Refused: ${result.reason}`);
  return result.parsed;
};

describe("reading an Airbnb reservation email", () => {
  it("reads a confirmation laid out one block per label", () => {
    expect(parsed(sampleEmail("confirmed-stacked"))).toEqual({
      kind: "confirmed",
      confirmationCode: "HMXK4Q2Z9R",
      listing: "Harbor Cottage by the Water",
      checkIn: { date: "2026-10-18", time: "15:00" },
      checkout: { date: "2026-10-22", time: "12:00" },
      guests: { adults: 2, children: 1, infants: 1, total: 3 },
    });
  });

  it("reads a confirmation with the check-in and checkout side by side, and a January stay booked in December is next year's", () => {
    const email = sampleEmail("confirmed-columns", "2026-12-28T18:00:00.000Z");
    expect(parsed(email, new Date("2026-12-28T18:00:00.000Z"))).toEqual({
      kind: "confirmed",
      confirmationCode: "HMB7TT3P2M",
      listing: "Harbor Cottage by the Water",
      checkIn: { date: "2027-01-03", time: "16:00" },
      checkout: { date: "2027-01-05", time: "10:00" },
      guests: { adults: 3, children: 0, infants: 0, total: 3 },
    });
  });

  it("reads a change", () => {
    const change = parsed(sampleEmail("changed"));
    expect(change.kind).toBe("changed");
    expect(change.checkout).toEqual({ date: "2026-10-22", time: "14:00" });
    expect(change.guests?.total).toBe(2);
  });

  it("reads a cancellation's date range, and one with no dates by its code alone", () => {
    expect(parsed(sampleEmail("cancelled-range"))).toEqual({
      kind: "cancelled",
      confirmationCode: "HMXK4Q2Z9R",
      checkIn: { date: "2026-10-18" },
      checkout: { date: "2026-10-22" },
    });
    expect(parsed(sampleEmail("cancelled-bare"))).toEqual({ kind: "cancelled", confirmationCode: "HMXK4Q2Z9R" });
  });

  it("refuses an email that isn't from Airbnb, including a forward from the host", () => {
    expect(parseAirbnbEmail(sampleEmail("forwarded"), NOW)).toEqual({ ok: false, reason: "not-airbnb" });
    expect(parseAirbnbEmail({ ...sampleEmail("confirmed-stacked"), from: "Airbnb <automated@airbnb.com.example.net>" }, NOW)).toEqual({ ok: false, reason: "not-airbnb" });
    expect(fromAirbnb("automated@airbnb.com")).toBe(true);
    expect(fromAirbnb("Airbnb <express@mail.airbnb.com>")).toBe(true);
    expect(fromAirbnb("Airbnb <automated@notairbnb.com>")).toBe(false);
  });

  it("refuses a guest message, and a reservation email with no code or no dates", () => {
    expect(parseAirbnbEmail(sampleEmail("guest-message"), NOW)).toEqual({ ok: false, reason: "not-a-reservation" });
    const stacked = sampleEmail("confirmed-stacked");
    expect(parseAirbnbEmail({ ...stacked, body: stacked.body.replace("HMXK4Q2Z9R", "") }, NOW)).toEqual({ ok: false, reason: "no-code" });
    expect(parseAirbnbEmail({ ...stacked, body: "Confirmation code HMXK4Q2Z9R" }, NOW)).toEqual({ ok: false, reason: "no-dates" });
  });

  it("leaves a side's time out when the email shows none", () => {
    const stacked = sampleEmail("confirmed-stacked");
    const flexible = parsed({ ...stacked, body: stacked.body.replace("3:00 PM", "Flexible") });
    expect(flexible.checkIn).toEqual({ date: "2026-10-18" });
    expect(flexible.checkout).toEqual({ date: "2026-10-22", time: "12:00" });
  });
});

describe("reading the awkward ones", () => {
  it("trusts only the address the email was sent from, not a display name that looks like Airbnb's", () => {
    expect(fromAirbnb('"Airbnb <automated@airbnb.com>" <phish@evil.example>')).toBe(false);
    expect(fromAirbnb("automated@airbnb.com <phish@evil.example>")).toBe(false);
    expect(fromAirbnb("Airbnb automated@airbnb.com")).toBe(false);
    expect(fromAirbnb("  automated@airbnb.com  ")).toBe(true);
  });

  it("gives a time on the checkout side of the columns to the checkout, even when check-in is Flexible", () => {
    const columns = sampleEmail("confirmed-columns", "2026-12-28T18:00:00.000Z");
    const body = columns.body.replace("4:00 PM                  10:00 AM", "Flexible                 11:00 AM");
    const read = parsed({ ...columns, body }, new Date("2026-12-28T18:00:00.000Z"));
    expect(read.checkIn).toEqual({ date: "2027-01-03" });
    expect(read.checkout).toEqual({ date: "2027-01-05", time: "11:00" });
  });

  it("takes a time only from the date's own line or a line that is just a time", () => {
    const stacked = sampleEmail("confirmed-stacked");
    const body = stacked.body.replace("Sun, Oct 18\n3:00 PM", "Sun, Oct 18\nFlexible").replace("Thu, Oct 22\n12:00 PM", "Thu, Oct 22\nLate checkout until 2 PM is $40");
    const read = parsed({ ...stacked, body });
    expect(read.checkIn).toEqual({ date: "2026-10-18" });
    expect(read.checkout).toEqual({ date: "2026-10-22" });
  });

  it("reads only real labels, not a sentence that starts like one or the Guest paid line", () => {
    const stacked = sampleEmail("confirmed-stacked");
    const body = `Check-in is easy, see you Dec 1!\nGuest paid 4 guests worth\n${stacked.body}`;
    const read = parsed({ ...stacked, body });
    expect(read.checkIn).toEqual({ date: "2026-10-18", time: "15:00" });
    expect(read.guests?.total).toBe(3);
  });

  it("puts a stay over New Year in the right years when the email comes in January", () => {
    const stacked = sampleEmail("confirmed-stacked", "2027-01-02T12:00:00.000Z");
    const body = stacked.body.replace("Sun, Oct 18", "Wed, Dec 30").replace("Thu, Oct 22", "Sun, Jan 3");
    const read = parsed({ ...stacked, body }, new Date("2027-01-02T12:00:00.000Z"));
    expect(read.checkIn?.date).toBe("2026-12-30");
    expect(read.checkout?.date).toBe("2027-01-03");
  });

  it("doesn't read when a cancellation was made as the stay's dates", () => {
    const bare = sampleEmail("cancelled-bare");
    const read = parsed({ ...bare, body: `Reservation HMXK4Q2Z9R was canceled on Nov 14, 2026 - 10:32 AM.\n\n${bare.body}` });
    expect(read.checkIn).toBeUndefined();
    expect(read.checkout).toBeUndefined();
    const range = sampleEmail("cancelled-range");
    const both = parsed({ ...range, body: `Canceled on Oct 10, 2026 - 9:15 AM.\n${range.body}` });
    expect(both.checkIn).toEqual({ date: "2026-10-18" });
    expect(both.checkout).toEqual({ date: "2026-10-22" });
  });

  it("treats a request as not yet a change", () => {
    const changed = sampleEmail("changed");
    expect(parseAirbnbEmail({ ...changed, subject: "Alteration request: HMXK4Q2Z9R" }, NOW)).toEqual({ ok: false, reason: "not-a-reservation" });
    expect(parseAirbnbEmail({ ...changed, subject: "Cancellation request for HMXK4Q2Z9R" }, NOW)).toEqual({ ok: false, reason: "not-a-reservation" });
    expect(parsed({ ...changed, subject: "Alteration request accepted: HMXK4Q2Z9R" }).kind).toBe("changed");
  });
});

describe("taking door codes out of an email", () => {
  it("removes digits on a line about a code, lock or keypad, and on the line after one, and keeps the HM code and phone numbers", () => {
    const body = sampleEmail("door-code").body;
    const clean = redactBookingEmail(body);
    expect(clean).not.toContain("6907");
    expect(clean).not.toContain("8088");
    expect(clean).toContain(`Lockbox code: ${CODE_REMOVED}`);
    expect(clean).toContain("HMQ9W2E4R6");
    expect(clean).toContain("+15555550123");
    expect(redactBookingEmail("Door code:\n7316\nSee you soon")).not.toContain("7316");
  });

  it("removes codes the access words miss: enter, garage opener, passcode, combination, alarm, a PIN run into its digits, and codes split by spaces", () => {
    const lines = [
      "Please enter 3156 then press the star.",
      "Garage opener: 7731",
      "Passcode 9024",
      "Combo is 135",
      "Alarm 6650",
      "PIN3378",
      "Code: 31 56",
      "Lock: 3-1-5-6",
      "Gate code is below",
      "3 1 5 6",
    ];
    const clean = redactBookingEmail(lines.join("\n"));
    for (const digits of ["3156", "7731", "9024", "135", "6650", "3378", "31 56", "3-1-5-6", "3 1 5 6"]) expect(clean).not.toContain(digits);
    expect(redactBookingEmail("Confirmation code\nHMQ9W2E4R6")).toContain("HMQ9W2E4R6");
  });

  it("removes what the door-code guard says carries the saved code", () => {
    const clean = redactBookingEmail("Your number is 5 1 9 3, welcome!", (text) => /5\s?1\s?9\s?3/.test(text));
    expect(clean).not.toMatch(/5\s?1\s?9\s?3/);
  });
});

describe("comparing listing titles", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(normalizeListing("  Harbor Cottage — by the Water! ")).toBe(normalizeListing("harbor cottage by the water"));
    expect(normalizeListing("Café & Loft")).toBe("cafe and loft");
  });
});
