import { describe, expect, it } from "vitest";
import { FakeLockAdapter } from "../src/locks/fake";
import { freshCode, guessable, makeSameCode, sharedLength } from "../src/locks/sameCode";

/** The lock adapter's fake and one code on every door. No network; codes are made at runtime. */

const WINDOW = { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };

function twoDoors() {
  const fake = new FakeLockAdapter();
  const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const side = fake.addDevice("acct-1", { id: "dev-side", name: "Side gate" });
  return { fake, devices: [front, side] };
}

describe("lock adapter fake", () => {
  it("lists only the devices tagged with the account", async () => {
    const { fake } = twoDoors();
    fake.addDevice("acct-2", { id: "dev-other", name: "Other front" });
    expect((await fake.devices({ customerKey: "acct-1" })).map((device) => device.id)).toEqual(["dev-front", "dev-side"]);
    expect((await fake.devices({ customerKey: "acct-3" })).length).toBe(0);
  });

  it("verifies its own webhooks and drops a changed body", () => {
    const { fake } = twoDoors();
    const signed = fake.webhook({ id: "evt-1", kind: "unlock", partnerType: "lock.unlocked", at: WINDOW.from, deviceId: "dev-front" });
    expect(fake.parseWebhook(signed)?.id).toBe("evt-1");
    expect(fake.parseWebhook({ headers: signed.headers, body: signed.body.replace("evt-1", "evt-2") })).toBeUndefined();
    expect(fake.parseWebhook({ headers: {}, body: signed.body })).toBeUndefined();
    const other = new FakeLockAdapter("another-secret");
    expect(other.parseWebhook(signed)).toBeUndefined();
  });
});

describe("one code on every door", () => {
  it("puts the same value on each device", async () => {
    const { fake, devices } = twoDoors();
    const made = await makeSameCode(fake, { devices, name: "Cleaner 1", window: WINDOW, avoid: new Set() });
    expect(made?.devices.map((device) => device.status)).toEqual(["set", "set"]);
    const front = fake.liveCodes("dev-front");
    const side = fake.liveCodes("dev-side");
    expect(front.length).toBe(1);
    expect(front[0]!.code).toBe(made!.code);
    expect(side[0]!.code).toBe(made!.code);
    expect(front[0]!.window).toEqual(WINDOW);
  });

  it("removes what it made and tries a new value on all when one lock refuses the value", async () => {
    const { fake, devices } = twoDoors();
    fake.refuseValues("dev-side", 1);
    const made = await makeSameCode(fake, { devices, name: "Cleaner 1", window: WINDOW, avoid: new Set() });
    expect(made).toBeDefined();
    expect(fake.liveCodes("dev-front").map((code) => code.code)).toEqual([made!.code]);
    expect(fake.liveCodes("dev-side").map((code) => code.code)).toEqual([made!.code]);
    expect(fake.calls.filter((call) => call.op === "removeCode").map((call) => call.deviceId)).toEqual(["dev-front"]);
  });

  it("gives up after five refusals and leaves nothing on the locks", async () => {
    const { fake, devices } = twoDoors();
    fake.refuseValues("dev-side", 9);
    expect(await makeSameCode(fake, { devices, name: "Cleaner 1", window: WINDOW, avoid: new Set() })).toBeUndefined();
    expect(fake.liveCodes("dev-front")).toEqual([]);
    expect(fake.liveCodes("dev-side")).toEqual([]);
  });

  it("keeps a device that didn't answer as failed, with no code id", async () => {
    const { fake, devices } = twoDoors();
    fake.breakOn("dev-side", "createCode");
    const made = await makeSameCode(fake, { devices, name: "Cleaner 1", window: WINDOW, avoid: new Set() });
    expect(made?.devices).toEqual([expect.objectContaining({ deviceId: "dev-front", status: "set" }), { deviceId: "dev-side", status: "failed" }]);
  });

  it("never makes a guessable code or one holding a code to avoid", () => {
    const avoid = new Set([["4", "8", "2", "1"].join("")]);
    for (let i = 0; i < 200; i++) {
      const code = freshCode(6, avoid);
      expect(code).toMatch(/^[1-9]\d{5}$/);
      expect(guessable(code)).toBe(false);
      expect(code.includes([...avoid][0]!)).toBe(false);
    }
    expect(guessable("111111")).toBe(true);
    expect(guessable("345678")).toBe(true);
    expect(guessable("876543")).toBe(true);
    expect(guessable(["2", "0", "2", "6"].join(""))).toBe(true);
    for (let i = 0; i < 500; i++) expect(freshCode(4, new Set())).not.toMatch(/^(19|20)\d\d$/);
  });

  it("picks a length every lock accepts", () => {
    expect(sharedLength([])).toBe(6);
    expect(sharedLength([{ codeLengths: [4, 5, 6] }, { codeLengths: [6, 8] }])).toBe(6);
    expect(sharedLength([{ codeLengths: [4, 5] }, { codeLengths: [4, 5, 8] }])).toBe(5);
    expect(sharedLength([{}, { codeLengths: [4] }])).toBe(4);
  });
});
