import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { cleanupDesks, ok, openDesk, PIN_KEY, setUp, testClock } from "./cleanerDeskHarness";
import { approvedOnDesk, resumeApproved } from "./hostApproval";
import { CLEANER, DOOR_CODE, HOST } from "./wiringProof";
import { deskFeatures } from "./featureEnv";

/**
 * Cleaner Core on connected locks (#180): the cleaner's own code is made at their YES, moved with the
 * window, revoked on a hold, and released from the lock. Fake lock adapter and 555 numbers only.
 */

afterEach(() => {
  setLockAdapter(undefined);
  cleanupDesks();
});

// The harness's turnover: checkout Oct 18 at 11:00 New York, next check-in the same day.
const CHECKOUT = "2026-10-18T15:00:00.000Z";
const UNTIL = "2026-10-19T04:00:00.000Z";

async function connected(options: { locks?: boolean; doors?: number } = {}) {
  const clock = testClock();
  const opened = openDesk([HOST, CLEANER], "0", clock.now);
  if (options.locks !== false) Object.assign(opened.env, deskFeatures("locks"));
  opened.env.CLEANER_CORE_PIN_KEY = randomBytes(32).toString("base64");
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const devices = [fake.addDevice("acct-1", { id: "dev-front", name: "Front door" })];
  if ((options.doors ?? 1) > 1) devices.push(fake.addDevice("acct-1", { id: "dev-side", name: "Side gate" }));
  hubFor(opened.root, { now: clock.now })
    .doorAccess(() => opened.env)
    .saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: devices.map((device) => storedDevice(device)), doors: devices.map((device) => device.id), activeAt: clock.now().toISOString() });
  await setUp(opened.desk, { groupChat: "cleaner-only" });
  return { ...opened, fake, clock };
}

/** The cleaner opts in, then takes the offered cleaning. */
async function taken(desk: Awaited<ReturnType<typeof connected>>["desk"]) {
  await desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "take", from: CLEANER, text: "YES" });
}

function codeTexts(sms: { sent: { to: string; body: string }[] }) {
  return sms.sent.filter((text) => text.to === CLEANER && /Door code/.test(text.body));
}

describe("Cleaner Core on connected locks", () => {
  it("makes no code before the cleaner's YES, and one at it, for the cleaning's window", async () => {
    const { desk, fake } = await connected();
    await desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
    expect(fake.liveCodes("dev-front")).toEqual([]);
    await desk.inbound({ id: "take", from: CLEANER, text: "YES" });
    const live = fake.liveCodes("dev-front");
    expect(live.length).toBe(1);
    expect(live[0]!.window).toEqual({ from: CHECKOUT, until: UNTIL });
    expect(live[0]!.code).not.toBe(DOOR_CODE);
  });

  it("releases the cleaner's own code, never the saved one, after the host's guests-left", async () => {
    const { desk, fake, sms, clock } = await connected();
    await taken(desk);
    const code = fake.liveCodes("dev-front")[0]!.code;
    clock.advance(Date.parse(CHECKOUT) - clock.now().getTime() + 30 * 60_000);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    const texts = codeTexts(sms);
    expect(texts.length).toBe(1);
    expect(texts[0]!.body).toContain(code);
    expect(texts[0]!.body).not.toContain(DOOR_CODE);
  });

  it("starts the code when the host clears the guests before checkout", async () => {
    const { desk, fake, clock } = await connected();
    await taken(desk);
    clock.advance(Date.parse(CHECKOUT) - clock.now().getTime() - 60 * 60_000);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(fake.liveCodes("dev-front")[0]!.window.from).toBe(clock.now().toISOString());
  });

  it("revokes the code when the host pauses the cleaning, and makes a new one, unsent, on resume", async () => {
    const { desk, fake, sms } = await connected();
    await taken(desk);
    const first = fake.liveCodes("dev-front")[0]!.code;
    ok(await approvedOnDesk((confirmation) => desk.holdJob(confirmation ? { confirmation } : {})));
    expect(fake.liveCodes("dev-front")).toEqual([]);
    ok(await resumeApproved(desk));
    const after = fake.liveCodes("dev-front");
    expect(after.length).toBe(1);
    expect(after[0]!.code).not.toBe(first);
    expect(codeTexts(sms)).toEqual([]);
  });

  it("names each door's code when one door fell back to a backup code, and tells the host", async () => {
    const { desk, fake, sms, clock } = await connected({ doors: 2 });
    fake.failCodes("dev-side");
    await taken(desk);
    clock.advance(Date.parse(CHECKOUT) - clock.now().getTime() + 30 * 60_000);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    const main = fake.liveCodes("dev-front")[0]!.code;
    const backup = fake.liveCodes("dev-side").find((code) => code.backup)!.code;
    const text = codeTexts(sms)[0]!.body;
    expect(text).toContain(`Front door: ${main}, Side gate: ${backup}`);
    const state = ok(await desk.getState("cleaners"));
    expect(JSON.stringify(state)).not.toContain(backup);
    expect(JSON.stringify(state)).not.toContain(main);
  });

  it("with the account's locks switch off, nothing reaches the lock and the saved code goes as before", async () => {
    const { desk, fake, sms, clock } = await connected({ locks: false });
    await taken(desk);
    clock.advance(Date.parse(CHECKOUT) - clock.now().getTime() + 30 * 60_000);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(fake.calls).toEqual([]);
    expect(codeTexts(sms)[0]!.body).toContain(DOOR_CODE);
  });
});
