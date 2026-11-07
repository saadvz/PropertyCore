import { afterEach, describe, expect, it, vi } from "vitest";
import { liveDeskFor } from "../src/cleaner-core/liveDesk";
import { lineStartText, lineStopText, whichPropertyText } from "../src/hosted/sharedRoute";
import { closeHostedApps } from "./cleanerOauthHarness";
import { CLEANER, COURT, INVITE, LANDLORD, LANE, LINE, sharedAccount, type SharedAccount } from "./sharedHarness";

/**
 * One cleaner on two properties of one account, texting the shared line one-to-one
 * (saadvz/TourCore#190): by name, by which property waits on them, or by asking. Only 555 numbers.
 */

const SLOW = { timeout: 180_000 };
const ASK = whichPropertyText([
  { id: "lane", label: "Scratch Lane", address: LANE.property.address },
  { id: "court", label: "Scratch Court", address: COURT.property.address },
]);

let open: SharedAccount | undefined;
let at = Date.parse("2026-10-14T13:00:00.000Z");
afterEach(() => {
  vi.restoreAllMocks();
  open?.m.close();
  open = undefined;
  closeHostedApps();
});

/** Lane and Court, both live and one-to-one, with Ana the cleaner on both. Lane's invite is out; Court's is held. */
async function shared() {
  at = Date.parse("2026-10-14T13:00:00.000Z");
  open = await sharedAccount({ now: () => new Date(at) });
  const s = open;
  const lane = await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  const court = await s.add("Scratch Court");
  await s.startProperty(court, COURT);
  await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only", shared: true });
  await s.finishProperty(court, COURT);
  return { s, lane, court };
}

/** After Ana's YES to Lane's invite: opted in on both, each property's offer out. */
async function optedIn() {
  const t = await shared();
  await t.s.m.text(LINE, CLEANER, "YES", "SM-opt-yes");
  return t;
}

const sentSince = (s: SharedAccount, before: number) => s.m.sms.sent.slice(before).filter((x) => x.to === CLEANER).map((x) => x.body);
const minutes = (n: number) => (at += n * 60_000);

describe("a shared cleaner's one-to-one text", () => {
  it("YES to the only open invite goes to that property and opts them in on both", SLOW, async () => {
    const { s, lane, court } = await shared();
    expect(s.bodiesTo(CLEANER).filter((b) => b.includes(INVITE))).toHaveLength(1);
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "YES", "SM-opt-yes");
    expect(s.seen(lane)).toContain("SM-opt-yes");
    expect(s.seen(court)).not.toContain("SM-opt-yes");
    expect(s.peopleFile()!.people.find((p) => p.phone === CLEANER)?.optedIn).toBeDefined();
    const after = sentSince(s, before);
    expect(after.some((b) => b.startsWith("8 Scratch Court: ") && b.includes("8 Scratch Court"))).toBe(true);
    expect(after.some((b) => b.includes(INVITE))).toBe(false);
    expect(after).not.toContain(ASK);
  });

  it("a bare number with nothing held goes by context, not as an answer", SLOW, async () => {
    const { s, lane, court } = await shared();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "2", "SM-two");
    expect(s.seen(lane)).toContain("SM-two");
    expect(s.seen(court)).not.toContain("SM-two");
    expect(sentSince(s, before)).not.toContain(ASK);
  });

  it("a text naming a property goes there", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    await s.m.text(LINE, CLEANER, "running late at 8 Scratch Court", "SM-late");
    expect(s.seen(court)).toContain("SM-late");
    expect(s.seen(lane)).not.toContain("SM-late");
  });

  it("with both waiting, they're asked, and the answer delivers the held text there only", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "YES", "SM-which");
    expect(sentSince(s, before)).toEqual([ASK]);
    expect(s.seen(lane)).not.toContain("SM-which");
    expect(s.seen(court)).not.toContain("SM-which");
    await s.m.text(LINE, CLEANER, "2", "SM-answer");
    expect(s.seen(court)).toContain("SM-which");
    expect(s.seen(lane)).not.toContain("SM-which");
    expect(s.seen(court)).not.toContain("SM-answer");
    expect(s.seen(lane)).not.toContain("SM-answer");
  });

  it("an answer with more to say delivers both, the held text first", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    await s.m.text(LINE, CLEANER, "running late", "SM-held");
    await s.m.text(LINE, CLEANER, "8 Scratch Court, and the dryer is broken", "SM-more");
    expect(s.seen(court)).toEqual(expect.arrayContaining(["SM-held", "SM-more"]));
    expect(s.seen(court).indexOf("SM-held")).toBeLessThan(s.seen(court).indexOf("SM-more"));
    expect(s.seen(lane)).not.toContain("SM-more");
  });

  it("the line's STOP reply still goes when a property fails to apply it", SLOW, async () => {
    const { s, lane } = await optedIn();
    const desk = liveDeskFor(s.root(lane), () => process.env, () => new Date(at));
    vi.spyOn(desk, "accountStop").mockRejectedValue(new Error("unreadable store"));
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
    expect(sentSince(s, before)).toEqual([lineStopText("Scratch")]);
  });

  it("once a later text went to a property by context, a bare number no longer answers the held text", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    // Ana takes both turnovers, so neither property waits on her.
    await s.m.text(LINE, CLEANER, "YES", "SM-take-1");
    await s.m.text(LINE, CLEANER, "1", "SM-answer-1");
    await s.m.text(LINE, CLEANER, "YES", "SM-take-2");
    // Nothing waits: her question is held and asked about.
    await s.m.text(LINE, CLEANER, "what time is checkout?", "SM-held");
    // Lane's cleaning starts, so her next text goes there by context.
    await s.call("mark_guests_left", { property: lane, confirmed: true });
    await s.m.text(LINE, CLEANER, "running late", "SM-late");
    expect(s.seen(lane)).toContain("SM-late");
    minutes(30);
    // A towel count half an hour later isn't her answer to the old question.
    await s.m.text(LINE, CLEANER, "2", "SM-two");
    expect(s.seen(court)).not.toContain("SM-held");
    expect(s.seen(lane)).toContain("SM-two");
  });

  it("answers by name too", SLOW, async () => {
    const { s, lane } = await optedIn();
    await s.m.text(LINE, CLEANER, "YES", "SM-which");
    await s.m.text(LINE, CLEANER, "12 scratch lane", "SM-answer");
    expect(s.seen(lane)).toContain("SM-which");
  });

  it("a new text replaces the held one; the ask goes at most once in 10 minutes", SLOW, async () => {
    const { s, court } = await optedIn();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "YES", "SM-h1");
    minutes(5);
    await s.m.text(LINE, CLEANER, "NO", "SM-h2");
    expect(sentSince(s, before)).toEqual([ASK]);
    minutes(6);
    await s.m.text(LINE, CLEANER, "YES", "SM-h3");
    expect(sentSince(s, before)).toEqual([ASK, ASK]);
    await s.m.text(LINE, CLEANER, "2", "SM-answer");
    expect(s.seen(court)).toContain("SM-h3");
    expect(s.seen(court)).not.toContain("SM-h1");
    expect(s.seen(court)).not.toContain("SM-h2");
  });

  it("after 2 hours unanswered the held text is dropped, with a note for the host on each property", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    await s.m.text(LINE, CLEANER, "call me at 5551234", "SM-lost");
    minutes(121);
    for (const property of [lane, court]) {
      const check = JSON.stringify(await s.call("check_now", { property }));
      expect(check).toContain("A text from Ana couldn't be matched to a property.");
      expect(check).not.toContain("5551234");
    }
    expect(s.seen(lane)).not.toContain("SM-lost");
    expect(s.seen(court)).not.toContain("SM-lost");
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "1", "SM-late-answer");
    // Nothing is held any more, so a bare "1" is a new text: with both properties waiting, it's asked about.
    expect(s.seen(lane)).not.toContain("SM-lost");
    expect(sentSince(s, before)).toEqual([ASK]);
  });

  it("STOP gets one reply, stops both properties, and notes the host on each", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
    expect(sentSince(s, before)).toEqual([lineStopText("Scratch")]);
    expect(s.peopleFile()!.people.find((p) => p.phone === CLEANER)?.stopped).toBeDefined();
    for (const property of [lane, court]) {
      expect(JSON.stringify(await s.call("check_now", { property }))).toContain("opted out of cleaning texts");
    }
    await s.call("mark_guests_left", { property: lane, confirmed: true });
    expect(sentSince(s, before)).toEqual([lineStopText("Scratch")]);
  });

  it("START gets one reply and lifts the STOP on both", SLOW, async () => {
    const { s } = await optedIn();
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "START", "SM-start");
    expect(sentSince(s, before)).toEqual([lineStartText("Scratch")]);
    expect(s.peopleFile()!.people.find((p) => p.phone === CLEANER)?.stopped).toBeUndefined();
  });

  it("HELP reaches no property and gets no reply from Property Core", SLOW, async () => {
    const { s, lane, court } = await optedIn();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "HELP", "SM-help");
    expect(sentSince(s, before)).toEqual([]);
    expect(s.seen(lane)).not.toContain("SM-help");
    expect(s.seen(court)).not.toContain("SM-help");
  });

  it("YES from a stopped cleaner lifts the STOP on both, then routes like any text", SLOW, async () => {
    const { s } = await optedIn();
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "YES", "SM-yes-again");
    expect(s.peopleFile()!.people.find((p) => p.phone === CLEANER)?.stopped).toBeUndefined();
    expect(sentSince(s, before).length).toBeLessThanOrEqual(1);
  });
});

describe("a cleaner on one property", () => {
  it("still gets their property's own STOP reply, and the account marks them stopped", SLOW, async () => {
    open = await sharedAccount();
    const s = open;
    await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    await s.liveProperty("Scratch Court", COURT, { cleaner: COURT.cleanerPhone, cleanerName: "Bea", groupChat: "cleaner-only" });
    await s.m.text(LINE, COURT.cleanerPhone, "YES", "SM-bea-yes");
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, COURT.cleanerPhone, "STOP", "SM-bea-stop");
    const replies = s.m.sms.sent.slice(before).filter((x) => x.to === COURT.cleanerPhone).map((x) => x.body);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("opted out");
    expect(replies[0]).toContain("8 Scratch Court");
    expect(s.peopleFile()!.people.find((p) => p.phone === COURT.cleanerPhone)?.stopped).toBeDefined();
  });
});

describe("an answer is read against the list that was asked", () => {
  it("with a property switched off after the ask, its number still means what the ask said", SLOW, async () => {
    at = Date.parse("2026-10-14T13:00:00.000Z");
    open = await sharedAccount({ now: () => new Date(at) });
    const s = open;
    const annexScratch = { ...LANE, property: { ...LANE.property, address: "9 Scratch Annex, Teaneck, NJ 07666" } };
    const lane = await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    const ids = [lane];
    for (const [label, scratch] of [["Scratch Court", COURT], ["Scratch Annex", annexScratch]] as const) {
      const id = await s.add(label);
      await s.startProperty(id, scratch);
      await s.tool("save_people", { property: id, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only", shared: true });
      await s.finishProperty(id, scratch);
      ids.push(id);
    }
    await s.m.text(LINE, CLEANER, "YES", "SM-opt-yes");
    await s.m.text(LINE, CLEANER, "what time is checkout?", "SM-held");
    // The ask listed 1 Lane, 2 Court, 3 Annex. Court's cleaning is switched off before the answer.
    s.m.registry.setFlow(s.accountId, ids[1]!, "cleaning", false);
    await s.m.text(LINE, CLEANER, "3", "SM-three");
    expect(s.seen(ids[2]!)).toContain("SM-held");
    expect(s.seen(lane)).not.toContain("SM-held");
  });
});
