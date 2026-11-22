import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCleanerAlertFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { cleanupDesks, ok, openDesk, setUp, testClock } from "./cleanerDeskHarness";
import { ADDRESS, CLEANER, DOOR_CODE, HOST, OBSERVER } from "./wiringProof";

/**
 * Finding #6: the host hears the cleaner's progress without asking. Her YES to cleaning texts, the group
 * being set up, and each YES or NO to a cleaning give one note each, which wakes the Alerts routine once
 * and shows once in check_now. Cleaner Core promises "I'll post here" only when a wake-up can reach the
 * chat. 555 numbers and a made-up code only; the routine is a stub.
 */

afterEach(cleanupDesks);

const OPT_IN = `Ana said YES to cleaning texts for ${ADDRESS}.`;
const GROUP = `The group text for ${ADDRESS} is set up.`;
const TAKEN = `Ana said YES to the Sunday, Oct 18 cleaning at ${ADDRESS}.`;

async function alerts(desk: LiveDesk): Promise<string[]> {
  return (ok(await desk.checkNow()).alerts as string[]) ?? [];
}

function countWakes(): { count: () => number } {
  let wakes = 0;
  setCleanerAlertFetch(async () => {
    wakes += 1;
    return { status: 200 };
  });
  return { count: () => wakes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the host hears the cleaner's progress (#6)", () => {
  it("one note each for the opt-in, the group and the cleaning taken, each waking the routine once and shown once", async () => {
    const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(opened.desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
    await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await alerts(opened.desk);
    const wakes = countWakes();

    await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
    await settle();
    expect(wakes.count()).toBe(1);
    expect(await alerts(opened.desk)).toEqual([OPT_IN, GROUP]);

    await opened.desk.inbound({ id: "take", from: CLEANER, text: "YES" });
    await settle();
    expect(wakes.count()).toBe(2);
    expect(await alerts(opened.desk)).toEqual([TAKEN]);
    // Nothing is told twice.
    expect(await alerts(opened.desk)).toEqual([]);
    const notes = JSON.stringify(ok(await opened.desk.getState("cleaners")).notes);
    expect(notes.split(GROUP).length - 1).toBe(1);
    expect(notes).not.toContain(DOOR_CODE);
    expect(notes).not.toContain(CLEANER.slice(2));
  });

  it("a group conversation Twilio makes again is not announced a second time", async () => {
    const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(opened.desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
    await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
    expect(await alerts(opened.desk)).toContain(GROUP);
    const first = opened.groups.created.length;
    for (const sid of opened.groups.created) opened.groups.close(sid);
    await opened.desk.inbound({ id: "take", from: CLEANER, text: "YES" });
    expect(opened.groups.created.length).toBeGreaterThan(first);
    expect(await alerts(opened.desk)).not.toContain(GROUP);
  });

  it("a group already running before this change is never announced", async () => {
    const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(opened.desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
    await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
    await alerts(opened.desk);
    // A desk saved before this change: its group runs, and it has no record of telling the host.
    const path = join(opened.root, "cleaner-live.json");
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved.conversationSid).toBeTruthy();
    delete saved.groupNoted;
    writeFileSync(path, `${JSON.stringify(saved)}\n`);
    const desk = opened.reopen();
    const posts = opened.groups.posts.length;
    await desk.inbound({ id: "take", from: CLEANER, text: "YES" });
    expect(opened.groups.posts.length).toBeGreaterThan(posts);
    const told = await alerts(desk);
    expect(told).toContain(TAKEN);
    expect(told).not.toContain(GROUP);
  });

  it("one-to-one, the opt-in and the cleaning taken are told, and no group note", async () => {
    const opened = openDesk([HOST, CLEANER], "0");
    await setUp(opened.desk, { groupChat: "cleaner-only" });
    await alerts(opened.desk);
    await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
    expect(await alerts(opened.desk)).toEqual([OPT_IN]);
    await opened.desk.inbound({ id: "take", from: CLEANER, text: "YES" });
    const told = await alerts(opened.desk);
    expect(told).toContain(TAKEN);
    expect(told.some((line) => line.startsWith("The group text"))).toBe(false);
  });

  it("promises a post here only while a wake-up reaches the chat, else the next scheduled check", async () => {
    const clock = testClock();
    const opened = openDesk([HOST, CLEANER], "0", clock.now);
    await setUp(opened.desk, { groupChat: "cleaner-only" });
    await opened.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
    await opened.desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    // The routine starts refusing wake-ups: the next one fails, and Cleaner Core stops promising.
    setCleanerAlertFetch(async () => ({ status: 500 }));
    clock.advance(60_000);
    await opened.desk.inbound({ id: "question", from: CLEANER, text: "Is the dryer fixed?" });
    await settle();
    expect(opened.desk.wakeHealth()).toMatch(/^failing: /);
    const asked = ok(await opened.desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-18", time: "12:00" }));
    const code = (asked.confirmation as { code: string }).code;
    const moved = ok(await opened.desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-18", time: "12:00", confirmation: code }));
    expect(moved.next).toBe("Done. Ana got the update for Sunday, Oct 18 at 12:00 PM. Ana's reply shows at the next scheduled check.");
    expect(String(moved.next)).not.toContain("I'll post here");
  });
});
