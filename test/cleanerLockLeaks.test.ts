import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { cleanupDesks, ok, openDesk, PIN_KEY, setUp, testClock } from "./cleanerDeskHarness";
import { approvedOnDesk } from "./hostApproval";
import { CLEANER, DOOR_CODE, HOST } from "./wiringProof";
import { deskFeatures } from "./featureEnv";

/**
 * Cleaner Core's leak checks guard every live code on a connected lock (#180): the saved code, the
 * cleaner's own code, and a backup code. Fake lock adapter and 555 numbers only.
 */

afterEach(() => {
  setLockAdapter(undefined);
  cleanupDesks();
});

const CHECKOUT = "2026-10-18T15:00:00.000Z";

async function released() {
  const clock = testClock();
  const opened = openDesk([HOST, CLEANER], "0", clock.now);
  Object.assign(opened.env, deskFeatures("locks"));
  opened.env.CLEANER_CORE_PIN_KEY = randomBytes(32).toString("base64");
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const devices = [fake.addDevice("acct-1", { id: "dev-front", name: "Front door" }), fake.addDevice("acct-1", { id: "dev-side", name: "Side gate" })];
  hubFor(opened.root, { now: clock.now })
    .doorAccess(() => opened.env)
    .saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: devices.map((device) => storedDevice(device)), doors: devices.map((device) => device.id), activeAt: clock.now().toISOString() });
  await setUp(opened.desk, { groupChat: "cleaner-only" });
  fake.failCodes("dev-side");
  await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
  await opened.desk.inbound({ id: "take", from: CLEANER, text: "YES" });
  clock.advance(Date.parse(CHECKOUT) - clock.now().getTime() + 30 * 60_000);
  ok(await opened.desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
  const own = fake.liveCodes("dev-front")[0]!.code;
  const backup = fake.liveCodes("dev-side").find((code) => code.backup)!.code;
  return { ...opened, fake, clock, own, backup };
}

/** Every file the desk wrote, as text, the sealed grants file included. */
function deskFiles(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("leak checks over every live code", () => {
  it("refuses a host message that holds the cleaner's own code or the backup code", async () => {
    const { desk, own, backup, sms } = await released();
    const before = sms.sent.length;
    for (const code of [own, backup, DOOR_CODE]) {
      const reply = await approvedOnDesk((confirmation) => desk.sendMessage({ to: CLEANER, text: `Try ${code} at the side`, ...(confirmation ? { confirmation } : {}) }));
      expect(reply.ok).toBe(false);
    }
    expect(sms.sent.length).toBe(before);
  });

  it("redacts a per-visit code the cleaner quotes, in what the agent reads", async () => {
    const { desk, own, backup } = await released();
    await desk.inbound({ id: "quote", from: CLEANER, text: `The side code ${backup} works, front ${own} too` });
    const state = JSON.stringify(ok(await desk.checkNow()));
    expect(state.includes(own)).toBe(false);
    expect(state.includes(backup)).toBe(false);
  });

  it("writes no per-visit code to any file, sealed grants included", async () => {
    const { root, own, backup } = await released();
    const text = deskFiles(root);
    expect(text.includes(own)).toBe(false);
    expect(text.includes(backup)).toBe(false);
  });

  it("never puts a per-visit code in get_state", async () => {
    const { desk, own, backup } = await released();
    const state = JSON.stringify(ok(await desk.getState("cleaners")));
    expect(state.includes(own)).toBe(false);
    expect(state.includes(backup)).toBe(false);
  });
});
