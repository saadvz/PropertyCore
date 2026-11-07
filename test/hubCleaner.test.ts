import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { hubFor } from "../src/hub/hub";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/** Cleaner Core reads its property and calendars from the property hub. 555 numbers and a made-up code only. */

const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const PUBLIC = "https://cleaner.example/t/tnt_abcdefghij/p/prp_abcdefghij";
const OTHER_URL = "https://calendar.example/other.ics";
const roots: string[] = [];

beforeEach(() => setCleanerAlertFetch(async () => ({ status: 200 })));
afterEach(() => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  resetLiveDesks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-cleaner-"));
  roots.push(root);
  return root;
}

function openDesk(root = folder(), extra: NodeJS.ProcessEnv = {}): { root: string; desk: LiveDesk } {
  setCleanerTwilioClient(fakeSms());
  setCleanerGroupFetch(fakeConversations().impl);
  setCleanerCalendarFetch(async (url) => ({ status: url === CALENDAR_URL ? 200 : 404, url, async text() { return url === CALENDAR_URL ? CALENDAR_ICS : ""; } }));
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_GROUP_CHAT: "0",
    CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    PUBLIC_BASE_URL: PUBLIC,
    ...extra,
  };
  return { root, desk: liveDeskFor(root, () => env, () => new Date(FROZEN)) };
}

const hubOf = (root: string) => hubFor(root, { now: () => new Date(FROZEN) });
const live = (root: string) => JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as Record<string, unknown>;

async function property(desk: LiveDesk): Promise<void> {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
}

/** Setup far enough that the engine holds the calendar's turnovers. */
async function withJobs(desk: LiveDesk): Promise<void> {
  await property(desk);
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }], done: true }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door" }, PIN_KEY));
  ok(await desk.setUpTexting());
  ok(await desk.runChecks());
}

function codeOf(result: Record<string, unknown>): string {
  const url = String(result.uploadUrl);
  return url.slice(url.lastIndexOf("/") + 1);
}

describe("Cleaner Core on the property hub", () => {
  it("save_property writes hub.json and cleaner-live.json has no address", async () => {
    const { root, desk } = openDesk();
    await property(desk);
    // Read the file itself: opening a hub here would move old fields and hide a desk that still wrote them.
    expect(live(root)).not.toHaveProperty("address");
    expect(JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).property).toEqual({ nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" });
    expect(live(root)).toMatchObject({ business: BUSINESS });
  });

  it("save_sources saves to the hub; dropJobs still guards", async () => {
    const { root, desk } = openDesk();
    await withJobs(desk);
    expect(hubOf(root).stored()).toEqual([{ name: "Airbnb", url: CALENDAR_URL }]);
    expect(live(root)).not.toHaveProperty("calendars");
    const refused = await desk.saveSources({ calendars: [{ name: "Other", url: OTHER_URL }] });
    expect(refused.ok).toBe(false);
    expect(hubOf(root).stored()).toEqual([{ name: "Airbnb", url: CALENDAR_URL }]);
    ok(await desk.saveSources({ calendars: [{ name: "Other", url: OTHER_URL }], dropJobs: true }));
    expect(hubOf(root).stored()).toEqual([{ name: "Other", url: OTHER_URL }]);
  });

  it("issues the hub's upload link", async () => {
    const { desk } = openDesk();
    await property(desk);
    const issued = ok(await desk.saveSources({ uploadLink: { name: "Airbnb" } }));
    expect(String(issued.uploadUrl).startsWith(`${PUBLIC}/calendar-link/`)).toBe(true);
    expect(await desk.uploadLinkOpen("calendar-link", codeOf(issued))).toMatchObject({ open: true, name: "Airbnb" });
  });

  it("an upload that would call off a cleaning gets 409", async () => {
    const { root, desk } = openDesk();
    await withJobs(desk);
    const issued = ok(await desk.saveSources({ uploadLink: { name: "Airbnb" } }));
    const refused = await desk.uploadCalendarLink(codeOf(issued), { url: OTHER_URL });
    expect(refused.status).toBe(409);
    expect(hubOf(root).stored()).toEqual([{ name: "Airbnb", url: CALENDAR_URL }]);
  });

  it("an upload whose link holds the door code is refused", async () => {
    const { root, desk } = openDesk();
    await withJobs(desk);
    const issued = ok(await desk.saveSources({ uploadLink: { name: "Vrbo" } }));
    const refused = await desk.uploadCalendarLink(codeOf(issued), { url: `https://calendar.example/${DOOR_CODE}.ics` });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused)).not.toContain(DOOR_CODE);
    expect(hubOf(root).stored()).toEqual([{ name: "Airbnb", url: CALENDAR_URL }]);
  });

  it("with CLEANER_CORE_ENABLED=0, wouldCancel is empty", async () => {
    const root = folder();
    const first = openDesk(root);
    await withJobs(first.desk);
    resetLiveDesks();
    const { desk } = openDesk(root, { CLEANER_CORE_ENABLED: "0" });
    const issued = ok(await desk.saveSources({ uploadLink: { name: "Airbnb" } }));
    expect((await desk.uploadCalendarLink(codeOf(issued), { url: OTHER_URL })).status).toBe(200);
  });

  it("get_state carries the set-aside line, and a save clears it", async () => {
    const root = folder();
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: {}, calendars: [{ name: "Airbnb", url: CALENDAR_URL }], calendarsSetAside: [{ name: "Vrbo", url: OTHER_URL }] }));
    const { desk } = openDesk(root);
    await property(desk);
    const state = ok(await desk.getState());
    const line = "Supply Core had its own calendars (Vrbo) that aren't in this property's list. Ask the host whether to add them.";
    expect(state.setAside).toBe(line);
    expect(JSON.stringify(state)).not.toContain(OTHER_URL);
    ok(await desk.saveSources({ done: true }));
    expect(ok(await desk.getState()).setAside).toBeUndefined();
  });

  it("a desk opened after the move never writes calendars back", async () => {
    const root = folder();
    writeFileSync(join(root, "cleaner-live.json"), JSON.stringify({ choice: "cleaners", business: BUSINESS, address: ADDRESS, timeZone: ZONE, calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    const { desk } = openDesk(root);
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
    expect(existsSync(join(root, "hub.json"))).toBe(true);
    expect(live(root)).not.toHaveProperty("calendars");
    expect(live(root)).not.toHaveProperty("address");
    expect(live(root)).toMatchObject({ host: HOST });
  });

  it("reset clears the hub's property and calendars", async () => {
    const { root, desk } = openDesk();
    await property(desk);
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    const preview = ok(await desk.resetProperty({}, () => undefined));
    ok(await desk.resetProperty({ confirmation: String((preview.confirmation as { code?: string })?.code ?? preview.confirmation) }, () => undefined));
    expect(hubOf(root).property()).toEqual({});
    expect(hubOf(root).calendars()).toEqual([]);
    expect(existsSync(join(root, "hub.json"))).toBe(false);
  });

  it("reset keeps the hub when Supply Core has a record, and says so", async () => {
    const { root, desk } = openDesk();
    await property(desk);
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    writeFileSync(join(root, "supply.json"), JSON.stringify({ settings: {}, setup: {}, items: [], draft: [], orders: [], carts: [], lowReports: [] }));
    const preview = ok(await desk.resetProperty({}, () => undefined));
    expect(String(preview.next)).toContain("The property's address and booking calendars stay, because Supply Core uses them.");
    ok(await desk.resetProperty({ confirmation: String((preview.confirmation as { code?: string })?.code ?? preview.confirmation) }, () => undefined));
    expect(hubOf(root).property().address).toBe(ADDRESS);
    expect(hubOf(root).stored()).toEqual([{ name: "Airbnb", url: CALENDAR_URL }]);
  });
});
