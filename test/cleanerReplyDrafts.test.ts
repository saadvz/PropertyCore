import { afterEach, describe, expect, it } from "vitest";
import { setCleanerAlertFetch } from "../src/cleaner-core/liveDesk";
import { CLEANER, DOOR_CODE, HOST } from "./wiringProof";
import { cleanupDesks, liveGroup, ok, type OutMessage } from "./cleanerDeskHarness";

afterEach(() => cleanupDesks());

describe("Reply state in check_now", () => {
  it("marks a cleaner question answered by the host's group reply, with the question as earlier context", async () => {
    const { desk } = await liveGroup();
    ok(await desk.checkNow());
    await desk.inbound({ id: "q", from: CLEANER, text: "Where are the spare towels?", channel: "group" });
    expect((ok(await desk.checkNow()).messages as OutMessage[]).at(-1)).toMatchObject({ text: "Where are the spare towels?", reply: "open" });
    await desk.inbound({ id: "h", from: HOST, text: "Hall closet, top shelf", channel: "group" });
    const now = ok(await desk.checkNow());
    expect(now.messages).toEqual([expect.objectContaining({ from: "host", text: "Hall closet, top shelf" })]);
    expect((now.messages as OutMessage[])[0]).not.toHaveProperty("reply");
    expect(now.earlier).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Where are the spare towels?", reply: "answered", by: "group" })]));
  });

  it("leaves earlier out when nothing is new", async () => {
    const { desk } = await liveGroup();
    await desk.inbound({ id: "q", from: CLEANER, text: "Where are the spare towels?", channel: "group" });
    ok(await desk.checkNow());
    expect(ok(await desk.checkNow())).not.toHaveProperty("earlier");
  });

  it("wakes the routine for the host's own group text", async () => {
    const posts: string[] = [];
    const { desk } = await liveGroup();
    setCleanerAlertFetch(async (_url, init) => {
      posts.push(init.body);
      return { status: 200 };
    });
    await desk.drainAlerts();
    const started = posts.length;
    await desk.inbound({ id: "h", from: HOST, text: "Hall closet, top shelf", channel: "group" });
    await desk.drainAlerts();
    expect(posts).toHaveLength(started + 1);
  });

  it("does nothing in Cleaner Core for a host group text that sounds like a decision", async () => {
    const { desk, sms, groups } = await liveGroup();
    const before = JSON.stringify(ok(await desk.getTurns()));
    const sentBefore = sms.sent.length + groups.posts.length;
    const decisions: [string, string][] = [
      ["d1", "Don't come today"],
      ["d2", "Come at 2 instead"],
      ["d3", "Guests are out"],
    ];
    for (const [id, text] of decisions)
      await desk.inbound({ id, from: HOST, text, channel: "group" });
    expect(JSON.stringify(ok(await desk.getTurns()))).toBe(before);
    expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
    expect([...sms.sent.map((s) => s.body), ...groups.posts.map((p) => p.body)].some((b) => b.includes(DOOR_CODE))).toBe(false);
  });
});
