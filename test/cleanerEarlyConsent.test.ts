import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveDesk } from "../src/cleaner-core/liveDesk";
import { doorAccessPath } from "../src/hub/doorAccess";
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

describe("a contact who opted out comes back by START, then YES (#215 follow-up)", () => {
  const people = { contacts: SAM, groupChat: "everyone", doorCodeTo: "cleaner" } as const;
  const BACK_IN = `You're opted back in to cleaning texts for ${ADDRESS}. Reply YES to join, or STOP to opt out.`;

  /** Activated, with Sam's STOP taken by the engine after Sam was invited. */
  async function stoppedAfterInvite() {
    const opened = await beforeActivate(people);
    const desk = opened.reopen();
    await activateAndSchedule(desk);
    await desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    return { opened, desk };
  }

  it("START no longer says they're back in while leaving them out: it asks for YES", async () => {
    const { opened, desk } = await stoppedAfterInvite();
    const before = mark(opened);
    await desk.inbound({ id: "sam-start", from: OBSERVER, text: "START" });
    expect(said(opened, OBSERVER, before)).toEqual([BACK_IN]);
    expect((await desk.moveSource()).optedOut).not.toContain(OBSERVER);
  });

  it("their YES after START puts them back in the group", async () => {
    const { opened, desk } = await stoppedAfterInvite();
    await desk.inbound({ id: "sam-start", from: OBSERVER, text: "START" });
    const before = mark(opened);
    await desk.inbound({ id: "sam-yes", from: OBSERVER, text: "YES" });
    expect(reached(opened, OBSERVER, before).length).toBeGreaterThan(0);
    expect((await desk.moveSource()).optedOut).not.toContain(OBSERVER);
  });

  it("without START, a YES after STOP still changes nothing (control)", async () => {
    const { opened, desk } = await stoppedAfterInvite();
    const before = mark(opened);
    await desk.inbound({ id: "sam-yes", from: OBSERVER, text: "YES" });
    expect(reached(opened, OBSERVER, before)).toEqual([]);
    expect((await desk.moveSource()).optedOut).toContain(OBSERVER);
  });

  it("an early STOP, before any invite, comes back the same way: START, then YES", async () => {
    const opened = await beforeActivate(people);
    await opened.desk.inbound({ id: "sam-stop", from: OBSERVER, text: "STOP" });
    const desk = opened.reopen();
    await activateAndSchedule(desk);
    const before = mark(opened);
    await desk.inbound({ id: "sam-start", from: OBSERVER, text: "START" });
    expect(said(opened, OBSERVER, before)).toEqual([BACK_IN]);
    // They were never sent the invite, so the START reply is the one their YES answers.
    await desk.inbound({ id: "sam-yes", from: OBSERVER, text: "YES" });
    expect(reached(opened, OBSERVER, before).length).toBeGreaterThan(1);
    expect((await desk.moveSource()).optedOut).not.toContain(OBSERVER);
  });
});

describe("a host's STOP or START while the engine can't open counts when it reopens (#215 follow-up)", () => {
  const people = { groupChat: "cleaner-and-host" } as const;

  /** The host's consent as the engine saved it. One property, so one tenant in the store. */
  function hostConsent(root: string): { ownerOptedOut: boolean; hostGroup: unknown } {
    const store = JSON.parse(readFileSync(join(root, "cleaner-job", "cleaner-core.json"), "utf8")) as Record<string, unknown> & { tenants?: Record<string, Record<string, unknown>> };
    const mine = store.tenants ? Object.values(store.tenants)[0]! : store;
    return { ownerOptedOut: mine.ownerOptedOut === true, hostGroup: mine.hostGroup };
  }

  /** Activated and seated, then the door code is gone and the server restarts, so no engine opens. */
  async function engineClosed() {
    const opened = await beforeActivate(people);
    await activateAndSchedule(opened.desk);
    expect(hostConsent(opened.root)).toEqual({ ownerOptedOut: false, hostGroup: "in" });
    rmSync(doorAccessPath(opened.root), { force: true });
    return { opened, desk: opened.reopen() };
  }

  it("a STOP while it's closed takes the host out of the group once the code is saved again", async () => {
    const { opened, desk } = await engineClosed();
    await desk.inbound({ id: "host-stop", from: HOST, text: "STOP" });
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
    await desk.inbound({ id: "cleaner-hi", from: CLEANER, text: "On my way" });
    expect(hostConsent(opened.root)).toEqual({ ownerOptedOut: true, hostGroup: "out" });
  });

  it("a START while it's closed brings back a host who stopped while it was open", async () => {
    const opened = await beforeActivate(people);
    await activateAndSchedule(opened.desk);
    await opened.desk.inbound({ id: "host-stop", from: HOST, text: "STOP" });
    expect(hostConsent(opened.root)).toEqual({ ownerOptedOut: true, hostGroup: "out" });
    rmSync(doorAccessPath(opened.root), { force: true });
    const desk = opened.reopen();
    await desk.inbound({ id: "host-start", from: HOST, text: "START" });
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
    await desk.inbound({ id: "cleaner-hi", from: CLEANER, text: "On my way" });
    expect(hostConsent(opened.root)).toEqual({ ownerOptedOut: false, hostGroup: "in" });
  });

  it("with nothing from the host while it's closed, the engine reopens as it was (control)", async () => {
    const { opened, desk } = await engineClosed();
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
    await desk.inbound({ id: "cleaner-hi", from: CLEANER, text: "On my way" });
    expect(hostConsent(opened.root)).toEqual({ ownerOptedOut: false, hostGroup: "in" });
  });
});
