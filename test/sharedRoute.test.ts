import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_EVERY_MS, HOLD_MS, LineAsks } from "../src/hosted/lineAsks";
import { answerOf, businessFor, droppedNote, lineStartText, lineStopText, namedProperty, sharedRefusal, whichPropertyText, type Named } from "../src/hosted/sharedRoute";

/** Property names, the which-property ask, and held line texts (saadvz/PropertyCore#190). */

const A: Named = { id: "prp_aaaaaaaaaa", label: "Beach", address: "12 Scratch Lane, Teaneck, NJ 07666" };
const B: Named = { id: "prp_bbbbbbbbbb", label: "Court", nickname: "the cottage", address: "8 Scratch Court, Teaneck, NJ 07666" };
const C: Named = { id: "prp_cccccccccc", label: "Annex", address: "9 Scratch Annex, Teaneck, NJ 07666" };
const PHONE = "+15555550101";

describe("namedProperty", () => {
  it("finds a property by its street, nickname or label, ignoring case", () => {
    expect(namedProperty("running late at scratch lane", [A, B])).toBe(A.id);
    expect(namedProperty("the Cottage door sticks", [A, B])).toBe(B.id);
    expect(namedProperty("beach is done", [A, B])).toBe(A.id);
  });

  it("only counts a whole word or phrase", () => {
    expect(namedProperty("thanks for the courtesy", [A, B])).toBeUndefined();
  });

  it("two matches are no match", () => {
    expect(namedProperty("lane and court both done", [{ ...A, label: "Lane" }, B])).toBeUndefined();
  });

  it("a plain reply names nothing", () => {
    expect(namedProperty("YES", [A, B])).toBeUndefined();
  });
});

describe("answerOf", () => {
  it("takes a bare number from the list, or a name", () => {
    expect(answerOf("1", [A, B])).toBe(A.id);
    expect(answerOf(" 2 ", [A, B])).toBe(B.id);
    expect(answerOf("3", [A, B])).toBeUndefined();
    expect(answerOf("8 scratch court", [A, B])).toBe(B.id);
  });

  it("a number inside a sentence is no answer", () => {
    expect(answerOf("2 towels left", [A, B])).toBeUndefined();
  });
});

describe("texts", () => {
  it("the ask lists the street part of each address, never a label", () => {
    expect(whichPropertyText([A, B])).toBe("Which property is this about? Reply 1 for 12 Scratch Lane or 2 for 8 Scratch Court.");
    expect(whichPropertyText([A, B, C])).toBe("Which property is this about? Reply 1 for 12 Scratch Lane, 2 for 8 Scratch Court or 3 for 9 Scratch Annex.");
    expect(whichPropertyText([A, B])).not.toContain("Beach");
  });

  it("the line's replies, the dropped note and the refusal read exactly", () => {
    expect(lineStopText("Scratch")).toBe("You're opted out of texts from Scratch. Reply START to opt back in. Reply HELP for help.");
    expect(lineStartText("Scratch")).toBe("You're opted back in to texts from Scratch. Reply STOP to opt out.");
    expect(droppedNote("Ana")).toBe("A text from Ana couldn't be matched to a property.");
    expect(sharedRefusal([{ label: "12 Scratch Lane", role: "cleaner" }])).toBe(
      "That number is already on 12 Scratch Lane as the cleaner. Ask the host whether the same person helps here too, then save again with shared: true.",
    );
    expect(sharedRefusal([{ label: "12 Scratch Lane", role: "cleaner" }, { label: "8 Scratch Court", role: "observer" }])).toBe(
      "That number is already on 12 Scratch Lane as the cleaner and on 8 Scratch Court as the observer. Ask the host whether the same person helps here too, then save again with shared: true.",
    );
  });

  it("businessFor names the one shared business, else this number", () => {
    expect(businessFor(["Scratch", "Scratch"])).toBe("Scratch");
    expect(businessFor(["Scratch", "Other"])).toBe("this number");
    expect(businessFor([undefined])).toBe("this number");
  });
});

describe("LineAsks", () => {
  it("holds one text per phone, asks at most every 10 minutes, and drops it after 2 hours", () => {
    const root = mkdtempSync(join(tmpdir(), "asks-"));
    let at = Date.parse("2026-11-07T12:00:00.000Z");
    const now = () => new Date(at);
    const asks = new LineAsks(root, now);
    const text = (id: string) => ({ id, text: `hi ${id}`, propertyIds: [A.id, B.id] });
    expect(asks.hold(PHONE, text("SM1"))).toEqual({ ask: true });
    at += 5 * 60_000;
    expect(asks.hold(PHONE, text("SM2"))).toEqual({ ask: false });
    expect(asks.held(PHONE)?.id).toBe("SM2");
    at += ASK_EVERY_MS + 60_000;
    expect(asks.hold(PHONE, text("SM3"))).toEqual({ ask: true });
    expect(new LineAsks(root, now).held(PHONE)?.id).toBe("SM3");
    expect(asks.take(PHONE)?.id).toBe("SM3");
    expect(asks.held(PHONE)).toBeUndefined();

    asks.hold(PHONE, text("SM4"));
    at += HOLD_MS + 1;
    expect(asks.held(PHONE)).toBeUndefined();
    expect(asks.expired().map((e) => [e.phone, e.text.id])).toEqual([[PHONE, "SM4"]]);
    expect(asks.expired()).toEqual([]);
  });
});
