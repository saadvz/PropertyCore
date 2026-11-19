import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownerLockEntries, readRecords } from "../src/hours-log/sources";
import { hubFor, resetHubs } from "../src/hub/hub";
import { LockDesk, STANDING_LINK_HOURS, STANDING_PAGE_PREFIX, type LockDeskDeps, type LockReply } from "../src/locks/desk";
import { appendLockLine } from "../src/locks/eventLog";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { handleLockTool, LOCK_TOOLS } from "../src/locks/tools";
import { entryEventsFrom } from "../src/oversight/events";

/**
 * Lock setup and standing codes (#180) on the fake lock adapter: the host's yes for each change, all
 * doors or none, the alerts routine first, and a standing code that reaches its person only on a
 * single-use page after their own YES. 555 numbers; no code in any text, tool result or file.
 */

const NOW = new Date("2026-12-01T12:00:00.000Z");
const HOST = "+15555550130";
const COHOST = "+15555550144";
const BASE = "https://pc.example/t/acct/p/prp_scratch";
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(options: { alerts?: boolean; textsAllowed?: boolean; connected?: boolean; other?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lock-desk-"));
  roots.push(root);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { SMART_LOCKS: "1", CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  fake.addDevice("acct", { id: "dev-front", name: "Front door" });
  fake.addDevice("acct", { id: "dev-side", name: "Side gate" });
  fake.addDevice("acct", { id: "dev-noise", name: "Living room sensor", kind: "noise-sensor" });
  const hub = hubFor(root, { now: () => clock });
  hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const sent: { to: string; body: string }[] = [];
  const stops = new Set<string>();
  const deps: LockDeskDeps = {
    now: () => clock,
    env: () => env,
    customerKey: "acct",
    otherDevices: () => options.other ?? [],
    alertsWorking: async () => options.alerts ?? true,
    textsAllowed: async () => options.textsAllowed ?? true,
    stopped: (phone) => stops.has(phone),
    send: async (to, body) => {
      sent.push({ to, body });
      return true;
    },
    publicBase: () => BASE,
    cleaningOn: () => true,
  };
  const desk = new LockDesk(root, deps);
  const door = hub.doorAccess(() => env);
  if (options.connected !== false) door.saveLocks({ ...emptyLocks(), customerKey: "acct", devices: [storedDevice({ id: "dev-front", accountId: "acct-acct", name: "Front door", kind: "lock", online: true })], doors: ["dev-front"], activeAt: NOW.toISOString() });
  return { root, desk, door, fake, sent, stops, at: (ms: number) => (clock = new Date(ms)) };
}

/** Asks, then answers with the approval code. */
async function approved(call: (confirmation?: string) => Promise<LockReply>): Promise<LockReply> {
  const first = await call();
  const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
  return code ? call(code) : first;
}

const tokenOf = (body: string) => body.slice(body.indexOf(STANDING_PAGE_PREFIX) + STANDING_PAGE_PREFIX.length);

/** Every file under the property folder, as text. */
function files(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("setting up connected locks", () => {
  it("gives a sign-in link, never asks for a password, and names no partner", async () => {
    const { desk } = world({ connected: false });
    const reply = await desk.connectLink({});
    expect(reply.structured?.url).toMatch(/^https:\/\/connect\.example\.com\/locks\//);
    expect(reply.text).toContain("never in chat");
  });

  it("switches on only with the host's yes, every door connected, and a working alerts routine", async () => {
    const mixed = world({ connected: false });
    expect((await approved((confirmation) => mixed.desk.saveLocks({ doors: ["dev-front"], otherDoors: true, ...(confirmation ? { confirmation } : {}) }))).structured?.connected).toBe(false);
    expect(mixed.door.connected()).toBe(false);
    const quiet = world({ connected: false, alerts: false });
    expect((await approved((confirmation) => quiet.desk.saveLocks({ doors: ["dev-front"], ...(confirmation ? { confirmation } : {}) }))).structured?.connected).toBe(false);
    expect(quiet.door.connected()).toBe(false);
    const good = world({ connected: false });
    const asked = await good.desk.saveLocks({ doors: ["dev-front", "dev-side"], sensors: ["dev-noise"] });
    expect(asked.structured?.question).toBe("Use Front door, Side gate for the cleaner's and pros' codes, and keep an eye on Living room sensor?");
    expect(good.door.connected()).toBe(false);
    expect((await approved((confirmation) => good.desk.saveLocks({ doors: ["dev-front", "dev-side"], sensors: ["dev-noise"], ...(confirmation ? { confirmation } : {}) }))).structured?.connected).toBe(true);
    expect(good.door.connected()).toBe(true);
  });

  it("refuses a device that's on another property, or a sensor as a door", async () => {
    const { desk } = world({ connected: false, other: ["dev-side"] });
    expect((await desk.saveLocks({ doors: ["dev-side"] })).isError).toBe(true);
    expect((await desk.saveLocks({ doors: ["dev-noise"] })).isError).toBe(true);
  });

  it("checkout-time codes need connected locks", async () => {
    const off = world({ connected: false });
    expect((await off.desk.settings({ cleaners: "automatic" })).isError).toBe(true);
    const on = world();
    const done = await approved((confirmation) => on.desk.settings({ cleaners: "automatic", pros: "automatic", extend: "automatic", ...(confirmation ? { confirmation } : {}) }));
    expect(done.isError).toBe(false);
    expect(on.door.locks().release).toEqual({ cleaners: "automatic", pros: "automatic" });
    expect(on.door.locks().extend).toBe("automatic");
  });

  it("switching off removes every per-visit code and goes back to the saved code", async () => {
    const { desk, door, fake } = world();
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550131", window: { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" } }]);
    await approved((confirmation) => desk.saveLocks({ off: true, ...(confirmation ? { confirmation } : {}) }));
    expect(door.connected()).toBe(false);
    expect(fake.liveCodes("dev-front")).toEqual([]);
  });

  it("every lock tool's input is strict, and none takes a code", async () => {
    const { desk } = world();
    for (const tool of LOCK_TOOLS) {
      const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
      for (const field of props) expect(field).not.toMatch(/^(code|doorCode|pin)$/i);
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect((await handleLockTool(desk, tool.name as string, { surprise: 1 }))?.isError).toBe(true);
      expect(JSON.stringify(tool)).not.toMatch(/seam/i);
    }
  });
});

describe("standing codes", () => {
  async function named(w: ReturnType<typeof world>, phone = COHOST, role = "co-host") {
    const reply = await approved((confirmation) => w.desk.addStanding({ name: "Pat Lee", phone, role, ...(confirmation ? { confirmation } : {}) }));
    expect(reply.isError).toBe(false);
    return reply.structured!.id as string;
  }

  it("texts the named person once asking for YES, and puts nothing on the locks before it", async () => {
    const w = world();
    const asked = await w.desk.addStanding({ name: "Pat Lee", phone: COHOST, role: "co-host" });
    expect(asked.structured?.question).toBe("Give Pat Lee their own standing door code at 12 Scratch Lane? They get one text asking them to reply YES first.");
    expect(w.sent).toEqual([]);
    await named(w);
    expect(w.sent).toEqual([{ to: COHOST, body: "This is the text line for 12 Scratch Lane. The host wants to give you your own door code there. Reply YES to get a private link to it, or STOP to opt out." }]);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(await w.desk.standingText(COHOST, "hello")).toBe(false);
    expect(w.sent.length).toBe(1);
  });

  it("after YES, makes the code and texts a private link that holds no code", async () => {
    const w = world();
    await named(w);
    expect(await w.desk.standingText(COHOST, "YES")).toBe(true);
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    const link = w.sent[1]!;
    expect(link.to).toBe(COHOST);
    expect(link.body).toMatch(new RegExp(`^Here's your private link to your door code at 12 Scratch Lane\\. It opens once, within 24 hours: ${BASE.replace(/\//g, "\\/")}\\/locks\\/code\\/[a-z]{40}$`));
    expect(link.body.includes(code)).toBe(false);
    expect(await w.desk.standingText(COHOST, "YES")).toBe(false);
    expect(w.sent.length).toBe(2);
  });

  it("the page shows the code once, then the link has ended", async () => {
    const w = world();
    await named(w);
    await w.desk.standingText(COHOST, "YES");
    const token = tokenOf(w.sent[1]!.body);
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    expect(w.desk.pageOpen(token)).toEqual({ name: "Pat Lee", street: "12 Scratch Lane" });
    expect((await w.desk.showCode(token))?.code).toBe(code);
    expect(await w.desk.showCode(token)).toBeUndefined();
    expect(w.desk.pageOpen(token)).toBeUndefined();
  });

  it("an unused link expires, and a new one takes the host's yes and ends the old", async () => {
    const w = world();
    const id = await named(w);
    await w.desk.standingText(COHOST, "YES");
    const first = tokenOf(w.sent[1]!.body);
    w.at(NOW.getTime() + STANDING_LINK_HOURS * 3600_000);
    expect(await w.desk.showCode(first)).toBeUndefined();
    const asked = await w.desk.newLink({ id });
    expect(asked.structured?.question).toBe("Text Pat Lee a new private link to their door code?");
    await approved((confirmation) => w.desk.newLink({ id, ...(confirmation ? { confirmation } : {}) }));
    const second = tokenOf(w.sent[2]!.body);
    expect(second).not.toBe(first);
    expect(await w.desk.showCode(first)).toBeUndefined();
    expect((await w.desk.showCode(second))?.code).toBe(w.fake.liveCodes("dev-front")[0]!.code);
  });

  it("never gives a link before the person's YES", async () => {
    const w = world();
    const id = await named(w);
    expect((await w.desk.newLink({ id })).isError).toBe(true);
  });

  it("their STOP, or the host's remove, takes the code off the locks", async () => {
    const w = world();
    const id = await named(w);
    await w.desk.standingText(COHOST, "YES");
    expect(w.fake.liveCodes("dev-front").length).toBe(1);
    await w.desk.standingText(COHOST, "STOP");
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    const v = world();
    const vid = await named(v);
    await v.desk.standingText(COHOST, "YES");
    await approved((confirmation) => v.desk.removeStanding({ id: vid, ...(confirmation ? { confirmation } : {}) }));
    expect(v.fake.liveCodes("dev-front")).toEqual([]);
    void id;
  });

  it("never texts a person who opted out, or before the host's phone is confirmed", async () => {
    const w = world({ textsAllowed: false });
    await named(w);
    expect(w.sent).toEqual([]);
    const v = world();
    v.stops.add(COHOST);
    await named(v);
    expect(v.sent).toEqual([]);
  });

  it("no code in get_locks, or in any file but the sealed grants", async () => {
    const w = world();
    await named(w);
    await w.desk.standingText(COHOST, "YES");
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    expect(JSON.stringify(w.desk.status()).includes(code)).toBe(false);
    expect(files(w.root).includes(code)).toBe(false);
  });

  it("the host's own unlocks on their standing code are owner rows in the hours log", async () => {
    const w = world();
    await named(w, HOST, "owner");
    await w.desk.standingText(HOST, "YES");
    const codeId = w.fake.liveCodes("dev-front")[0]!.codeId;
    const ref = w.door.grants().grantOf(codeId)!;
    appendLockLine(w.root, { type: "lock", id: "evt-in", at: "2026-12-03T15:00:00.000Z", loggedAt: NOW.toISOString(), device: "Front door", deviceId: "dev-front", action: "unlock", side: "outside", grant: { flow: ref.flow, jobId: ref.jobId }, partnerType: "lock.unlocked" });
    appendLockLine(w.root, { type: "lock", id: "evt-out", at: "2026-12-03T17:30:00.000Z", loggedAt: NOW.toISOString(), device: "Front door", deviceId: "dev-front", action: "lock", side: "outside", partnerType: "lock.locked" });
    expect(ownerLockEntries(readRecords(w.root))).toEqual([
      { kind: "owner-on-site", actor: "host", log: "owner", participant: "", at: "2026-12-03T15:00:00.000Z", until: "2026-12-03T17:30:00.000Z", task: "On site (Front door)", reference: "Lock event evt-in", onSite: true, timing: "measured" },
    ]);
  });

  it("a co-host's unlocks are not owner rows, and #240 reads each unlock as an entry", async () => {
    const w = world();
    await named(w);
    await w.desk.standingText(COHOST, "YES");
    const ref = w.door.grants().grantOf(w.fake.liveCodes("dev-front")[0]!.codeId)!;
    const line = { type: "lock" as const, id: "evt-c", at: "2026-12-03T15:00:00.000Z", loggedAt: NOW.toISOString(), device: "Front door", deviceId: "dev-front", action: "unlock" as const, grant: { flow: ref.flow, jobId: ref.jobId }, partnerType: "lock.unlocked" };
    appendLockLine(w.root, line);
    expect(ownerLockEntries(readRecords(w.root))).toEqual([]);
    expect(entryEventsFrom([line], () => "Pat Lee")).toEqual([{ id: "evt-c", at: "2026-12-03T15:00:00.000Z", device: "Front door", person: "Pat Lee" }]);
  });
});
