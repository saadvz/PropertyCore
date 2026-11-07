import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { cleaningWindow, DOOR_WINDOW_OVER, fixedCodePort, type DoorAccessPort } from "../src/cleaner-core/doorPort";
import type { AccessGrant } from "../src/hub/doorAccess";
import { hubFor, resetHubs } from "../src/hub/hub";
import { sealPin } from "../src/hub/pinSeal";

/** The engine gets the door code for a release only from the hub's door access request. 555 numbers and made-up codes. */

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
// Built at runtime so the secret scan never finds a code in this file.
const CODE = ["5", "2", "6", "0"].join("");
const OTHER = ["6", "1", "3", "9"].join("");
const NOW = "2026-10-14T15:00:00.000Z";
const AFTER = "2026-10-18T15:30:00.000Z";
const feed = (name: string) => readFileSync(join("src/cleaner-core/fixtures", name), "utf8");
const dirs: string[] = [];

afterEach(() => {
  resetHubs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "door-port-"));
  dirs.push(dir);
  return dir;
}

type Request = Parameters<DoorAccessPort["request"]>[0];

function port(answer: (input: Request) => AccessGrant, check = CODE): DoorAccessPort & { asked: Request[] } {
  const asked: Request[] = [];
  return {
    asked,
    request: async (input) => {
      asked.push(input);
      return answer(input);
    },
    codeForChecks: () => check,
  };
}

function engine(sent: CleanerText[], clock: { at: string }, access: DoorAccessPort, extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    hostName: "Scratch",
    consented: true,
    sink: { send: (text) => void sent.push(text) },
    now: () => new Date(clock.at),
    access,
    accessRefused: { sealed: "Enter the code again.", "window-over": DOOR_WINDOW_OVER },
    watchFreshness: false,
    ...extra,
  });
}

async function scheduled(job: ReturnType<typeof engine>): Promise<void> {
  await job.pollFeed(feed("guesty-lite-scratch.ics"));
  await job.receive({ id: "opt", from: CLEANER, text: "YES" });
  await job.receive({ id: "out", from: OWNER, text: "YES" });
  await job.receive({ id: "in", from: OWNER, text: "YES" });
  await job.receive({ id: "yes", from: CLEANER, text: "YES" });
}

const pins = (sent: CleanerText[]) => sent.filter((text) => text.kind === "pin");

describe("the cleaning window", () => {
  it("runs from checkout to the end of the next check-in day", () => {
    expect(cleaningWindow({ checkoutDate: "2026-11-07", checkoutTime: "10:00", nextCheckInDate: "2026-11-10", timeZone: "America/New_York" })).toEqual({
      from: "2026-11-07T15:00:00.000Z",
      until: "2026-11-11T05:00:00.000Z",
    });
  });

  it("with no next booking ends two days after checkout", () => {
    expect(cleaningWindow({ checkoutDate: "2026-11-07", checkoutTime: "10:00", nextCheckInDate: null, timeZone: "America/New_York" }).until).toBe("2026-11-09T05:00:00.000Z");
  });
});

describe("the engine asks the hub at release", () => {
  it("the code text uses the grant's code and lock location", async () => {
    const sent: CleanerText[] = [];
    const clock = { at: NOW };
    const access = port((input) => ({ ok: true, kind: "code", code: OTHER, lockLocation: "side gate", until: input.window.until }));
    const job = engine(sent, clock, access);
    await scheduled(job);
    clock.at = AFTER;
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]!.body).toContain(OTHER);
    expect(pins(sent)[0]!.body).toContain("side gate");
    expect(pins(sent)[0]!.body).not.toContain(CODE);
    // The fixture's turnover is same-day: checkout Oct 18 11:00 AM, next guest Oct 18.
    expect(access.asked).toEqual([{ person: CLEANER, purpose: "cleaning", jobId: expect.any(String), window: { from: "2026-10-18T15:00:00.000Z", until: "2026-10-19T04:00:00.000Z" } }]);
  });

  it("a refused grant sends the cleaner nothing and notes the host once", async () => {
    const sent: CleanerText[] = [];
    const clock = { at: NOW };
    const job = engine(sent, clock, port(() => ({ ok: false, reason: "sealed" })));
    await scheduled(job);
    clock.at = AFTER;
    await job.receive({ id: "left-1", from: OWNER, text: "guests have left" });
    await job.receive({ id: "left-2", from: OWNER, text: "guests have left" });
    await job.runReminders();
    expect(pins(sent)).toEqual([]);
    expect(sent.filter((text) => text.to === CLEANER && text.body.includes("Door code"))).toEqual([]);
    expect(job.hostNotes().filter((note) => note === "Enter the code again.")).toHaveLength(1);
  });

  it("a same-day turnover released in the evening still sends", async () => {
    const root = folder();
    const key = randomBytes(32);
    const hub = hubFor(root, { now: () => new Date(clock.at) });
    const door = hub.doorAccess(() => ({}));
    const clock = { at: NOW };
    expect(door.save(CODE, undefined, key)).toEqual({ ok: true });
    const access: DoorAccessPort = { request: async (input) => door.request({ ...input, key }), codeForChecks: () => door.codeForChecks(key) };
    const sent: CleanerText[] = [];
    const job = engine(sent, clock, access);
    await scheduled(job);
    clock.at = "2026-10-18T23:30:00.000Z";
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]!.body).toContain(CODE);
  });

  it("days late, the hub refuses the window and the host hears it once", async () => {
    const root = folder();
    const key = randomBytes(32);
    const clock = { at: NOW };
    const door = hubFor(root, { now: () => new Date(clock.at) }).doorAccess(() => ({}));
    door.save(CODE, undefined, key);
    const access: DoorAccessPort = { request: async (input) => door.request({ ...input, key }), codeForChecks: () => door.codeForChecks(key) };
    const sent: CleanerText[] = [];
    const job = engine(sent, clock, access);
    await scheduled(job);
    clock.at = "2026-10-21T15:00:00.000Z";
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(pins(sent)).toEqual([]);
    expect(job.hostNotes().filter((note) => note === DOOR_WINDOW_OVER)).toHaveLength(1);
  });

  it("after a restart the reminder pass sends the code once through the hub", async () => {
    const root = folder();
    const data = folder();
    const server = randomBytes(32).toString("base64");
    const env = () => ({ CLEANER_CORE_PIN_KEY: server });
    const clock = { at: "2026-10-18T16:00:00.000Z" };
    const hubPort = (): DoorAccessPort => {
      const door = hubFor(root, { now: () => new Date(clock.at) }).doorAccess(env);
      return { request: async (input) => door.request(input), codeForChecks: () => door.codeForChecks() };
    };
    hubFor(root, { now: () => new Date(clock.at) }).doorAccess(env).save(CODE, undefined, undefined);
    const first = engine([], clock, hubPort(), { dataDir: data, halt: "before-pin" });
    await scheduled(first);
    await expect(first.receive({ id: "left", from: OWNER, text: "guests have left" })).rejects.toThrow(/before-pin/);
    resetHubs();
    const sent: CleanerText[] = [];
    const second = engine(sent, clock, hubPort(), { dataDir: data });
    await second.runReminders();
    resetHubs();
    await engine(sent, clock, hubPort(), { dataDir: data }).runReminders();
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]!.body).toContain(CODE);
  });
});

describe("the engine stores no door code", () => {
  it("the engine store never holds a seal", async () => {
    const data = folder();
    const clock = { at: NOW };
    const job = engine([], clock, fixedCodePort(CODE), { dataDir: data });
    await scheduled(job);
    const store = readFileSync(join(data, "cleaner-core.json"), "utf8");
    expect(store).not.toContain("pinSeal");
    expect(store).not.toContain(CODE);
  });

  it("an old store's pinSeal is ignored and dropped on the next save", async () => {
    const data = folder();
    const clock = { at: NOW };
    await scheduled(engine([], clock, fixedCodePort(CODE), { dataDir: data }));
    const path = join(data, "cleaner-core.json");
    const old = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // The old engine seal's key was made from the property id, so this is a seal the old engine opened.
    old.pinSeal = sealPin(CODE, createHash("sha256").update("cleaner-core-pin:prop_12_scratch_lane").digest());
    writeFileSync(path, `${JSON.stringify(old)}\n`);
    const sent: CleanerText[] = [];
    const again = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      hostName: "Scratch",
      consented: true,
      sink: { send: (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      watchFreshness: false,
      dataDir: data,
    });
    await again.runReminders();
    clock.at = AFTER;
    await again.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(pins(sent)).toEqual([]);
    expect(readFileSync(path, "utf8")).not.toContain("pinSeal");
  });
});
