import { afterEach, describe, expect, it } from "vitest";
import type { LiveDesk } from "../src/cleaner-core/liveDesk";
import { cleanupDesks, LOCK, ok, openDesk, PIN_KEY, ROUTINE, ZONE } from "./cleanerDeskHarness";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, DOOR_CODE, HOST, OBSERVER, TEST_PIN_KEY } from "./wiringProof";

// saadvz/TourCore#215 items 1 and 10: a STOP or START that comes in before the engine first opens
// is kept on disk, so a restart in between can't send the person an opt-in or add them to the group.

afterEach(cleanupDesks);

type PeopleInput = Parameters<LiveDesk["savePeople"]>[0];

/** Every setup step but Activate, so no engine is open yet. */
async function saveAllButActivate(desk: LiveDesk, people: Partial<PeopleInput>): Promise<void> {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", ...people }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
}

/** What each text and group step that reached this phone since `from` said or did, without Twilio's ids. */
function said(opened: ReturnType<typeof openDesk>, phone: string, from: { sms: number; posts: number; joins: number }): unknown[] {
  return reached(opened, phone, from).map((item) => ("body" in (item as object) ? (item as { body: string }).body : item));
}

/** Every text and group step that reached this phone since `from`. */
function reached(opened: ReturnType<typeof openDesk>, phone: string, from: { sms: number; posts: number; joins: number }): unknown[] {
  return [
    ...opened.sms.sent.slice(from.sms).filter((sent) => sent.to === phone),
    ...opened.groups.posts.slice(from.posts).filter((post) => post.to.includes(phone)),
    ...opened.groups.participantPosts.slice(from.joins).filter((join) => Object.values(join.params).includes(phone)),
  ];
}

function mark(opened: ReturnType<typeof openDesk>) {
  return { sms: opened.sms.sent.length, posts: opened.groups.posts.length, joins: opened.groups.participantPosts.length };
}

const SAM = [{ name: "Sam", role: "observer", phone: OBSERVER }];

/** A desk with every setup step saved but Activate. The server keeps the code's key, so the code opens again after a restart. */
async function beforeActivate(people: Partial<PeopleInput>) {
  const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
  opened.env.CLEANER_CORE_PIN_KEY = TEST_PIN_KEY;
  await saveAllButActivate(opened.desk, people);
  return opened;
}

/** Activate, then the cleaner's two YES texts, which start the group. */
async function activateAndSchedule(desk: LiveDesk): Promise<void> {
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
}

describe("a host's STOP or START before the engine first opens survives a restart (#215 item 1)", () => {
  // In a group the host is seated once the cleaner takes the first cleaning, so being left out shows.
  const people = { contacts: SAM, groupChat: "cleaner-and-host" } as const;

  it("without a STOP the host is seated in the group (control)", async () => {
    const opened = await beforeActivate(people);
    const desk = opened.reopen();
    const before = mark(opened);
    await activateAndSchedule(desk);
    expect(reached(opened, HOST, before).length).toBeGreaterThan(0);
  });

  it("the host's early STOP holds, so the host gets no opt-in and isn't added to the group", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "host-stop", from: HOST, text: "STOP" });
    const desk = opened.reopen();
    const before = mark(opened);
    await activateAndSchedule(desk);
    expect(reached(opened, HOST, before)).toEqual([]);
  });

  it("the host's early START after a STOP also holds, so the host is seated", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "host-stop", from: HOST, text: "STOP" });
    // A save in between writes the STOP to disk, so only the START is left to keep.
    ok(await opened.desk.savePreferences({}));
    await opened.desk.inbound({ id: "host-start", from: HOST, text: "START" });
    const desk = opened.reopen();
    const before = mark(opened);
    await activateAndSchedule(desk);
    expect(reached(opened, HOST, before).length).toBeGreaterThan(0);
  });
});

describe("a saved contact's STOP before the engine first opens is kept (#215 item 10)", () => {
  const people = { contacts: SAM, groupChat: "everyone", doorCodeTo: "cleaner" } as const;

  it("without a STOP the contact is invited to the group (control)", async () => {
    const opened = await beforeActivate(people);
    const desk = opened.reopen();
    const before = mark(opened);
    await activateAndSchedule(desk);
    expect(reached(opened, OBSERVER, before).length).toBeGreaterThan(0);
  });

  it("the contact's early STOP holds across a restart: no invite and no group text", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    const desk = opened.reopen();
    const before = mark(opened);
    await activateAndSchedule(desk);
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    expect(reached(opened, OBSERVER, before)).toEqual([]);
  });

  it("the contact's early STOP holds without a restart too", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    const before = mark(opened);
    await activateAndSchedule(opened.desk);
    expect(reached(opened, OBSERVER, before)).toEqual([]);
  });

  it("the contact's START after an early STOP brings them back", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    await opened.desk.inbound({ id: "sam-start", from: OBSERVER, text: "START" });
    const desk = opened.reopen();
    const before = mark(opened);
    await activateAndSchedule(desk);
    expect(reached(opened, OBSERVER, before).length).toBeGreaterThan(0);
  });

  it("once the engine opens, it counts the contact's early STOP as out", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    const desk = opened.reopen();
    await activateAndSchedule(desk);
    expect((await desk.moveSource()).optedOut).toContain(OBSERVER);
  });

  it("a START after the engine opens treats an early STOP like a STOP sent after it opened", async () => {
    const early = await beforeActivate(people);
    await early.desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    const earlyDesk = early.reopen();
    await activateAndSchedule(earlyDesk);
    const before = mark(early);
    await earlyDesk.inbound({ id: "sam-start", from: OBSERVER, text: "START" });
    const earlyOut = (await earlyDesk.moveSource()).optedOut.includes(OBSERVER);
    const earlyAfter = said(early, OBSERVER, before);
    cleanupDesks();

    const late = await beforeActivate(people);
    const lateDesk = late.reopen();
    await activateAndSchedule(lateDesk);
    await lateDesk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    const lateBefore = mark(late);
    await lateDesk.inbound({ id: "sam-start", from: OBSERVER, text: "START" });
    const lateOut = (await lateDesk.moveSource()).optedOut.includes(OBSERVER);

    expect(earlyOut).toBe(lateOut);
    // The same reply to the START and nothing else: no invite and no group text either way.
    expect(earlyAfter).toEqual(said(late, OBSERVER, lateBefore));
  });
});
