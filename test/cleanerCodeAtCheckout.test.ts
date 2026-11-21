import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice, type ReleaseMode } from "../src/locks/settings";
import { cleanupDesks, ok, openDesk, PIN_KEY, setUp, testClock } from "./cleanerDeskHarness";
import { approvedOnDesk, resumeApproved } from "./hostApproval";
import { CLEANER, DOOR_CODE, HOST } from "./wiringProof";
import { deskFeatures } from "./featureEnv";

/**
 * The cleaner's code at checkout time (codeAtCheckout, #180): off by default, only on connected
 * locks, every other release check intact, a hold revokes, an offline lock falls back to the host's
 * yes, and resuming never sends a code on its own. Fake lock adapter and 555 numbers only.
 */

afterEach(() => {
  setLockAdapter(undefined);
  cleanupDesks();
});

// The harness's turnover: checkout Oct 18 at 11:00 New York, next check-in 16:00 the same day.
const CHECKOUT = Date.parse("2026-10-18T15:00:00.000Z");
const MIN = 60_000;

async function world(options: { cleaners?: ReleaseMode; locks?: boolean; take?: boolean } = {}) {
  const clock = testClock();
  const opened = openDesk([HOST, CLEANER], "0", clock.now);
  if (options.locks !== false) Object.assign(opened.env, deskFeatures("locks"));
  opened.env.CLEANER_CORE_PIN_KEY = randomBytes(32).toString("base64");
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const device = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const door = hubFor(opened.root, { now: clock.now }).doorAccess(() => opened.env);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(device)], doors: [device.id], activeAt: clock.now().toISOString(), release: { cleaners: options.cleaners ?? "automatic", pros: "ask" } });
  await setUp(opened.desk, { groupChat: "cleaner-only" });
  await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
  if (options.take !== false) await opened.desk.inbound({ id: "take", from: CLEANER, text: "YES" });
  const at = (ms: number) => clock.advance(ms - clock.now().getTime());
  const codeTexts = () => opened.sms.sent.filter((text) => text.to === CLEANER && /Door code/.test(text.body));
  const notes = async () => {
    const now = ok(await opened.desk.checkNow());
    return ((now.alerts as unknown[] | undefined) ?? []).map((alert) => (typeof alert === "string" ? alert : JSON.stringify(alert)));
  };
  return { ...opened, fake, door, clock, at, codeTexts, notes };
}

describe("the cleaner's code at checkout time", () => {
  it("is off by default: at checkout nothing goes, and the host is asked as today", async () => {
    const w = await world({ cleaners: "ask" });
    w.at(CHECKOUT + MIN);
    await w.desk.lockClock();
    expect(w.codeTexts()).toEqual([]);
    expect((await w.notes()).some((note) => note.includes("Have the guests left?"))).toBe(true);
    expect(w.codeTexts()).toEqual([]);
  });

  it("gives the host a heads-up an hour before, then sends the cleaner's own code at checkout", async () => {
    const w = await world();
    w.at(CHECKOUT - 61 * MIN);
    await w.desk.lockClock();
    w.at(CHECKOUT - 60 * MIN);
    await w.desk.lockClock();
    expect(w.codeTexts()).toEqual([]);
    expect(await w.notes()).toContain("The cleaner's code goes out at checkout, 11:00 AM. If the guests are staying late, say pause.");
    w.at(CHECKOUT);
    await w.desk.lockClock();
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    expect(w.codeTexts().length).toBe(1);
    expect(w.codeTexts()[0]!.body).toContain(code);
    expect(w.codeTexts()[0]!.body).not.toContain(DOOR_CODE);
    expect(await w.notes()).toContain("Sent Ana the code for the 11:00 AM turnover. Say pause if the guests are still there.");
    await w.desk.lockClock();
    expect(w.codeTexts().length).toBe(1);
  });

  it("keeps every other check: no YES from the cleaner, nothing goes", async () => {
    const w = await world({ take: false });
    w.at(CHECKOUT + MIN);
    await w.desk.lockClock();
    expect(w.codeTexts()).toEqual([]);
  });

  it("sends nothing at checkout while the cleaning is on hold", async () => {
    const w = await world();
    ok(await approvedOnDesk((confirmation) => w.desk.holdJob(confirmation ? { confirmation } : {})));
    w.at(CHECKOUT + MIN);
    await w.desk.lockClock();
    expect(w.codeTexts()).toEqual([]);
  });

  it("needs connected locks: with the account's locks switch off nothing goes on its own", async () => {
    const w = await world({ locks: false });
    w.at(CHECKOUT + MIN);
    await w.desk.lockClock();
    ok(await w.desk.checkNow());
    expect(w.codeTexts()).toEqual([]);
  });

  it("falls back to the host's yes when the lock is offline at checkout", async () => {
    const w = await world();
    const locks = w.door.locks();
    locks.devices[0]!.online = false;
    w.door.saveLocks(locks);
    w.at(CHECKOUT + MIN);
    await w.desk.lockClock();
    expect(w.codeTexts()).toEqual([]);
    expect((await w.notes()).some((note) => note.includes("Have the guests left?"))).toBe(true);
    ok(await w.desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(w.codeTexts().length).toBe(1);
  });

  it("a pause revokes the code; resuming sends nothing; reminders every 30 minutes; the host's yes sends a new code", async () => {
    const w = await world();
    w.at(CHECKOUT);
    await w.desk.lockClock();
    const first = w.fake.liveCodes("dev-front")[0]!.code;
    expect(w.codeTexts().length).toBe(1);
    ok(await approvedOnDesk((confirmation) => w.desk.holdJob(confirmation ? { confirmation } : {})));
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    w.at(CHECKOUT + 29 * MIN);
    await w.desk.lockClock();
    w.at(CHECKOUT + 30 * MIN);
    await w.desk.lockClock();
    w.at(CHECKOUT + 61 * MIN);
    await w.desk.lockClock();
    const early = (await w.notes()).filter((note) => note.includes("is still paused"));
    expect(early).toEqual([
      "The turnover at 12 Practice Lane, Teaneck, NJ 07666 is still paused. Once the guests have left, tell me and I'll send Ana a new code.",
      "The turnover at 12 Practice Lane, Teaneck, NJ 07666 is still paused. Once the guests have left, tell me and I'll send Ana a new code.",
    ]);
    // Less than three hours before the 4:00 PM check-in, the reminder says time is short.
    w.at(CHECKOUT + 185 * MIN);
    await w.desk.lockClock();
    const late = (await w.notes()).filter((note) => note.includes("is still paused"));
    expect(late).toEqual([expect.stringContaining("The next guests check in at 4:00 PM, so time for the cleaning is getting short.")]);
    ok(await resumeApproved(w.desk));
    await w.desk.lockClock();
    expect(w.codeTexts().length).toBe(1);
    const second = w.fake.liveCodes("dev-front")[0]!.code;
    expect(second).not.toBe(first);
    ok(await w.desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(w.codeTexts().length).toBe(2);
    expect(w.codeTexts()[1]!.body).toContain(second);
  });
});
