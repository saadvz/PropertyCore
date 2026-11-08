import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupInviteBody } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerCoreOptions, type CleanerText } from "../src/cleaner-core/core";
import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

/**
 * The engine's hooks for account-level opt-in and STOP (saadvz/PropertyCore#190): an invite held while
 * another property's is out, the YES and STOP reported, and an account change applied with no text.
 * Only 555 numbers; the door code is the made-up Scratch pin.
 */

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const EXTRA = "+15555550122";
const NOW = "2026-10-14T15:00:00.000Z";
const PIN = SCRATCH_TENANTS[0]!.pin;
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");

function sink() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

interface Opts {
  group?: boolean;
  extra?: boolean;
  elsewhere?: (phone: string) => boolean;
  consent?: [string, "in" | "out"][];
  more?: Partial<CleanerCoreOptions>;
}

function engine(box: ReturnType<typeof sink>, o: Opts = {}) {
  const consent = o.consent;
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(PIN),
    hostName: "Scratch",
    consented: true,
    sink: box,
    now: () => new Date(NOW),
    noteHostOnStop: true,
    ...(o.elsewhere ? { optInElsewhere: o.elsewhere } : {}),
    ...(consent ? { onConsent: (phone: string, c: "in" | "out") => void consent.push([phone, c]) } : {}),
    ...(o.group ? { groupChat: { hostName: "Cory", cleanerName: "Maria", ...(o.extra ? { extra: [{ phone: EXTRA, name: "Alex" }] } : {}) } } : {}),
    ...o.more,
  });
}

const invitesTo = (box: ReturnType<typeof sink>, phone: string) => box.sent.filter((t) => t.kind === "opt-in" && t.to === phone);
const to = (box: ReturnType<typeof sink>, phone: string) => box.sent.filter((t) => t.to === phone || t.audience?.includes(phone));

describe("an invite already out elsewhere", () => {
  it("holds the cleaner's invite, one-to-one", async () => {
    const box = sink();
    const job = engine(box, { elsewhere: (p) => p === CLEANER });
    await job.pollFeed(FEED);
    expect(invitesTo(box, CLEANER)).toEqual([]);
  });

  it("sends the invite as today when no other property has one out", async () => {
    const box = sink();
    const job = engine(box, { elsewhere: () => false });
    await job.pollFeed(FEED);
    expect(invitesTo(box, CLEANER)).toHaveLength(1);
  });

  it("holds a group contact's invite", async () => {
    const box = sink();
    const job = engine(box, { group: true, extra: true, elsewhere: (p) => p === EXTRA });
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    expect(invitesTo(box, EXTRA)).toEqual([]);
    expect(invitesTo(box, CLEANER)).toHaveLength(1);
  });
});

describe("onConsent", () => {
  it("reports the cleaner's YES to the invite once", async () => {
    const consent: [string, "in" | "out"][] = [];
    const job = engine(sink(), { consent });
    await job.pollFeed(FEED);
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "opt-yes-2", from: CLEANER, text: "YES" });
    expect(consent).toEqual([[CLEANER, "in"]]);
  });

  it("reports a group contact's YES", async () => {
    const consent: [string, "in" | "out"][] = [];
    const job = engine(sink(), { group: true, extra: true, consent });
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "extra-yes", from: EXTRA, text: "YES" });
    expect(consent).toEqual([[CLEANER, "in"], [EXTRA, "in"]]);
  });

  it("reports a STOP one-to-one and in a group, once each", async () => {
    const one: [string, "in" | "out"][] = [];
    const a = engine(sink(), { consent: one });
    await a.pollFeed(FEED);
    await a.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await a.receive({ id: "stop-1", from: CLEANER, text: "STOP" });
    await a.receive({ id: "stop-2", from: CLEANER, text: "STOP" });
    expect(one).toEqual([[CLEANER, "in"], [CLEANER, "out"]]);

    const group: [string, "in" | "out"][] = [];
    const b = engine(sink(), { group: true, consent: group });
    await b.pollFeed(FEED);
    await b.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await b.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await b.receive({ id: "stop-g", from: CLEANER, text: "STOP", channel: "group" });
    expect(group).toEqual([[CLEANER, "in"], [CLEANER, "out"]]);
  });
});

describe("accountOptIn", () => {
  it("moves a pending cleaner in with no invite, and reports nothing back", async () => {
    const box = sink();
    const consent: [string, "in" | "out"][] = [];
    const job = engine(box, { elsewhere: () => true, consent });
    await job.pollFeed(FEED);
    await job.accountOptIn(CLEANER);
    expect(invitesTo(box, CLEANER)).toEqual([]);
    expect(job.waitingOn(CLEANER)).toBe(false);
    expect(consent).toEqual([]);
    // In, the offer to the cleaner can go once the host times it, as after a YES.
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    expect(to(box, CLEANER).some((t) => t.kind === "offer")).toBe(true);
  });

  it("starts the group with its intro, naming only this property", async () => {
    const box = sink();
    const job = engine(box, { group: true, elsewhere: () => true });
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    const sent = await job.accountOptIn(CLEANER);
    expect(sent.length).toBeGreaterThan(0);
    for (const text of sent) expect(text.body).not.toContain("Scratch Court");
    expect(box.sent.some((t) => t.channel === "group")).toBe(true);
    expect(invitesTo(box, CLEANER)).toEqual([]);
  });

  it("never moves a cleaner who opted out back in", async () => {
    const box = sink();
    const job = engine(box);
    await job.pollFeed(FEED);
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "stop", from: CLEANER, text: "STOP" });
    const before = box.sent.length;
    expect(await job.accountOptIn(CLEANER)).toEqual([]);
    expect(box.sent.length).toBe(before);
  });
});

describe("accountStop and accountStart", () => {
  async function confirmed(group = false) {
    const box = sink();
    const job = engine(box, group ? { group: true } : {});
    await job.pollFeed(FEED);
    if (group) {
      await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
      await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
      await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    } else {
      await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
      await job.receive({ id: "y-out", from: OWNER, text: "YES" });
      await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    }
    await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
    return { box, job };
  }

  it("a stop holds the cleaning and notes the host, with no text to the cleaner", async () => {
    const { box, job } = await confirmed();
    const before = to(box, CLEANER).length;
    await job.accountStop(CLEANER);
    expect(to(box, CLEANER).length).toBe(before);
    expect(job.jobOnHold()).toBe(true);
    expect(box.sent.filter((t) => t.to === OWNER && t.kind === "held")).toHaveLength(1);
    await job.hostDeparture("left");
    expect(to(box, CLEANER).filter((t) => t.body.includes(PIN))).toEqual([]);
  });

  it("a second stop changes nothing", async () => {
    const { box, job } = await confirmed();
    await job.accountStop(CLEANER);
    const before = box.sent.length;
    await job.accountStop(CLEANER);
    expect(box.sent.length).toBe(before);
  });

  it("a start one-to-one brings the cleaner back in, with no text to them", async () => {
    const { box, job } = await confirmed();
    await job.accountStop(CLEANER);
    const before = to(box, CLEANER).length;
    await job.accountStart(CLEANER);
    expect(to(box, CLEANER).length).toBe(before);
    expect(job.waitingOn(CLEANER)).toBe(false);
    await job.accountStop(CLEANER);
    expect(box.sent.filter((t) => t.to === OWNER && t.kind === "held")).toHaveLength(2);
  });

  it("a start in group mode leaves the cleaner out, as START does today", async () => {
    const { box, job } = await confirmed(true);
    await job.accountStop(CLEANER);
    await job.accountStart(CLEANER);
    const before = box.sent.length;
    expect(await job.accountOptIn(CLEANER)).toEqual([]);
    expect(box.sent.length).toBe(before);
    await job.hostDeparture("left");
    expect(to(box, CLEANER).filter((t) => t.body.includes(PIN))).toEqual([]);
  });
});

describe("waitingOn", () => {
  it("is true while the invite waits, false after the YES with nothing open", async () => {
    const job = engine(sink());
    await job.pollFeed(FEED);
    expect(job.waitingOn(CLEANER)).toBe(true);
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    expect(job.waitingOn(CLEANER)).toBe(false);
  });

  it("is true with an offer out, and during the cleaning", async () => {
    const job = engine(sink());
    await job.pollFeed(FEED);
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    expect(job.waitingOn(CLEANER)).toBe(true);
    await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
    expect(job.waitingOn(CLEANER)).toBe(false);
    await job.hostDeparture("left");
    expect(job.waitingOn(CLEANER)).toBe(true);
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });
    expect(job.waitingOn(CLEANER)).toBe(false);
  });

  it("is true while the checklist question waits", async () => {
    const job = engine(sink(), { more: { checklist: { name: "Turnover", items: ["Towels"] } } });
    await job.pollFeed(FEED);
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
    await job.hostDeparture("left");
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });
    expect(job.waitingOn(CLEANER)).toBe(true);
    await job.receive({ id: "yes-check", from: CLEANER, text: "YES" });
    expect(job.waitingOn(CLEANER)).toBe(false);
  });

  it("is true while the supplies question waits", async () => {
    const job = engine(sink(), { more: { supplyAsk: true } });
    await job.pollFeed(FEED);
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
    await job.hostDeparture("left");
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });
    expect(job.waitingOn(CLEANER)).toBe(true);
    await job.receive({ id: "low", from: CLEANER, text: "towels are low" });
    expect(job.waitingOn(CLEANER)).toBe(false);
  });

  it("is true for a group contact's open invite, and false for a phone not on this property", async () => {
    const job = engine(sink(), { group: true, extra: true });
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    expect(job.waitingOn(EXTRA)).toBe(true);
    expect(job.waitingOn("+15555550199")).toBe(false);
    expect(job.waitingOn(OWNER)).toBe(false);
  });

  it("a held invite isn't waiting", async () => {
    const job = engine(sink(), { elsewhere: () => true });
    await job.pollFeed(FEED);
    expect(job.waitingOn(CLEANER)).toBe(false);
  });
});

it("the group invite still reads as today", () => {
  expect(groupInviteBody("Cory", ADDRESS)).toContain(ADDRESS);
});
