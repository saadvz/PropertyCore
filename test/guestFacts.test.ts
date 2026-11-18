import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asksLateCheckout, factProblem, holdsDoorCode, matchFacts, type GuestFact } from "../src/guest-messages/facts";
import {
  appendGuestMessage,
  GUEST_FACTS_FILE,
  GUEST_MESSAGES_FILE,
  GuestFactsFileError,
  lateCheckoutFor,
  messageIdFor,
  readGuestFacts,
  readGuestMessages,
  writeGuestFacts,
  type GuestMessageRecord,
} from "../src/guest-messages/store";

/** The house's facts for guests and the guest log (#242). Made-up door codes only. */

const AT = "2026-10-14T15:00:00.000Z";
const fact = (topic: GuestFact["topic"], text: string): GuestFact => ({ topic, text, savedAt: AT });
const code = (...digits: string[]) => digits.join("");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "guest-facts-"));
  roots.push(root);
  return root;
}

describe("a house fact", () => {
  it("refuses a fact holding a door code without repeating it", () => {
    for (const [topic, text] of [
      ["check_in", `Lockbox code is ${code("7", "3", "5", "0")}`],
      ["check_in", `Gate: ${code("1", "2", "3", "4")}#`],
      ["other", `The PIN is ${code("5", "5", "5", "5")}`],
    ] as const) {
      const problem = factProblem(topic, text);
      expect(problem).toBeDefined();
      expect(problem).not.toMatch(/\d{4}/);
    }
    expect(factProblem("check_in", `Lockbox code is ${code("7", "3", "5", "0")}`)).toContain("check-in");
  });

  it("keeps a wifi password", () => {
    expect(factProblem("wifi", "Network HarborGuest, password sunny2024")).toBeUndefined();
    expect(holdsDoorCode("password 123456")).toBe(false);
    expect(holdsDoorCode("door code 123456")).toBe(true);
  });

  it("refuses empty and over-long facts", () => {
    expect(factProblem("parking", "")).toBeDefined();
    expect(factProblem("parking", "   ")).toBeDefined();
    expect(factProblem("parking", "x".repeat(501))).toBeDefined();
    expect(factProblem("parking", "x".repeat(500))).toBeUndefined();
    expect(factProblem("parking", 42)).toBeDefined();
  });
});

describe("which facts answer a message", () => {
  it("matches the topics a message touches", () => {
    const wifi = fact("wifi", "Network HarborGuest, password sunny2024.");
    expect(matchFacts("What's the wifi password and where do we park?", [wifi, fact("trash", "Bins go out Tuesday night.")])).toEqual({ facts: [wifi], missing: ["parking"], isNew: false });
  });

  it("marks a question nothing answers as new", () => {
    expect(matchFacts("Is there a hair dryer?", [fact("wifi", "Network HarborGuest.")])).toEqual({ facts: [], missing: [], isNew: true });
  });

  it("matches an other fact on a shared word", () => {
    const dryer = fact("other", "Hair dryer is under the bathroom sink.");
    expect(matchFacts("Is there a hair dryer?", [dryer, fact("other", "Beach towels are in the hall closet.")]).facts).toEqual([dryer]);
  });

  it("marks a topic with nothing saved as missing and new", () => {
    expect(matchFacts("Where do we park?", [])).toEqual({ facts: [], missing: ["parking"], isNew: true });
  });

  it("spots a late checkout ask", () => {
    for (const text of ["Could we do a late checkout?", "Can we check out at 1?", "ok if we stay a bit longer on Sunday", "Could we leave a little later?", "Is an extra hour possible on our last day?"]) expect(asksLateCheckout(text)).toBe(true);
    for (const text of ["What time is checkout?", "Where do we park?"]) expect(asksLateCheckout(text)).toBe(false);
  });
});

describe("the facts file and the guest log", () => {
  it("writes and reads the facts, and refuses a broken file", () => {
    const root = folder();
    expect(readGuestFacts(root)).toEqual({ facts: [], skipped: [] });
    writeGuestFacts(root, { facts: [fact("wifi", "Network HarborGuest.")], skipped: ["area"] });
    expect(readGuestFacts(root)).toEqual({ facts: [fact("wifi", "Network HarborGuest.")], skipped: ["area"] });
    writeFileSync(join(root, GUEST_FACTS_FILE), "{");
    expect(() => readGuestFacts(root)).toThrow(GuestFactsFileError);
  });

  it("appends records and skips a line it can't read", () => {
    const root = folder();
    const one: GuestMessageRecord = { at: AT, id: "gm_1", event: "taken" };
    appendGuestMessage(root, one);
    appendFileSync(join(root, GUEST_MESSAGES_FILE), "not json\n");
    appendGuestMessage(root, { ...one, id: "gm_2" });
    expect(readGuestMessages(root).map((record) => record.id)).toEqual(["gm_1", "gm_2"]);
  });

  it("gives one email the same id every time", () => {
    const email = { from: "Airbnb <automated@airbnb.com>", subject: "RE: Reservation at X", messageId: "<a@example.test>" };
    expect(messageIdFor(email, "hash")).toBe(messageIdFor(email, "other"));
    expect(messageIdFor(email, "hash")).toMatch(/^gm_[0-9a-f]{12}$/);
    expect(messageIdFor({ ...email, messageId: undefined }, "hash")).not.toBe(messageIdFor({ ...email, messageId: undefined }, "other"));
  });

  it("lateCheckoutFor returns the latest for that checkout date", () => {
    const late = (time: string, checkout = "2026-10-18"): GuestMessageRecord => ({ at: AT, id: "lc_1", event: "late-checkout", lateCheckout: { checkout, time } });
    expect(lateCheckoutFor([late("13:00"), late("12:00"), late("14:00", "2026-10-22")], "2026-10-18")).toBe("12:00");
    expect(lateCheckoutFor([late("13:00")], "2026-10-25")).toBeUndefined();
  });
});
