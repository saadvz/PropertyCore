import { afterEach, describe, expect, it } from "vitest";
import { liveApp, type LiveApp } from "./liveApp";
import { reachedLandlord, visitorSession } from "./visitorScenarioKit";

/**
 * A booked visitor moves their tour by text, with no landlord: "can I change the time?" offers the open
 * times, and a pick moves the booking. Booked by `book()`: Unit 1A, Monday Sep 28 at 2:00 PM. Only 555
 * numbers.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const SLOW = { timeout: 30_000 };

async function booked(): Promise<LiveApp> {
  const app = await liveApp({ cleanups });
  await app.book();
  return app;
}

/** The visitor's booked start, as the record holds it. */
async function bookedStart(app: LiveApp): Promise<string | undefined> {
  return (await visitorSession(app).reservation())?.slotStart;
}

describe("rescheduling by text", () => {
  it("offers the open times for a plain change ask, and moves the booking on a pick", SLOW, async () => {
    const app = await booked();
    const before = await bookedStart(app);
    const offered = (await app.text("Can I change the time for the tour?")).join("\n");
    expect(offered).toMatch(/1\)|Reply 1/);
    expect(offered).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    const moved = (await app.text("1")).join("\n");
    expect(moved).toMatch(/moved|all set|confirmed/i);
    expect(await bookedStart(app)).not.toBe(before);
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("offers a named day's times for a booked visitor", SLOW, async () => {
    const app = await booked();
    const reply = (await app.text("Can we do Thursday instead?")).join("\n");
    expect(reply).toMatch(/Thursday/);
    expect(reply).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("says nothing is open when no other time is, and keeps the booking", SLOW, async () => {
    const app = await booked();
    const before = await bookedStart(app);
    const session = visitorSession(app);
    session.rescheduleOptions = async () => [];
    const reply = (await app.text("Can I change the time?")).join("\n");
    expect(reply).toMatch(/nothing (else )?is open/i);
    expect(await bookedStart(app)).toBe(before);
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("offers other times, and keeps the booking, when the picked time was just taken", SLOW, async () => {
    const app = await booked();
    const before = await bookedStart(app);
    await app.text("Can I change the time?");
    const session = visitorSession(app);
    session.reschedule = async () => ({ changed: false });
    const reply = (await app.text("1")).join("\n");
    expect(reply).toMatch(/just taken|no longer open|isn't open/i);
    expect(reply).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(await bookedStart(app)).toBe(before);
  });
});
