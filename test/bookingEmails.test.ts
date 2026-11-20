import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCleanerCalendarFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { setStayCodeHook } from "../src/cleaner-core/stayCodeHook";
import type { BookingEmailInput } from "../src/hub/airbnbEmail";
import { BOOKING_EMAILS_FILE, readBookingEmails } from "../src/hub/bookingEmails";
import { sampleEmail } from "./airbnbEmails";
import { PIN_KEY, cleanupDesks, liveGroup, liveOneToOne, ok, refused, testClock } from "./cleanerDeskHarness";
import { CALENDAR_URL, DOOR_CODE, HOST } from "./wiringProof";

/**
 * Airbnb reservation emails on a live desk (#244). The harness calendar has stay-a (Oct 14 to 18) and
 * stay-b (Oct 18 to 22); the samples are for Oct 18 to 22, so they are stay-b. Made-up emails, made-up
 * HM codes and door codes, 555 numbers only.
 */

/** stay-b gone; a booking the calendar adds later has its own UID, as a new booking does. */
const ONLY_A = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:stay-a", "DTSTART;VALUE=DATE:20261014", "DTEND;VALUE=DATE:20261018", "SUMMARY:Guest", "END:VEVENT", "END:VCALENDAR", ""].join("\n");
const LATER = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261014",
  "DTEND;VALUE=DATE:20261018",
  "SUMMARY:Guest",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-c",
  "DTSTART;VALUE=DATE:20261018",
  "DTEND;VALUE=DATE:20261022",
  "SUMMARY:Next guest",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n");

const hookCalls: unknown[] = [];

afterEach(() => {
  setStayCodeHook(undefined);
  hookCalls.length = 0;
  cleanupDesks();
});

function calendar(body: () => string): void {
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? body() : "";
    },
  }));
}

async function opened(clock = testClock()) {
  setStayCodeHook({
    async windowMoved(input) {
      hookCalls.push({ moved: input.jobId });
    },
    async stayCancelled(input) {
      hookCalls.push({ cancelled: input.jobId });
    },
  });
  const desk = await liveOneToOne(clock.now);
  return { ...desk, clock };
}

const read = (desk: LiveDesk, email: BookingEmailInput, more: { thisListing?: boolean; confirmation?: string } = {}) => desk.readBookingEmail({ email, ...more }, PIN_KEY);

async function turns(desk: LiveDesk) {
  return ok(await desk.getTurns()).turns as { checkoutDate: string; nextCheckInDate: string | null; checkoutTime: string | null; nextCheckInTime: string | null; status: string; guests?: number; confirmationCode?: string }[];
}

/** The turn checking out that day; a called-off one only when there's no other. */
const turn = async (desk: LiveDesk, checkoutDate: string) => {
  const all = (await turns(desk)).filter((item) => item.checkoutDate === checkoutDate);
  return all.find((item) => item.status !== "canceled") ?? all[0]!;
};

async function alerts(desk: LiveDesk): Promise<string[]> {
  return ok(await desk.checkNow()).alerts as string[];
}

describe("an Airbnb email for a listing this property hasn't saved", () => {
  it("changes nothing and asks the host, then with the host's yes saves the listing and applies the times", async () => {
    const { desk, root } = await opened();
    const asked = ok(await read(desk, sampleEmail("confirmed-stacked")));
    expect(asked).toMatchObject({ outcome: "mismatch", listing: "Harbor Cottage by the Water" });
    expect(String(asked.next)).toContain("thisListing");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBeNull();
    expect((await alerts(desk)).some((line) => line.includes("Harbor Cottage by the Water"))).toBe(true);

    const applied = ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    expect(applied.outcome).toBe("applied");
    expect(await turn(desk, "2026-10-22")).toMatchObject({ checkoutTime: "12:00 PM", guests: 3, confirmationCode: "HMXK4Q2Z9R" });
    expect((await turn(desk, "2026-10-18")).nextCheckInTime).toBe("3:00 PM");
    expect(readBookingEmails(root).map((item) => item.outcome)).toEqual(["mismatch", "applied"]);

    // The next email for the same listing matches on its own.
    expect(ok(await read(desk, sampleEmail("changed"))).outcome).toBe("applied");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("2:00 PM");
  });
});

describe("an Airbnb email for this property", () => {
  async function listed() {
    const desk = await opened();
    ok(await read(desk.desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    return desk;
  }

  it("notes the host once when the email's times differ from what was saved, and not when they're the same", async () => {
    const { desk } = await listed();
    const notes = await alerts(desk);
    // stay-a's next check-in was saved at 4:00 PM through confirm_times; stay-b had the usual 10:30 AM checkout.
    expect(notes).toContain("Airbnb says the next guest checks in on Sunday, Oct 18 at 3:00 PM, not 4:00 PM. I'm using 3:00 PM.");
    expect(notes).toContain("Airbnb says checkout on Thursday, Oct 22 is 12:00 PM, not 10:30 AM. I'm using 12:00 PM.");
    expect(await alerts(desk)).toEqual([]);
    const again = sampleEmail("confirmed-stacked");
    ok(await read(desk, { ...again, messageId: "<another@example.test>", subject: `${again.subject} ` }));
    expect((await alerts(desk)).filter((line) => line.startsWith("Airbnb says"))).toEqual([]);
  });

  it("takes a second copy of the same email as a duplicate", async () => {
    const { desk, root } = await listed();
    expect(ok(await read(desk, sampleEmail("confirmed-stacked"))).outcome).toBe("duplicate");
    expect(readBookingEmails(root).at(-1)?.outcome).toBe("duplicate");
  });

  it("refuses an email that isn't from Airbnb, and keeps only that it came, not its body", async () => {
    const { desk, root } = await listed();
    const reply = ok(await read(desk, sampleEmail("forwarded")));
    expect(reply).toMatchObject({ outcome: "refused", reason: "not-airbnb" });
    const kept = readBookingEmails(root).at(-1)!;
    expect(kept).toMatchObject({ outcome: "refused", refused: "not-airbnb" });
    expect(kept.body).toBeUndefined();
    expect(ok(await read(desk, sampleEmail("forwarded"))).outcome).toBe("duplicate");
  });

  it("takes the host's yes to the listing even when the email comes back without its message id", async () => {
    const { desk } = await opened();
    expect(ok(await read(desk, sampleEmail("confirmed-stacked"))).outcome).toBe("mismatch");
    const { messageId: _id, ...noId } = sampleEmail("confirmed-stacked");
    expect(ok(await read(desk, noId, { thisListing: true })).outcome).toBe("applied");
  });

  it("keeps the newer email's times when an older one is passed after it", async () => {
    const { desk, root } = await listed();
    ok(await read(desk, sampleEmail("changed", "2026-10-14T16:00:00.000Z")));
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("2:00 PM");
    const older = sampleEmail("confirmed-stacked", "2026-10-14T14:00:00.000Z");
    expect(ok(await read(desk, { ...older, messageId: "<older-copy@example.test>", subject: `${older.subject} (1)` })).outcome).toBe("superseded");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("2:00 PM");
    expect(readBookingEmails(root).at(-1)?.outcome).toBe("superseded");
  });

  it("changes nothing and asks the host when its dates disagree with the calendar", async () => {
    const { desk } = await listed();
    const stacked = sampleEmail("changed");
    const reply = ok(await read(desk, { ...stacked, body: stacked.body.replace("Thu, Oct 22", "Fri, Oct 23") }));
    expect(reply.outcome).toBe("disagrees");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("12:00 PM");
    expect(await alerts(desk)).toContain("Airbnb says HMXK4Q2Z9R is Oct 18 to Oct 23, but the calendar shows Oct 18 to Oct 22. Check the booking, then run the checks again.");
  });

  it("leaves a cleaning alone once its door code went out, and tells the host", async () => {
    const { desk } = await liveGroup();
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect((await turn(desk, "2026-10-18")).status).toBe("cleared");
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    expect((await turn(desk, "2026-10-18")).nextCheckInTime).toBe("4:00 PM");
    expect(await alerts(desk)).toContain("Airbnb changed the next check-in on Sunday, Oct 18 to 3:00 PM after the door code went out. I left that cleaning as it was.");
    // The stay's own cleaning, not under way, still gets its checkout time.
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("12:00 PM");
  });

  it("never keeps or repeats a door code", async () => {
    const { desk, root } = await listed();
    const reply = await read(desk, sampleEmail("door-code"));
    expect(JSON.stringify(reply)).not.toContain(DOOR_CODE);
    const log = readFileSync(join(root, BOOKING_EMAILS_FILE), "utf8");
    expect(log).toContain("HMQ9W2E4R6");
    expect(log).not.toContain(DOOR_CODE);
    expect(log).not.toContain("6907");
  });

  it("calls the lock hook when it moves a window", async () => {
    await listed();
    expect(hookCalls).toContainEqual({ moved: "stay-b" });
  });
});

describe("a booking the calendar doesn't show yet", () => {
  it("reads the calendars itself, so a same-day booking gets its times at once", async () => {
    let ics = ONLY_A;
    const { desk } = await opened();
    calendar(() => ics);
    ok(await desk.checkNow());
    ics = LATER;
    const reply = ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    expect(reply.outcome).toBe("applied");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("12:00 PM");
  });

  it("waits for the calendar, applies on the next check, and asks the host after 3 hours", async () => {
    let ics = ONLY_A;
    const { desk, root, clock } = await opened();
    calendar(() => ics);
    ok(await desk.checkNow());
    expect(ok(await read(desk, sampleEmail("confirmed-stacked", clock.now().toISOString()), { thisListing: true })).outcome).toBe("pending");
    clock.advance(60 * 60 * 1000);
    expect((await alerts(desk)).filter((line) => line.includes("HMXK4Q2Z9R"))).toEqual([]);
    ics = LATER;
    ok(await desk.checkNow());
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("12:00 PM");
    expect(readBookingEmails(root).map((item) => item.outcome)).toEqual(["pending", "applied"]);
  });

  it("doesn't let a waiting email undo a newer change once the calendar catches up", async () => {
    let ics = ONLY_A;
    const { desk, root, clock } = await opened();
    calendar(() => ics);
    ok(await desk.checkNow());
    expect(ok(await read(desk, sampleEmail("confirmed-stacked", clock.now().toISOString()), { thisListing: true })).outcome).toBe("pending");
    clock.advance(10 * 60 * 1000);
    ics = LATER;
    expect(ok(await read(desk, sampleEmail("changed", clock.now().toISOString()))).outcome).toBe("applied");
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("2:00 PM");
    ok(await desk.checkNow());
    expect((await turn(desk, "2026-10-22")).checkoutTime).toBe("2:00 PM");
    expect(readBookingEmails(root).map((item) => item.outcome)).toEqual(["pending", "applied", "superseded"]);
  });

  it("asks the host when it still isn't on the calendar 3 hours later", async () => {
    const { desk, clock } = await opened();
    calendar(() => ONLY_A);
    ok(await desk.checkNow());
    ok(await read(desk, sampleEmail("confirmed-stacked", clock.now().toISOString()), { thisListing: true }));
    clock.advance(3 * 60 * 60 * 1000 + 1);
    expect(await alerts(desk)).toContain("Airbnb says HMXK4Q2Z9R is Oct 18 to Oct 22, but the calendar doesn't show it. Check the booking, then run the checks again.");
  });
});

describe("an Airbnb cancellation", () => {
  it("is already done when the calendar dropped the stay: nothing more is called off or asked", async () => {
    const { desk } = await opened();
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    calendar(() => ONLY_A);
    const reply = ok(await read(desk, sampleEmail("cancelled-bare")));
    expect(reply).toMatchObject({ outcome: "applied" });
    expect(reply).not.toHaveProperty("confirmation");
    expect((await turn(desk, "2026-10-22"))?.status ?? "canceled").toBe("canceled");
    expect(hookCalls).toContainEqual({ cancelled: "stay-b" });
  });

  it("asks the host when the calendar still shows the stay, and calls it off only with the yes", async () => {
    const { desk, root } = await opened();
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    const asked = ok(await read(desk, sampleEmail("cancelled-range")));
    expect(asked.outcome).toBe("asked");
    expect(typeof (asked.confirmation as { code: string }).code).toBe("string");
    expect((await turn(desk, "2026-10-22")).status).not.toBe("canceled");
    expect(refused(await read(desk, sampleEmail("cancelled-range"), { confirmation: "not-the-code" })).error).toBeTruthy();
    const done = ok(await read(desk, sampleEmail("cancelled-range"), { confirmation: (asked.confirmation as { code: string }).code }));
    expect(done.outcome).toBe("called-off");
    expect((await turn(desk, "2026-10-22")).status).toBe("canceled");
    expect(hookCalls).toContainEqual({ cancelled: "stay-b" });
    expect(readBookingEmails(root).map((item) => item.outcome)).toEqual(["applied", "asked", "called-off"]);
    // The calendar still shows it, but the call-off holds.
    ok(await desk.checkNow());
    expect((await turn(desk, "2026-10-22")).status).toBe("canceled");
  });

  it("goes by the first cleaning with the stay's dates, as before #263, even when another one has them", async () => {
    const { desk } = await opened();
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    calendar(() => ONLY_A);
    ok(await desk.checkNow());
    expect((await turn(desk, "2026-10-22"))?.status ?? "canceled").toBe("canceled");
    // A new booking for the same nights: its cleaning is on, next to the old one's called-off cleaning.
    calendar(() => LATER);
    ok(await desk.checkNow());
    const reply = ok(await read(desk, sampleEmail("cancelled-bare")));
    expect(reply.outcome).toBe("applied");
    expect(reply).not.toHaveProperty("confirmation");
  });

  it("changes nothing and tells the host when the calendar never showed the cancelled stay", async () => {
    const { desk } = await opened();
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    const cancel = sampleEmail("cancelled-range");
    const other = { ...cancel, subject: cancel.subject.replace("HMXK4Q2Z9R", "HMZZ7ZZ7ZZ"), body: cancel.body.replaceAll("HMXK4Q2Z9R", "HMZZ7ZZ7ZZ").replace("Oct 18 – 22", "Nov 1 – 5") };
    const reply = ok(await read(desk, other));
    expect(reply.outcome).toBe("disagrees");
    expect(await alerts(desk)).toContain("Airbnb says HMZZ7ZZ7ZZ (Nov 1 to Nov 5) was cancelled, but I can't find that stay on the calendar. Nothing was called off.");
    expect((await turn(desk, "2026-10-22")).status).not.toBe("canceled");
  });

  it("goes by the dates it already knows for the booking over a cancellation's own wording", async () => {
    const { desk } = await opened();
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    const cancel = sampleEmail("cancelled-range");
    const asked = ok(await read(desk, { ...cancel, body: cancel.body.replace("Oct 18 – 22", "Oct 19 – 23") }));
    expect(asked.outcome).toBe("asked");
    expect(String(asked.next)).toContain("(Oct 18 to Oct 22)");
  });

  it("shows the exact text the cleaner gets when the cleaning is live", async () => {
    const { desk } = await opened();
    const confirm = sampleEmail("confirmed-stacked");
    // A stay-a booking, so the offered cleaning (stay-a's) is the one cancelled.
    ok(await read(desk, { ...confirm, body: confirm.body.replace("Sun, Oct 18", "Wed, Oct 14").replace("Thu, Oct 22", "Sun, Oct 18") }, { thisListing: true }));
    const cancel = sampleEmail("cancelled-range");
    const asked = ok(await read(desk, { ...cancel, body: cancel.body.replace("Oct 18 – 22", "Oct 14 – 18") }));
    expect(asked.outcome).toBe("asked");
    expect(asked.texts).toEqual([expect.objectContaining({ to: "Ana", body: expect.stringContaining("is canceled") })]);
  });
});

describe("the host's phone stays out of it", () => {
  it("never texts the host about an email", async () => {
    const { desk, sms } = await opened();
    const before = sms.sent.filter((item) => item.to === HOST).length;
    ok(await read(desk, sampleEmail("confirmed-stacked"), { thisListing: true }));
    expect(sms.sent.filter((item) => item.to === HOST).length).toBe(before);
  });
});
