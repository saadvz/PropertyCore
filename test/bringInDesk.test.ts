import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { CODE_WAITING, packageDeskFor, resetPackageDesks } from "../src/package-arrivals/desk";
import { visitLogFor } from "../src/visits/store";
import { cleanupFolders, order, propertyFolder, PROPERTY_ID, writeOrders } from "./packageFixture";

/**
 * #241: the bring-in person's own code on connected locks. The fake lock adapter, 555 numbers, made-up orders
 * and codes made at runtime only; texts go to an in-memory list, never a phone.
 */

afterEach(() => {
  resetPackageDesks();
  resetPeople();
  resetHubs();
  setLockAdapter(undefined);
  cleanupFolders();
});

const HOST = "+15555550100";
const ANA = "+15555550111";
const RAY = "+15555550122";
const SAVED = ["4", "8", "2", "1"].join("");
const at = (local: string, day = "17") => new Date(`2026-11-${day}T${local}:00.000-05:00`);
const iso = (local: string, day = "17") => at(local, day).toISOString();
const s = (reply: { structured?: Record<string, unknown> }) => reply.structured as Record<string, any>;

function setup(opts: { connected?: boolean; packages?: "ask" | "automatic"; textsAllowed?: boolean; send?: (to: string, body: string) => Promise<boolean>; stays?: { checkIn: string; checkout: string }[] } = {}) {
  const { root, accountRoot } = propertyFolder();
  if (opts.stays) {
    const hub = JSON.parse(readFileSync(join(root, "hub.json"), "utf8"));
    writeFileSync(join(root, "hub.json"), JSON.stringify({ ...hub, stays: opts.stays.map((stay) => ({ ...stay, kind: "stay" })) }));
  }
  writeOrders(root, [order("ord_a", { expectedBy: "2026-11-17" })]);
  let clock = at("10:00");
  const now = () => clock;
  const people = peopleFor(accountRoot, { now });
  people.savePropertyPeople(PROPERTY_ID, HOST, [
    { phone: ANA, role: "cleaner", name: "Ana" },
    { phone: RAY, role: "co-host", name: "Ray" },
  ]);
  for (const phone of [ANA, RAY]) people.optIn(phone, PROPERTY_ID);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const env = { SMART_LOCKS: opts.connected === false ? "0" : "1", CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
  const door = hubFor(root, { now }).doorAccess(() => env);
  door.useSleep(async () => undefined);
  door.save(SAVED, "back door", undefined);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: clock.toISOString(), release: { cleaners: "ask", pros: "ask", ...(opts.packages ? { packages: opts.packages } : {}) } });
  const sent: { to: string; body: string }[] = [];
  const desk = packageDeskFor(root, {
    now,
    door: () => door,
    textsAllowed: async () => opts.textsAllowed ?? true,
    send:
      opts.send ??
      (async (to, body) => {
        sent.push({ to, body });
        return true;
      }),
  });
  desk.saveSettings({ bringInHours: 4 });
  return { root, desk, door, fake, people, sent, setNow: (next: Date) => (clock = next) };
}

const live = (fake: FakeLockAdapter) => fake.liveCodes("dev-front").filter((code) => !code.backup);

/** Every file in the property folder, but the sealed grants and the saved code, as text. */
function otherFiles(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "door-grants.json" && entry.name !== "door-access.json")
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

async function approve(desk: ReturnType<typeof setup>["desk"]) {
  const asked = s(desk.approveCode({ orderId: "ord_a" }));
  expect(asked.question).toMatch(/Ana/);
  expect(asked.question).not.toMatch(/\d{4,}/);
  return desk.approveCode({ orderId: "ord_a", confirmation: asked.confirmation });
}

describe("bring-in codes, off connected locks", () => {
  it("changes nothing: the reply says the code waits, and nothing reaches the lock or a phone", async () => {
    const { desk, fake, sent } = setup({ connected: false });
    expect(s(desk.planBringIn({ orderId: "ord_a", person: ANA }))).toMatchObject({ code: "waiting", next: CODE_WAITING });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    expect(await desk.syncCodes()).toEqual({ notes: [] });
    expect(live(fake)).toEqual([]);
    expect(sent).toEqual([]);
    expect(desk.approveCode({ orderId: "ord_a" }).isError).toBe(true);
  });
});

describe("bring-in codes on connected locks", () => {
  it("under ask (the default), puts the person's code on the lock for the window, and texts it only after the host's OK", async () => {
    const { root, desk, fake, sent } = setup();
    const planned = s(desk.planBringIn({ orderId: "ord_a", person: ANA }));
    expect(planned.code).toBe("after-drop");
    expect(planned.next).not.toBe(CODE_WAITING);
    // Nothing before the drop.
    await desk.syncCodes();
    expect(live(fake)).toEqual([]);

    expect(s(desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") })).visit.code).toBe("waiting-for-ok");
    await desk.syncCodes();
    const codes = live(fake);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.window).toEqual({ from: iso("10:00"), until: iso("13:30") });
    expect(visitLogFor(root).codeNames()[codes[0]!.name]).toEqual({ role: "package" });
    expect(sent).toEqual([]);

    const okd = await approve(desk);
    expect(okd.isError).toBe(false);
    const { notes } = await desk.syncCodes();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ANA);
    expect(sent[0]!.body).toContain(codes[0]!.code);
    expect(sent[0]!.body).toMatch(/Ana/);
    expect(notes.join(" ")).toMatch(/Ana got the bring-in code by text/);
    expect(notes.join(" ")).not.toContain(codes[0]!.code);
    expect(s(desk.check()).visits[0]).toMatchObject({ code: "texted" });

    // Once per visit, whatever happens next.
    await desk.syncCodes();
    expect(sent).toHaveLength(1);
    expect(otherFiles(root)).not.toContain(codes[0]!.code);
  });

  it("on automatic, texts the default person their code once the drop is seen", async () => {
    const { desk, fake, sent } = setup({ packages: "automatic" });
    desk.saveSettings({ person: RAY });
    expect(s(desk.markSeen({ orderId: "ord_a", how: "camera" })).visit.code).toBe("goes-by-text");
    await desk.syncCodes();
    expect(sent.map((item) => item.to)).toEqual([RAY]);
    expect(sent[0]!.body).toContain(live(fake)[0]!.code);
    expect(desk.approveCode({ orderId: "ord_a" }).isError).toBe(true);
  });

  it("takes the code off the lock once the package is inside", async () => {
    const { desk, fake, setNow } = setup({ packages: "automatic" });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    await desk.syncCodes();
    expect(live(fake)).toHaveLength(1);
    setNow(at("11:00"));
    desk.markBroughtIn({ orderId: "ord_a" });
    await desk.syncCodes();
    expect(live(fake)).toEqual([]);
  });

  it("revokes the code when the host picks someone else, and when the person says STOP", async () => {
    const { desk, fake, people, sent } = setup({ packages: "automatic" });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    await desk.syncCodes();
    const first = live(fake)[0]!.code;
    desk.planBringIn({ orderId: "ord_a", person: RAY });
    await desk.syncCodes();
    expect(live(fake).map((code) => code.code)).not.toContain(first);
    expect(live(fake)).toHaveLength(1);
    expect(sent.map((item) => item.to)).toEqual([ANA, RAY]);
    people.stop(RAY);
    await desk.syncCodes();
    expect(live(fake)).toEqual([]);
  });

  it("tells the host once when texts can't go out, and sends nothing", async () => {
    const { desk, fake, sent } = setup({ packages: "automatic", textsAllowed: false });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    const first = await desk.syncCodes();
    expect(first.notes.join(" ")).toMatch(/Texts can't go out/);
    expect(live(fake)).toHaveLength(1);
    expect((await desk.syncCodes()).notes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("never sends a second text after a send that may not have gone out", async () => {
    let calls = 0;
    const { desk } = setup({
      packages: "automatic",
      send: async () => {
        calls++;
        throw new Error("network");
      },
    });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    expect((await desk.syncCodes()).notes.join(" ")).toMatch(/may not have gone out/);
    expect((await desk.syncCodes()).notes).toEqual([]);
    expect(calls).toBe(1);
  });

  it("falls back to the host's saved code when the lock didn't take the person's, and tells the host", async () => {
    const { desk, fake, sent } = setup({ packages: "automatic" });
    fake.failCodes("dev-front");
    fake.setBackups("dev-front", 0);
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    const { notes } = await desk.syncCodes();
    expect(sent[0]!.body).toContain(SAVED);
    expect(notes.join(" ")).toMatch(/saved door code/);
  });

  it("makes no code while guests are staying, and tells the host once", async () => {
    const { desk, fake, sent } = setup({ packages: "automatic", stays: [{ checkIn: "2026-11-16", checkout: "2026-11-19" }] });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markSeen({ orderId: "ord_a", how: "host", at: iso("09:30") });
    expect((await desk.syncCodes()).notes.join(" ")).toMatch(/Guests are staying/);
    expect((await desk.syncCodes()).notes).toEqual([]);
    expect(live(fake)).toEqual([]);
    expect(sent).toEqual([]);
    expect(s(desk.check()).visits[0]).toMatchObject({ code: "none-during-stay" });
  });
});
