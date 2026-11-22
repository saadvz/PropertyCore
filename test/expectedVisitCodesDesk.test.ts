import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { OversightDesk, type OversightDeps, type OversightReply } from "../src/oversight/desk";
import { readOversight } from "../src/oversight/store";
import { handleOversightTool, OVERSIGHT_TOOLS } from "../src/oversight/tools";

/** #280 item 17: an expected visit with a phone saves its visitor, with the host's yes for their own code. 555 numbers only. */

const NOW = new Date("2026-11-17T14:00:00.000Z");
const HOST = "+15555550130";
const MIKE = "+15555550161";
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(extra: Partial<OversightDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "visit-desk-"));
  roots.push(root);
  hubFor(root, { now: () => NOW }).saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const desk = new OversightDesk(root, { now: () => NOW, codes: () => true, hostPhone: () => HOST, ...extra });
  return { root, desk };
}

const MIKE_VISIT = { who: "Mike Doyle", date: "2026-11-19", from: "12:00", to: "17:00", phone: "555 555 0161" };

function approved(call: (confirmation?: string) => OversightReply): OversightReply {
  const first = call();
  const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
  return code ? call(code) : first;
}

describe("a visit with a phone (#280 17)", () => {
  it("a visit with a phone takes the host's yes, naming the person and their code", () => {
    const { root, desk } = world();
    const asked = desk.addVisit(MIKE_VISIT);
    expect(asked.isError).toBe(false);
    expect(asked.structured?.saved).toBe(false);
    expect(asked.structured?.question).toBe("Mike Doyle, Thursday, Nov 19, 12 to 5 PM, with their own door code? They get one text asking them to reply YES first.");
    expect(readOversight(root).visits).toEqual([]);
    const done = approved((confirmation) => desk.addVisit({ ...MIKE_VISIT, ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured?.saved).toBe(true);
    const file = readOversight(root);
    expect(file.visits).toEqual([expect.objectContaining({ who: "Mike Doyle", phone: MIKE })]);
    expect(file.visitors).toEqual([{ phone: MIKE, name: "Mike Doyle", addedAt: NOW.toISOString() }]);
    // Nothing goes out from here: the visitor's one text goes from the lock clock.
    expect(done.text).not.toContain(MIKE);
    expect(done.text).not.toContain("5555550161");
  });

  it("a visitor who already said YES isn't asked again, and the question says so", () => {
    const { root, desk } = world();
    approved((confirmation) => desk.addVisit({ ...MIKE_VISIT, ...(confirmation ? { confirmation } : {}) }));
    const file = readOversight(root);
    file.visitors![0]!.yesAt = NOW.toISOString();
    writeFileSync(join(root, "oversight.json"), JSON.stringify(file));
    const asked = desk.addVisit({ who: "Mike Doyle", date: "2026-11-20", phone: MIKE_VISIT.phone });
    expect(asked.structured?.question).toBe("Mike Doyle, Friday, Nov 20, all day, with their own door code?");
  });

  it("a confirmation for a different visit or number is refused", () => {
    const { desk } = world();
    const asked = desk.addVisit(MIKE_VISIT);
    const code = (asked.structured?.confirmation as { code: string }).code;
    const wrong = desk.addVisit({ ...MIKE_VISIT, phone: "555 555 0162", confirmation: code } as typeof MIKE_VISIT);
    expect(wrong.isError).toBe(true);
  });

  it("refuses the host's own phone as a visitor", () => {
    const { desk } = world();
    const reply = desk.addVisit({ ...MIKE_VISIT, phone: "+1 555 555 0130" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe("That's your own number. Ask for a standing code with add_standing_code instead.");
  });

  it("refuses a number that opted out", () => {
    const { desk } = world({ stopped: (phone) => phone === MIKE });
    const reply = desk.addVisit(MIKE_VISIT);
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/replied STOP/);
  });

  it("without connected locks, a phone is refused and the visit still saves without one", () => {
    const { root, desk } = world({ codes: () => false });
    const reply = desk.addVisit(MIKE_VISIT);
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe("Door codes for visitors need connected locks here. Save the visit without a phone, and it's still checked.");
    const { phone: _phone, ...plain } = MIKE_VISIT;
    expect(desk.addVisit(plain).structured?.saved).toBe(true);
    expect(readOversight(root).visits[0]!.phone).toBeUndefined();
  });

  it("list shows the code's state, never a phone or digits", () => {
    const { desk } = world({ codeStatus: () => "on-lock" });
    approved((confirmation) => desk.addVisit({ ...MIKE_VISIT, ...(confirmation ? { confirmation } : {}) }));
    const { phone: _phone, ...plain } = MIKE_VISIT;
    desk.addVisit({ ...plain, who: "Ana Ruiz", date: "2026-11-21" });
    const list = desk.listVisits();
    const open = list.structured?.open as { who: string; code: string; phoneLast4?: string }[];
    expect(open.map((visit) => [visit.who, visit.code, visit.phoneLast4])).toEqual([
      ["Mike Doyle", "waiting-for-yes", "0161"],
      ["Ana Ruiz", "none", undefined],
    ]);
    expect(list.text).not.toContain(MIKE);
    expect(list.text).not.toContain("5555550161");
  });

  it("the add_expected_visit tool takes a phone and a confirmation", () => {
    const tool = OVERSIGHT_TOOLS.find((item) => item.name === "add_expected_visit")!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["phone", "confirmation"]));
    const { desk } = world();
    const asked = handleOversightTool(desk, "add_expected_visit", MIKE_VISIT);
    expect(asked?.structured?.question).toMatch(/with their own door code/);
  });
});
