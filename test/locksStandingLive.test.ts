import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrantNote } from "../src/hub/doorAccess";
import { hubFor, resetHubs } from "../src/hub/hub";
import { LockDesk, STANDING_PAGE_PREFIX, type LockDeskDeps, type LockReply } from "../src/locks/desk";
import { FakeLockAdapter } from "../src/locks/fake";
import { GUEST_TOOLS } from "../src/locks/guestTools";
import { setLockAdapter } from "../src/locks/registry";
import { SeamLockAdapter } from "../src/locks/seam";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { handleLockTool, LOCK_TOOLS } from "../src/locks/tools";
import { deskFeatures } from "./featureEnv";

/**
 * Standing codes as Saad's live run on 22 Nov found them (#180): the host's own code on their number
 * on file, an invite that's marked sent only once it went and goes on its own once it can, no tool
 * that widens who may be texted, a code a door refused that the host hears about and the clock tries
 * again, and a page that never uses its link up before the code is on the lock. Fake lock adapter,
 * 555 numbers, no code in any text or tool result.
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

function world(options: { textsAllowed?: boolean; hostPhone?: string | null; sendWorks?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lock-live-"));
  roots.push(root);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  fake.addDevice("acct", { id: "dev-front", name: "Front door" });
  const hub = hubFor(root, { now: () => clock });
  hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const sent: { to: string; body: string }[] = [];
  const told: GrantNote[] = [];
  const state = { textsAllowed: options.textsAllowed ?? true, sendWorks: options.sendWorks ?? true };
  const deps: LockDeskDeps = {
    now: () => clock,
    env: () => env,
    customerKey: "acct",
    otherDevices: () => [],
    alertsWorking: async () => true,
    textsAllowed: async () => state.textsAllowed,
    stopped: () => false,
    send: async (to, body) => {
      if (!state.sendWorks) return false;
      sent.push({ to, body });
      return true;
    },
    publicBase: () => BASE,
    cleaningOn: () => true,
    hostPhone: async () => (options.hostPhone === null ? undefined : (options.hostPhone ?? HOST)),
    tell: async (notes) => void told.push(...notes),
  };
  const desk = new LockDesk(root, deps);
  const door = hub.doorAccess(() => env);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct", devices: [storedDevice({ id: "dev-front", accountId: "acct-acct", name: "Front door", kind: "lock", online: true })], doors: ["dev-front"], activeAt: NOW.toISOString() });
  return { root, desk, door, fake, sent, told, state, at: (ms: number) => (clock = new Date(ms)) };
}

async function approved(call: (confirmation?: string) => Promise<LockReply>): Promise<LockReply> {
  const first = await call();
  const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
  return code ? call(code) : first;
}

const tokenOf = (body: string) => body.slice(body.indexOf(STANDING_PAGE_PREFIX) + STANDING_PAGE_PREFIX.length);
const standing = (w: ReturnType<typeof world>) => (w.desk.status().structured?.standing as { id: string; status: string; lock?: string }[]) ?? [];

describe("the host's own standing code (E)", () => {
  it("uses the host's confirmed number on file, named by its last four, so they never type it", async () => {
    const w = world();
    const asked = await handleLockTool(w.desk, "add_standing_code", { name: "Saad", role: "owner" });
    expect(asked?.isError).toBe(false);
    expect(asked?.structured?.question).toBe("Give you your own standing door code at 12 Scratch Lane, on your number ending 0130? You get one text there asking you to reply YES first.");
    const done = await approved((confirmation) => w.desk.addStanding({ name: "Saad", role: "owner", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured?.invited).toBe(true);
    expect(done.text).toBe("The host got one text asking them to reply YES. Their code link goes once they do.");
    expect(w.sent).toEqual([expect.objectContaining({ to: HOST })]);
    // Nothing the agent sees says another person's name or "last four digits".
    for (const text of [asked!.text, done.text]) expect(text).not.toMatch(/Maria|last four digits/);
  });

  it("asks for the number only when no confirmed host phone is on file, and still never for a co-host's", async () => {
    const none = world({ hostPhone: null });
    const reply = await none.desk.addStanding({ name: "Saad", role: "owner" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/confirmed mobile on file/);
    const cohost = await none.desk.addStanding({ name: "Pat Lee", role: "co-host" });
    expect(cohost.text).toBe("Ask the host for Pat Lee's mobile number, with its country code.");
  });

  it("the add_standing_code tool takes no phone for the host's own code", () => {
    const tool = LOCK_TOOLS.find((item) => item.name === "add_standing_code")!;
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["name", "role"]);
    expect(String(tool.description)).toMatch(/leave phone out/);
  });
});

describe("the invite (A and B)", () => {
  it("is marked sent only once it went, says why it didn't, and goes on its own once it can, with no remove and remake", async () => {
    const w = world({ sendWorks: false });
    const done = await approved((confirmation) => w.desk.addStanding({ name: "Saad", role: "owner", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured).toMatchObject({ invited: false, waiting: "send-failed" });
    expect(done.text).toMatch(/didn't go out just now\. I'll try again on my own/);
    expect(done.text).toMatch(/No tool changes who may be texted, so never tell the host you turned texts on/);
    expect(standing(w)[0]!.status).toBe("invite-not-sent-yet");
    // Before this fix the record said "waiting-for-yes" for a text that never went, and nothing tried again.
    w.state.sendWorks = true;
    await w.desk.standingClock();
    expect(w.sent).toEqual([]); // waits 10 minutes between tries
    w.at(NOW.getTime() + 11 * 60_000);
    await w.desk.standingClock();
    expect(w.sent).toEqual([expect.objectContaining({ to: HOST, body: expect.stringContaining("Reply YES") })]);
    expect(standing(w)[0]!.status).toBe("waiting-for-yes");
    await w.desk.standingClock();
    expect(w.sent).toHaveLength(1);
  });

  it("waits while the property's texts aren't on, says so plainly, and goes once they are", async () => {
    const w = world({ textsAllowed: false });
    const done = await approved((confirmation) => w.desk.addStanding({ name: "Pat Lee", phone: COHOST, role: "co-host", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured).toMatchObject({ invited: false, waiting: "texts-off" });
    expect(done.text).toMatch(/The invite goes on its own once it is/);
    expect(w.sent).toEqual([]);
    w.state.textsAllowed = true;
    await w.desk.standingClock();
    expect(w.sent).toEqual([expect.objectContaining({ to: COHOST })]);
  });

  it("tells the host once when the invite still can't go after several tries", async () => {
    const w = world({ sendWorks: false });
    await approved((confirmation) => w.desk.addStanding({ name: "Pat Lee", phone: COHOST, role: "co-host", ...(confirmation ? { confirmation } : {}) }));
    for (let minute = 11; minute < 200; minute += 11) {
      w.at(NOW.getTime() + minute * 60_000);
      await w.desk.standingClock();
    }
    expect(w.told.filter((note) => note.id.startsWith("lock:standing-invite:"))).toHaveLength(1);
  });

  it("no lock or guest tool can mark a person's YES or widen who may be texted: only their own text does", async () => {
    const w = world();
    const done = await approved((confirmation) => w.desk.addStanding({ name: "Pat Lee", phone: COHOST, role: "co-host", ...(confirmation ? { confirmation } : {}) }));
    const id = done.structured!.id as string;
    for (const tool of [...LOCK_TOOLS, ...GUEST_TOOLS]) {
      const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
      for (const field of props) expect(field).not.toMatch(/consent|opt.?in|^yes|texts?$/i);
    }
    for (const tool of LOCK_TOOLS) {
      if (tool.name === "save_locks" || tool.name === "remove_standing_code") continue;
      await approved((confirmation) => handleLockTool(w.desk, tool.name as string, { id, name: "Pat Lee", phone: COHOST, role: "co-host", ...(confirmation ? { confirmation } : {}) }).then((reply) => reply!));
    }
    const person = w.door.locks().standing!.find((item) => item.id === id)!;
    expect(person.yesAt).toBeUndefined();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(w.sent.some((text) => text.body.includes(STANDING_PAGE_PREFIX))).toBe(false);
    expect(await w.desk.standingText(COHOST, "YES")).toBe(true);
    expect(w.door.locks().standing!.find((item) => item.id === id)!.yesAt).toBeDefined();
  });
});

describe("the code on the lock (D)", () => {
  async function yes(w: ReturnType<typeof world>, phone = COHOST) {
    await approved((confirmation) => w.desk.addStanding({ name: "Pat Lee", phone, role: "co-host", ...(confirmation ? { confirmation } : {}) }));
    expect(await w.desk.standingText(phone, "YES")).toBe(true);
  }

  it("a door that refused the code is one host note, and the clock puts it on the lock later", async () => {
    const w = world();
    w.fake.breakOn("dev-front", "createCode");
    await yes(w);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(w.told).toEqual([expect.objectContaining({ id: expect.stringMatching(/^lock:issue-failed:standing:std_/), text: "I couldn't put Pat Lee's standing code on the lock yet. I'll keep trying; their private link shows the code once it's there." })]);
    expect(standing(w)[0]!.lock).toBe("failed");
    await w.desk.standingClock();
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
    expect(standing(w)[0]!.lock).toBe("set");
    for (const note of w.told) expect(note.text.includes(w.fake.liveCodes("dev-front")[0]!.code)).toBe(false);
  });

  it("the partner is asked for no backup codes on a standing (ongoing) code, only on a time-bound one", async () => {
    const bodies: Record<string, unknown>[] = [];
    const seam = new SeamLockAdapter({
      apiKey: "seam_test_scratch",
      now: () => NOW,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return { status: 200, json: async () => ({ access_code: { access_code_id: "ac_scratch", status: "setting" } }) };
      },
    });
    await seam.createCode({ deviceId: "dev", code: "482913", name: "Standing abcdefgh", window: { from: NOW.toISOString(), until: "2046-12-01T12:00:00.000Z" } });
    await seam.createCode({ deviceId: "dev", code: "482913", name: "Cleaning abcdefgh", window: { from: NOW.toISOString(), until: "2026-12-02T12:00:00.000Z" } });
    expect(bodies[0]).not.toHaveProperty("use_backup_access_code_pool");
    expect(bodies[0]).not.toHaveProperty("ends_at");
    expect(bodies[1]).toMatchObject({ use_backup_access_code_pool: true, ends_at: "2026-12-02T12:00:00.000Z" });
  });
});

describe("the page's show my code (C)", () => {
  async function linked(w: ReturnType<typeof world>) {
    await approved((confirmation) => w.desk.addStanding({ name: "Pat Lee", phone: COHOST, role: "co-host", ...(confirmation ? { confirmation } : {}) }));
    await w.desk.standingText(COHOST, "YES");
    return tokenOf(w.sent.find((text) => text.body.includes(STANDING_PAGE_PREFIX))!.body);
  }

  it("while the code is still going on the lock, says so and keeps the link; then shows it once", async () => {
    const w = world();
    w.fake.programSlowly("dev-front");
    const token = await linked(w);
    expect(await w.desk.showCode(token)).toEqual({ ok: false, reason: "pending" });
    expect(w.desk.pageOpen(token)).toBeDefined();
    w.fake.settle("dev-front");
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    expect(await w.desk.showCode(token)).toEqual({ ok: true, code });
    expect(await w.desk.showCode(token)).toEqual({ ok: false, reason: "gone" });
  });

  it("with nothing on the lock yet, tries to put it there and says to wait, without using the link", async () => {
    const w = world();
    w.fake.breakOn("dev-front", "createCode");
    const token = await linked(w);
    w.fake.programSlowly("dev-front");
    expect(await w.desk.showCode(token)).toEqual({ ok: false, reason: "pending" });
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
    w.fake.settle("dev-front");
    expect((await w.desk.showCode(token)).ok).toBe(true);
  });

  it("a lock that refused the code says so, tells the host, and keeps the link", async () => {
    const w = world();
    w.fake.failCodes("dev-front");
    const token = await linked(w);
    w.told.splice(0);
    expect(await w.desk.showCode(token)).toEqual({ ok: false, reason: "failed" });
    expect(w.told.map((note) => note.id)).toEqual([expect.stringMatching(/^lock:issue-failed:standing:/)]);
    expect(w.desk.pageOpen(token)).toBeDefined();
  });
});
