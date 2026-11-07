import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { CHECKLIST_ASK, SUPPLY_DONE_ASK, SUPPLY_NOTED } from "../src/cleaner-core/cleanerTexts";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

/**
 * With Supply Core on, the cleaner's DONE gets one text that also asks what's running low, and the
 * next reply is saved as the supplies answer. Only 555 numbers and the Scratch Lane made-up code.
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
const CHECKLIST = { name: "Lake House", items: ["Strip the beds", "Restock coffee"] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  checklist?: boolean;
  supplyAsk?: boolean;
  dataDir?: string;
  clock?: { now: Date };
}

function engine(box: ReturnType<typeof sink>, options: Options) {
  const clock = options.clock ?? { now: new Date(NOW) };
  return openCleanerCore({
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
    ...(options.checklist ? { checklist: CHECKLIST } : {}),
    ...(options.supplyAsk === false ? {} : { supplyAsk: true }),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  });
}

async function cleaning(options: Options = {}) {
  const box = sink();
  const clock = options.clock ?? { now: new Date(NOW) };
  const job = engine(box, { ...options, clock });
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
  await job.receive({ id: "left", from: OWNER, text: "guests have left" });
  return { box, job, clock };
}

const channel = (group?: boolean) => (group ? { channel: "group" as const } : {});
const bodies = (sent: CleanerText[], body: string) => sent.filter((text) => text.body === body);

describe("the supplies question after DONE", () => {
  it("DONE sends one combined text and marks the job done", async () => {
    const { box, job } = await cleaning();
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([SUPPLY_DONE_ASK]);
    expect(bodies(box.sent, DONE_ACK)).toEqual([]);
    expect(job.jobs()[0]?.status).toBe("done");
  });

  it("after the checklist YES, the same combined text", async () => {
    const { job } = await cleaning({ checklist: true });
    const asked = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(asked.sent.map((text) => text.body)).toEqual([CHECKLIST_ASK]);
    const yes = await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(yes.sent.map((text) => text.body)).toEqual([SUPPLY_DONE_ASK]);
  });

  it("the next cleaner text is the answer: saved, labelled supply-report, replied Thanks, noted.", async () => {
    const { job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "Out of paper towels and almost out of dish soap" });
    expect(answer.sent.map((text) => text.body)).toEqual([SUPPLY_NOTED]);
    expect(answer.outcome).toBe("supply-report");
    expect(job.jobs()[0]?.supplyReport).toEqual({ text: "Out of paper towels and almost out of dish soap", at: NOW });
  });

  it("NONE, NO, and 'nothing' save none with the same reply", async () => {
    for (const word of ["NONE", "No", "nothing"]) {
      const { job } = await cleaning();
      await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
      const answer = await job.receive({ id: "low-1", from: CLEANER, text: word });
      expect(answer.sent.map((text) => text.body)).toEqual([SUPPLY_NOTED]);
      expect(job.jobs()[0]?.supplyReport).toEqual({ none: true, at: NOW });
    }
  });

  it("a YES is not the answer; the question keeps waiting", async () => {
    const { job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const yes = await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(yes.outcome).not.toBe("supply-report");
    expect(job.jobs()[0]?.supplyReport).toBeUndefined();
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "trash bags" });
    expect(answer.outcome).toBe("supply-report");
  });

  it("STOP, HELP, an injury report, and a code-like text still win", async () => {
    for (const text of ["STOP", "HELP", "I fell and I'm hurt", `the door code ${PIN} didn't stick`]) {
      const { job } = await cleaning();
      await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
      const reply = await job.receive({ id: "x-1", from: CLEANER, text });
      expect(reply.outcome).not.toBe("supply-report");
      expect(job.jobs()[0]?.supplyReport).toBeUndefined();
    }
  });

  it("after 12 hours the question is closed and a text is a normal message", async () => {
    const { job, clock } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    clock.now = new Date(new Date(NOW).getTime() + 12 * 3_600_000 + 60_000);
    const late = await job.receive({ id: "low-1", from: CLEANER, text: "paper towels" });
    expect(late.outcome).not.toBe("supply-report");
    expect(job.jobs()[0]?.supplyReport).toBeUndefined();
  });

  it("in a group, only the cleaner's reply counts", async () => {
    const { job } = await cleaning({ group: true });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE", ...channel(true) });
    expect(done.sent.map((text) => text.body)).toEqual(["Thanks, cleaning marked done. Anything running low? Maria, reply with what's low, or NONE."]);
    const host = await job.receive({ id: "host-1", from: OWNER, text: "we need coffee", ...channel(true) });
    expect(host.outcome).not.toBe("supply-report");
    expect(job.jobs()[0]?.supplyReport).toBeUndefined();
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "coffee pods", ...channel(true) });
    expect(answer.outcome).toBe("supply-report");
  });

  it("a replayed answer and a restart send one Thanks, noted.", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-supply-ask-"));
    dirs.push(dir);
    const { box, job } = await cleaning({ dataDir: dir });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    await job.receive({ id: "low-1", from: CLEANER, text: "paper towels" });
    await job.receive({ id: "low-1", from: CLEANER, text: "paper towels" });
    const box2 = sink();
    const reopened = engine(box2, { dataDir: dir });
    await reopened.receive({ id: "low-1", from: CLEANER, text: "paper towels" });
    await reopened.receive({ id: "low-2", from: CLEANER, text: "and soap" });
    expect([...bodies(box.sent, SUPPLY_NOTED), ...bodies(box2.sent, SUPPLY_NOTED)]).toHaveLength(1);
    expect(reopened.jobs()[0]?.supplyReport?.text).toBe("paper towels");
  });

  it("supplyAsk off keeps today's done text exactly", async () => {
    const { job } = await cleaning({ supplyAsk: false });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    const next = await job.receive({ id: "low-1", from: CLEANER, text: "paper towels" });
    expect(next.outcome).not.toBe("supply-report");
  });

  it("an answer with a 4-digit run is redacted in the job", async () => {
    const { job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const answer = await job.receive({ id: "low-1", from: CLEANER, text: "out of soap, gate 4812 sticks" });
    expect(answer.outcome).toBe("supply-report");
    expect(job.jobs()[0]?.supplyReport?.text).not.toContain("4812");
  });
});

describe("the supplies question and a later offer", () => {
  it("a bare NO while the next turnover's offer waits declines the offer, not the supplies question", async () => {
    const { box, job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    await job.receive({ id: "h1", from: OWNER, text: "YES" });
    await job.receive({ id: "h2", from: OWNER, text: "YES" });
    expect(job.jobs()[1]?.status).toBe("offered");
    const no = await job.receive({ id: "no-1", from: CLEANER, text: "No" });
    expect(no.outcome).not.toBe("supply-report");
    expect(bodies(box.sent, SUPPLY_NOTED)).toEqual([]);
    expect(job.jobs()[0]?.supplyReport).toBeUndefined();
    expect(job.jobs()[1]?.status).toBe("declined");
  });
});
