import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { visitLogFor } from "../src/visits/store";
import { cleanupDesks, ok, openDesk, PIN_KEY, refused, setUp, testClock } from "./cleanerDeskHarness";
import { approvedOnDesk } from "./hostApproval";
import { deskFeatures } from "./featureEnv";
import { CALENDAR_URL, CLEANER, DOOR_CODE, HOST, OBSERVER } from "./wiringProof";

/**
 * Finding #8: a declined cleaning moves to another day between checkout and the next check-in, on the
 * host's yes, and the cleaner is back on it only after their own YES. The reminder, the door code, the
 * lock code and the visit window follow the moved day. 555 numbers, a made-up code, the fake lock adapter.
 */

// Checkout Sunday Oct 18 at 11:00 New York; the next guests check in Thursday Oct 22 at 16:00.
const GAP_ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261014",
  "DTEND;VALUE=DATE:20261018",
  "SUMMARY:Guest",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-b",
  "DTSTART;VALUE=DATE:20261022",
  "DTEND;VALUE=DATE:20261026",
  "SUMMARY:Next guest",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n");

// Monday Oct 19 at 10:00 New York.
const MOVED_START = "2026-10-19T14:00:00.000Z";

afterEach(() => {
  setLockAdapter(undefined);
  cleanupDesks();
});

function gapCalendar(): void {
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? GAP_ICS : "";
    },
  }));
}

async function opened(options: { group?: boolean; locks?: boolean } = {}) {
  const clock = testClock();
  const desk = openDesk(options.group ? [HOST, CLEANER, OBSERVER] : [HOST, CLEANER], options.group ? "1" : "0", clock.now);
  gapCalendar();
  let fake: FakeLockAdapter | undefined;
  if (options.locks) {
    Object.assign(desk.env, deskFeatures("locks"));
    desk.env.CLEANER_CORE_PIN_KEY = randomBytes(32).toString("base64");
    fake = new FakeLockAdapter();
    setLockAdapter(fake);
    const devices = [fake.addDevice("acct-1", { id: "dev-front", name: "Front door" })];
    hubFor(desk.root, { now: clock.now })
      .doorAccess(() => desk.env)
      .saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: devices.map((device) => storedDevice(device)), doors: devices.map((device) => device.id), activeAt: clock.now().toISOString() });
  }
  await setUp(desk.desk, options.group ? { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" } : { groupChat: "cleaner-only" });
  if (options.group) await desk.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await desk.desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
  return { ...desk, clock, fake };
}

/** Posts in the group thread that match. */
function groupPosts(groups: { posts: { body: string }[] }, pattern: RegExp): string[] {
  return groups.posts.map((post) => post.body).filter((body) => pattern.test(body));
}

function move(desk: LiveDesk, date = "2026-10-19", time = "10:00") {
  return approvedOnDesk((confirmation) => desk.moveCleaning({ checkout: "2026-10-18", date, time, ...(confirmation ? { confirmation } : {}) }, PIN_KEY));
}

async function alerts(desk: LiveDesk): Promise<string[]> {
  return (ok(await desk.checkNow()).alerts as string[]) ?? [];
}

describe("move_cleaning (#8)", () => {
  it("tells the host about the NO with a real next step, then moves the cleaning on the host's yes and asks the cleaner again", async () => {
    const { desk, sms } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    const noted = await alerts(desk);
    expect(noted).toContain("Ana said no to the Sunday, Oct 18 cleaning, so nobody is booked for it yet. The next guests check in Thursday, Oct 22 at 4:00 PM, so whoever cleans has until then. It can also move to another day or time before then, if Ana can do it.");

    const preview = ok(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-19", time: "10:00" }, PIN_KEY));
    expect(preview.next).toContain("moves from checkout, Sunday, Oct 18 at 11:00 AM to Monday, Oct 19 at 10:00 AM");
    expect(preview.next).toContain("Ana said no to it before, so this asks them again.");
    expect(preview.texts).toEqual([{ to: "cleaner", body: "Update: the cleaning at 12 Practice Lane, Teaneck, NJ 07666 is now Monday, Oct 19 at 10:00 AM. Reply YES to take it, or NO if you can't." }]);
    const before = sms.sent.length;
    expect(sms.sent.length).toBe(before);

    const moved = ok(await move(desk));
    expect(moved.next).toBe("Done. Ana got the update for Monday, Oct 19 at 10:00 AM. I'll post here when Ana replies.");
    expect(sms.sent.at(-1)).toMatchObject({ to: CLEANER, body: "Update: the cleaning at 12 Practice Lane, Teaneck, NJ 07666 is now Monday, Oct 19 at 10:00 AM. Reply YES to take it, or NO if you can't." });
    const turn = (ok(await desk.getTurns()).turns as { status: string; movedTo?: string }[])[0]!;
    expect(turn).toMatchObject({ status: "offered", movedTo: "Monday, Oct 19 at 10:00 AM" });

    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    expect(sms.sent.at(-1)).toMatchObject({ to: CLEANER, body: "Cleaning is scheduled for Monday, Oct 19 at 10:00 AM at 12 Practice Lane, Teaneck, NJ 07666." });
    expect(await alerts(desk)).toContain("Ana said YES to the Monday, Oct 19 at 10:00 AM cleaning at 12 Practice Lane, Teaneck, NJ 07666.");
    // Each note shows once.
    expect(await alerts(desk)).toEqual([]);
  });

  it("refuses a start before checkout, into the next check-in, in the past, or once the code went out", async () => {
    const { desk, clock } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    expect(refused(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-18", time: "09:00" }, PIN_KEY)).error).toContain("can't start before then");
    // Check-in Thursday 4 PM: a start after 1 PM that day leaves less than the 3 hours a turnover needs.
    expect(refused(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-22", time: "13:30" }, PIN_KEY)).error).toContain("at least 3 hours before that");
    ok(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-22", time: "13:00" }, PIN_KEY));
    expect(refused(await desk.moveCleaning({ checkout: "2026-10-17", date: "2026-10-19", time: "10:00" }, PIN_KEY)).error).toContain("No cleaning checks out on 2026-10-17");
    clock.advance(Date.parse("2026-10-20T15:00:00.000Z") - clock.now().getTime());
    expect(refused(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-19", time: "10:00" }, PIN_KEY)).error).toContain("has already passed");
  });

  it("a stale approval code moves nothing", async () => {
    const { desk, sms } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    const asked = ok(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-19", time: "10:00" }, PIN_KEY));
    const code = (asked.confirmation as { code: string }).code;
    const sent = sms.sent.length;
    // The same code for a different time is refused.
    expect(refused(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-20", time: "10:00", confirmation: code }, PIN_KEY)).error).toContain("expired or doesn't match");
    expect(sms.sent.length).toBe(sent);
  });

  it("sends the reminder on the moved day and the door code only from the moved start", async () => {
    const { desk, sms, clock } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    ok(await move(desk));
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    // Checkout day: the host says the guests left. The code waits for Monday 10 AM.
    clock.advance(Date.parse("2026-10-18T16:00:00.000Z") - clock.now().getTime());
    const left = ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(left.next).toBe("Got it, the guests are gone. The cleaning was moved to Monday, Oct 19 at 10:00 AM, so Ana gets the door code then, not before.");
    await desk.checkNow();
    expect(sms.sent.some((text) => text.to === CLEANER && text.body.includes(DOOR_CODE))).toBe(false);
    expect(sms.sent.some((text) => text.to === CLEANER && /^Reminder:/.test(text.body) && text.body.includes("Sunday"))).toBe(false);
    // Monday morning: the reminder names the moved day and time. Still no code.
    clock.advance(Date.parse("2026-10-19T12:30:00.000Z") - clock.now().getTime());
    await desk.checkNow();
    expect(sms.sent.some((text) => text.to === CLEANER && text.body === "Reminder: cleaning at 12 Practice Lane, Teaneck, NJ 07666 on Monday, Oct 19, starting 10:00 AM. What time do you plan to arrive?")).toBe(true);
    expect(sms.sent.some((text) => text.to === CLEANER && text.body.includes(DOOR_CODE))).toBe(false);
    // From the moved start, the next check sends the code once, then DONE works as usual.
    clock.advance(Date.parse(MOVED_START) - clock.now().getTime() + 60_000);
    await desk.checkNow();
    await desk.checkNow();
    expect(sms.sent.filter((text) => text.to === CLEANER && text.body.includes(DOOR_CODE)).length).toBe(1);
  });

  it("writes the moved window to the visit records", async () => {
    const { desk, root, clock } = await opened();
    // Visit log lines are keyed by the time they're written, so the clock moves between steps.
    clock.advance(60_000);
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    clock.advance(60_000);
    ok(await move(desk));
    clock.advance(60_000);
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    const turn = (ok(await desk.getTurns()).turns as { checkoutDate: string }[])[0]!;
    expect(turn.checkoutDate).toBe("2026-10-18");
    const windows = visitLogFor(root).read().filter((event) => event.type === "visit-window" && event.from.startsWith("2026-10-1"));
    expect(windows.at(-1)).toMatchObject({ from: MOVED_START, sameDay: false, until: "2026-10-20T00:00:00.000Z" });
  });

  it("on connected locks, makes the cleaner's own code only at their YES, for the moved window", async () => {
    const { desk, fake, clock } = await opened({ locks: true });
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    ok(await move(desk));
    await desk.lockClock();
    expect(fake!.liveCodes("dev-front")).toEqual([]);
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    const live = fake!.liveCodes("dev-front");
    expect(live.length).toBe(1);
    expect(live[0]!.window).toEqual({ from: MOVED_START, until: "2026-10-20T04:00:00.000Z" });
    expect(live[0]!.code).not.toBe(DOOR_CODE);
    void clock;
  });

  it("in a group, posts the update to the group and the cleaner's YES puts them back on it", async () => {
    const { desk, groups } = await opened({ group: true });
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    ok(await move(desk));
    expect(groupPosts(groups, /is now Monday, Oct 19 at 10:00 AM/).length).toBe(1);
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    const turn = (ok(await desk.getTurns()).turns as { status: string }[])[0]!;
    expect(turn.status).toBe("confirmed");
  });

  it("a NO to the moved time declines it again, and nothing more goes out", async () => {
    const { desk, sms } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    ok(await move(desk));
    await desk.inbound({ id: "no-again", from: CLEANER, text: "NO" });
    const sent = sms.sent.length;
    await desk.checkNow();
    expect(sms.sent.length).toBe(sent);
    expect((ok(await desk.getTurns()).turns as { status: string }[])[0]!.status).toBe("declined");
  });

  it("wakes the alert routine once for the cleaner's YES to the moved time", async () => {
    const { desk } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    await desk.checkNow();
    ok(await move(desk));
    let wakes = 0;
    setCleanerAlertFetch(async () => {
      wakes += 1;
      return { status: 200 };
    });
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakes).toBe(1);
  });

  it("moving a cleaning the cleaner already took asks them again, and takes their lock code off until their YES", async () => {
    const { desk, fake } = await opened({ locks: true });
    await desk.inbound({ id: "take", from: CLEANER, text: "YES" });
    expect(fake!.liveCodes("dev-front").length).toBe(1);
    ok(await move(desk));
    await desk.lockClock();
    expect(fake!.liveCodes("dev-front")).toEqual([]);
    expect((ok(await desk.getTurns()).turns as { status: string }[])[0]!.status).toBe("offered");
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    expect(fake!.liveCodes("dev-front").map((code) => code.window.from)).toEqual([MOVED_START]);
  });

  it("is refused while the cleaning is paused", async () => {
    const { desk, sms } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    ok(await approvedOnDesk((confirmation) => desk.holdJob(confirmation ? { confirmation } : {})));
    const sent = sms.sent.length;
    expect(refused(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-19", time: "10:00" }, PIN_KEY)).error).toContain("paused");
    expect(sms.sent.length).toBe(sent);
  });

  it("a new next check-in on the calendar drops the move, tells the cleaner the cleaning is back at checkout, and asks again", async () => {
    const { desk, sms } = await opened();
    await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
    ok(await move(desk, "2026-10-21", "10:00"));
    await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
    // The next guests now arrive a day earlier, Wednesday Oct 21.
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? GAP_ICS.replace("DTSTART;VALUE=DATE:20261022", "DTSTART;VALUE=DATE:20261021") : "";
      },
    }));
    await desk.checkNow();
    const turn = (ok(await desk.getTurns()).turns as { status: string; movedTo?: unknown }[])[0]!;
    expect(turn.status).not.toBe("confirmed");
    expect(turn.movedTo).toBeUndefined();
    expect(sms.sent.some((text) => text.to === CLEANER && /Wednesday, Oct 21 at 10:00 AM/.test(text.body) && /^Reminder/.test(text.body))).toBe(false);
  });

  it("is not a tool the alert routines may call", async () => {
    const { readFileSync } = await import("node:fs");
    for (const routine of ["cleaner-template/routines/cleaner-core-alerts.md", "cleaner-template/routines/cleaner-core-check.md"]) {
      const allowed = readFileSync(routine, "utf8").split("## Allowed tools")[1] ?? "";
      expect(allowed).not.toContain("move_cleaning");
    }
  });
});
