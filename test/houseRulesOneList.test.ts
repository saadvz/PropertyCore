import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guestDeskFor, type GuestReply } from "../src/guest-messages/desk";
import { GUEST_TOOLS } from "../src/guest-messages/tools";
import { GUEST_FACTS_FILE, readGuestFacts, writeGuestFacts } from "../src/guest-messages/store";
import { mergeGuestRules, rulesForGuests, splitRuleText } from "../src/house-rules/merge";
import { readHostSteps } from "../src/hours-log/hostSteps";
import { ASK_FOR_RULES, rulesAsk, stayCheckDeskFor, type StayCheckReply } from "../src/stay-check/desk";
import type { HouseRule } from "../src/stay-check/rules";
import { readStayCheck, STAY_CHECK_FILE, writeStayCheck } from "../src/stay-check/store";
import { STAY_CHECK_TOOLS } from "../src/stay-check/tools";

/**
 * One list of house rules (#15): the nightly stay check's list is the one guest replies draft from, an older
 * house facts rules text moves onto it without losing anything, and a camera check still needs the host's yes
 * to its read-back (#253). Made-up property, made-up rules, made-up door codes.
 */

const NOW = new Date("2026-11-22T15:00:00.000Z");
const DOOR = ["7", "3", "5", "0"].join("");
const HUB = {
  schemaVersion: 1,
  property: { nickname: "Harbor Cottage", address: "12 Scratch Lane", timeZone: "America/New_York", checkoutTime: "10:30", checkInTime: "16:00" },
  calendars: [],
  stays: [{ checkIn: "2026-10-18", checkout: "2026-10-22", kind: "stay" }],
};
const MAX6: HouseRule = { text: "No more than 6 guests", check: { kind: "people", max: 6 } };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder() {
  const root = mkdtempSync(join(tmpdir(), "house-rules-"));
  roots.push(root);
  writeFileSync(join(root, "hub.json"), JSON.stringify(HUB));
  return root;
}

/** A guest-facts.json as #260 saved it: a rules fact and an "anything else" fact. */
function olderFacts(root: string, rules = "No smoking, parties or pets") {
  writeGuestFacts(root, {
    facts: [
      { topic: "wifi", text: "Network HarborGuest, password sunny2024.", savedAt: "2026-11-22T13:00:00.000Z" },
      { topic: "rules", text: rules, savedAt: "2026-11-22T13:05:00.000Z" },
      { topic: "other", text: "Max 4 guests", savedAt: "2026-11-22T13:06:00.000Z" },
    ],
    skipped: ["area"],
  });
}

/** A made-up Airbnb guest-message email with the guest's words. */
function guestEmail(words: string, id = "rules") {
  return {
    from: "Airbnb <automated@airbnb.com>",
    subject: "RE: Reservation at Harbor Cottage by the Water for Oct 18 - 22, 2026",
    body: `Jamie Rivera\n${words}\n\nConfirmation code\nHMXK4Q2Z9R`,
    messageId: `<${id}@example.test>`,
    receivedAt: "2026-10-14T15:00:00.000Z",
  };
}

const ok = (reply: GuestReply | StayCheckReply) => {
  if (reply.isError) throw new Error(reply.text);
  return reply.structured!;
};

describe("a house facts rules text as house rules", () => {
  it("keeps a line of several rules as one rule, in the host's words", () => {
    expect(splitRuleText("No smoking, parties or pets")).toEqual(["No smoking, parties or pets"]);
  });

  it("splits lines and takes list marks off", () => {
    expect(splitRuleText("- No smoking\n2. Quiet after 10 PM\n\n• Shoes off inside")).toEqual(["No smoking", "Quiet after 10 PM", "Shoes off inside"]);
  });

  it("splits a line over 200 characters by its sentences, and cuts only a sentence over 200 at a space", () => {
    const long = `${"Please keep the noise down on the deck after dark. ".repeat(3)}${"word ".repeat(60).trim()}.`;
    const pieces = splitRuleText(long);
    expect(pieces.every((piece) => piece.length > 0 && piece.length <= 200)).toBe(true);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " ").trim());
  });
});

describe("moving an older rules fact onto the one list (#15)", () => {
  it("moves it as text only, keeps every other fact, and keeps the host's save in the history", () => {
    const root = folder();
    olderFacts(root);
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "moved", added: 1 });
    const stay = readStayCheck(root);
    expect(stay.rules).toEqual([{ text: "No smoking, parties or pets" }]);
    // The host never agreed to a read-back for it, so no check, and the move is Property Core's, not a save of the host's.
    expect(stay.rulesSavedAt).toBeUndefined();
    expect(stay.rulesMergedAt).toBe(NOW.toISOString());
    const facts = readGuestFacts(root);
    expect(facts.facts.map((fact) => fact.topic)).toEqual(["wifi", "other"]);
    expect(facts.skipped).toEqual(["area"]);
    expect(facts.history).toEqual([{ at: "2026-11-22T13:05:00.000Z", topic: "rules" }]);
    expect(readHostSteps(root)).toEqual([]);
  });

  it("is done once: a second call moves nothing", () => {
    const root = folder();
    olderFacts(root);
    mergeGuestRules(root, NOW);
    const before = readFileSync(join(root, STAY_CHECK_FILE), "utf8");
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "none" });
    expect(readFileSync(join(root, STAY_CHECK_FILE), "utf8")).toBe(before);
  });

  it("adds a rule already on the list only once, and leaves the saved checks alone", () => {
    const root = folder();
    writeStayCheck(root, { rules: [MAX6, { text: "No smoking." }], checkTime: "22:30", rulesSavedAt: "2026-11-21T12:00:00.000Z", sightings: {}, allowances: [] });
    olderFacts(root, "no smoking\nQuiet after 10 PM");
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "moved", added: 1 });
    expect(readStayCheck(root)).toMatchObject({ rules: [MAX6, { text: "No smoking." }, { text: "Quiet after 10 PM" }], checkTime: "22:30", rulesSavedAt: "2026-11-21T12:00:00.000Z" });
  });

  it("after a crash between the two writes, finds the rules already moved and only takes the fact out", () => {
    const root = folder();
    olderFacts(root);
    // The list was written, the fact not yet taken out.
    writeStayCheck(root, { rules: [{ text: "No smoking, parties or pets" }], sightings: {}, allowances: [] });
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "moved", added: 0 });
    expect(readStayCheck(root).rules).toEqual([{ text: "No smoking, parties or pets" }]);
    expect(readGuestFacts(root).facts.some((fact) => fact.topic === "rules")).toBe(false);
  });

  it("keeps the fact where it is, untouched, when the list has no room, and drafts still read it", () => {
    const root = folder();
    const full = Array.from({ length: 20 }, (_, i) => ({ text: `Rule ${String.fromCharCode(65 + i)}` }));
    writeStayCheck(root, { rules: full, sightings: {}, allowances: [] });
    olderFacts(root);
    const before = readFileSync(join(root, GUEST_FACTS_FILE), "utf8");
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "kept", why: "too-many" });
    expect(readFileSync(join(root, GUEST_FACTS_FILE), "utf8")).toBe(before);
    expect(readStayCheck(root).rules).toHaveLength(20);
    expect(rulesForGuests(root, NOW).rules).toContain("No smoking, parties or pets");
  });

  it("never puts text that looks like a door code on the list", () => {
    const root = folder();
    olderFacts(root, `No parties. Side gate ${DOOR}.`);
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "kept", why: "code" });
    expect(existsSync(join(root, STAY_CHECK_FILE))).toBe(false);
  });

  it("writes nothing over a house rules record it can't read", () => {
    const root = folder();
    writeFileSync(join(root, STAY_CHECK_FILE), "{ not json");
    olderFacts(root);
    expect(mergeGuestRules(root, NOW)).toEqual({ status: "kept", why: "unreadable" });
    expect(readFileSync(join(root, STAY_CHECK_FILE), "utf8")).toBe("{ not json");
    expect(rulesForGuests(root, NOW)).toEqual({ rules: ["No smoking, parties or pets"], unreadable: true });
  });

  it("moves on the first get_house_rules, and on the first get_guest_facts", () => {
    const a = folder();
    olderFacts(a);
    expect(ok(stayCheckDeskFor(a, { now: () => NOW }).getRules()).rules).toEqual([{ text: "No smoking, parties or pets" }]);
    const b = folder();
    olderFacts(b);
    const read = ok(guestDeskFor(b, { now: () => NOW }).getFacts());
    expect(read.houseRules).toEqual(["No smoking, parties or pets"]);
    expect((read.facts as { topic: string }[]).map((fact) => fact.topic)).toEqual(["wifi", "other"]);
    expect(readStayCheck(b).rules).toEqual([{ text: "No smoking, parties or pets" }]);
  });
});

describe("every house rule drafts guest replies (#15)", () => {
  it("a guest asking about the rules gets every rule, a checked one too, in the host's words only", () => {
    const root = folder();
    writeStayCheck(root, { rules: [MAX6, { text: "No parties" }, { text: "Two cars max", check: { kind: "vehicles", max: 2 } }], sightings: {}, allowances: [] });
    const read = ok(guestDeskFor(root, { now: () => NOW }).readMessage({ email: guestEmail("Can we bring our dog? What are the house rules?") }));
    expect(read.facts).toEqual([
      { topic: "rules", text: "No more than 6 guests" },
      { topic: "rules", text: "No parties" },
      { topic: "rules", text: "Two cars max" },
    ]);
    expect(read.missing).not.toContain("rules");
    expect(JSON.stringify(read)).not.toMatch(/"kind"\s*:\s*"vehicles"/);
  });

  it("a rule answers a question that shares its words, like cars", () => {
    const root = folder();
    writeStayCheck(root, { rules: [{ text: "Two cars max", check: { kind: "vehicles", max: 2 } }, { text: "No smoking" }], sightings: {}, allowances: [] });
    const read = ok(guestDeskFor(root, { now: () => NOW }).readMessage({ email: guestEmail("Is there room for our two cars?", "cars") }));
    expect(read.facts).toContainEqual({ topic: "rules", text: "Two cars max" });
    expect(read.facts).not.toContainEqual({ topic: "rules", text: "No smoking" });
  });

  it("a rule saved as a house fact is refused with where it goes, and nothing is written", () => {
    const root = folder();
    const desk = guestDeskFor(root, { now: () => NOW });
    const refused = desk.saveFact({ topic: "rules", text: "No parties" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/save_house_rules/);
    expect(existsSync(join(root, GUEST_FACTS_FILE))).toBe(false);
    expect(existsSync(join(root, STAY_CHECK_FILE))).toBe(false);
    const save = GUEST_TOOLS.find((tool) => tool.name === "save_guest_facts") as { inputSchema: { properties: { topic: { enum: string[] } } } };
    expect(save.inputSchema.properties.topic.enum).not.toContain("rules");
  });
});

describe("save_house_rules add, and the rules question (#15, #16)", () => {
  it("adds one rule at the end, refuses one that looks like a door code, and keeps one check per kind", () => {
    const root = folder();
    const desk = stayCheckDeskFor(root, { now: () => NOW });
    ok(desk.saveRules({ rules: [MAX6] }));
    ok(desk.saveRules({ add: { text: "No parties" } }));
    expect(readStayCheck(root).rules).toEqual([MAX6, { text: "No parties" }]);
    const code = desk.saveRules({ add: { text: `Gate code ${DOOR}` } });
    expect(code.isError).toBe(true);
    expect(code.text).not.toContain(DOOR);
    expect(desk.saveRules({ add: { text: "Up to 8 guests", check: { kind: "people", max: 8 } } }).isError).toBe(true);
    expect(desk.saveRules({ rules: [], add: { text: "x" } }).isError).toBe(true);
    expect(readStayCheck(root).rules).toEqual([MAX6, { text: "No parties" }]);
  });

  it("never raises an allowed number: a false flag and an add leave the saved max as it was", () => {
    const root = folder();
    const desk = stayCheckDeskFor(root, { now: () => NOW });
    ok(desk.saveRules({ rules: [MAX6] }));
    ok(desk.markFlagFalse({ kind: "people" }));
    ok(desk.saveRules({ add: { text: "No parties" } }));
    expect(readStayCheck(root).rules[0]).toEqual(MAX6);
  });

  it("with the nightly check off here, keeps every rule as text and refuses a check", () => {
    const root = folder();
    const desk = stayCheckDeskFor(root, { now: () => NOW, checks: false, guestReplies: true });
    const asked = ok(desk.getRules());
    expect(String(asked.ask)).toMatch(/Save each one as text/);
    expect(String(asked.ask)).not.toMatch(/camera/i);
    expect(String(asked.ask)).toMatch(/used to draft guest replies/);
    const refused = desk.saveRules({ add: MAX6 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/text only/);
    ok(desk.saveRules({ add: { text: "No more than 6 guests" } }));
    expect(readStayCheck(root).rules).toEqual([{ text: "No more than 6 guests" }]);
  });

  it("the setup question asks about rules the cameras can check first, and suggests none", () => {
    for (const ask of [ASK_FOR_RULES, rulesAsk({ checks: true, guestReplies: true })]) {
      expect(ask).toMatch(/starting with what the cameras can check: how many guests at most, pets, how many cars, and quiet hours/);
      expect(ask).toMatch(/Don't suggest rules they didn't give/);
      expect(ask).toMatch(/save its check only after they agree/);
      expect(ask).not.toMatch(/wifi|parking|trash|check-in|the area/i);
    }
    const get = STAY_CHECK_TOOLS.find((tool) => tool.name === "get_house_rules") as { description: string };
    expect(get.description).toMatch(/Setup asks this and nothing else about the house/);
  });
});
