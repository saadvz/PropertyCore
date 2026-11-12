import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXER_FILE, TRADES, emptyFixer, fixerAskOn, isTrade, letterToken, newId, readFixer, tokenHash, writeFixer } from "../src/fixer-core/store";
import {
  PLAIN_CHAT, bookingQuestion, codeText, dollars, firstName, hostGoQuestion, preferredQuestion, proInvite, raisedPrice, revealNews, rotationQuestion,
} from "../src/fixer-core/texts";

const folder = () => mkdtempSync(join(tmpdir(), "fixer-"));
const TZ = "America/Chicago";

describe("fixer.json", () => {
  it("reads a missing file as an empty record with the defaults", () => {
    const file = readFixer(folder());
    expect(file).toEqual(emptyFixer());
    expect(file.settings.checkInBufferMinutes).toBe(60);
    expect(file.settings.cleaningMinutes).toBe(180);
  });

  it("fills in a partial file", () => {
    const root = folder();
    writeFileSync(join(root, FIXER_FILE), JSON.stringify({ settings: { cleaningMinutes: 240 }, jobs: [] }));
    const file = readFixer(root);
    expect(file.settings).toEqual({ checkInBufferMinutes: 60, cleaningMinutes: 240, askCleaner: false });
    expect(file.pros).toEqual([]);
    expect(file.upkeep).toEqual([]);
    expect(file.setup).toEqual({});
  });

  it("round-trips a write", () => {
    const root = folder();
    const file = emptyFixer();
    file.settings.askCleaner = true;
    file.setup.prosDone = true;
    file.offAt = "2026-11-08T10:00:00Z";
    writeFixer(root, file);
    expect(readFixer(root)).toEqual(file);
  });

  it("asks the cleaner only when activated, not off, and the host said yes", () => {
    const root = folder();
    expect(fixerAskOn(root)).toBe(false);
    const file = emptyFixer();
    file.settings.askCleaner = true;
    writeFixer(root, file);
    expect(fixerAskOn(root)).toBe(false);
    file.settings.activatedAt = "2026-11-08T10:00:00Z";
    writeFixer(root, file);
    expect(fixerAskOn(root)).toBe(true);
    file.settings.askCleaner = false;
    writeFixer(root, file);
    expect(fixerAskOn(root)).toBe(false);
    file.settings.askCleaner = true;
    file.offAt = "2026-11-09T10:00:00Z";
    writeFixer(root, file);
    expect(fixerAskOn(root)).toBe(false);
  });
});

describe("ids and tokens", () => {
  it("knows the eight trades", () => {
    expect(TRADES).toHaveLength(8);
    expect(isTrade("plumbing")).toBe(true);
    expect(isTrade("pest-control")).toBe(true);
    expect(isTrade("cleaning")).toBe(false);
    expect(isTrade(3)).toBe(false);
  });

  it("makes ids of the right shape", () => {
    expect(newId("pro_", 10)).toMatch(/^pro_[a-z0-9]{10}$/);
    expect(newId("upk_", 8)).toMatch(/^upk_[a-z0-9]{8}$/);
    expect(newId("job_", 10)).not.toBe(newId("job_", 10));
  });

  it("makes letters-only tokens and hashes them", () => {
    expect(letterToken()).toMatch(/^[a-p]{64}$/);
    expect(letterToken(8)).toMatch(/^[a-p]{16}$/);
    expect(letterToken()).not.toBe(letterToken());
    expect(tokenHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("copy", () => {
  it("formats money like Supply Core", () => {
    expect(dollars(18_000)).toBe("$180.00");
    expect(dollars(2_000_000)).toBe("$20,000.00");
  });

  it("asks the host to go", () => {
    expect(hostGoQuestion({ what: "Kitchen sink leaks", cleanerName: "Dana", proName: "Joe's Plumbing" })).toBe(
      "Kitchen sink leaks (photo from Dana). Want me to call Joe's Plumbing?",
    );
    expect(hostGoQuestion({ what: "Kitchen sink leaks", cleanerName: "Dana" })).toBe("Kitchen sink leaks (photo from Dana). Want me to find someone?");
  });

  it("asks to book", () => {
    const base = { proName: "Joe", from: "2026-11-10T16:00:00Z", until: "2026-11-10T18:00:00Z", timeZone: TZ, access: "code" as const };
    expect(bookingQuestion({ ...base, estimateCents: 18_000 })).toBe("Joe can come Tuesday 10 to 12, about $180. Book it and let them in with the door code?");
    expect(bookingQuestion({ ...base, estimateCents: 18_050 })).toBe("Joe can come Tuesday 10 to 12, about $180.50. Book it and let them in with the door code?");
    expect(bookingQuestion(base)).toBe("Joe can come Tuesday 10 to 12. Book it and let them in with the door code?");
    expect(bookingQuestion({ ...base, estimateCents: 18_000, access: "host" })).toBe("Joe can come Tuesday 10 to 12, about $180. Book it and you'll let them in?");
    expect(bookingQuestion({ ...base, from: "2026-11-10T16:30:00Z", until: "2026-11-10T21:00:00Z" })).toBe(
      "Joe can come Tuesday 10:30 to 3. Book it and let them in with the door code?",
    );
  });

  it("tells a raised price, a reveal, and asks the follow-ups", () => {
    expect(raisedPrice({ proName: "Joe", newCents: 30_000, oldCents: 18_000 })).toBe("Joe says the fix is $300.00, not $180.00. Go ahead?");
    expect(revealNews({ proName: "Joe", at: "2026-11-10T21:05:00Z", timeZone: TZ })).toBe("Joe opened the door code at 3:05.");
    expect(preferredQuestion({ proName: "Joe", trade: "pest-control" })).toBe("Add Joe to your preferred list for pest-control?");
    expect(rotationQuestion({ proName: "Joe" })).toBe("Joe knows the door code. Want to change it? Set the new code on the lock, then save it here.");
  });

  it("writes the code text and the invite", () => {
    const f = { proName: "Joe Smith", street: "12 Oak St", code: "9317" };
    expect(codeText({ ...f, lockLocation: "the side door" })).toBe(
      "Hi Joe, the door code for 12 Oak St is 9317, at the side door. Reply DONE with photos when you finish.",
    );
    expect(codeText(f)).toBe("Hi Joe, the door code for 12 Oak St is 9317. Reply DONE with photos when you finish.");
    expect(codeText({ ...f, proName: "Joe's Plumbing" })).toContain("Hi Joe's,");
    expect(firstName("  Ann  Lee")).toBe("Ann");
    expect(proInvite({ proName: "Joe Smith", business: "Oak Rentals", street: "12 Oak St" })).toBe(
      "Hi Joe, this is Oak Rentals for repair visits at 12 Oak St. Reply YES to get visit details by text, or STOP to opt out.",
    );
  });

  it("has the plain chat line", () => {
    expect(PLAIN_CHAT).toBe(
      "Fixer Core works with Grok Bot and Muse for now: they find, call and book pros themselves. In this chat, Cleaner Core works without Fixer Core.",
    );
  });
});
