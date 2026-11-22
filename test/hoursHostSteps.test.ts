import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { V1_ROW_KINDS, DEFAULT_KIND_CODES, ROW_KINDS, ROW_KIND_SET } from "../src/hours-log/codes";
import { hoursDeskFor } from "../src/hours-log/desk";
import { HOST_STEPS_FILE, readHostSteps, recordHostStep } from "../src/hours-log/hostSteps";
import { buildMonth } from "../src/hours-log/month";
import { KINDS_OFF, OWNER_KINDS, OWNER_RULES_VERSION } from "../src/hours-log/ownerRules";
import { factsFrom, rawFacts, readRecords, DEFAULT_SOURCES, type RowFact } from "../src/hours-log/sources";
import { readHours, writeHours } from "../src/hours-log/store";
import { handleHoursTool } from "../src/hours-log/tools";
import { visitLogFor } from "../src/visits/store";
import { octoberFolder, type Fixture } from "./hoursFixture";

/**
 * The hours log's owner rows for the host's own steps in the newer features (#18): each from that feature's
 * own record of the host's yes, never from Property Core's own work, and a month the host already confirmed
 * keeps its rows and fingerprint. Made-up property, names and 555 numbers; no door code anywhere.
 */

let open: Fixture | undefined;
afterEach(() => {
  open?.cleanup();
  open = undefined;
});

const OCT = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const NOV = (day: number, hour = 15) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const NEW_KINDS = ROW_KINDS.filter((kind) => !V1_ROW_KINDS.has(kind));
const OCTOBER_FINGERPRINT = "9a5c8afbed7a805ed31f49edc1b5095cd57e19f7002bd0b58905fc05b500129e";

const lines = (root: string, name: string, records: unknown[]) => {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, name), records.map((record) => `${JSON.stringify(record)}\n`).join(""));
};

const ownerOf = (facts: RowFact[]) => facts.filter((fact) => fact.log === "owner" && NEW_KINDS.includes(fact.kind));
/** The fixture's Fixer Core and Supply Core were activated on Sep 1: setup rows of the host's, left out where a test looks at other kinds. */
const notActivate = (facts: RowFact[]) => facts.filter((fact) => !(fact.kind === "setup" && fact.at === "2026-09-01T00:00:00.000Z"));

/** Saad's Nov 22 test as records: each of the host's own steps in the newer features, in the features' own files. */
function saadsNovember(f: Fixture): void {
  const root = f.root;
  // Approved texts to the cleaner, in the visit log, and one text Property Core sent on its own.
  const log = visitLogFor(root);
  log.append({ type: "message", id: "msg-host-1", at: NOV(22, 14), direction: "out", role: "cleaner", label: "host-message", body: "Can you come at noon?" });
  log.append({ type: "message", id: "msg-host-2", at: NOV(22, 15), direction: "out", role: "group", label: "host-message", body: "Thanks!" });
  log.append({ type: "message", id: "msg-offer", at: NOV(22, 16), direction: "out", role: "cleaner", label: "offer", body: "New cleaning: Nov 24" });
  log.append({ type: "message", id: "msg-in", at: NOV(22, 17), direction: "in", role: "cleaner", label: "other", body: "Sure" });
  // Locks, a standing code, guest codes and the house rules: each feature's own call wrote its step.
  recordHostStep(root, { at: NOV(22, 18), kind: "locks-on", about: "Front door" });
  recordHostStep(root, { at: NOV(22, 18) + "", kind: "lock-settings" });
  recordHostStep(root, { at: NOV(22, 19), kind: "standing-add", about: "Robin", ref: "std_abcdefghij" });
  recordHostStep(root, { at: NOV(22, 20), kind: "guest-codes-mode", about: "ask" });
  recordHostStep(root, { at: NOV(22, 21), kind: "rules-save", about: "3" });
  recordHostStep(root, { at: NOV(22, 21), kind: "check-time", about: "22:30" });
  recordHostStep(root, { at: NOV(22, 22), kind: "upkeep-save", about: "Clean the gutters", ref: "upk_abcdefgh" });
  recordHostStep(root, { at: NOV(22, 13), kind: "activate", about: "Cleaner Core" });
  // House facts the host entered.
  f.write("guest-facts.json", { facts: [{ topic: "wifi", text: "Network HarborGuest, password sunny2024.", savedAt: NOV(22, 12) }], skipped: [], history: [{ at: NOV(22, 12), topic: "wifi" }] });
  // An expected visit the host logged, and one Property Core flagged.
  f.write("oversight.json", { visits: [{ id: "v-0123abcd", who: "Pat", date: "2026-11-24", from: "10:00", to: "12:00", source: "text", savedAt: NOV(22, 23), flaggedAt: NOV(24, 18) }] });
  // A guest reply the host approved, a late checkout they allowed, and what Property Core did on its own.
  lines(root, "guest-messages.jsonl", [
    { at: NOV(21, 12), id: "gm_aaaaaaaaaaaa", event: "taken", parsed: { kind: "message", text: "Hi" } },
    { at: NOV(21, 13), id: "gm_aaaaaaaaaaaa", event: "reply-approved", reply: "Welcome!" },
    { at: NOV(21, 14), id: "gm_bbbbbbbbbbbb", event: "reply-skipped" },
    { at: NOV(21, 15), id: "gm_cccccccccccc", event: "refused", refused: "not-airbnb" },
    { at: NOV(21, 16), id: "lc_job1", event: "late-checkout", lateCheckout: { checkout: "2026-11-23", time: "13:00" } },
  ]);
  // A Vrbo booking the host said yes to; an Airbnb email Property Core's own reader applied.
  lines(root, "booking-emails.jsonl", [
    { at: NOV(20, 12), receivedAt: NOV(20, 12), from: "x", subject: "Vrbo booking", bodyHash: "h-vrbo", outcome: "applied", hostConfirmed: true, parsed: { kind: "confirmed", platform: "vrbo", confirmationCode: "HA-1A2B3C", checkIn: { date: "2026-11-27" }, checkout: { date: "2026-11-30" } } },
    { at: NOV(20, 13), receivedAt: NOV(20, 13), from: "x", subject: "Airbnb booking", bodyHash: "h-airbnb", outcome: "applied", parsed: { kind: "confirmed", confirmationCode: "HMSCRATCHAA", checkIn: { date: "2026-12-01" }, checkout: { date: "2026-12-03" } } },
  ]);
}

describe("owner rows for the host's own steps in the newer features (#18)", () => {
  it("each of Saad's steps on Nov 22 is an owner row, with a reference", () => {
    open = octoberFolder();
    saadsNovember(open);
    const owner = ownerOf(factsFrom(readRecords(open.root)));
    expect(owner.map((fact) => [fact.kind, fact.task])).toEqual(
      expect.arrayContaining([
        ["setup", "Activated Cleaner Core"],
        ["house-facts", "Saved the wifi house fact"],
        ["approve-text", "Approved a text to the cleaner"],
        ["approve-text", "Approved a text to the cleaning group"],
        ["lock-setup", "Connected the locks (Front door) and approved them for the cleaner's and pros' codes; Approved how door codes go out"],
        ["standing-code", "Approved a standing code for Robin"],
        ["guest-codes", "Chose how guest door codes work: ask first"],
        ["house-rules", "Saved the house rules (3 rules); Set the nightly check time to 22:30"],
        ["save-upkeep", "Saved the upkeep schedule: Clean the gutters"],
        ["expected-visit", "Logged an expected visit: Pat on 2026-11-24, 10:00 to 12:00"],
        ["approve-guest-reply", "Approved a reply to a guest's message"],
        ["allow-late-checkout", "Allowed a late checkout until 13:00 on 2026-11-23"],
        ["approve-booking-email", "Approved a booking from Vrbo, 2026-11-27 to 2026-11-30"],
      ]),
    );
    for (const fact of owner) {
      expect(fact.reference.length).toBeGreaterThan(0);
      expect(fact).toMatchObject({ actor: "host", log: "owner", timing: "rule", onSite: false });
    }
  });

  it("every new kind is an owner kind with its own code, and a row with no minutes set is 0 hours and asks how long", () => {
    for (const kind of NEW_KINDS) {
      expect(OWNER_KINDS.has(kind)).toBe(true);
      expect(DEFAULT_KIND_CODES[kind]).toBeTruthy();
    }
    open = octoberFolder();
    saadsNovember(open);
    const month = buildMonth(readRecords(open.root), "2026-11", {});
    expect(month.rows.filter((row) => NEW_KINDS.includes(row.kind)).every((row) => row.hours === 0)).toBe(true);
    expect(month.needs).toContainEqual(expect.stringMatching(/^Owner minutes aren't set for SET-1 \(Setup and onboarding\)/));
  });
});

describe("the system never writes owner time for its own work (#18)", () => {
  it("Property Core's own texts, a guest message it took or refused, a skipped reply, a booking its reader applied and a flag it raised give no owner row", () => {
    open = octoberFolder();
    saadsNovember(open);
    const facts = factsFrom(readRecords(open.root));
    const refs = facts.map((fact) => fact.reference).join("\n");
    expect(refs).not.toMatch(/msg-offer|msg-in|gm_bbbbbbbbbbbb|gm_cccccccccccc|h-airbnb/);
    expect(facts.filter((fact) => fact.reference === "Guest message gm_aaaaaaaaaaaa")).toHaveLength(1);
    expect(facts.some((fact) => fact.task.includes("flag") && fact.kind === "expected-visit")).toBe(false);
    // Every owner row in the month is still the host's own action.
    for (const fact of facts.filter((item) => item.log === "owner")) {
      expect(fact.actor).toBe("host");
      expect(OWNER_KINDS.has(fact.kind)).toBe(true);
    }
  });

  it("a lock that disconnected on its own, a code Property Core stamped, and rules it moved give no owner row", () => {
    open = octoberFolder();
    // The lock partner's disconnect is a lock-connection line, never a step of the host's.
    visitLogFor(open.root).append({ type: "lock-connection", id: "pc-locks:off:x", at: NOV(10), connected: false });
    // Switching automatic to ask stamps yesAt on stays with codes: Property Core's, not a yes of the host's.
    open.write("guest-codes.json", { schemaVersion: 1, stays: { HMSCRATCHAA: { yesAt: NOV(11) } }, leases: [] });
    // A house facts rules text moved onto the list (#15).
    open.write("stay-check.json", { rules: [{ text: "No parties" }], rulesMergedAt: NOV(12), sightings: {}, allowances: [] });
    expect(notActivate(ownerOf(factsFrom(readRecords(open.root))))).toEqual([]);
  });

  it("the flow audit gives a setup row only for the host turning a flow on for this property", () => {
    open = octoberFolder();
    const account = join(open.root, "acct");
    const property = join(account, "properties", "prp_scratchlane");
    mkdirSync(property, { recursive: true });
    lines(account, "service-audit.jsonl", [
      { at: NOV(1), actor: "host", property: "prp_scratchlane", flow: "cleaning", on: true, forced: false },
      { at: NOV(2), actor: "admin", property: "prp_scratchlane", flow: "supplies", on: true, forced: false },
      { at: NOV(3), actor: "host", property: "prp_scratchlane", flow: "fixer", on: false, forced: false },
      { at: NOV(4), actor: "host", property: "prp_other", flow: "fixer", on: true, forced: false },
    ]);
    const setup = factsFrom(readRecords(property)).filter((fact) => fact.kind === "setup");
    expect(setup.map((fact) => [fact.at, fact.task])).toEqual([[NOV(1), "Turned on Cleaner Core for the property"]]);
  });

  it("a host step never holds a phone or the digits of a code", () => {
    open = octoberFolder();
    recordHostStep(open.root, { at: NOV(5), kind: "standing-add", about: "+1 555 555 0142", ref: "std_abcdefghij" });
    const code = ["4", "8", "2", "1"].join("");
    recordHostStep(open.root, { at: NOV(5), kind: "rules-add", about: `Gate ${code}` });
    const text = readFileSync(join(open.root, HOST_STEPS_FILE), "utf8");
    expect(text).not.toMatch(/\d{3}[\s.-]?\d{4}/);
    expect(text).not.toContain(code);
    expect(readHostSteps(open.root)).toHaveLength(2);
  });

  it("a step from before #18 in a feature's own file and the step itself are one row, not two", () => {
    open = octoberFolder();
    open.write("door-locks.json", { schemaVersion: 1, devices: [], doors: [], activeAt: NOV(6), release: { cleaners: "ask", pros: "ask" }, extend: "ask", standing: [{ id: "std_abcdefghij", name: "Robin", phone: "+15555550142", role: "co-host", addedAt: NOV(7), removedAt: NOV(8) }] });
    recordHostStep(open.root, { at: NOV(7), kind: "standing-add", about: "Robin", ref: "std_abcdefghij" });
    recordHostStep(open.root, { at: NOV(8), kind: "standing-remove", about: "Robin", ref: "std_abcdefghij" });
    recordHostStep(open.root, { at: NOV(6), kind: "locks-on" });
    const owner = notActivate(ownerOf(factsFrom(readRecords(open.root))));
    expect(owner.map((fact) => [fact.kind, fact.at])).toEqual([
      ["lock-setup", NOV(6)],
      ["standing-code", NOV(7)],
      ["standing-code", NOV(8)],
    ]);
    expect(JSON.stringify(owner)).not.toContain("5555550142");
  });
});

describe("a month already confirmed keeps its rows and fingerprint (#18)", () => {
  it("unchanged fingerprint: the October records build the same month with the new sources", () => {
    open = octoberFolder();
    expect(buildMonth(readRecords(open.root), "2026-10", {}).fingerprint).toBe(OCTOBER_FINGERPRINT);
  });

  it("a month confirmed before #18 is built with its own kinds, so new records in it change nothing and it still exports", async () => {
    open = octoberFolder();
    const now = new Date("2026-11-22T15:00:00.000Z");
    const desk = hoursDeskFor(open.root, { now: () => now });
    const asked = (await handleHoursTool(desk, "review_hours", { month: "2026-10" }))!;
    await handleHoursTool(desk, "review_hours", { month: "2026-10", confirmation: (asked.structured!.confirmation as { code: string }).code });
    // As #258 left it: a mark with no kind set.
    const file = readHours(open.root);
    const { kindSet: _set, ...before } = file.months["2026-10"]!;
    writeHours(open.root, { ...file, months: { "2026-10": before } });
    expect(before.fingerprint).toBe(OCTOBER_FINGERPRINT);
    // The host approved a guest reply and saved house rules in October, recorded since.
    lines(open.root, "guest-messages.jsonl", [{ at: OCT(20), id: "gm_aaaaaaaaaaaa", event: "reply-approved", reply: "Welcome!" }]);
    recordHostStep(open.root, { at: OCT(21), kind: "rules-save", about: "2" });
    const review = (await handleHoursTool(desk, "review_hours", { month: "2026-10" }))!;
    expect(review.structured!.confirmed).toMatchObject({ stillMatches: true });
    const exported = (await handleHoursTool(desk, "export_hours", { month: "2026-10" }))!;
    expect(exported.isError).toBe(false);
    // An unconfirmed month has every kind.
    expect(buildMonth(readRecords(open.root), "2026-10", {}).fingerprint).not.toBe(OCTOBER_FINGERPRINT);
  });

  it("a month confirmed since #18 keeps every kind and says so", async () => {
    open = octoberFolder();
    lines(open.root, "guest-messages.jsonl", [{ at: OCT(20), id: "gm_aaaaaaaaaaaa", event: "reply-approved", reply: "Welcome!" }]);
    const desk = hoursDeskFor(open.root, { now: () => new Date("2026-11-22T15:00:00.000Z") });
    const asked = (await handleHoursTool(desk, "review_hours", { month: "2026-10" }))!;
    await handleHoursTool(desk, "review_hours", { month: "2026-10", confirmation: (asked.structured!.confirmation as { code: string }).code });
    const mark = readHours(open.root).months["2026-10"]!;
    expect(mark.kindSet).toBe(ROW_KIND_SET);
    expect(mark.ownerFacts?.some((fact) => fact.kind === "approve-guest-reply")).toBe(true);
    expect(mark.rulesVersion).toBe(OWNER_RULES_VERSION);
  });

  it("a kind left out builds no row in any log", () => {
    open = octoberFolder();
    recordHostStep(open.root, { at: OCT(5), kind: "activate", about: "Cleaner Core" });
    const all = rawFacts(readRecords(open.root));
    expect(all.some((fact) => fact.kind === "setup")).toBe(!KINDS_OFF.has("setup"));
    const without = rawFacts(readRecords(open.root), DEFAULT_SOURCES, [], new Set(ROW_KINDS.filter((kind) => kind !== "setup")));
    expect(without.some((fact) => fact.kind === "setup")).toBe(false);
    expect(without.filter((fact) => fact.kind !== "setup")).toEqual(all.filter((fact) => fact.kind !== "setup"));
  });
});

// Kept beside the sources: a file the tests write with nothing in it reads as no steps.
describe("host-steps.jsonl", () => {
  it("skips a torn line and an unknown kind", () => {
    open = octoberFolder();
    writeFileSync(join(open.root, HOST_STEPS_FILE), `${JSON.stringify({ at: NOV(1), kind: "locks-on" })}\n{"at":\n${JSON.stringify({ at: NOV(2), kind: "send-code" })}\n`);
    expect(readHostSteps(open.root).map((step) => step.kind)).toEqual(["locks-on"]);
  });
});
