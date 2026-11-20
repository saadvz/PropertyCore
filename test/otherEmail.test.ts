import { describe, expect, it } from "vitest";
import { checkOtherEmail, type ExtractedBooking } from "../src/hub/otherEmail";
import { DOOR_CODE } from "./wiringProof";

/** The shape check on fields the agent extracted from a non-Airbnb booking email (#263). Made-up emails and references. */

const NOW = new Date("2026-10-14T15:00:00Z");
const SOURCE = { platform: "direct" as const, sender: "bookings@example.test" };
const EMAIL = {
  from: "My Place <bookings@example.test>",
  subject: "New Booking Notification for Oct 18-Oct 22 at Scratch Lane",
  body: "Oct 18, 2026 to Oct 22, 2026 at Scratch Lane for 3 guests from Website.\nBooking #DB-4417\nArrival 4:00 PM, departure 10:00 AM.",
};
const GOOD: ExtractedBooking = { kind: "confirmed", reference: "DB-4417", checkIn: { date: "2026-10-18", time: "16:00" }, checkout: { date: "2026-10-22", time: "10:00" }, guests: { adults: 2, children: 1 } };
const noCode = () => false;
const check = (extracted: unknown, email = EMAIL) => checkOtherEmail(email, extracted, SOURCE, NOW, noCode);

describe("checkOtherEmail", () => {
  it("takes good fields, with the platform and a guest total from adults and children", () => {
    expect(check(GOOD)).toEqual({
      ok: true,
      parsed: { kind: "confirmed", platform: "direct", confirmationCode: "DB-4417", checkIn: { date: "2026-10-18", time: "16:00" }, checkout: { date: "2026-10-22", time: "10:00" }, guests: { adults: 2, children: 1, infants: 0, total: 3 } },
    });
  });

  it("takes a booking with no reference, no times and no guests", () => {
    const bare = { kind: "cancelled", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22" } };
    expect(check(bare)).toEqual({ ok: true, parsed: { kind: "cancelled", platform: "direct", confirmationCode: "", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22" } } });
  });

  it.each([
    ["no fields at all", undefined, "extracted"],
    ["an unknown kind", { ...GOOD, kind: "inquiry" }, "kind"],
    ["a date that doesn't exist", { ...GOOD, checkIn: { date: "2026-02-30" } }, "checkIn"],
    ["checkout not after check-in", { ...GOOD, checkout: { date: "2026-10-18" } }, "checkout"],
    ["more than 60 nights", { ...GOOD, checkout: { date: "2026-12-18" } }, "checkout"],
    ["a check-in more than 2 years ahead", { ...GOOD, checkIn: { date: "2028-11-01" }, checkout: { date: "2028-11-03" } }, "checkIn"],
    ["a time that isn't HH:MM", { ...GOOD, checkout: { date: "2026-10-22", time: "10am" } }, "checkout"],
    ["no guests", { ...GOOD, guests: { adults: 0 } }, "guests"],
    ["51 guests", { ...GOOD, guests: { total: 51 } }, "guests"],
    ["a reference that isn't in the email", { ...GOOD, reference: "DB-9999" }, "reference"],
    ["a reference with other characters", { ...GOOD, reference: "DB 4417; drop" }, "reference"],
  ])("refuses %s", (_name, extracted, field) => {
    expect(check(extracted)).toMatchObject({ ok: false, reason: "bad-fields", field });
  });

  it("refuses fields that carry the door code", () => {
    const carries = (text: string) => text.includes(DOOR_CODE);
    expect(checkOtherEmail(EMAIL, { ...GOOD, listing: `Door ${DOOR_CODE}` }, SOURCE, NOW, carries)).toMatchObject({ ok: false, reason: "door-code" });
  });

  it("names the listing when given", () => {
    expect(check({ ...GOOD, listing: "Scratch Lane" })).toMatchObject({ ok: true, parsed: { listing: "Scratch Lane" } });
  });
});
