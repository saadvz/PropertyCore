import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { CHECKLIST_ASK, SUPPLY_DONE_ASK, SUPPLY_NOTED, repairDoneAsk, supplyRepairDoneAsk } from "../src/cleaner-core/cleanerTexts";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { emptyFixer, writeFixer } from "../src/fixer-core/store";
import { fakeConversations } from "./fakeConversations";
import { BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/**
 * With Fixer Core chosen by the host, the DONE text also asks "Anything broken?" (with Supply Core on,
 * "Anything running low or broken?") and the next reply is a repair-report. Only 555 numbers and the
 * Scratch Lane made-up code.
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
  repairAsk?: boolean;
  cleanerName?: string;
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
    ...(options.supplyAsk ? { supplyAsk: true } : {}),
    ...(options.repairAsk ? { repairAsk: true } : {}),
    ...(options.cleanerName ? { cleanerName: options.cleanerName } : {}),
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


describe("the repair question after DONE", () => {
  it("the two texts, with and without a saved name", () => {
    expect(repairDoneAsk("Maria")).toBe("Thanks, cleaning marked done. Anything broken? Maria, reply with what you noticed (a photo helps), or NONE.");
    expect(repairDoneAsk()).toBe("Thanks, cleaning marked done. Anything broken? Reply with what you noticed (a photo helps), or NONE.");
    expect(supplyRepairDoneAsk("Maria Lopez")).toBe("Thanks, cleaning marked done. Anything running low or broken? Maria, reply with what you noticed (a photo helps), or NONE.");
    expect(supplyRepairDoneAsk()).toBe("Thanks, cleaning marked done. Anything running low or broken? Reply with what you noticed (a photo helps), or NONE.");
    expect(SUPPLY_DONE_ASK).toBe("Thanks, cleaning marked done. Anything running low? Reply with what's low, or NONE.");
  });

  it("repair only, supplies and repairs, and neither choose the DONE text", async () => {
    const cases: [Options, string][] = [
      [{ repairAsk: true, cleanerName: "Maria Lopez" }, repairDoneAsk("Maria")],
      [{ repairAsk: true }, repairDoneAsk()],
      [{ repairAsk: true, supplyAsk: true, cleanerName: "Maria" }, supplyRepairDoneAsk("Maria")],
      [{ supplyAsk: true }, SUPPLY_DONE_ASK],
      [{}, DONE_ACK],
    ];
    for (const [options, expected] of cases) {
      const { job } = await cleaning(options);
      const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
      expect(done.sent.map((text) => text.body)).toEqual([expected]);
    }
  });

  it("the next reply is one repair-report, even when it names a supply and a repair", async () => {
    const { job } = await cleaning({ repairAsk: true, supplyAsk: true });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const answer = await job.receive({ id: "r-1", from: CLEANER, text: "Out of paper towels and the faucet drips" });
    expect(answer.sent.map((text) => text.body)).toEqual([SUPPLY_NOTED]);
    expect(answer.outcome).toBe("repair-report");
    expect(job.jobs()[0]?.supplyReport).toEqual({ text: "Out of paper towels and the faucet drips", at: NOW });
  });

  it("NONE is saved as none", async () => {
    const { job } = await cleaning({ repairAsk: true });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const answer = await job.receive({ id: "r-1", from: CLEANER, text: "NONE" });
    expect(answer.outcome).toBe("repair-report");
    expect(job.jobs()[0]?.supplyReport).toEqual({ none: true, at: NOW });
  });

  it("after the checklist YES, the repair text", async () => {
    const { job } = await cleaning({ checklist: true, repairAsk: true, cleanerName: "Maria" });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const yes = await job.receive({ id: "yes-1", from: CLEANER, text: "YES" });
    expect(yes.sent.map((text) => text.body)).toEqual([repairDoneAsk("Maria")]);
  });

  it("STOP, HELP, an injury report, and a code-like text still win", async () => {
    for (const text of ["STOP", "HELP", "I fell and I'm hurt", `the door code ${PIN} didn't stick`]) {
      const { job } = await cleaning({ repairAsk: true });
      await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
      const reply = await job.receive({ id: "x-1", from: CLEANER, text });
      expect(reply.outcome).not.toBe("repair-report");
      expect(job.jobs()[0]?.supplyReport).toBeUndefined();
    }
  });

  it("after 12 hours it is a normal message", async () => {
    const { job, clock } = await cleaning({ repairAsk: true });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    clock.now = new Date(new Date(NOW).getTime() + 12 * 3_600_000 + 60_000);
    const late = await job.receive({ id: "r-1", from: CLEANER, text: "the faucet drips" });
    expect(late.outcome).not.toBe("repair-report");
  });

  it("in a group, the text names the cleaner once and only the cleaner's reply counts", async () => {
    const { job } = await cleaning({ group: true, repairAsk: true, cleanerName: "Maria" });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE", ...channel(true) });
    expect(done.sent.map((text) => text.body)).toEqual(["Thanks, cleaning marked done. Anything broken? Maria, reply with what you noticed (a photo helps), or NONE."]);
    const host = await job.receive({ id: "host-1", from: OWNER, text: "the faucet drips", ...channel(true) });
    expect(host.outcome).not.toBe("repair-report");
    const answer = await job.receive({ id: "r-1", from: CLEANER, text: "the faucet drips", ...channel(true) });
    expect(answer.outcome).toBe("repair-report");
  });
});

describe("the live desk and Fixer Core", () => {
  const ZONE = "America/New_York";
  const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
  const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
  const roots: string[] = [];
  beforeEach(() => setCleanerAlertFetch(async () => ({ status: 200 })));
  afterEach(() => {
    setCleanerTwilioClient(undefined);
    setCleanerGroupFetch(undefined);
    setCleanerCalendarFetch(undefined);
    setCleanerAlertFetch(undefined);
    resetLiveDesks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const ok = (reply: ToolReply) => {
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };

  function openDesk() {
    const root = mkdtempSync(join(tmpdir(), "cleaner-repair-desk-"));
    roots.push(root);
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fakeConversations().impl);
    setCleanerCalendarFetch(async (url) => ({ status: url === CALENDAR_URL ? 200 : 404, url, async text() { return url === CALENDAR_URL ? CALENDAR_ICS : ""; } }));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "0",
      CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
      CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
    };
    return { root, sms, env, desk: liveDeskFor(root, () => env, () => new Date(FROZEN)) };
  }

  async function live(desk: LiveDesk) {
    ok(await desk.getState("cleaners", true));
    ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana Diaz", groupChat: "cleaner-only" }));
    ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door" }, PIN_KEY));
    ok(await desk.savePreferences({}));
    ok(await desk.savePayments({ on: false }));
    ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
    ok(await desk.activate());
    ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
  }

  function choose(root: string, askCleaner: boolean) {
    const file = emptyFixer();
    file.settings.activatedAt = new Date(FROZEN).toISOString();
    file.settings.askCleaner = askCleaner;
    writeFixer(root, file);
  }

  const bodies = (sms: ReturnType<typeof fakeSms>) => sms.sent.map((text) => text.body);

  it("keeps today's done text when Fixer Core is activated but the host did not choose it", async () => {
    const { desk, sms, root } = openDesk();
    choose(root, false);
    await live(desk);
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(bodies(sms)).toContain(DONE_ACK);
  });

  it("asks with the first name when chosen, labels the answer, and cleaningFor reports DONE and clearance", async () => {
    const { desk, sms, root } = openDesk();
    choose(root, true);
    await live(desk);
    expect(await desk.cleaningFor("2026-01-01")).toBeUndefined();
    const cleared = await desk.cleaningFor("2026-10-18");
    expect(cleared?.cleared).toBe(true);
    expect(cleared?.doneAt).toBeUndefined();
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(bodies(sms)).toContain(repairDoneAsk("Ana"));
    expect(await desk.cleaningFor("2026-10-18")).toMatchObject({ cleared: true, doneAt: new Date(FROZEN).toISOString() });
    await desk.inbound({ id: "r", from: CLEANER, text: "the faucet drips, gate 4812" });
    const messages = ok(await desk.checkNow()).messages as { handled: string; text: string }[];
    const report = messages.find((m) => m.handled === "repair-report");
    expect(report?.text).toContain("faucet");
    expect(report?.text).not.toContain("4812");
  });

  it("cleaningFor opens the engine on a fresh desk over saved files, before any other call", async () => {
    const { desk, root, env } = openDesk();
    choose(root, true);
    await live(desk);
    resetLiveDesks();
    const fresh = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(await fresh.cleaningFor("2026-10-18")).toMatchObject({ cleared: true });
  });

  it("keeps Cleaner Core working when fixer.json or supply.json can't be read", async () => {
    const { desk, sms, root } = openDesk();
    choose(root, true);
    await live(desk);
    for (const name of ["fixer.json", "supply.json"]) writeFileSync(join(root, name), "{ not json");
    desk.refreshSupplyAsk();
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(bodies(sms)).toContain(DONE_ACK);
    expect(ok(await desk.checkNow())).toBeDefined();
  });
});
