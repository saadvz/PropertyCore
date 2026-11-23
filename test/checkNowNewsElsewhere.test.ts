import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import { CLEANER, COURT, LANDLORD, LANE, LINE, sharedAccount, type SharedAccount } from "./sharedHarness";

/**
 * check_now that names one property, on an account of two (23 Nov Grok run): the live alerts routine's prompt named
 * one property, so the cleaner's texts at the other never reached the chat. check_now now names the other property
 * that has news waiting, until a check reads it. Only 555 numbers.
 */

const SLOW = { timeout: 180_000 };
let open: SharedAccount | undefined;
let at = Date.parse("2026-10-14T13:00:00.000Z");
afterEach(() => {
  open?.m.close();
  open = undefined;
  closeHostedApps();
});

/** Lane and Court on one account, with Ana the cleaner on both. */
async function twoProperties() {
  at = Date.parse("2026-10-14T13:00:00.000Z");
  open = await sharedAccount({ now: () => new Date(at) });
  const s = open;
  const lane = await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  const court = await s.add("Scratch Court");
  await s.startProperty(court, COURT);
  await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only", shared: true });
  await s.finishProperty(court, COURT);
  // Both read once, so only what comes after is news.
  await s.call("check_now", {});
  return { s, lane, court };
}

describe("check_now for one property on an account of two", () => {
  it("names the other property while its cleaner's text waits, and stops once it's read", SLOW, async () => {
    const { s, lane, court } = await twoProperties();
    await s.m.text(LINE, CLEANER, "YES", "SM-opt-yes");
    expect(s.seen(lane)).toContain("SM-opt-yes");
    const court1 = await s.call("check_now", { property: court });
    expect(String(court1.structured?.newsElsewhere)).toContain("Scratch Lane");
    expect(String(court1.structured?.newsElsewhere)).toContain("check_now with no property");
    // Asking does not mark Lane's news read.
    const court2 = await s.call("check_now", { property: court });
    expect(String(court2.structured?.newsElsewhere)).toContain("Scratch Lane");
    const every = JSON.stringify(await s.call("check_now", {}));
    expect(every).toContain("said YES");
    const court3 = await s.call("check_now", { property: court });
    expect(court3.structured?.newsElsewhere).toBeUndefined();
  });

  it("says nothing when the other property has no news", SLOW, async () => {
    const { s, lane } = await twoProperties();
    const reply = await s.call("check_now", { property: lane });
    expect(reply.isError).toBeFalsy();
    expect(reply.structured?.newsElsewhere).toBeUndefined();
  });
});
