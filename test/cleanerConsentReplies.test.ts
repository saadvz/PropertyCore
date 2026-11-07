import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import { CLEANER, COURT, LANDLORD, LANE, LINE, sharedAccount, type SharedAccount } from "./sharedHarness";

// saadvz/TourCore#164: replies to a saved person's own text (STOP, START, "which property?",
// "use your assistant") wait for a confirmed host like every other text, because several name
// the address. The STOP itself is still kept.

let open: SharedAccount | undefined;
afterEach(() => {
  open?.m.close();
  open = undefined;
  closeHostedApps();
});

/** No allowlist and no owner: the host saved in setup isn't confirmed. */
const UNCONFIRMED = { CLEANER_CORE_SMS_ALLOWLIST: "" };

async function twoProperties(env?: NodeJS.ProcessEnv) {
  open = await sharedAccount(env ? { env } : {});
  const s = open;
  const lane = await s.add("Scratch Lane");
  await s.startProperty(lane, LANE);
  await s.tool("save_people", { property: lane, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  const court = await s.add("Scratch Court");
  await s.startProperty(court, COURT);
  await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only", shared: true });
  return { s, lane, court };
}

describe("replies before the host is confirmed", () => {
  it("a shared cleaner and the host get no reply from the line, and the cleaner's STOP still holds", { timeout: 120_000 }, async () => {
    const { s } = await twoProperties(UNCONFIRMED);
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "hello", "SM-hello");
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
    expect(s.peopleFile()?.people.find((person) => person.phone === CLEANER)?.stopped).toBeDefined();
    await s.m.text(LINE, CLEANER, "START", "SM-start");
    await s.m.text(LINE, LANDLORD, "hi there", "SM-host");
    expect(s.m.sms.sent.slice(before)).toEqual([]);
  });

  it("one property: the cleaner's and host's STOP and START get no reply, and the cleaner's STOP still holds", { timeout: 120_000 }, async () => {
    open = await sharedAccount({ env: UNCONFIRMED });
    const s = open;
    const lane = await s.add("Scratch Lane");
    await s.startProperty(lane, LANE);
    await s.tool("save_people", { property: lane, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    const before = s.m.sms.sent.length;
    const stopped = () => s.peopleFile()?.people.find((person) => person.phone === CLEANER)?.stopped;
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop1");
    expect(stopped()).toBeDefined();
    await s.m.text(LINE, LANDLORD, "STOP", "SM-hstop1");
    await s.m.text(LINE, CLEANER, "START", "SM-start1");
    expect(stopped()).toBeUndefined();
    await s.m.text(LINE, LANDLORD, "START", "SM-hstart1");
    expect(s.m.sms.sent.slice(before)).toEqual([]);
  });

  it("once the host is confirmed, the same texts get their replies", { timeout: 120_000 }, async () => {
    const { s } = await twoProperties();
    const before = s.m.sms.sent.length;
    await s.m.text(LINE, CLEANER, "hello", "SM-hello");
    await s.m.text(LINE, CLEANER, "STOP", "SM-stop");
    const bodies = s.m.sms.sent.slice(before).filter((sent) => sent.to === CLEANER).map((sent) => sent.body);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
  });
});
