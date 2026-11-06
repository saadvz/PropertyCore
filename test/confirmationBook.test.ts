import { describe, expect, it } from "vitest";
import { ConfirmationBook } from "../src/operator/confirmations";

describe("ConfirmationBook", () => {
  it("keeps a code from a book with no expiry", () => {
    let at = 0;
    const book = new ConfirmationBook(Number.POSITIVE_INFINITY, () => at);
    const issued = book.issue("a", "t", "f", "q?");
    expect(issued).not.toHaveProperty("expiresInMinutes");
    at = 365 * 24 * 60 * 60_000;
    expect(() => book.redeem(issued.code, "a", "t", "f")).not.toThrow();
  });

  it("still expires a code from the 10-minute book", () => {
    let at = 0;
    const book = new ConfirmationBook(10 * 60_000, () => at);
    const issued = book.issue("a", "t", "f", "q?");
    expect(issued.expiresInMinutes).toBe(10);
    at = 10 * 60_000;
    expect(() => book.redeem(issued.code, "a", "t", "f")).toThrow(/expired/);
  });
});
