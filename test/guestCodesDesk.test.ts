import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedBookingEmail } from "../src/hub/airbnbEmail";
import { appendBookingEmail, type BookingEmailOutcome } from "../src/hub/bookingEmails";
import { holdsCodeToken } from "../src/hub/digits";
import { hubFor, resetHubs } from "../src/hub/hub";
import { appendGuestMessage } from "../src/guest-messages/store";
import { FakeLockAdapter } from "../src/locks/fake";
import { GUEST_PAGE_PREFIX, GuestCodeDesk, type GuestDeskDeps } from "../src/locks/guestDesk";
import { handleGuestTool, GUEST_TOOLS } from "../src/locks/guestTools";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import type { LockReply } from "../src/locks/desk";
import { deskFeatures } from "./featureEnv";

/**
 * The guest-code desk (#262) on the fake lock adapter: the host's choice, a code for each stay 7 days
 * ahead, the host's single-use page, moves, cancellations and leases. 555 numbers, made-up
 * confirmation codes; no code in any note, tool result, text or file but the sealed grants.
 */

const NOW = new Date("2026-12-10T12:00:00.000Z");
const HOST_BASE = "https://pc.example/t/acct/p/prp_scratch";
const TENANT = "+15555550155";
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let sentAt = 0;
function email(root: string, parsed: ParsedBookingEmail, outcome: BookingEmailOutcome = "applied"): void {
  sentAt += 1;
  const at = new Date(Date.parse("2026-12-01T00:00:00Z") + sentAt * 60_000).toISOString();
  appendBookingEmail(root, { at, receivedAt: at, from: "automated@airbnb.com", subject: "Reservation", parsed, outcome });
}

const booked = (code: string, checkIn: string, checkout: string, out?: string): ParsedBookingEmail => ({
  kind: "confirmed",
  confirmationCode: code,
  checkIn: { date: checkIn, time: "15:00" },
  checkout: { date: checkout, ...(out ? { time: out } : { time: "11:00" }) },
});

function world(options: { env?: NodeJS.ProcessEnv; connected?: boolean; textsAllowed?: boolean; programming?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "guest-desk-"));
  roots.push(root);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = options.env ?? { ...deskFeatures("guest-codes"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const front = fake.addDevice("acct", { id: "dev-front", name: "Front door" });
  if (options.programming) fake.programSlowly("dev-front");
  const hub = hubFor(root, { now: () => clock });
  hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const door = hub.doorAccess(() => env);
  door.useSleep(async () => undefined);
  if (options.connected !== false) door.saveLocks({ ...emptyLocks(), customerKey: "acct", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString() });
  const sent: { to: string; body: string }[] = [];
  const stops = new Set<string>();
  const deps: GuestDeskDeps = {
    now: () => clock,
    env: () => env,
    textsAllowed: async () => options.textsAllowed ?? true,
    stopped: (phone) => stops.has(phone),
    send: async (to, body) => {
      sent.push({ to, body });
      return true;
    },
    publicBase: () => HOST_BASE,
  };
  const desk = new GuestCodeDesk(root, deps);
  const codes = () => fake.liveCodes("dev-front").filter((item) => item.status !== "removed");
  return { root, desk, door, fake, sent, stops, codes, at: (iso: string) => (clock = new Date(iso)) };
}

async function approved(call: (confirmation?: string) => Promise<LockReply>): Promise<LockReply> {
  const first = await call();
  const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
  return code ? call(code) : first;
}

const tokenIn = (text: string) => text.slice(text.indexOf(GUEST_PAGE_PREFIX) + GUEST_PAGE_PREFIX.length).split(/\s/)[0]!;

function files(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("off means unchanged", () => {
  it("does nothing without the flag, without connected locks, or before the host chooses", async () => {
    for (const options of [{ env: deskFeatures("locks") }, { connected: false }, {}]) {
      const { root, desk, fake } = world(options);
      email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
      expect(await desk.sync()).toEqual([]);
      expect(fake.calls.filter((call) => call.op === "createCode")).toEqual([]);
      resetHubs();
    }
  });

  it("without a connected lock, says no code can be made and points to the lock step", async () => {
    const { desk } = world({ connected: false });
    const status = desk.status();
    expect(status.isError).toBe(false);
    expect(status.structured).toMatchObject({ connected: false });
    expect(status.text).toMatch(/connect_lock/);
    expect((await desk.setMode({ mode: "automatic" })).isError).toBe(true);
  });
});

describe("the host's choice", () => {
  it("needs the host's yes, and automatic makes a code 7 days ahead with a single-use link in the note", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    email(root, booked("HMSCRATCHBB", "2026-12-24", "2026-12-26"));
    const asked = await desk.setMode({ mode: "automatic" });
    expect(asked.structured?.question).toMatch(/door code for each booking/);
    expect(codes()).toHaveLength(0);
    expect((await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    const notes = await desk.sync();
    expect(codes()).toHaveLength(1);
    const ready = notes.find((note) => note.id.startsWith("guest:ready:"))!;
    expect(ready.text).toContain("the guest on 12–15 Dec");
    expect(ready.text).toContain(`${HOST_BASE}${GUEST_PAGE_PREFIX}`);
    expect(ready.text).not.toContain(codes()[0]!.code);
    // The next pass tells nothing twice.
    expect(await desk.sync()).toEqual([]);
  });

  it("under ask, asks once per booking and makes the code only after the host's yes for it", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "ask", ...(confirmation ? { confirmation } : {}) }));
    const first = await desk.sync();
    expect(first.map((note) => note.id)).toEqual(["guest:ask:HMSCRATCHAA"]);
    expect(first[0]!.text).not.toMatch(/make_guest_code/);
    expect(await desk.sync()).toEqual([]);
    expect(codes()).toHaveLength(0);
    expect((await approved((confirmation) => desk.makeCode({ stay: "HMSCRATCHAA", ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    const after = await desk.sync();
    expect(codes()).toHaveLength(1);
    expect(after.map((note) => note.id)).toEqual(["guest:ready:HMSCRATCHAA"]);
  });

  it("under ask, takes another platform's booking by its prefixed key, in any case, after the host's yes (#263)", async () => {
    const { root, desk, codes } = world();
    sentAt += 1;
    const at = new Date(Date.parse("2026-12-01T00:00:00Z") + sentAt * 60_000).toISOString();
    appendBookingEmail(root, { at, receivedAt: at, from: "sender@messages.homeaway.com", subject: "Reservation", parsed: { ...booked("HA-1A2B3C", "2026-12-12", "2026-12-15"), platform: "vrbo" }, outcome: "applied", hostConfirmed: true });
    await approved((confirmation) => desk.setMode({ mode: "ask", ...(confirmation ? { confirmation } : {}) }));
    const first = await desk.sync();
    expect(first.map((note) => note.id)).toEqual(["guest:ask:vrbo:HA-1A2B3C"]);
    expect(first[0]!.text).not.toContain("vrbo:HA-1A2B3C");
    expect(desk.status().structured?.stays).toEqual([expect.objectContaining({ stay: "vrbo:HA-1A2B3C", status: "waiting-for-host" })]);
    expect((await approved((confirmation) => desk.makeCode({ stay: "VRBO:ha-1a2b3c", ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    await desk.sync();
    expect(codes()).toHaveLength(1);
  });

  it("automatic to ask keeps the codes already made", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    await desk.sync();
    const code = codes()[0]!.code;
    await approved((confirmation) => desk.setMode({ mode: "ask", ...(confirmation ? { confirmation } : {}) }));
    const notes = await desk.sync();
    expect(codes().map((item) => item.code)).toEqual([code]);
    expect(notes).toEqual([]);
  });

  it("off takes every stay's code off the lock and tells the host which", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    await desk.sync();
    expect(codes()).toHaveLength(1);
    await approved((confirmation) => desk.setMode({ mode: "off", ...(confirmation ? { confirmation } : {}) }));
    const notes = await desk.sync();
    expect(codes()).toHaveLength(0);
    expect(notes.map((note) => note.id)).toEqual(["guest:removed:HMSCRATCHAA"]);
  });
});

describe("a stay's code follows its booking", () => {
  it("a late checkout moves the end and keeps the same code; a cancellation removes it", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    await desk.sync();
    const code = codes()[0]!.code;
    appendGuestMessage(root, { id: "lc_scratch", at: NOW.toISOString(), event: "late-checkout", lateCheckout: { checkout: "2026-12-15", time: "13:00" } });
    const moved = await desk.sync();
    expect(moved.map((note) => note.id)).toEqual(["guest:moved:HMSCRATCHAA:2026-12-15T18:00:00.000Z"]);
    expect(moved[0]!.text).toMatch(/The door code stays the same/);
    expect(codes()[0]!.code).toBe(code);
    expect(codes()[0]!.window.until).toBe("2026-12-15T18:00:00.000Z");
    email(root, { kind: "cancelled", confirmationCode: "HMSCRATCHAA", checkIn: { date: "2026-12-12" }, checkout: { date: "2026-12-15" } }, "applied");
    const removed = await desk.sync();
    expect(codes()).toHaveLength(0);
    expect(removed.map((note) => note.id)).toEqual(["guest:removed:HMSCRATCHAA"]);
  });

  it("tells the host once, urgently, when a stay checks in within a day and its code isn't on the lock", async () => {
    const { root, desk, at } = world({ programming: true });
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    expect(await desk.sync()).toEqual([]);
    at("2026-12-11T21:00:00.000Z");
    const notes = await desk.sync();
    expect(notes).toEqual([expect.objectContaining({ id: "guest:not-set:HMSCRATCHAA", urgent: true })]);
    expect(await desk.sync()).toEqual([]);
  });
});

describe("the host's page", () => {
  it("shows the code once, then the link has ended; a new link takes the host's yes", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    const ready = (await desk.sync()).find((note) => note.id.startsWith("guest:ready:"))!;
    const token = tokenIn(ready.text);
    expect(desk.pageOpen(token)).toMatchObject({ title: expect.stringContaining("12–15 Dec") });
    expect(await desk.showCode(token)).toEqual({ ok: true, code: codes()[0]!.code });
    expect(desk.pageOpen(token)).toBeUndefined();
    expect(await desk.showCode(token)).toEqual({ ok: false, reason: "gone" });
    const link = await approved((confirmation) => desk.newLink({ stay: "HMSCRATCHAA", ...(confirmation ? { confirmation } : {}) }));
    expect(link.isError).toBe(false);
    const fresh = tokenIn(link.text);
    expect(await desk.showCode(fresh)).toEqual({ ok: true, code: codes()[0]!.code });
    expect(link.text).not.toContain(codes()[0]!.code);
  });

  it("a late checkout keeps the host's link working until the new checkout", async () => {
    const { root, desk, codes, at } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    const token = tokenIn((await desk.sync()).find((note) => note.id.startsWith("guest:ready:"))!.text);
    appendGuestMessage(root, { id: "lc_scratch", at: NOW.toISOString(), event: "late-checkout", lateCheckout: { checkout: "2026-12-15", time: "13:00" } });
    await desk.sync();
    at("2026-12-15T17:00:00.000Z");
    expect(await desk.showCode(token)).toEqual({ ok: true, code: codes()[0]!.code });
  });

  it("a cancelled stay's link shows nothing", async () => {
    const { root, desk } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    const token = tokenIn((await desk.sync()).find((note) => note.id.startsWith("guest:ready:"))!.text);
    email(root, { kind: "cancelled", confirmationCode: "HMSCRATCHAA", checkIn: { date: "2026-12-12" }, checkout: { date: "2026-12-15" } }, "applied");
    await desk.sync();
    expect(desk.pageOpen(token)).toBeUndefined();
    expect(await desk.showCode(token)).toEqual({ ok: false, reason: "gone" });
  });
});

describe("leases", () => {
  it("texts the tenant once for YES, then a single-use link; no code before YES; STOP removes it", async () => {
    const { desk, sent, codes, stops } = world();
    const reply = await approved((confirmation) => desk.addLease({ name: "Sam", phone: "(555) 555-0155", start: "2026-12-01", moveOut: "2027-06-30", ...(confirmation ? { confirmation } : {}) }));
    expect(reply.isError).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(TENANT);
    expect(sent[0]!.body).toMatch(/Reply YES/);
    await desk.sync();
    expect(codes()).toHaveLength(0);
    expect(await desk.leaseText(TENANT, "Yes")).toBe(true);
    expect(codes()).toHaveLength(1);
    expect(codes()[0]!.window).toEqual({ from: "2026-12-01T05:00:00.000Z", until: "2027-07-01T03:59:00.000Z" });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toContain(GUEST_PAGE_PREFIX);
    const code = codes()[0]!.code;
    for (const item of sent) expect(item.body).not.toContain(code);
    expect(await desk.showCode(tokenIn(sent[1]!.body))).toEqual({ ok: true, code });
    stops.add(TENANT);
    expect(await desk.leaseText(TENANT, "STOP")).toBe(false);
    expect(codes()).toHaveLength(0);
  });

  it("a changed move-out moves the end, and removing the lease takes the code off", async () => {
    const { desk, codes } = world();
    const added = await approved((confirmation) => desk.addLease({ name: "Sam", phone: TENANT, start: "2026-12-01", moveOut: "2027-06-30", ...(confirmation ? { confirmation } : {}) }));
    const id = added.structured?.id as string;
    await desk.leaseText(TENANT, "YES");
    await approved((confirmation) => desk.changeLease({ id, moveOut: "2027-03-31", ...(confirmation ? { confirmation } : {}) }));
    expect(codes()[0]!.window.until).toBe("2027-04-01T03:59:00.000Z");
    await approved((confirmation) => desk.removeLease({ id, ...(confirmation ? { confirmation } : {}) }));
    expect(codes()).toHaveLength(0);
  });

  it("doesn't text the tenant before the host's phone is confirmed", async () => {
    const { desk, sent } = world({ textsAllowed: false });
    const reply = await approved((confirmation) => desk.addLease({ name: "Sam", phone: TENANT, start: "2026-12-01", moveOut: "2027-06-30", ...(confirmation ? { confirmation } : {}) }));
    expect(reply.isError).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("never seen, logged or unsealed", () => {
  it("no tool result, note or file but the sealed grants holds a guest code", async () => {
    const { root, desk, codes } = world();
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15"));
    const replies: string[] = [];
    for (const name of GUEST_TOOLS.map((tool) => tool.name as string)) replies.push(JSON.stringify(await handleGuestTool(desk, name, {})));
    await approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));
    const notes = await desk.sync();
    replies.push(JSON.stringify(await handleGuestTool(desk, "get_guest_codes", {})));
    const code = codes()[0]!.code;
    expect(JSON.stringify(notes)).not.toContain(code);
    for (const reply of replies) expect(reply).not.toContain(code);
    expect(holdsCodeToken(files(root), code)).toBe(false);
    expect(JSON.stringify(replies)).not.toMatch(/HMSCRATCHAA.*guest name/);
  });
});
