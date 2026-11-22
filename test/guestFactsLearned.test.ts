import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guestDeskFor, LEARN_FACTS, type GuestReply } from "../src/guest-messages/desk";
import { readGuestFacts } from "../src/guest-messages/store";
import { GUEST_TOOLS } from "../src/guest-messages/tools";
import { GUEST_MESSAGES_INSTRUCTION } from "../src/hosted/guestMessages";

/**
 * Learning house facts as guests ask (#16): nothing asks the host for facts up front; a guest's question that
 * nothing saved answers comes to the host, and the host's answer is kept, with their okay, for the next guest.
 * Nothing reaches a guest. Made-up property, guests and door codes.
 */

const NOW = new Date("2026-10-14T15:00:00.000Z");
const DOOR = ["7", "3", "5", "0"].join("");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function property() {
  const root = mkdtempSync(join(tmpdir(), "guest-learn-"));
  roots.push(root);
  writeFileSync(
    join(root, "hub.json"),
    JSON.stringify({ schemaVersion: 1, property: { nickname: "Harbor Cottage", timeZone: "America/New_York" }, calendars: [], stays: [{ checkIn: "2026-10-18", checkout: "2026-10-22", kind: "stay" }] }),
  );
  return { root, desk: guestDeskFor(root, { now: () => NOW }) };
}

function guestEmail(words: string, id: string) {
  return {
    from: "Airbnb <automated@airbnb.com>",
    subject: "RE: Reservation at Harbor Cottage by the Water for Oct 18 - 22, 2026",
    body: `Jamie Rivera\n${words}\n\nConfirmation code\nHMXK4Q2Z9R`,
    messageId: `<${id}@example.test>`,
    receivedAt: NOW.toISOString(),
  };
}

const ok = (reply: GuestReply) => {
  if (reply.isError) throw new Error(reply.text);
  return reply.structured!;
};

describe("house facts are learned as guests ask (#16)", () => {
  it("nothing tells the agent to interview the host for facts", () => {
    const texts = [LEARN_FACTS, GUEST_MESSAGES_INSTRUCTION, ...GUEST_TOOLS.map((tool) => String(tool.description))];
    for (const text of texts) {
      expect(text).not.toMatch(/one topic at a time|Start with wifi|Ask the host for them/i);
    }
    expect(LEARN_FACTS).toMatch(/Don't ask the host for house facts up front/);
    expect(GUEST_MESSAGES_INSTRUCTION).toMatch(/Don't ask the host for house facts up front/);
  });

  it("a question nothing answers goes to the host with how to keep the answer, and the next guest gets a draft from it", () => {
    const { root, desk } = property();
    const first = ok(desk.readMessage({ email: guestEmail("Hi! What's the wifi password?", "first") }));
    expect(first).toMatchObject({ facts: [], missing: ["wifi"], new: true, learn: { messageId: first.messageId, topics: ["wifi"] } });
    expect(String(first.next)).toMatch(/new question and ask what to say/);
    expect(String(first.next)).toMatch(new RegExp(`Only on their okay, call save_guest_facts with topic wifi, the host's own words \\(never a door code\\), and messageId ${first.messageId}`));

    const saved = ok(desk.saveFact({ topic: "wifi", text: "Network HarborGuest, password sunny2024.", messageId: first.messageId }));
    expect(saved).toMatchObject({ saved: true, topic: "wifi", learnedFrom: first.messageId });
    expect(readGuestFacts(root).history).toEqual([{ at: NOW.toISOString(), topic: "wifi", learnedFrom: first.messageId }]);

    const next = ok(desk.readMessage({ email: guestEmail("Can you send the wifi again?", "second") }));
    expect(next).toMatchObject({ facts: [{ topic: "wifi", text: "Network HarborGuest, password sunny2024." }], missing: [], new: false });
    expect(next.learn).toBeUndefined();
  });

  it("an answer to a question on no topic is kept under other", () => {
    const { desk } = property();
    const read = ok(desk.readMessage({ email: guestEmail("Is there a hair dryer?", "dryer") }));
    expect(read.learn).toEqual({ messageId: read.messageId, topics: ["other"] });
    ok(desk.saveFact({ topic: "other", text: "The hair dryer is under the bathroom sink.", messageId: read.messageId }));
    const again = ok(desk.readMessage({ email: guestEmail("Where's the hair dryer?", "dryer-2") }));
    expect(again.facts).toEqual([{ topic: "other", text: "The hair dryer is under the bathroom sink." }]);
  });

  it("a house rules question with no rules saved offers the one list, not a fact", () => {
    const { desk } = property();
    const read = ok(desk.readMessage({ email: guestEmail("Can we bring our dog?", "dog") }));
    expect(read.learn).toEqual({ messageId: read.messageId, topics: ["rules"] });
    expect(String(read.next)).toMatch(/call save_house_rules with add/);
    expect(String(read.next)).not.toMatch(/save_guest_facts/);
  });

  it("keeps no door code from the host's answer, and refuses a message it never read", () => {
    const { root, desk } = property();
    const read = ok(desk.readMessage({ email: guestEmail("How do we get in?", "in") }));
    const refused = desk.saveFact({ topic: "check_in", text: `Lockbox code ${DOOR} by the side door.`, messageId: read.messageId });
    expect(refused.isError).toBe(true);
    expect(refused.text).not.toContain(DOOR);
    expect(desk.saveFact({ topic: "check_in", text: "Self check-in from 4 PM.", messageId: "gm_notarealone" }).isError).toBe(true);
    expect(readGuestFacts(root).facts).toEqual([]);
    for (const name of readdirSync(root)) expect(readFileSync(join(root, name), "utf8")).not.toContain(DOOR);
  });

  it("saving a learned fact sends nothing and writes only the house facts", () => {
    const { root, desk } = property();
    const read = ok(desk.readMessage({ email: guestEmail("Where do the bins go?", "bins") }));
    const before = new Set(readdirSync(root));
    ok(desk.saveFact({ topic: "trash", text: "Bins go to the curb Tuesday night.", messageId: read.messageId }));
    const added = readdirSync(root).filter((name) => !before.has(name));
    expect(added.every((name) => name === "guest-facts.json")).toBe(true);
    expect(existsSync(join(root, "guest-facts.json"))).toBe(true);
  });
});

describe("the agents' instructions (#15, #16)", () => {
  const files = [
    "CLEANER_CORE_BOOTSTRAP.md",
    "property-core-template/bot-profile.md",
    "property-core-template/muse/skills/property-core/SKILL.md",
    "property-core-template/claude/plugin/skills/property-core/SKILL.md",
  ];

  it("ask only about house rules in setup, learn facts as guests ask, and keep an answer only on the host's okay", () => {
    for (const path of files) {
      const text = readFileSync(path, "utf8").replace(/\s+/g, " ");
      expect(text, path).toMatch(/only (when|where) `get_house_rules` or `read_guest_message` is/);
      expect(text, path).toMatch(/ask about the house only this: call `get_house_rules`/);
      expect(text, path).toMatch(/Don't ask (the host )?about wifi, parking, checkout or other house facts up front/);
      expect(text, path).toMatch(/Only on their okay, call `save_guest_facts`|only on their okay, call `save_guest_facts`/);
      expect(text, path).toMatch(/no guest is ever texted/);
    }
  });
});
