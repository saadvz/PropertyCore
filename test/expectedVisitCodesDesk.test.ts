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

describe("the host passes on a visitor's yes (25 Nov)", () => {
  function saved(desk: OversightDesk, extra: Record<string, unknown> = {}): string {
    const reply = approved((confirmation) => desk.addVisit({ ...MIKE_VISIT, ...extra, ...(confirmation ? { confirmation } : {}) }));
    return (reply.structured!.visit as { id: string }).id;
  }

  it("confirm_expected_visit takes the host's two-call yes and records the host and how, for that visit", () => {
    const { root, desk } = world();
    const id = saved(desk);
    const asked = desk.confirmVisit({ id, via: "call" });
    expect(asked.isError).toBe(false);
    expect(asked.structured?.question).toBe("Mike Doyle confirmed their visit on Thursday, Nov 19, 12 to 5 PM on a call? Their door code is made for it.");
    expect(readOversight(root).visits[0]!.confirmed).toBeUndefined();
    const done = approved((confirmation) => desk.confirmVisit({ id, via: "call", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured).toMatchObject({ confirmed: true, by: "host", via: "call" });
    expect(done.structured?.next).toContain("visit_code_link");
    expect(readOversight(root).visits[0]!.confirmed).toEqual({ at: NOW.toISOString(), by: "host", via: "call" });
    expect(done.text).not.toContain("5555550161");
  });

  it("host-arranged has its own question", () => {
    const { desk } = world();
    const id = saved(desk);
    expect(desk.confirmVisit({ id, via: "host-arranged" }).structured?.question).toBe("You set up Mike Doyle's visit on Thursday, Nov 19, 12 to 5 PM yourself, so it's confirmed? Their door code is made for it.");
  });

  it("is refused without how, for a visit with no phone, cancelled, over, unknown, or off connected locks", () => {
    const { desk } = world();
    const id = saved(desk);
    expect(desk.confirmVisit({ id }).text).toBe("Say how they confirmed: via email, call, or host-arranged when you set it up with them yourself.");
    expect(desk.confirmVisit({ id: "v-ffffffff", via: "call" }).isError).toBe(true);
    const { phone: _phone, ...plain } = MIKE_VISIT;
    const bare = (desk.addVisit({ ...plain, who: "Ana Ruiz" }).structured!.visit as { id: string }).id;
    expect(desk.confirmVisit({ id: bare, via: "call" }).text).toBe("That visit has no phone, so there's no door code to make. Cancel it and save it again with their phone.");
    desk.cancelVisit({ id });
    expect(desk.confirmVisit({ id, via: "call" }).isError).toBe(true);
    const later = world({ now: () => new Date("2026-11-19T21:00:00.000Z") });
    const old = saved(later.desk, { date: "2026-11-19" });
    const lateDesk = new OversightDesk(later.root, { now: () => new Date("2026-11-19T22:01:00.000Z"), codes: () => true, hostPhone: () => HOST });
    expect(lateDesk.confirmVisit({ id: old, via: "call" }).text).toBe("That visit has already ended.");
    const off = new OversightDesk(later.root, { now: () => NOW, codes: () => false, hostPhone: () => HOST });
    expect(off.confirmVisit({ id: old, via: "call" }).isError).toBe(true);
  });

  it("answers already for a confirmed visit or a visitor who said YES by text, with nothing new on record", () => {
    const { root, desk } = world();
    const id = saved(desk);
    approved((confirmation) => desk.confirmVisit({ id, via: "email", ...(confirmation ? { confirmation } : {}) }));
    expect(desk.confirmVisit({ id, via: "call" }).structured).toMatchObject({ already: true, via: "email" });
    const file = readOversight(root);
    file.visitors![0]!.yesAt = NOW.toISOString();
    writeFileSync(join(root, "oversight.json"), JSON.stringify(file));
    const second = saved(desk, { date: "2026-11-20" });
    expect(desk.confirmVisit({ id: second, via: "call" }).structured).toMatchObject({ already: true, by: "visitor", via: "text" });
    expect(readOversight(root).visits.find((visit) => visit.id === second)!.confirmed).toBeUndefined();
  });

  it("confirmedVia on add_expected_visit puts both in one question and saves the yes", () => {
    const { root, desk } = world();
    const asked = desk.addVisit({ ...MIKE_VISIT, confirmedVia: "call" });
    expect(asked.structured?.question).toBe("Mike Doyle, Thursday, Nov 19, 12 to 5 PM, with their own door code? They confirmed on a call.");
    const done = approved((confirmation) => desk.addVisit({ ...MIKE_VISIT, confirmedVia: "call", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured?.saved).toBe(true);
    expect(readOversight(root).visits[0]!.confirmed).toEqual({ at: NOW.toISOString(), by: "host", via: "call" });
    expect(done.structured?.next).toContain("visit_code_link");
    // A confirmation for the plain question doesn't save it as confirmed.
    const plain = desk.addVisit({ ...MIKE_VISIT, date: "2026-11-21" });
    const code = (plain.structured?.confirmation as { code: string }).code;
    expect(desk.addVisit({ ...MIKE_VISIT, date: "2026-11-21", confirmedVia: "call", confirmation: code }).isError).toBe(true);
  });

  it("confirmedVia needs a phone and a known way", () => {
    const { desk } = world();
    const { phone: _phone, ...plain } = MIKE_VISIT;
    expect(desk.addVisit({ ...plain, confirmedVia: "call" }).text).toBe("confirmedVia goes with the visitor's phone, for their own door code.");
    expect(desk.addVisit({ ...MIKE_VISIT, confirmedVia: "fax" }).isError).toBe(true);
  });

  it("a number that replied STOP is taken only with the host's yes, and is never told it gets a text", () => {
    const { desk } = world({ stopped: (phone) => phone === MIKE });
    expect(desk.addVisit(MIKE_VISIT).text).toMatch(/replied STOP/);
    const asked = desk.addVisit({ ...MIKE_VISIT, confirmedVia: "email" });
    expect(asked.isError).toBe(false);
    expect(asked.structured?.question).toBe("Mike Doyle, Thursday, Nov 19, 12 to 5 PM, with their own door code? They confirmed by email.");
    const done = approved((confirmation) => desk.addVisit({ ...MIKE_VISIT, confirmedVia: "email", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured?.saved).toBe(true);
    expect(done.structured?.next).not.toMatch(/by text/);
  });

  it("the tools take confirmedVia and confirm_expected_visit", () => {
    const add = OVERSIGHT_TOOLS.find((item) => item.name === "add_expected_visit")!;
    expect(Object.keys((add.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("confirmedVia");
    const { desk } = world();
    const id = saved(desk);
    expect(handleOversightTool(desk, "confirm_expected_visit", { id, via: "call" })?.structured?.question).toMatch(/on a call/);
  });
});
