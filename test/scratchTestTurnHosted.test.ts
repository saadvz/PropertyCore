import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import type { MultiTenantApp } from "./multiTenantHarness";
import { CLEANER, LANE, sharedAccount } from "./sharedHarness";

/**
 * A Scratch test turnover on the shared service, after the cleaner already said YES (23 Nov Grok run): the
 * reset keeps the cleaner's YES, so the next test turnover has no opt-in to wait for. Its offer goes at once,
 * even in quiet hours, and add_test_turn says what went. 555 numbers and the made-up Scratch code only;
 * Scratch texts stay in the outbox.
 */

const OFFER_WENT = "Test turnover saved. The cleaning offer went out.";
const SLOW = { timeout: 90_000 };
let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function laneWithGroup() {
  const s = await sharedAccount({ env: { CLEANER_CORE_SCRATCH_TOOLS: "1", CLEANER_CORE_GROUP_CHAT: "1" } });
  open = s.m;
  const id = await s.liveProperty("Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" });
  const lines = async () => ((await s.call("read_outbox", { property: id })).structured?.lines as string[]) ?? [];
  return { s, id, lines };
}

describe("a test turnover after the cleaner already said YES", () => {
  it("offers the cleaning at once, even in quiet hours, and says so", SLOW, async () => {
    const { s, id, lines } = await laneWithGroup();
    // Quiet hours cover the harness's frozen morning, as the overnight ones covered 1 AM on the 23 Nov run.
    await s.tool("save_schedule", { property: id, quietFrom: "06:00", quietUntil: "23:00" });
    await s.tool("reset_scratch", { property: id });
    await s.tool("add_test_turn", { property: id, checkout: "10:00 AM", checkIn: "9:00 AM" });
    await s.tool("send_test_text", { property: id, from: CLEANER, text: "YES" });
    await s.tool("reset_scratch", { property: id });
    const again = await s.tool("add_test_turn", { property: id, checkout: "10:00 AM", checkIn: "9:00 AM" });
    expect(again.structured?.next).toBe(OFFER_WENT);
    expect((await lines()).filter((line) => line.startsWith("Cleaning offer"))).toEqual(["Cleaning offer to the group: sent."]);
  });

  it("a NO to that offer is a decline, with the host's note", SLOW, async () => {
    const { s, id, lines } = await laneWithGroup();
    await s.tool("save_schedule", { property: id, quietFrom: "06:00", quietUntil: "23:00" });
    await s.tool("reset_scratch", { property: id });
    await s.tool("add_test_turn", { property: id, checkout: "10:00 AM", checkIn: "9:00 AM" });
    await s.tool("send_test_text", { property: id, from: CLEANER, text: "YES" });
    await s.tool("reset_scratch", { property: id });
    await s.tool("add_test_turn", { property: id, checkout: "10:00 AM", checkIn: "9:00 AM" });
    await s.tool("send_test_text", { property: id, from: CLEANER, text: "NO" });
    expect((await lines()).some((line) => line.startsWith("Decline note"))).toBe(true);
    const check = JSON.stringify((await s.tool("check_now", { property: id })).structured);
    expect(check).toContain("whoever cleans");
  });
});
