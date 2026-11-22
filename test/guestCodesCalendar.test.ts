import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Guest codes for calendar stays (#280 item 19), on the guest-code desk (#262) and the fake lock adapter: the host's choice, a code for each stay 7 days
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
  const root = mkdtempSync(join(tmpdir(), "guest-calendar-"));
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

/** Puts the calendar's stays and blocks in the hub, as a clean calendar read would. */
function calendar(root: string, stays: { checkIn: string; checkout: string; kind?: "stay" | "block" }[]): void {
  const path = join(root, "hub.json");
  const hub = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...hub, stays: stays.map((stay) => ({ kind: "stay", ...stay })) }));
}

const automatic = (desk: GuestCodeDesk) => approved((confirmation) => desk.setMode({ mode: "automatic", ...(confirmation ? { confirmation } : {}) }));

describe("calendar stays get a code too (#280 19)", () => {
  it("a calendar-only stay gets a code on the property's usual times", async () => {
    const { root, desk, codes, door } = world();
    hubFor(root, { now: () => NOW }).saveProperty({ checkInTime: "15:00", checkoutTime: "10:00" });
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15" }]);
    await automatic(desk);
    const notes = await desk.sync();
    expect(codes()).toHaveLength(1);
    expect(codes()[0]!.window).toEqual({ from: "2026-12-12T20:00:00.000Z", until: "2026-12-15T15:00:00.000Z" });
    expect(notes.find((note) => note.id === "guest:ready:cal:2026-12-12:2026-12-15")?.text).toContain("the guest on 12–15 Dec");
    expect(door.grants().live("guest", "stay:cal:2026-12-12:2026-12-15")).toBeDefined();
  });

  it("blocked dates never get a code", async () => {
    const { root, desk, codes } = world();
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15", kind: "block" }]);
    await automatic(desk);
    await desk.sync();
    expect(codes()).toHaveLength(0);
    expect(desk.status().structured?.stays).toEqual([]);
  });

  it("an email booking for the same dates is one stay, with the email's times", async () => {
    const { root, desk, codes } = world();
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15" }]);
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15", "10:30"));
    await automatic(desk);
    await desk.sync();
    expect(codes()).toHaveLength(1);
    expect(codes()[0]!.window).toEqual({ from: "2026-12-12T20:00:00.000Z", until: "2026-12-15T15:30:00.000Z" });
    const stays = desk.status().structured?.stays as { stay: string; source: string }[];
    expect(stays.map((stay) => [stay.stay, stay.source])).toEqual([["HMSCRATCHAA", "email"]]);
  });

  it("an email for a calendar stay that already has a code keeps that code", async () => {
    const { root, desk, codes, door } = world();
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15" }]);
    await automatic(desk);
    const notes = await desk.sync();
    const link = notes.find((note) => note.id.startsWith("guest:ready:"))!.text;
    const before = codes().map((code) => code.code);
    email(root, booked("HMSCRATCHAA", "2026-12-12", "2026-12-15", "10:30"));
    const later = await desk.sync();
    expect(codes().map((code) => code.code)).toEqual(before);
    expect(door.grants().live("guest", "stay:cal:2026-12-12:2026-12-15")).toBeDefined();
    expect(later.some((note) => note.id.startsWith("guest:removed:") || note.id.startsWith("guest:ready:"))).toBe(false);
    // The email's later checkout moves the same code, and the host's link keeps working.
    expect(codes()[0]!.window.until).toBe("2026-12-15T15:30:00.000Z");
    expect((await desk.showCode(tokenIn(link))).ok).toBe(true);
  });

  it("says plainly which stays get a code", async () => {
    const { root, desk } = world();
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15" }, { checkIn: "2026-12-20", checkout: "2026-12-22" }]);
    email(root, booked("HMSCRATCHBB", "2026-12-24", "2026-12-26"));
    const done = await automatic(desk);
    expect(done.text).toContain("That's 3 upcoming stays.");
    const status = desk.status();
    expect(status.text).toContain("Every booking from the calendar and the booking emails gets a code. Blocked dates don't.");
    expect((status.structured?.stays as { source: string }[]).map((stay) => stay.source)).toEqual(["calendar", "calendar", "email"]);
  });

  it("under ask, make_guest_code takes the calendar key", async () => {
    const { root, desk, codes } = world();
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15" }]);
    await approved((confirmation) => desk.setMode({ mode: "ask", ...(confirmation ? { confirmation } : {}) }));
    const asked = await desk.sync();
    expect(asked.map((note) => note.id)).toContain("guest:ask:cal:2026-12-12:2026-12-15");
    await approved((confirmation) => desk.makeCode({ stay: "cal:2026-12-12:2026-12-15", ...(confirmation ? { confirmation } : {}) }));
    await desk.sync();
    expect(codes()).toHaveLength(1);
  });

  it("a calendar-only stay whose dates change keeps its code (final review)", async () => {
    const { root, desk, codes, door } = world();
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-15" }]);
    await automatic(desk);
    const notes = await desk.sync();
    const link = notes.find((note) => note.id.startsWith("guest:ready:"))!.text;
    const before = codes().map((code) => code.code);
    // The guest extends by two nights on the calendar.
    calendar(root, [{ checkIn: "2026-12-12", checkout: "2026-12-17" }]);
    const later = await desk.sync();
    expect(codes().map((code) => code.code)).toEqual(before);
    expect(door.grants().live("guest", "stay:cal:2026-12-12:2026-12-15")).toBeDefined();
    expect(later.some((note) => note.id.startsWith("guest:removed:") || note.id.startsWith("guest:ready:"))).toBe(false);
    expect(codes()[0]!.window.until).toBe("2026-12-17T16:00:00.000Z");
    expect((await desk.showCode(tokenIn(link))).ok).toBe(true);
  });
});
