import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { DRAFT_CONFIRM, DRAFT_NEXT, type SetupAsk } from "../src/cleaner-core/setupAsk";
import { PUBLIC } from "./fakeSendblue";
import { filesUnder } from "./files";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_TOKEN, DOOR_CODE, HOST, OBSERVER, startWiredApp, type WiredApp } from "./wiringProof";

/**
 * Draft-and-confirm setup (saadvz/PropertyCore#166): the agent drafts what it already knows, saves it in
 * any order, shows the host one summary with the gaps marked "needs you", and then asks only what's
 * still missing. The host always confirms the door code (through its secure upload), who gets it,
 * any spending, and anyone new who will be texted. Only 555 numbers and made-up codes.
 */

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const DOOR_PREFIX = `${PUBLIC}/door-code/`;
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const VENMO = "made-up-cleaner";

const open: WiredApp[] = [];

beforeEach(() => setCleanerAlertFetch(async () => ({ status: 200 })));

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) await open.pop()?.close();
});

async function app(): Promise<WiredApp> {
  const started = await startWiredApp();
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function state(wired: WiredApp, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (await call(wired, "get_state", args)).structured ?? {};
}

async function upload(wired: WiredApp, link: string, body: Record<string, unknown>): Promise<{ status: number; raw: string }> {
  const res = await fetch(`http://127.0.0.1:${wired.port}${new URL(link).pathname}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, raw: await res.text() };
}

interface Draft {
  fill: { fill: string; from: string; tool?: string }[];
  confirm: string[];
  needsYou: SetupAsk[];
}

const draftOf = (result: Record<string, unknown>) => result.draft as Draft | undefined;
const gaps = (result: Record<string, unknown>) => draftOf(result)?.needsYou.map((step) => step.step);
const askStep = (result: Record<string, unknown> | undefined) => (result?.ask as { step?: string } | undefined)?.step;

/** What the agent found in the listing, the booking emails, the calendars, the contacts, and past texts. */
const DRAFTED = {
  property: { business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" },
  sources: { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] },
  people: { host: HOST, hostName: "Dana", cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" },
  preferences: { checklist: ["Strip the beds", "Restock coffee"], photosRequired: true },
};

describe("draft-and-confirm setup", () => {
  it("drafts first, saves in any order, asks only the door code and payments, then reviews payments and activates", async () => {
    const wired = await app();
    const first = await state(wired, { choice: "cleaners" });
    // The draft comes before any question.
    expect(first.next).toBe(`That's Cleaner Core. It schedules cleaners between guest stays. ${DRAFT_NEXT}`);
    expect(first.ask).toBeUndefined();
    const draft = draftOf(first);
    expect(draft?.confirm).toEqual(DRAFT_CONFIRM);
    expect(draft?.fill.map((part) => part.tool).filter(Boolean)).toEqual(["save_property", "save_sources", "save_people", "save_schedule", "save_preferences"]);
    expect(JSON.stringify(draft?.fill)).toMatch(/listing and the booking confirmation emails/);
    expect(JSON.stringify(draft?.fill)).toMatch(/past supply orders/);
    expect(JSON.stringify(draft?.fill)).toMatch(/pros the host has used/);
    expect(gaps(first)).toEqual(["property", "sources", "people", "schedule", "door-code", "preferences", "payments"]);

    // The agent saves what it drafted, out of the old order: preferences and people before the property.
    for (const [tool, args] of [
      ["save_preferences", DRAFTED.preferences],
      ["save_people", DRAFTED.people],
      ["save_schedule", {}],
      ["save_property", DRAFTED.property],
      ["save_sources", DRAFTED.sources],
    ] as const) {
      const saved = await call(wired, tool, args);
      expect(saved.isError, `${tool}: ${saved.text}`).toBe(false);
    }
    // The door code is never drafted, and payments are spending: both still need the host. The summary
    // also asks whether bookings come from anywhere besides the drafted calendar.
    const summary = await state(wired);
    expect(summary.next).toBe(DRAFT_NEXT);
    expect(gaps(summary)).toEqual(["sources", "door-code", "payments"]);
    // Only what's still missing is drafted, so nothing already saved is saved over.
    expect(draftOf(summary)?.fill.map((part) => part.tool).filter(Boolean)).toEqual(["save_sources"]);
    expect(summary.done).toEqual(expect.arrayContaining(["Property saved.", "Cleaner saved.", "Schedule saved.", "Calendar link saved.", "Preferences saved."]));

    // The host saw the summary and corrected it in one reply: that's all the calendars. Host decision 1.
    expect((await call(wired, "save_sources", { done: true })).isError).toBe(false);
    const asked: string[] = [];
    const afterDraft = await state(wired, { drafted: true });
    expect(afterDraft.draft).toBeUndefined();
    asked.push(String(askStep(afterDraft)));
    expect(askStep(afterDraft)).toBe("door-code");

    // The door code, through its secure upload.
    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(issued.isError, issued.text).toBe(false);
    const link = String(issued.structured?.uploadUrl);
    expect(link.startsWith(DOOR_PREFIX), link).toBe(true);
    expect((await upload(wired, link, { code: DOOR_CODE })).status).toBe(200);

    // Spending takes its own yes, bound to the username and the amount. Host decision 2.
    const atPayments = await state(wired);
    asked.push(String(askStep(atPayments)));
    expect(askStep(atPayments)).toBe("payments");
    const preview = await call(wired, "save_payments", { on: true, rate: 85, venmo: `@${VENMO}` });
    expect(preview.isError, preview.text).toBe(false);
    const confirmation = preview.structured?.confirmation as { code?: string } | string;
    const code = typeof confirmation === "string" ? confirmation : String(confirmation.code);
    const paid = await call(wired, "save_payments", { on: true, rate: 85, venmo: VENMO, confirmation: code });
    expect(paid.isError, paid.text).toBe(false);

    // Nothing else is asked: the routines are the agent's own work.
    const routines = await state(wired);
    expect(askStep(routines)).toBeUndefined();
    expect(String(routines.next)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    expect((await call(wired, "save_alert_routine", ROUTINE)).isError).toBe(false);

    // The review includes payments. Host decision 3 is Activate.
    const review = await state(wired);
    expect(review.next).toBe("Summarize this setup for the host in your own words, then ask them to reply Activate.");
    const setup = review.setup as Record<string, unknown>;
    expect(setup.payments).toEqual({ on: true, perCleaning: "$85.00", venmo: `@${VENMO}` });
    expect(setup.preferences).toEqual({ checklist: DRAFTED.preferences.checklist, photosRequired: true, supplyNotes: false });
    expect(setup.access).toEqual({ lockLocation: "front door keypad" });
    expect(JSON.stringify(review).includes(DOOR_CODE)).toBe(false);

    const activated = await call(wired, "activate");
    expect(activated.isError, activated.text).toBe(false);
    expect((await state(wired)).done).toContain("Checks finished.");
    // About three host decisions plus the door code: the summary, payments, and Activate.
    expect(asked).toEqual(["door-code", "payments"]);
    expect(wired.cleanerSent).toEqual([]);
    for (const path of filesUnder(wired.root)) expect(new RegExp(`(^|\\D)${DOOR_CODE}(\\D|$)`).test(readFileSync(path, "utf8")), path).toBe(false);
  });

  it("refuses Activate until every step it needs is saved, and names what's missing", async () => {
    const wired = await app();
    await state(wired, { choice: "cleaners" });
    expect((await call(wired, "save_people", DRAFTED.people)).isError).toBe(false);
    const early = await call(wired, "activate");
    expect(early.isError).toBe(true);
    expect(early.text).toContain("Before Activate, save the property, a booking calendar, the door code, and the cleaning preferences (empty ones if there are none).");
  });

  it("waits only for the property before the door code, and asks the drafted steps again only when they're missing", async () => {
    const wired = await app();
    await state(wired, { choice: "cleaners" });
    const before = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(before.isError).toBe(true);
    expect(before.text).toContain("Save the property first.");
    expect((await call(wired, "save_property", DRAFTED.property)).isError).toBe(false);
    // No calendar and no cleaner yet: the code's upload link opens anyway.
    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(issued.isError, issued.text).toBe(false);
    expect((await upload(wired, String(issued.structured?.uploadUrl), { code: DOOR_CODE })).status).toBe(200);
    expect(gaps(await state(wired))).toEqual(["sources", "people", "schedule", "preferences", "payments"]);
    // After the draft, the old order picks the first gap.
    expect(askStep(await state(wired, { drafted: true }))).toBe("sources");
  });

  it("refuses set_up_texting until the property, a calendar, the people, and the door code are saved", async () => {
    const wired = await app();
    await state(wired, { choice: "cleaners" });
    expect((await call(wired, "save_property", DRAFTED.property)).isError).toBe(false);
    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect((await upload(wired, String(issued.structured?.uploadUrl), { code: DOOR_CODE })).status).toBe(200);
    // A saved code no longer means the cleaner and a calendar are saved, so texting can't skip setup.
    const early = await call(wired, "set_up_texting");
    expect(early.isError).toBe(true);
    expect(early.text).toContain("Before texting, save a booking calendar and the host and the cleaner.");
    const still = await state(wired);
    expect(still.next).toBe(DRAFT_NEXT);
    expect(still.done).not.toContain("Texting saved.");
  });

  it("drafts only what a setup already under way is still missing", async () => {
    const wired = await app();
    // Saved before draft-and-confirm: no drafted mark yet.
    await state(wired, { choice: "cleaners" });
    for (const [tool, args] of [["save_property", DRAFTED.property], ["save_sources", { ...DRAFTED.sources, done: true }], ["save_people", DRAFTED.people]] as const) {
      expect((await call(wired, tool, args)).isError).toBe(false);
    }
    const draft = await state(wired);
    expect(gaps(draft)).toEqual(["schedule", "door-code", "preferences", "payments"]);
    expect(draftOf(draft)?.fill.map((part) => part.tool).filter(Boolean)).toEqual(["save_schedule", "save_preferences"]);
  });

  it("refuses a door code whose digits are already in the cleaner's notes saved earlier in the draft", async () => {
    const wired = await app();
    await state(wired, { choice: "cleaners" });
    expect((await call(wired, "save_property", DRAFTED.property)).isError).toBe(false);
    expect((await call(wired, "save_preferences", { instructions: `Gate opens with ${DOOR_CODE.split("").join(" ")}` })).isError).toBe(false);
    const refused = await call(wired, "save_door_code", { code: DOOR_CODE });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("checklist or the note for the cleaner");
    expect(refused.text.includes(DOOR_CODE)).toBe(false);
  });

  it("refuses a door code that is already a saved contact's name", async () => {
    const wired = await app();
    await state(wired, { choice: "cleaners" });
    expect((await call(wired, "save_property", DRAFTED.property)).isError).toBe(false);
    const people = { ...DRAFTED.people, groupChat: "everyone", doorCodeTo: "cleaner", contacts: [{ name: `Gate ${DOOR_CODE}`, role: "co-host", phone: OBSERVER }] };
    expect((await call(wired, "save_people", people)).isError).toBe(false);
    const refused = await call(wired, "save_door_code", { code: DOOR_CODE });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("in a name or a setting saved for this setup");
  });
});
