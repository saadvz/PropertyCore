import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doorCodeUploadCode } from "../src/cleaner-core/http";
import { CODE_IN_DRAFT, CODE_IN_SAVED_ANSWER, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { hubFor } from "../src/hub/hub";
import { PIN_KEY as HARNESS_KEY, cleanupDesks, idOf, liveGroup, openDesk as openHarnessDesk, setUp, testClock } from "./cleanerDeskHarness";
import { DOOR_WINDOW_OVER } from "../src/cleaner-core/doorPort";
import { fakeConversations } from "./fakeConversations";
import { approvedOnDesk } from "./hostApproval";
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
  cleanupDesks();
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

  it("a desk with real cleanings and a legacy Guesty Lite link moves into hub.json and its checks call off nothing and add nothing", async () => {
    const root = folder();
    const first = openDesk(root);
    await property(first.desk);
    ok(await first.desk.saveCalendarLink({ url: CALENDAR_URL }));
    ok(await first.desk.saveSources({ done: true }));
    ok(await first.desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
    ok(await first.desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door" }, PIN_KEY));
    ok(await first.desk.setUpTexting());
    const before = ok(await first.desk.runChecks()).turns as { checkoutDate: string; status: string }[];
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((turn) => turn.status === "canceled")).toBe(false);

    // Put the folder back the way code before the hub kept it: the details and the single link in cleaner-live.json.
    const hub = JSON.parse(readFileSync(join(root, "hub.json"), "utf8")) as { property: Record<string, string>; calendars: { url: string; legacy?: true }[] };
    expect(hub.calendars).toEqual([{ name: "Guesty Lite", url: CALENDAR_URL, legacy: true }]);
    writeFileSync(join(root, "cleaner-live.json"), JSON.stringify({ ...live(root), ...hub.property, calendarLink: CALENDAR_URL, sourcesDone: true }));
    rmSync(join(root, "hub.json"));
    resetLiveDesks();

    const { desk } = openDesk(root);
    expect(hubOf(root).calendars().map((c) => c.sourceId)).toEqual(["guesty-lite"]);
    const after = ok(await desk.checkNow()).turns as { checkoutDate: string; status: string }[];
    expect(after.map((turn) => [turn.checkoutDate, turn.status])).toEqual(before.map((turn) => [turn.checkoutDate, turn.status]));
    expect(live(root)).not.toHaveProperty("calendarLink");
  });

  it("an address Supply Core changes in the hub reaches Cleaner Core's engine on its next step", async () => {
    const { root, desk } = openDesk();
    await withJobs(desk);
    const moved = "8 Scratch Court, Teaneck, NJ 07666";
    // Supply Core saves the shared property through the same hub.
    expect(hubOf(root).saveProperty({ address: moved })).toEqual({ ok: true });
    const { sent } = await desk.inbound({ id: "stop-after-move", from: CLEANER, text: "STOP" });
    const bodies = sent.map((text) => text.body).join("\n");
    expect(bodies).toContain(moved);
    expect(bodies).not.toContain(ADDRESS);
  });

  it("while calendars are set aside, a calendar list that would call off cleanings is held for the host", async () => {
    const root = folder();
    const first = openDesk(root);
    await withJobs(first.desk);
    const before = ok(await first.desk.checkNow()).turns as { checkoutDate: string; status: string }[];
    expect(before.length).toBeGreaterThan(0);
    // The state a move leaves when cleaning was off and Supply Core's list won: Cleaner Core's calendar set aside.
    const hub = JSON.parse(readFileSync(join(root, "hub.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, "hub.json"), JSON.stringify({ ...hub, calendars: [{ name: "Vrbo", url: OTHER_URL }], calendarsSetAside: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    resetLiveDesks();
    const { desk } = openDesk(root);
    // Supply Core's calendar reads cleanly and lists none of the stays Cleaner Core's cleanings came from.
    setCleanerCalendarFetch(async (url) => ({ status: 200, url, async text() { return url === CALENDAR_URL ? CALENDAR_ICS : "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));

    const checked = ok(await desk.checkNow());
    expect((checked.turns as { status: string }[]).map((turn) => turn.status)).toEqual(before.map((turn) => turn.status));
    expect(checked.calendarsHeld).toBe(
      "Calendars are set aside for this property, and its saved calendar list would call off 2 upcoming cleanings. Ask the host: to add a set-aside calendar, send its link again with save_sources uploadLink; to keep the list as it is, call save_sources with done: true and dropJobs: true.",
    );
    const refused = await desk.runChecks();
    expect(refused.ok).toBe(false);

    ok(await desk.saveSources({ done: true, dropJobs: true }));
    expect(hubOf(root).setAside()).toEqual([]);
  });
});

describe("Cleaner Core keeps the door code in the hub", () => {
  const GATE = ["4", "4", "1", "7"].join("");

  it("save_door_code seals into door-access.json, not cleaner-live.json", async () => {
    const { root, desk } = openDesk();
    await withJobs(desk);
    expect(live(root)).not.toHaveProperty("pinSeal");
    expect(live(root)).not.toHaveProperty("lockLocation");
    const door = JSON.parse(readFileSync(join(root, "door-access.json"), "utf8")) as Record<string, unknown>;
    expect(door.pinSeal).toBeTruthy();
    expect(door.lockLocation).toBe("back door");
    expect(JSON.stringify(door)).not.toContain(DOOR_CODE);
  });

  it("upload refuses digits in a waiting draft and keeps the link", async () => {
    const { desk } = await liveGroup();
    await desk.inbound({ id: "q", from: CLEANER, text: "How do I get in the side gate?", channel: "group" });
    const draftId = await idOf(desk, "How do I get in the side gate?");
    ok(await desk.saveDraft({ replyTo: draftId, text: `It opens with ${GATE}.` }, HARNESS_KEY));
    const link = codeOf(ok(await desk.saveDoorCode({}, HARNESS_KEY)));
    const refusedUpload = await desk.uploadDoorCode(link, { code: GATE });
    expect(refusedUpload).toEqual({ status: 400, body: { ok: false, error: CODE_IN_DRAFT } });
    expect(JSON.stringify(refusedUpload)).not.toContain(GATE);
    ok(await desk.saveDraft({ replyTo: draftId, drop: true }, HARNESS_KEY));
    expect((await desk.uploadDoorCode(link, { code: GATE })).status).toBe(200);
  });

  it("upload refuses digits in a saved answer", async () => {
    const { desk } = await liveGroup();
    ok(await approvedOnDesk((confirmation) => desk.saveAnswer({ topic: "Gate", answer: `The side gate opens with ${GATE}.`, ...(confirmation ? { confirmation } : {}) }, HARNESS_KEY)));
    const link = codeOf(ok(await desk.saveDoorCode({}, HARNESS_KEY)));
    expect(await desk.uploadDoorCode(link, { code: GATE })).toEqual({ status: 400, body: { ok: false, error: CODE_IN_SAVED_ANSWER("Gate") } });
  });

  it("a link from save_door_code opens at /door-code/ and the old /cleaner-core/door-code/ path", async () => {
    const { desk } = openDesk();
    await property(desk);
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }], done: true }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
    const issued = ok(await desk.saveDoorCode({}, PIN_KEY));
    const url = String(issued.uploadUrl);
    expect(url.startsWith(`${PUBLIC}/door-code/`)).toBe(true);
    const code = codeOf(issued);
    expect(doorCodeUploadCode(`/door-code/${code}`)).toBe(code);
    expect(doorCodeUploadCode(`/cleaner-core/door-code/${code}`)).toBe(code);
    expect(await desk.uploadLinkOpen("door-code", code)).toMatchObject({ open: true });
  });
});

describe("mark_guests_left asks the hub for door access", () => {
  it("mark_guests_left replies with the window line when the window is over", async () => {
    const clock = testClock();
    const { desk, sms } = openHarnessDesk([HOST, CLEANER], "0", clock.now);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-1", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-2", from: CLEANER, text: "YES" });
    // The first cleaning's checkout is Oct 18 and the next guest arrives the same day: the window ends Oct 19.
    clock.advance(Date.parse("2026-10-21T15:00:00.000Z") - clock.now().getTime());
    const late = await desk.markGuestsLeft({ confirmed: true }, HARNESS_KEY);
    expect(late).toEqual({ ok: false, error: DOOR_WINDOW_OVER });
    expect(sms.sent.some((item) => item.body.includes(DOOR_CODE))).toBe(false);
  });

  it("an on-time release still sends the code once", async () => {
    const clock = testClock();
    const { desk, sms } = openHarnessDesk([HOST, CLEANER], "0", clock.now);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-1", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-2", from: CLEANER, text: "YES" });
    clock.advance(Date.parse("2026-10-18T16:00:00.000Z") - clock.now().getTime());
    ok(await desk.markGuestsLeft({ confirmed: true }, HARNESS_KEY));
    expect(sms.sent.filter((item) => item.to === CLEANER && item.body.includes(DOOR_CODE))).toHaveLength(1);
  });
});
