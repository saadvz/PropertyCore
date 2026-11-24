import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import type { LockWebhookEvent } from "../src/locks/adapter";
import { FakeLockAdapter } from "../src/locks/fake";
import { applyLockEvent } from "../src/locks/inbound";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { deskFeatures } from "./featureEnv";

/**
 * A lock account that drops and comes back (#280 items 21 and 22): the host hears when it's back, and the
 * checkout-time code the disconnect paused comes back on. Only the fake lock adapter; codes made at runtime.
 */

const NOW = new Date("2026-12-01T12:00:00Z");
const SERVER = randomBytes(32).toString("base64");
const ON = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: SERVER };
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: { cleaners?: "ask" | "automatic" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lock-reconnect-"));
  roots.push(root);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const device = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const hub = hubFor(root, { now: () => NOW });
  const door = hub.doorAccess(() => ON);
  door.useSleep(async () => undefined);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString(), release: { cleaners: options.cleaners ?? "ask", pros: "ask" } });
  return { root, fake, door };
}

const event = (id: string, kind: LockWebhookEvent["kind"], minutes: number): LockWebhookEvent => ({ id, kind, partnerType: kind, at: new Date(NOW.getTime() + minutes * 60_000).toISOString(), accountId: "acct-acct-1", customerKey: "acct-1" });

describe("the lock account is back (#280 21)", () => {
  it("tells the host once when the account is back", async () => {
    const { door, fake } = setup();
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    const back = await applyLockEvent(door, fake, event("ev-on", "account-connected", 30), NOW);
    expect(back.notes.map((note) => note.text)).toEqual(["Your lock account is connected again, so I can make and change codes."]);
    expect((await applyLockEvent(door, fake, event("ev-on", "account-connected", 30), NOW)).notes).toEqual([]);
    expect((await applyLockEvent(door, fake, event("ev-on-2", "account-connected", 40), NOW)).notes).toEqual([]);
  });

  it("turns the checkout-time code back on if the disconnect paused it", async () => {
    const { door, fake } = setup({ cleaners: "automatic" });
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    expect(door.locks().release.cleaners).toBe("ask");
    const back = await applyLockEvent(door, fake, event("ev-on", "account-connected", 30), NOW);
    expect(back.notes.map((note) => note.text)).toEqual(["Your lock account is connected again, so I can make and change codes. The cleaner's code goes out at checkout again, like before."]);
    expect(door.locks().release.cleaners).toBe("automatic");
  });

  it("leaves ask as it was", async () => {
    const { door, fake } = setup({ cleaners: "ask" });
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    await applyLockEvent(door, fake, event("ev-on", "account-connected", 30), NOW);
    expect(door.locks().release.cleaners).toBe("ask");
  });

  it("a first connect says nothing", async () => {
    const { door, fake } = setup();
    expect((await applyLockEvent(door, fake, event("ev-first", "account-connected", 0), NOW)).notes).toEqual([]);
  });
});

// ---- Item 22: the host's tools guide a stuck reconnect and put codes back on the doors ----

import { LockDesk, type LockDeskDeps, type LockReply } from "../src/locks/desk";
import { handleLockTool, LOCK_TOOLS } from "../src/locks/tools";

function deskWorld(options: { cleaners?: "ask" | "automatic" } = {}) {
  const { root, fake, door } = setup(options);
  const hub = hubFor(root, { now: () => NOW });
  hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const sent: { to: string; body: string }[] = [];
  const told: string[] = [];
  const deps: LockDeskDeps = {
    now: () => NOW,
    env: () => ON,
    customerKey: "acct-1",
    otherDevices: () => [],
    alertsWorking: async () => true,
    textsAllowed: async () => true,
    stopped: () => false,
    send: async (to, body) => {
      sent.push({ to, body });
      return true;
    },
    publicBase: () => "https://pc.example/t/acct/p/prp_scratch",
    cleaningOn: () => true,
    tell: async (notes) => void told.push(...notes.map((note) => note.text)),
  };
  return { root, fake, door, desk: new LockDesk(root, deps), sent, told };
}

async function approved(call: (confirmation?: string) => Promise<LockReply>): Promise<LockReply> {
  const first = await call();
  const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
  return code ? call(code) : first;
}

const WINDOW = { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };

describe("a stuck reconnect (#280 22)", () => {
  it("get_locks says the account is still disconnected and how to fix it", async () => {
    const { desk, fake } = deskWorld();
    fake.disconnectAccount("acct-1");
    const listed = await desk.list();
    expect(listed.structured?.account).toBe("disconnected");
    expect(listed.text).toContain("connect_lock with fresh: true");
  });

  it("fresh: true takes the host's yes, removes only the stuck connection, and gives a new link", async () => {
    const { desk, fake } = deskWorld();
    fake.addDevice("acct-2", { id: "dev-other", name: "Someone else's door" });
    fake.disconnectAccount("acct-1");
    const asked = await desk.connectLink({ fresh: true });
    expect(asked.structured?.question).toBe("Remove the stuck connection to your lock account and start a new sign-in? Codes already made go back on your doors once they show up again.");
    expect(fake.calls.some((call) => call.op === "removeAccount")).toBe(false);
    const done = await approved((confirmation) => desk.connectLink({ fresh: true, ...(confirmation ? { confirmation } : {}) }));
    expect(String(done.structured?.url)).toMatch(/^https:\/\/connect\.example\.com\/locks\//);
    expect(await fake.accounts({ customerKey: "acct-1" })).toEqual([]);
    expect((await fake.devices({ customerKey: "acct-2" })).length).toBe(1);
  });

  it("fresh: true is refused while the account is connected", async () => {
    const { desk } = deskWorld();
    const reply = await desk.connectLink({ fresh: true });
    expect(reply.isError).toBe(true);
  });

  it("connect_lock lists fresh and confirmation", () => {
    const props = (LOCK_TOOLS.find((tool) => tool.name === "connect_lock")!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["confirmation", "fresh", "kind"]);
  });

  it("get_locks puts everyone's codes back once the doors show up, and tells the host once", async () => {
    const { desk, fake, door, told } = deskWorld();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    const before = fake.liveCodes("dev-front").map((code) => code.code);
    fake.replaceDevice("dev-front", "dev-9");
    await desk.list();
    await desk.list();
    expect(fake.liveCodes("dev-9").map((code) => code.code)).toEqual(before);
    expect(told).toEqual(["Your locks came back after the reconnect. Everyone's codes were put back on the Front door, so nobody needs a new one."]);
  });

  it("picking the new doors puts everyone's codes back on them", async () => {
    const { desk, fake, door } = deskWorld();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    const before = fake.liveCodes("dev-front").map((code) => code.code);
    fake.replaceDevice("dev-front", "dev-8");
    fake.addDevice("acct-1", { id: "dev-9", name: "Front door" });
    const listed = await desk.list();
    expect(door.connected()).toBe(false);
    expect(listed.text).toContain("save_locks");
    const saved = await approved((confirmation) => desk.saveLocks({ doors: ["dev-9"], ...(confirmation ? { confirmation } : {}) }));
    expect(saved.structured?.connected).toBe(true);
    expect(fake.liveCodes("dev-9").map((code) => code.code)).toEqual(before);
    expect(door.locks().rehomeNeeded).toBeUndefined();
  });

  it("picking the new doors pairs each old door with the new one of the same name, whatever order they're picked in", async () => {
    const { desk, fake, door } = deskWorld();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    const front = fake.liveCodes("dev-front").map((code) => code.code);
    const back = fake.addDevice("acct-1", { id: "dev-back", name: "Back door" });
    door.saveLocks({ ...door.locks(), devices: [...door.locks().devices, storedDevice(back)], doors: ["dev-front", "dev-back"] });
    fake.replaceDevice("dev-front", "dev-8");
    fake.replaceDevice("dev-back", "dev-7");
    await approved((confirmation) => desk.saveLocks({ doors: ["dev-7", "dev-8"], ...(confirmation ? { confirmation } : {}) }));
    expect(fake.liveCodes("dev-8").map((code) => code.code)).toEqual(front);
    expect(fake.liveCodes("dev-7")).toEqual([]);
  });

  it("picking a different number of doors takes the old codes off, for their flows to make again", async () => {
    const { desk, fake, door } = deskWorld();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    fake.replaceDevice("dev-front", "dev-8");
    fake.addDevice("acct-1", { id: "dev-9", name: "Front door" });
    await approved((confirmation) => desk.saveLocks({ doors: ["dev-8", "dev-9"], ...(confirmation ? { confirmation } : {}) }));
    expect(door.grants().live("cleaning", "job-1")).toBeUndefined();
  });

  it("the lock clock re-homes once the doors show up", async () => {
    const { desk, fake, door } = deskWorld();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    const before = fake.liveCodes("dev-front").map((code) => code.code);
    fake.replaceDevice("dev-front", "dev-9");
    await desk.reconnectClock();
    expect(fake.liveCodes("dev-9").map((code) => code.code)).toEqual(before);
  });

  it("the tool refuses fields it doesn't list", async () => {
    const { desk } = deskWorld();
    expect((await handleLockTool(desk, "connect_lock", { fresh: true, bogus: 1 }))?.isError).toBe(true);
  });
});

describe("a fresh sign-in after a stuck reconnect (final review)", () => {
  it("the lock clock tells the host the account is back and turns the checkout-time code back on, once the doors sync", async () => {
    const { desk, fake, door, told } = deskWorld({ cleaners: "automatic" });
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    const before = fake.liveCodes("dev-front").map((code) => code.code);
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    await fake.removeAccount({ customerKey: "acct-1", accountId: "acct-acct-1" });
    // The new connection shows up before its devices do.
    fake.addAccount("acct-1");
    await desk.reconnectClock();
    expect(told).toEqual([]);
    expect(door.locks().rehomeNeeded).toBeUndefined();
    fake.addDevice("acct-1", { id: "dev-9", name: "Front door", accountId: "acct-new" });
    await desk.reconnectClock();
    expect(told).toContain("Your lock account is connected again, so I can make and change codes. The cleaner's code goes out at checkout again, like before.");
    expect(told.some((text) => text.startsWith("Your locks came back after the reconnect."))).toBe(true);
    expect(door.locks().release.cleaners).toBe("automatic");
    expect(door.locks().disconnectedAt).toBeUndefined();
    expect(fake.liveCodes("dev-9").map((code) => code.code)).toEqual(before);
    // Nothing more on later ticks.
    told.splice(0);
    await desk.reconnectClock();
    expect(told).toEqual([]);
  });

  it("an empty or half-synced device list raises no urgent note and keeps waiting", async () => {
    const { desk, fake, door, told } = deskWorld();
    const back = fake.addDevice("acct-1", { id: "dev-back", name: "Back door" });
    door.saveLocks({ ...door.locks(), devices: [...door.locks().devices, storedDevice(back)], doors: [...door.locks().doors, back.id] });
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    await fake.removeAccount({ customerKey: "acct-1", accountId: "acct-acct-1" });
    fake.addAccount("acct-1");
    await desk.list();
    expect(told.filter((text) => text.includes("can't tell which lock"))).toEqual([]);
    fake.addDevice("acct-1", { id: "dev-9", name: "Front door" });
    await desk.reconnectClock();
    expect(told.filter((text) => text.includes("can't tell which lock"))).toEqual([]);
    expect(door.locks().disconnectedAt).toBeDefined();
    fake.addDevice("acct-1", { id: "dev-10", name: "Back door" });
    await desk.reconnectClock();
    expect(door.locks().doors.sort()).toEqual(["dev-10", "dev-9"]);
    expect(told.filter((text) => text.includes("can't tell which lock"))).toEqual([]);
    expect(door.locks().disconnectedAt).toBeUndefined();
  });

  it("a door that never comes back is still told, once the account lists as many locks as the property's doors", async () => {
    const { desk, fake, door, told } = deskWorld();
    await applyLockEvent(door, fake, event("ev-off", "account-disconnected", 0), NOW);
    await fake.removeAccount({ customerKey: "acct-1", accountId: "acct-acct-1" });
    fake.addDevice("acct-1", { id: "dev-9", name: "Garage keypad" });
    await desk.reconnectClock();
    expect(told.filter((text) => text.includes("can't tell which lock"))).toHaveLength(1);
    expect(door.locks().rehomeNeeded).toEqual(["dev-front"]);
  });
});

describe("a lock account that vanished (live test, Nov 24)", () => {
  it("get_locks flags a saved lock whose account no longer shows up, and gives the host a sign-in link", async () => {
    const { desk, fake, door } = deskWorld();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    await fake.removeAccount({ customerKey: "acct-1", accountId: "acct-acct-1" });
    const listed = await desk.list();
    expect(listed.structured?.account).toBe("none");
    expect(listed.structured?.connected).toBe(false);
    expect(listed.structured?.problems).toContain("The host's lock account is disconnected, so codes can't be made or changed. connect_lock gives the host a sign-in link.");
    expect(String(listed.structured?.url)).toMatch(/^https:\/\/connect\.example\.com\/locks\//);
    expect(listed.text).toContain("The host's lock account is gone");
    expect(listed.text).not.toContain("The locks are connected.");
    expect(door.locks().disconnectedAt).toBe(NOW.toISOString());
  });

  it("pauses the checkout-time code once, and signing in again puts the codes back and turns it back on", async () => {
    const { desk, fake, door, told } = deskWorld({ cleaners: "automatic" });
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    const before = fake.liveCodes("dev-front").map((code) => code.code);
    await fake.removeAccount({ customerKey: "acct-1", accountId: "acct-acct-1" });
    await desk.list();
    await desk.list();
    expect(door.locks().release.cleaners).toBe("ask");
    expect(told).toEqual(["While your lock account is disconnected, the cleaner's code won't go out at checkout. Tell me when the guests have left, like before."]);
    told.splice(0);
    fake.addDevice("acct-1", { id: "dev-9", name: "Front door", accountId: "acct-new" });
    const back = await desk.list();
    expect(back.text).not.toContain("is gone");
    expect(back.structured?.connected).toBe(true);
    expect(fake.liveCodes("dev-9").map((code) => code.code)).toEqual(before);
    expect(door.locks().release.cleaners).toBe("automatic");
    expect(told).toContain("Your lock account is connected again, so I can make and change codes. The cleaner's code goes out at checkout again, like before.");
  });

  it("a property that never had connected locks still gets the first-setup step", async () => {
    const { desk, door, fake } = deskWorld();
    await fake.removeAccount({ customerKey: "acct-1", accountId: "acct-acct-1" });
    door.saveLocks({ ...emptyLocks(), customerKey: "acct-1" });
    const listed = await desk.list();
    expect(listed.text).toContain("No lock account is connected here yet.");
    expect(door.locks().disconnectedAt).toBeUndefined();
  });
});
