import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationBook } from "../src/operator/confirmations";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bookFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "confirmations-"));
  dirs.push(dir);
  return join(dir, "approvals.json");
}

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

describe("ConfirmationBook kept in a file", () => {
  it("approves across a restart, once only", () => {
    const file = bookFile();
    const issued = new ConfirmationBook(10 * 60_000, () => 0, { file }).issue("a", "t", "f", "q?");
    const restarted = new ConfirmationBook(10 * 60_000, () => 60_000, { file });
    expect(restarted.peek(issued.code)).toEqual({ action: "a", target: "t", fingerprint: "f" });
    expect(() => restarted.redeem(issued.code, "a", "t", "f")).not.toThrow();
    expect(() => restarted.redeem(issued.code, "a", "t", "f")).toThrow(/already used/);
    expect(() => new ConfirmationBook(10 * 60_000, () => 60_000, { file }).redeem(issued.code, "a", "t", "f")).toThrow(/already used/);
  });

  it("uses the code up before checking it, so a mismatch can't be retried after a restart", () => {
    const file = bookFile();
    const issued = new ConfirmationBook(10 * 60_000, () => 0, { file }).issue("a", "t", "f", "q?");
    expect(() => new ConfirmationBook(10 * 60_000, () => 0, { file }).redeem(issued.code, "a", "t", "changed")).toThrow(/changed/);
    expect(() => new ConfirmationBook(10 * 60_000, () => 0, { file }).redeem(issued.code, "a", "t", "f")).toThrow(/expired/);
  });

  it("keeps the same expiry across a restart", () => {
    const file = bookFile();
    const issued = new ConfirmationBook(10 * 60_000, () => 0, { file }).issue("a", "t", "f", "q?");
    const restarted = new ConfirmationBook(10 * 60_000, () => 10 * 60_000, { file });
    expect(() => restarted.redeem(issued.code, "a", "t", "f")).toThrow(/expired/);
  });

  it("keeps a code that never expires", () => {
    const file = bookFile();
    const issued = new ConfirmationBook(Number.POSITIVE_INFINITY, () => 0, { file }).issue("a", "t", "f", "q?");
    const restarted = new ConfirmationBook(Number.POSITIVE_INFINITY, () => 365 * 24 * 60 * 60_000, { file });
    expect(() => restarted.redeem(issued.code, "a", "t", "f")).not.toThrow();
  });

  it("stores only a hash of the code, readable by the service alone", () => {
    const file = bookFile();
    const issued = new ConfirmationBook(10 * 60_000, () => 0, { file }).issue("a", "t", "f", "Pay $80?");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(issued.code);
    expect(text).not.toContain("Pay $80?");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("drops tagged codes, and clear removes the file", () => {
    const file = bookFile();
    const book = new ConfirmationBook(Number.POSITIVE_INFINITY, () => 0, { file });
    const one = book.issue("a", "t", "f1", "q?", "draft-1");
    const two = book.issue("a", "t", "f2", "q?", "draft-1");
    const other = book.issue("a", "t", "f3", "q?", "draft-2");
    book.dropTagged("draft-1");
    const restarted = new ConfirmationBook(Number.POSITIVE_INFINITY, () => 0, { file });
    expect(restarted.peek(one.code)).toBeUndefined();
    expect(restarted.peek(two.code)).toBeUndefined();
    expect(restarted.peek(other.code)).toBeDefined();
    restarted.clear();
    expect(existsSync(file)).toBe(false);
    expect(new ConfirmationBook(Number.POSITIVE_INFINITY, () => 0, { file }).size).toBe(0);
  });

  it("starts empty from a damaged file", () => {
    const file = bookFile();
    new ConfirmationBook(10 * 60_000, () => 0, { file }).issue("a", "t", "f", "q?");
    writeFileSync(file, "{not json");
    expect(new ConfirmationBook(10 * 60_000, () => 0, { file }).size).toBe(0);
  });
});
