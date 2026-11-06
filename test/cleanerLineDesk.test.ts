import { afterEach, describe, expect, it } from "vitest";
import { withCaller } from "../src/cleaner-core/callerContext";
import { cleanupDesks, liveGroup, ok, openDesk, setUp } from "./cleanerDeskHarness";
import { CLEANER, DOOR_CODE, HOST, OBSERVER } from "./wiringProof";

/** What a property's desk needs on a line shared by several properties. Only 555 numbers. */

const LABEL = "12 Scratch Lane";

afterEach(() => cleanupDesks());

/** Marks the desk's env as one property of two, the way the hosted service builds it. */
function asOneOfTwo(env: NodeJS.ProcessEnv): void {
  env.CLEANER_CORE_PROPERTY_ID = "prp_lane000001";
  env.CLEANER_CORE_PROPERTY_LABEL = LABEL;
  env.CLEANER_CORE_PROPERTY_COUNT = "2";
}

const to = (sms: { sent: { to: string; body: string }[] }, phone: string) => sms.sent.filter((s) => s.to === phone).map((s) => s.body);

describe("LiveDesk on a shared line", () => {
  it("phonesOnProperty lists the host and the people", async () => {
    const { desk } = openDesk([HOST, CLEANER, OBSERVER], "0");
    await setUp(desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-only" });
    expect(await desk.phonesOnProperty()).toEqual({ host: HOST, people: [CLEANER, OBSERVER] });
  });

  it("markOptedOut keeps every text from the phone, sends nothing itself, and START brings it back", async () => {
    const { desk, sms } = openDesk([HOST, CLEANER], "0");
    await desk.markOptedOut(CLEANER);
    expect(sms.sent).toEqual([]);
    await setUp(desk, { groupChat: "cleaner-only" });
    expect(to(sms, CLEANER)).toEqual([]);
    await desk.inbound({ id: "start-cleaner", from: CLEANER, text: "START" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    expect(to(sms, CLEANER).length).toBeGreaterThan(0);
  });

  it("markOptedOut holds across a restart", async () => {
    const opened = openDesk([HOST, CLEANER], "0");
    await opened.desk.markOptedOut(CLEANER);
    const again = opened.reopen();
    await setUp(again, { groupChat: "cleaner-only" });
    expect(to(opened.sms, CLEANER)).toEqual([]);
  });

  it("an unused host text shows in check_now, without its digits, and wakes the routine", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.noteUnusedHostText(`guests left, code ${DOOR_CODE}`);
    const check = JSON.stringify(ok(await desk.checkNow()));
    expect(check).toContain("The host texted the line");
    expect(check).toContain("Ask them in chat which property.");
    expect(check).not.toContain(DOOR_CODE);
  });

  it("markRoutineConnected counts the account's routine for this property", async () => {
    const { desk, env } = openDesk([HOST, CLEANER], "0");
    env.CLEANER_CORE_PRIMARY_CONNECTION = "grant-grok";
    expect(await withCaller({ assistant: "grok", connectionId: "grant-grok" }, async () => desk.routineConnectionIds())).toEqual([]);
    desk.markRoutineConnected(["grant-grok"]);
    expect(desk.routineConnectionIds()).toEqual(["grant-grok"]);
  });

  it("with two properties, texts to the host start with the label", async () => {
    const { desk, sms, env } = openDesk([HOST, CLEANER], "0");
    asOneOfTwo(env);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "stop-host", from: HOST, text: "STOP" });
    const host = to(sms, HOST);
    expect(host.length).toBeGreaterThan(0);
    for (const body of host) expect(body.startsWith(`${LABEL}: `)).toBe(true);
  });

  it("with two properties, a text to the cleaner one-to-one does not carry the label", async () => {
    const { desk, sms, env } = openDesk([HOST, CLEANER], "0");
    asOneOfTwo(env);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    const cleaner = to(sms, CLEANER);
    expect(cleaner.length).toBeGreaterThan(0);
    for (const body of cleaner) expect(body.startsWith(`${LABEL}:`)).toBe(false);
  });

  it("with two properties, group texts start with the label", async () => {
    const opened = await liveGroupAsOneOfTwo();
    expect(opened.groups.posts.length).toBeGreaterThan(0);
    for (const post of opened.groups.posts) expect(post.body.startsWith(`${LABEL}: `)).toBe(true);
  });

  it("with one property, texts are unchanged", async () => {
    const { desk, sms } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "stop-host", from: HOST, text: "STOP" });
    for (const body of sms.sent.map((s) => s.body)) expect(body.startsWith(`${LABEL}:`)).toBe(false);
  });
});

/** liveGroup, with the env marked as one of two properties before setup. */
async function liveGroupAsOneOfTwo() {
  const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
  asOneOfTwo(opened.env);
  await setUp(opened.desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
  await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await opened.desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  await opened.desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
  return opened;
}

void liveGroup;
