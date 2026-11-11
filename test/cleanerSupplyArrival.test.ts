import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { repairDoneAsk, SUPPLY_ARRIVAL_ASK, SUPPLY_DONE_ASK, SUPPLY_NOTED } from "../src/cleaner-core/cleanerTexts";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

/**
 * When the host chose to ask on arrival, the supplies question goes on its own right after the door
 * code, so what's low can be delivered while the cleaner is there, and the done text leaves it out.
 * Only 555 numbers and the Scratch Lane made-up code.
 */

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const NOW = "2026-10-14T15:00:00.000Z";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const DONE_ACK = "Thanks, cleaning marked done.";

function sink() {
  const sent: CleanerText[] = [];
  return {
    sent,
    async send(text: CleanerText) {
      sent.push(text);
    },
  };
}

interface Options {
  group?: boolean;
  arrival?: boolean;
  repairAsk?: boolean;
  clock?: { now: Date };
}

async function cleaning(options: Options = {}) {
  const box = sink();
  const clock = options.clock ?? { now: new Date(NOW) };
  const job = openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(PIN),
    hostName: "Scratch",
    consented: true,
    sink: box,
    now: () => clock.now,
    grokReadsMessages: true,
    supplyAsk: true,
    ...(options.arrival === false ? {} : { supplyAskOnArrival: true }),
    ...(options.repairAsk ? { repairAsk: true } : {}),
    ...(options.group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  });
  await job.pollFeed(FEED);
  if (options.group) {
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
  } else {
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
  }
  await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
  const left = await job.receive({ id: "left", from: OWNER, text: "guests have left" });
  return { box, job, clock, left };
}

const channel = (group?: boolean) => (group ? { channel: "group" as const } : {});
const bodies = (sent: CleanerText[], body: string) => sent.filter((text) => text.body === body);

describe("the supplies question on arrival", () => {
  it("goes once, on its own, right after the door code, and never carries the code", async () => {
    const { box } = await cleaning();
    const pinAt = box.sent.findIndex((text) => text.body.includes(PIN));
    const askAt = box.sent.findIndex((text) => text.body === SUPPLY_ARRIVAL_ASK);
    expect(pinAt).toBeGreaterThanOrEqual(0);
    expect(askAt).toBeGreaterThan(pinAt);
    expect(bodies(box.sent, SUPPLY_ARRIVAL_ASK)).toHaveLength(1);
    expect(box.sent[askAt]!.to).toBe(CLEANER);
    expect(SUPPLY_ARRIVAL_ASK).not.toContain(PIN);
  });

  it("the cleaner's next text is the answer: saved, labelled supply-report, replied Thanks, noted.", async () => {
    const { job } = await cleaning();
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "paper towels and sugar" });
    expect(answer.outcome).toBe("supply-report");
    expect(answer.sent.map((text) => text.body)).toEqual([SUPPLY_NOTED]);
    expect(job.jobs()[0]?.arrivalSupplyReport).toEqual({ text: "paper towels and sugar", at: NOW });
    expect(job.jobs()[0]?.status).not.toBe("done");
  });

  it("NONE saves none, and DONE still finishes the cleaning, without asking about supplies again", async () => {
    const { box, job } = await cleaning();
    await job.receive({ id: "low-1", from: CLEANER, text: "NONE" });
    expect(job.jobs()[0]?.arrivalSupplyReport).toEqual({ none: true, at: NOW });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    expect(bodies(box.sent, SUPPLY_DONE_ASK)).toEqual([]);
    expect(job.jobs()[0]?.status).toBe("done");
  });

  it("DONE before any answer is still DONE, and a later answer still counts", async () => {
    const { job } = await cleaning();
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    expect(job.jobs()[0]?.status).toBe("done");
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "coffee pods" });
    expect(answer.outcome).toBe("supply-report");
    expect(job.jobs()[0]?.arrivalSupplyReport?.text).toBe("coffee pods");
  });

  it("STOP, HELP, an injury report, and a code-like text still win", async () => {
    for (const text of ["STOP", "HELP", "I fell and I'm hurt", `the door code ${PIN} didn't stick`]) {
      const { job } = await cleaning();
      const reply = await job.receive({ id: "x-1", from: CLEANER, text });
      expect(reply.outcome, text).not.toBe("supply-report");
      expect(job.jobs()[0]?.arrivalSupplyReport).toBeUndefined();
    }
  });

  it("after 12 hours the question is closed", async () => {
    const { job, clock } = await cleaning();
    clock.now = new Date(new Date(NOW).getTime() + 12 * 3_600_000 + 60_000);
    const late = await job.receive({ id: "low-1", from: CLEANER, text: "paper towels" });
    expect(late.outcome).not.toBe("supply-report");
    expect(job.jobs()[0]?.arrivalSupplyReport).toBeUndefined();
  });

  it("with Fixer Core on, DONE asks only about repairs", async () => {
    const { job } = await cleaning({ repairAsk: true });
    await job.receive({ id: "low-1", from: CLEANER, text: "trash bags" });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([repairDoneAsk()]);
    const broken = await job.receive({ id: "broken-1", from: CLEANER, text: "the shower handle is loose" });
    expect(broken.outcome).toBe("repair-report");
  });

  it("in a group, it goes to the group and only the cleaner's reply counts", async () => {
    const { box, job } = await cleaning({ group: true });
    const ask = box.sent.find((text) => text.body.includes("anything running low"));
    expect(ask?.channel).toBe("group");
    const host = await job.receive({ id: "host-1", from: OWNER, text: "we need coffee", ...channel(true) });
    expect(host.outcome).not.toBe("supply-report");
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "coffee pods", ...channel(true) });
    expect(answer.outcome).toBe("supply-report");
  });

  it("asked when done keeps today's flow: no text after the door code, the done text asks", async () => {
    const { box, job } = await cleaning({ arrival: false });
    expect(bodies(box.sent, SUPPLY_ARRIVAL_ASK)).toEqual([]);
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([SUPPLY_DONE_ASK]);
  });
});
