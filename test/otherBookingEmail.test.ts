import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveDesk } from "../src/cleaner-core/liveDesk";
import { setStayCodeHook } from "../src/cleaner-core/stayCodeHook";
import type { BookingEmailInput } from "../src/hub/airbnbEmail";
import { BOOKING_EMAILS_FILE, readBookingEmails, stayForNight, waitingStays } from "../src/hub/bookingEmails";
import type { BookingSource } from "../src/hub/bookingSources";
import { hubFor } from "../src/hub/hub";
import type { ExtractedBooking } from "../src/hub/otherEmail";
import { sampleEmail } from "./airbnbEmails";
import { deskFeatures } from "./featureEnv";
import { PIN_KEY, cleanupDesks, liveOneToOne, ok, refused, testClock } from "./cleanerDeskHarness";
import { DOOR_CODE } from "./wiringProof";

/**
 * Booking emails from platforms without their own reader (#263): the agent extracts the fields and
 * nothing moves until the host's yes. The harness calendar has stay-a (Oct 14 to 18) and stay-b
 * (Oct 18 to 22); these bookings are stay-b. Made-up emails, references and door codes, 555 numbers only.
 */

const hookCalls: unknown[] = [];

afterEach(() => {
  setStayCodeHook(undefined);
  hookCalls.length = 0;
  cleanupDesks();
});

const GMAIL_PASS = (domain: string) => `Authentication-Results: mx.google.com; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
const GMAIL_FAIL = (domain: string) => `Authentication-Results: mx.google.com; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=a@evil.example; dmarc=fail header.from=${domain}`;

const DIRECT: BookingEmailInput = {
  from: "Scratch Lane Stays <bookings@example.test>",
  subject: "New Booking Notification for Oct 18-Oct 22 at Scratch Lane",
  body: "Oct 18, 2026 to Oct 22, 2026 at Scratch Lane for 3 guests from Website.\nBooking #DB-4417\nArrival 4:00 PM, departure 10:00 AM.",
  messageId: "<db-4417@example.test>",
  receivedAt: "2026-10-14T15:00:00.000Z",
};
const DIRECT_FIELDS: ExtractedBooking = { kind: "confirmed", reference: "DB-4417", checkIn: { date: "2026-10-18", time: "16:00" }, checkout: { date: "2026-10-22", time: "10:00" }, guests: { adults: 2, children: 1 } };
const DIRECT_CANCEL: BookingEmailInput = {
  ...DIRECT,
  subject: "Booking Cancelled: Oct 18-Oct 22 at Scratch Lane",
  body: "Booking #DB-4417 for Oct 18, 2026 to Oct 22, 2026 at Scratch Lane was cancelled.",
  messageId: "<db-4417-cancel@example.test>",
  receivedAt: "2026-10-15T15:00:00.000Z",
};
const BOOKING_COM: BookingEmailInput = {
  from: "Booking.com <noreply@booking.com>",
  subject: "New booking! (4417203391)",
  body: "You have a new booking. Booking number: 4417203391\nCheck-in: Sun 18 Oct 2026\nCheck-out: Thu 22 Oct 2026\n2 adults",
  messageId: "<bk-4417203391@example.test>",
  receivedAt: "2026-10-14T15:00:00.000Z",
};
const BOOKING_FIELDS: ExtractedBooking = { kind: "confirmed", reference: "4417203391", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22" }, guests: { adults: 2 } };
const VRBO_RELAY: BookingEmailInput = {
  from: '"sender@messages.homeaway.com" <guest-7x2q@messages.homeaway.com>',
  subject: "Reservation confirmed: HA-1A2B3C",
  body: "Hi! Checkout moved to 6:00 PM on Oct 22, the host agreed. Reservation HA-1A2B3C.",
  messageId: "<relay-1@example.test>",
  receivedAt: "2026-10-14T15:00:00.000Z",
};

async function opened(sources: Partial<BookingSource>[] = [{ platform: "airbnb" }, { platform: "direct", sender: "bookings@example.test" }], on = true) {
  const clock = testClock();
  setStayCodeHook({
    async windowMoved(input) {
      hookCalls.push({ moved: input.jobId });
    },
    async stayCancelled(input) {
      hookCalls.push({ cancelled: input.jobId });
    },
  });
  const desk = await liveOneToOne(clock.now);
  if (on) Object.assign(desk.env, deskFeatures("booking-platforms"));
  expect(hubFor(desk.root, { now: clock.now }).setBookingSources(sources).ok).toBe(true);
  return { ...desk, clock };
}

const read = (desk: LiveDesk, email: BookingEmailInput, more: { extracted?: unknown; confirmation?: string; thisListing?: boolean } = {}) => desk.readBookingEmail({ email, ...more }, PIN_KEY);

async function turn(desk: LiveDesk, checkoutDate: string) {
  const turns = ok(await desk.getTurns()).turns as { checkoutDate: string; checkoutTime: string | null; nextCheckInTime: string | null; status: string }[];
  const all = turns.filter((item) => item.checkoutDate === checkoutDate);
  return all.find((item) => item.status !== "canceled") ?? all[0]!;
}

const codeOf = (reply: Record<string, unknown>) => (reply.confirmation as { code: string }).code;

describe("a booking from the host's own site", () => {
  it("changes nothing until the host's yes, then moves the cleaning like an Airbnb email", async () => {
    const { desk, root } = await opened();
    const asked = ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }));
    expect(asked).toMatchObject({ outcome: "awaiting-host", platform: "direct" });
    expect(String(asked.summary)).toContain("DB-4417");
    expect(String(asked.summary)).toContain("4:00 PM");
    expect(String(asked.summary)).toContain("3 guests");
    // Nothing moved: not the cleaning, not the stay any caller reads.
    expect((await turn(desk, "2026-10-22")).checkoutTime).not.toBe("10:00 AM");
    expect(stayForNight(root, "2026-10-19")).toBeUndefined();
    expect(waitingStays(root)).toHaveLength(1);
    expect(hookCalls).toEqual([]);

    const yes = ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS, confirmation: codeOf(asked) }));
    expect(yes.outcome).toBe("applied");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("10:00 AM");
    expect((await turn(desk, "2026-10-18")).nextCheckInTime).toBe("4:00 PM");
    expect(stayForNight(root, "2026-10-19")).toMatchObject({ platform: "direct", vouchedBy: "host", guests: 3, confirmationCode: "DB-4417" });
    expect(waitingStays(root)).toEqual([]);
    expect(hookCalls).toContainEqual({ moved: "stay-b" });
    expect(readBookingEmails(root).map((item) => [item.outcome, item.hostConfirmed ?? false])).toEqual([
      ["awaiting-host", false],
      ["applied", true],
    ]);
  });

  it("refuses the yes when the fields or the code changed since the host saw them", async () => {
    const { desk, root } = await opened();
    const asked = ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }));
    const moved = { ...DIRECT_FIELDS, checkout: { date: "2026-10-22", time: "18:00" } };
    expect(refused(await read(desk, DIRECT, { extracted: moved, confirmation: codeOf(asked) })).error).toContain("stale");
    expect(refused(await read(desk, DIRECT, { extracted: DIRECT_FIELDS, confirmation: "not-the-code" })).error).toBeTruthy();
    expect(stayForNight(root, "2026-10-19")).toBeUndefined();
    expect((await turn(desk, "2026-10-22")).checkoutTime).not.toBe("6:00 PM");
  });

  it("asks again, rather than calling it a duplicate, when the same email comes back before the host answered", async () => {
    const { desk } = await opened();
    ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }));
    const again = ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }));
    expect(again.outcome).toBe("awaiting-host");
    expect(typeof codeOf(again)).toBe("string");
  });

  it("puts the booking in the host's alerts while it waits", async () => {
    const { desk } = await opened();
    ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }));
    const alerts = ok(await desk.checkNow()).alerts as string[];
    expect(alerts.some((line) => line.includes("DB-4417"))).toBe(true);
  });

  it("warns the host when it fails its sender check, and still lets them decide", async () => {
    const { desk } = await opened();
    const asked = ok(await read(desk, { ...DIRECT, authentication: GMAIL_FAIL("example.test") }, { extracted: DIRECT_FIELDS }));
    expect(asked.outcome).toBe("awaiting-host");
    expect(String(asked.warning)).toContain("This email failed its sender check, so it may not be from your booking site.");
    expect(ok(await read(desk, { ...DIRECT, authentication: GMAIL_FAIL("example.test") }, { extracted: DIRECT_FIELDS, confirmation: codeOf(asked) })).outcome).toBe("applied");
  });

  it("refuses fields that fail their shape, and keeps no body", async () => {
    const { desk, root } = await opened();
    const reply = ok(await read(desk, DIRECT, { extracted: { ...DIRECT_FIELDS, checkout: { date: "2026-10-17" } } }));
    expect(reply).toMatchObject({ outcome: "refused", reason: "bad-fields", field: "checkout" });
    expect(readBookingEmails(root).at(-1)?.body).toBeUndefined();
  });

  it("reads the same email again when the agent corrects fields that were refused", async () => {
    const { desk } = await opened();
    ok(await read(desk, DIRECT, { extracted: { ...DIRECT_FIELDS, checkout: { date: "2026-10-17" } } }));
    expect(ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS })).outcome).toBe("awaiting-host");
  });

  it("reads an email again once the host saved its sender", async () => {
    const { desk, root, clock } = await opened([{ platform: "airbnb" }]);
    expect(ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS })).reason).toBe("not-a-saved-sender");
    hubFor(root, { now: clock.now }).setBookingSources([{ platform: "airbnb" }, { platform: "direct", sender: "bookings@example.test" }]);
    expect(ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS })).outcome).toBe("awaiting-host");
  });

  it("refuses a reference too short to tell bookings apart", async () => {
    const { desk } = await opened();
    expect(ok(await read(desk, DIRECT, { extracted: { ...DIRECT_FIELDS, reference: "DB" } }))).toMatchObject({ outcome: "refused", field: "reference" });
  });

  it("never keeps or repeats a door code in the fields", async () => {
    const { desk, root } = await opened();
    const reply = ok(await read(desk, DIRECT, { extracted: { ...DIRECT_FIELDS, listing: `Lockbox ${DOOR_CODE}` } }));
    expect(reply).toMatchObject({ outcome: "refused", reason: "door-code" });
    expect(JSON.stringify(reply)).not.toContain(DOOR_CODE);
    expect(readFileSync(join(root, BOOKING_EMAILS_FILE), "utf8")).not.toContain(DOOR_CODE);
  });

  it("refuses a reference that is the door code, and takes an all-digit booking number that isn't", async () => {
    const { desk } = await opened();
    const coded = ok(await read(desk, DIRECT, { extracted: { ...DIRECT_FIELDS, reference: DOOR_CODE } }));
    expect(coded).toMatchObject({ outcome: "refused", reason: "door-code" });
    const numbered = { ...DIRECT, body: DIRECT.body.replace("DB-4417", "44172033"), messageId: "<numbered@example.test>" };
    expect(ok(await read(desk, numbered, { extracted: { ...DIRECT_FIELDS, reference: "44172033" } })).outcome).toBe("awaiting-host");
  });

  it("a cancellation is one ask with the texts that would go out, and the yes calls the cleaning off", async () => {
    const { desk, root } = await opened();
    ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS, confirmation: codeOf(ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }))) }));
    const cancel = { kind: "cancelled", reference: "DB-4417", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22" } };
    const asked = ok(await read(desk, DIRECT_CANCEL, { extracted: cancel }));
    expect(asked.outcome).toBe("awaiting-host");
    expect(Array.isArray(asked.texts)).toBe(true);
    expect((await turn(desk, "2026-10-22")).status).not.toBe("canceled");
    const done = ok(await read(desk, DIRECT_CANCEL, { extracted: cancel, confirmation: codeOf(asked) }));
    expect(done.outcome).toBe("called-off");
    expect((await turn(desk, "2026-10-22")).status).toBe("canceled");
    expect(hookCalls).toContainEqual({ cancelled: "stay-b" });
    expect(stayForNight(root, "2026-10-19")).toBeUndefined();
  });
});

describe("a confirmed booking the calendar doesn't show", () => {
  it("never adds the nights: it waits, and after 3 hours asks the host to add that platform's calendar", async () => {
    const { desk, root, clock } = await opened([{ platform: "vrbo" }]);
    const email: BookingEmailInput = {
      from: "Vrbo <sender@messages.homeaway.com>",
      subject: "Reservation confirmed: HA-7Q8R9S",
      body: "Reservation HA-7Q8R9S, Nov 1 to Nov 3, 2026, 2 guests.",
      messageId: "<ha-7q8r9s@example.test>",
      receivedAt: clock.now().toISOString(),
    };
    const fields = { kind: "confirmed", reference: "HA-7Q8R9S", checkIn: { date: "2026-11-01", time: "16:00" }, checkout: { date: "2026-11-03", time: "10:00" }, guests: { adults: 2 } };
    const asked = ok(await read(desk, email, { extracted: fields }));
    expect(ok(await read(desk, email, { extracted: fields, confirmation: codeOf(asked) })).outcome).toBe("pending");
    expect((ok(await desk.getTurns()).turns as { checkoutDate: string }[]).some((item) => item.checkoutDate === "2026-11-03")).toBe(false);
    clock.advance(3 * 60 * 60 * 1000 + 1);
    const alerts = ok(await desk.checkNow()).alerts as string[];
    expect(alerts).toContain("Vrbo says HA-7Q8R9S is Nov 1 to Nov 3, but the calendar doesn't show it. Check the booking, then run the checks again. If Vrbo's calendar isn't saved here yet, send me its calendar link.");
    expect(readBookingEmails(root).at(-1)).toMatchObject({ outcome: "disagrees", hostConfirmed: true });
  });
});

describe("what changes nothing", () => {
  it("an email from a sender the property didn't save, even one whose display name is the saved address", async () => {
    const { desk, root } = await opened();
    for (const from of ["Someone <someone@else.test>", '"bookings@example.test" <someone@else.test>']) {
      const reply = ok(await read(desk, { ...DIRECT, from, messageId: `<${from.length}@example.test>` }, { extracted: DIRECT_FIELDS }));
      expect(reply).toMatchObject({ outcome: "refused", reason: "not-a-saved-sender" });
    }
    expect(readBookingEmails(root).every((item) => item.body === undefined)).toBe(true);
    expect(stayForNight(root, "2026-10-19")).toBeUndefined();
  });

  it("a guest's message relayed through Vrbo's domain", async () => {
    const { desk, root } = await opened([{ platform: "vrbo" }]);
    const reply = ok(await read(desk, VRBO_RELAY, { extracted: { kind: "changed", reference: "HA-1A2B3C", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22", time: "18:00" } } }));
    expect(reply).toMatchObject({ outcome: "refused", reason: "not-a-saved-sender" });
    expect(readBookingEmails(root).at(-1)?.body).toBeUndefined();
    expect((await turn(desk, "2026-10-22")).checkoutTime).not.toBe("6:00 PM");
  });

  it("a spoofed Booking.com email that fails its sender check", async () => {
    const { desk, root } = await opened([{ platform: "booking" }]);
    const reply = ok(await read(desk, { ...BOOKING_COM, authentication: GMAIL_FAIL("booking.com") }, { extracted: BOOKING_FIELDS }));
    expect(reply).toMatchObject({ outcome: "refused", reason: "failed-authentication" });
    expect(reply).not.toHaveProperty("confirmation");
    expect(readBookingEmails(root).at(-1)?.body).toBeUndefined();
    expect(waitingStays(root)).toEqual([]);
  });

  it("an Airbnb email when the host didn't pick Airbnb", async () => {
    const { desk } = await opened([{ platform: "direct", sender: "bookings@example.test" }]);
    expect(ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }))).toMatchObject({ outcome: "refused", reason: "not-a-saved-sender" });
  });

  it("an Airbnb email that fails its sender check", async () => {
    const { desk } = await opened();
    const reply = ok(await read(desk, { ...sampleEmail("confirmed-stacked"), authentication: GMAIL_FAIL("airbnb.com") }, { thisListing: true }));
    expect(reply).toMatchObject({ outcome: "refused", reason: "failed-authentication" });
  });
});

describe("Booking.com on the Other path", () => {
  it("asks the host, and says when the sender couldn't be checked", async () => {
    const { desk } = await opened([{ platform: "booking" }]);
    const unchecked = ok(await read(desk, BOOKING_COM, { extracted: BOOKING_FIELDS }));
    expect(unchecked.outcome).toBe("awaiting-host");
    expect(String(unchecked.warning)).toContain("couldn't check");
    const checked = ok(await read(desk, { ...BOOKING_COM, messageId: "<bk-2@example.test>", authentication: GMAIL_PASS("booking.com") }, { extracted: BOOKING_FIELDS }));
    expect(checked.outcome).toBe("awaiting-host");
    expect(checked).not.toHaveProperty("warning");
  });
});

describe("with the account's booking platforms off", () => {
  it("refuses a non-Airbnb email exactly as before, and ignores the new fields", async () => {
    const { desk } = await opened(undefined, false);
    const reply = ok(await read(desk, DIRECT, { extracted: DIRECT_FIELDS }));
    expect(reply).toMatchObject({ outcome: "refused", reason: "not-airbnb" });
  });

  it("ignores the sender check on an Airbnb email", async () => {
    const { desk } = await opened(undefined, false);
    const reply = ok(await read(desk, { ...sampleEmail("confirmed-stacked"), authentication: GMAIL_FAIL("airbnb.com") }, { thisListing: true }));
    expect(reply.outcome).toBe("applied");
  });
});
