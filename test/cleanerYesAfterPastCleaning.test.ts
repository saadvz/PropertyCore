import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

/**
 * A real cleaner's YES to an offer (25 Nov) got "This cleaning is already marked done." back. An
 * earlier stay checked out without ever being timed or taken, so the YES went to that past
 * cleaning, and the reply looked at the first cleaning ever finished. The YES now schedules the
 * cleaning that was offered.
 */

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const ALREADY = "This cleaning is already marked done.";

function setUp(group: boolean) {
  const sent: CleanerText[] = [];
  const clock = { at: new Date("2026-10-14T15:00:00.000Z") };
  const engine = openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(lane!.pin),
    hostName: "Scratch",
    consented: true,
    sink: { async send(text: CleanerText) { sent.push(text); } },
    now: () => clock.at,
    ...(group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  });
  return { engine, sent, clock };
}

/** The first cleaning (checkout Oct 18) is timed, taken, and finished. */
async function firstCleaningDone(group: boolean) {
  const setup = setUp(group);
  const { engine, clock } = setup;
  await engine.pollFeed(FEED);
  if (group) {
    await engine.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await engine.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await engine.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
  } else {
    await engine.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await engine.receive({ id: "y-out", from: OWNER, text: "YES" });
    await engine.receive({ id: "y-in", from: OWNER, text: "YES" });
  }
  await engine.receive({ id: "y-offer", from: CLEANER, text: "YES" });
  clock.at = new Date("2026-10-18T15:30:00.000Z");
  await engine.receive({ id: "left", from: OWNER, text: "guests have left" });
  await engine.receive({ id: "done-1", from: CLEANER, text: "DONE" });
  expect(engine.jobs()[0]?.status).toBe("done");
  return setup;
}

describe("Cleaner Core: the cleaner's YES after a past cleaning nobody timed", () => {
  for (const group of [true, false]) {
    it(`schedules the offered cleaning${group ? " in a group text" : ""}`, async () => {
      const { engine, sent, clock } = await firstCleaningDone(group);
      // The Oct 20 cleaning is never timed or taken. It's now Oct 21.
      clock.at = new Date("2026-10-21T14:00:00.000Z");
      const [, past, next] = engine.jobs();
      expect(past?.checkoutDate).toBe("2026-10-20");
      expect(past?.status).toBe("discovered");
      expect(next).toBeDefined();
      const timed = await engine.setJobTimes({ jobId: next!.id, checkout: 11 * 60, checkIn: 16 * 60 });
      expect(timed.applied).toBe(true);
      await engine.runReminders();
      expect(engine.jobs()[2]?.status).toBe("offered");

      const before = sent.length;
      const yes = await engine.receive({ id: "y-next", from: CLEANER, text: "YES" });
      const replies = sent.slice(before).filter((text) => text.to === CLEANER || text.kind === "confirm").map((text) => text.body);
      expect(replies).not.toContain(ALREADY);
      expect(yes.reason).toBe("scheduled");
      expect(engine.jobs()[2]?.status).toBe("confirmed");
      expect(replies.some((body) => body.startsWith("Cleaning is scheduled for"))).toBe(true);
    });
  }

  it("still says the cleaning is done when the cleaner texts DONE again and nothing new is offered", async () => {
    const { engine } = await firstCleaningDone(false);
    const again = await engine.receive({ id: "done-2", from: CLEANER, text: "DONE" });
    expect(again.sent.map((text) => text.body)).toEqual([ALREADY]);
  });

  it("asks for YES, not DONE, when a text comes in while an offer waits", async () => {
    const { engine, clock } = await firstCleaningDone(false);
    clock.at = new Date("2026-10-21T14:00:00.000Z");
    const next = engine.jobs()[2]!;
    await engine.setJobTimes({ jobId: next.id, checkout: 11 * 60, checkIn: 16 * 60 });
    await engine.runReminders();
    const help = await engine.receive({ id: "huh", from: CLEANER, text: "DONE" });
    expect(help.sent.map((text) => text.body)).toEqual(["Reply YES to schedule the cleaning, or STOP to opt out."]);
  });
});
