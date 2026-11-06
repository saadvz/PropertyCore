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

  it("drops one code and counts the codes it holds", () => {
    const book = new ConfirmationBook(Number.POSITIVE_INFINITY, () => 0);
    const first = book.issue("a", "t", "f1", "q?");
    book.issue("a", "t", "f2", "q?");
    expect(book.size).toBe(2);
    book.drop(first.code);
    expect(book.size).toBe(1);
    expect(() => book.redeem(first.code, "a", "t", "f1")).toThrow(/expired/);
  });
});
