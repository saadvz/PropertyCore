import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { CHECKLIST_ASK, CHECKLIST_NOT_DONE, PHOTO_FIRST } from "../src/cleaner-core/cleanerTexts";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const NOW = "2026-10-14T15:00:00.000Z";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const DONE_ACK = "Thanks, cleaning marked done.";
const HOST_DONE = "The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.";
const CHECKLIST = { name: "Lake House", items: ["Strip the beds", "Restock coffee"] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sink() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

interface Options {
  group?: boolean;
  checklist?: boolean;
  photosRequired?: boolean;
  dataDir?: string;
}

function engine(box: ReturnType<typeof sink>, options: Options) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    pin: PIN,
    hostName: "Scratch",
    consented: true,
    sink: box,
    now: () => new Date(NOW),
    grokReadsMessages: true,
    ...(options.checklist === false ? {} : { checklist: CHECKLIST }),
    ...(options.photosRequired ? { photosRequired: true } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  });
}

/** A cleaning in progress: offered, confirmed, the guests have left, and the code and checklist went out. */
async function cleaning(options: Options = {}) {
  const box = sink();
  const job = engine(box, options);
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
  return { box, job };
}

const channel = (group?: boolean) => (group ? { channel: "group" as const } : {});
const bodies = (sent: CleanerText[], body: string) => sent.filter((text) => text.body === body);

describe("DONE waits for the checklist YES", () => {
  it("asks about the checklist, then YES finishes the cleaning", async () => {
    const { box, job } = await cleaning();
    const asked = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(asked.sent.map((text) => text.body)).toEqual([CHECKLIST_ASK]);
    expect(job.jobs()[0]?.status).not.toBe("done");
    expect(bodies(box.sent, HOST_DONE)).toEqual([]);

    const yes = await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(yes.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    expect(job.jobs()[0]?.status).toBe("done");
    expect(job.jobs()[0]?.checklistConfirmedAt).toBe(NOW);
    expect(bodies(box.sent, HOST_DONE)).toHaveLength(1);
  });

  it("keeps the cleaning open on NO, and labels it checklist-not-done", async () => {
    const { job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const no = await job.receive({ id: "no-1", from: CLEANER, text: "NO" });
    expect(no.sent.map((text) => text.body)).toEqual([CHECKLIST_NOT_DONE]);
    expect(no.outcome).toBe("checklist-not-done");
    expect(job.jobs()[0]?.status).not.toBe("done");

    await job.receive({ id: "done-2", from: CLEANER, text: "DONE" });
    const yes = await job.receive({ id: "yes-2", from: CLEANER, text: "YES" });
    expect(yes.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    expect(job.jobs()[0]?.status).toBe("done");
  });

  it("asks for a photo first when photos are required", async () => {
    const { job } = await cleaning({ photosRequired: true });
    const early = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(early.sent.map((text) => text.body)).toEqual([PHOTO_FIRST]);
    await job.receive({ id: "mms", from: CLEANER, text: "", media: 1 });
    const asked = await job.receive({ id: "done-2", from: CLEANER, text: "DONE" });
    expect(asked.sent.map((text) => text.body)).toEqual([CHECKLIST_ASK]);
  });

  it("finishes straight away without a checklist", async () => {
    const { job } = await cleaning({ checklist: false });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    expect(job.jobs()[0]?.status).toBe("done");
    expect(job.jobs()[0]?.checklistConfirmedAt).toBeUndefined();
  });

  it("in a group, asks in the group and counts only the cleaner's YES", async () => {
    const { job } = await cleaning({ group: true });
    const asked = await job.receive({ id: "done-1", from: CLEANER, text: "DONE", ...channel(true) });
    expect(asked.sent.map((text) => ({ body: text.body, channel: text.channel }))).toEqual([{ body: CHECKLIST_ASK.replace("Reply YES", "Maria, reply YES"), channel: "group" }]);
    await job.receive({ id: "host-yes-2", from: OWNER, text: "YES", ...channel(true) });
    expect(job.jobs()[0]?.status).not.toBe("done");
    const yes = await job.receive({ id: "yes-1", from: CLEANER, text: "YES", ...channel(true) });
    expect(yes.sent.map((text) => text.body)).toEqual([DONE_ACK]);
    expect(job.jobs()[0]?.status).toBe("done");
  });

  it("still puts STOP and an injury first while the question waits", async () => {
    const hurt = await cleaning();
    await hurt.job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const injury = await hurt.job.receive({ id: "hurt", from: CLEANER, text: "I fell and I'm hurt" });
    expect(injury.reason).not.toBe("done");
    expect(hurt.job.jobs()[0]?.status).not.toBe("done");

    const stop = await cleaning();
    await stop.job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const stopped = await stop.job.receive({ id: "stop", from: CLEANER, text: "STOP" });
    expect(stopped.reason).not.toBe("done");
    expect(stop.job.jobs()[0]?.status).not.toBe("done");
  });

  it("asks once per DONE and finishes once when DONE comes twice before YES", async () => {
    const { box, job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    await job.receive({ id: "done-2", from: CLEANER, text: "DONE" });
    await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(bodies(box.sent, CHECKLIST_ASK)).toHaveLength(2);
    expect(bodies(box.sent, DONE_ACK)).toHaveLength(1);
  });

  it("finishes once when the same YES is replayed", async () => {
    const { box, job } = await cleaning();
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(bodies(box.sent, DONE_ACK)).toHaveLength(1);
    expect(bodies(box.sent, HOST_DONE)).toHaveLength(1);
  });

  it("keeps the waiting question across a restart and finishes once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-checklist-yes-"));
    dirs.push(dir);
    const { box, job } = await cleaning({ dataDir: dir });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const box2 = sink();
    const reopened = engine(box2, { dataDir: dir });
    await reopened.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    await reopened.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(bodies([...box.sent, ...box2.sent], DONE_ACK)).toHaveLength(1);
    expect(reopened.jobs()[0]?.status).toBe("done");
  });
});
