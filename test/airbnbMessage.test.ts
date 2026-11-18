import { describe, expect, it } from "vitest";
import { MAX_MESSAGE, parseAirbnbMessage } from "../src/guest-messages/airbnbMessage";
import { sampleMessage } from "./airbnbEmails";

/** Airbnb's guest-message emails (#242). Made-up emails, made-up HM codes and door codes. */

const NOW = new Date("2026-10-14T15:00:00.000Z");
const parse = (name: string) => parseAirbnbMessage(sampleMessage(name), NOW);

describe("reading an Airbnb guest-message email", () => {
  it("reads a message on a reservation", () => {
    expect(parse("message")).toEqual({
      ok: true,
      parsed: {
        kind: "message",
        guest: "Jamie",
        text: "Hi! Where should we park when we get there?",
        listing: "Harbor Cottage by the Water",
        checkIn: "2026-10-18",
        checkout: "2026-10-22",
        confirmationCode: "HMXK4Q2Z9R",
      },
    });
  });

  it("cuts the message at Airbnb's footer", () => {
    const read = parse("message-footer");
    if (!read.ok) throw new Error(read.reason);
    expect(read.parsed.guest).toBe("Jamie");
    expect(read.parsed.text).toBe("Thanks so much! One more thing: which day is trash pickup?\nWe want to put the bins out before we leave.");
    expect(read.parsed.text).not.toContain("Respond to");
    expect(read.parsed.text).not.toContain("https://");
    expect(read.parsed.text).not.toContain("Airbnb, Inc.");
    expect(read.parsed.confirmationCode).toBeUndefined();
  });

  it("reads an inquiry with no code", () => {
    const read = parse("inquiry");
    if (!read.ok) throw new Error(read.reason);
    expect(read.parsed).toMatchObject({ kind: "inquiry", guest: "Morgan", checkIn: "2026-11-20", checkout: "2026-11-23", listing: "Harbor Cottage by the Water" });
    expect(read.parsed.confirmationCode).toBeUndefined();
  });

  it("refuses a booking email, a sender not at airbnb.com and an empty message", () => {
    expect(parse("booking-confirmed")).toEqual({ ok: false, reason: "booking-email" });
    expect(parse("not-airbnb")).toEqual({ ok: false, reason: "not-airbnb" });
    expect(parse("empty")).toEqual({ ok: false, reason: "no-message" });
    expect(parseAirbnbMessage({ ...sampleMessage("message"), subject: "Your payout was sent" }, NOW)).toEqual({ ok: false, reason: "not-a-message" });
  });

  it("reads a confirmation code that sits on the same line as the word code", () => {
    const email = sampleMessage("message");
    const read = parseAirbnbMessage({ ...email, body: email.body.replace(/Confirmation code\s*\n\s*HMXK4Q2Z9R/, "Confirmation code HMAB123456") }, NOW);
    if (!read.ok) throw new Error(read.reason);
    expect(read.parsed.confirmationCode).toBe("HMAB123456");
  });

  it("takes a door code out of the guest's words", () => {
    const read = parse("door-code");
    if (!read.ok) throw new Error(read.reason);
    expect(read.parsed.text).toContain("[code removed]");
    expect(read.parsed.text).not.toContain("7350");
  });

  it("keeps a long message to 2,000 characters", () => {
    const long = sampleMessage("message");
    const read = parseAirbnbMessage({ ...long, body: `Jamie Rivera\n${"word ".repeat(1000)}` }, NOW);
    if (!read.ok) throw new Error(read.reason);
    expect(read.parsed.text.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(MAX_MESSAGE).toBe(2000);
  });
});
