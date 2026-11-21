import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CleanerCore } from "../src/cleaner-core/core";
import { setLateCheckout, type LateCheckoutDesk } from "../src/cleaner-core/lateCheckout";
import type { LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { setStayCodeHook } from "../src/cleaner-core/stayCodeHook";
import { readGuestMessages } from "../src/guest-messages/store";
import { deskFeatures } from "./featureEnv";
import { PIN_KEY, cleanupDesks, liveGroup, liveOneToOne, ok, refused } from "./cleanerDeskHarness";

/**
 * A guest's late checkout, on the host's yes (#242). The harness calendar has stay-a (Oct 14 to 18) and
 * stay-b (Oct 18 to 22); stay-a's checkout is 11:00 AM and the next check-in 4:00 PM. 555 numbers only.
 */

const hookCalls: string[] = [];
afterEach(() => {
  setStayCodeHook(undefined);
  hookCalls.length = 0;
  cleanupDesks();
});

async function opened(flag = true, open: typeof liveOneToOne = liveOneToOne) {
  setStayCodeHook({
    async windowMoved(input) {
      hookCalls.push(input.jobId);
    },
    async stayCancelled() {},
  });
  const desk = await open();
  if (flag) Object.assign(desk.env, deskFeatures("guest-messages"));
  return desk;
}

async function turn(desk: LiveDesk, checkoutDate: string) {
  const turns = ok(await desk.getTurns()).turns as { checkoutDate: string; checkoutTime: string | null; status: string }[];
  return turns.find((item) => item.checkoutDate === checkoutDate && item.status !== "canceled")!;
}

async function listed(desk: LiveDesk): Promise<string[]> {
  const reply = (await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method: "tools/list" }, PIN_KEY)) as { body: { result: { tools: { name: string }[] } } };
  return reply.body.result.tools.map((tool) => tool.name);
}

describe("late checkout", () => {
  it("isn't listed or answered without the account's guest-messages switch", async () => {
    const { desk } = await opened(false);
    expect(await listed(desk)).not.toContain("set_late_checkout");
    expect(refused(await desk.setLateCheckout({ checkout: "2026-10-18", time: "13:00" }, PIN_KEY)).error).toContain("isn't available");
  });

  it("previews the change and a code, then moves checkout with the host's yes", async () => {
    const { desk, root } = await opened();
    expect(await listed(desk)).toContain("set_late_checkout");
    const preview = ok(await desk.setLateCheckout({ checkout: "2026-10-18", time: "13:00" }, PIN_KEY));
    expect(String(preview.next)).toContain("1:00 PM");
    expect(String(preview.next)).toContain("11:00 AM");
    expect(String(preview.next)).toContain("3 hours before the next check-in at 4:00 PM");
    expect((await turn(desk, "2026-10-18")).checkoutTime).not.toBe("1:00 PM");

    const code = (preview.confirmation as { code: string }).code;
    const done = ok(await desk.setLateCheckout({ checkout: "2026-10-18", time: "13:00", confirmation: code }, PIN_KEY));
    expect(done).toMatchObject({ applied: true, checkout: "2026-10-18", time: "13:00" });
    expect((await turn(desk, "2026-10-18")).checkoutTime).toBe("1:00 PM");
    expect(hookCalls).toContain("stay-a");
    expect(readGuestMessages(root)).toContainEqual(expect.objectContaining({ event: "late-checkout", lateCheckout: { checkout: "2026-10-18", time: "13:00" } }));
  });

  it("refuses a time that runs into the next check-in", async () => {
    const { desk } = await opened();
    const before = (await turn(desk, "2026-10-18")).checkoutTime;
    refused(await desk.setLateCheckout({ checkout: "2026-10-18", time: "16:00" }, PIN_KEY));
    refused(await desk.setLateCheckout({ checkout: "2026-10-18", time: "17:30" }, PIN_KEY));
    expect((await turn(desk, "2026-10-18")).checkoutTime).toBe(before);
  });

  it("refuses a day with no cleaning, and a code for another time", async () => {
    const { desk } = await opened();
    refused(await desk.setLateCheckout({ checkout: "2026-10-25", time: "13:00" }, PIN_KEY));
    const code = (ok(await desk.setLateCheckout({ checkout: "2026-10-18", time: "13:00" }, PIN_KEY)).confirmation as { code: string }).code;
    refused(await desk.setLateCheckout({ checkout: "2026-10-18", time: "14:00", confirmation: code }, PIN_KEY));
    expect((await turn(desk, "2026-10-18")).checkoutTime).not.toBe("2:00 PM");
  });

  it("leaves a cleaning alone once its door code went out", async () => {
    const { desk } = await opened(true, () => liveGroup());
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    const error = refused(await desk.setLateCheckout({ checkout: "2026-10-18", time: "13:00" }, PIN_KEY)).error;
    expect(error).toMatch(/door code|under way|already/i);
  });
});

describe("late checkout's guards, on a stand-in engine", () => {
  type Job = { id: string; status: string; checkoutDate: string; checkoutTime: string | null; nextCheckInDate: string | null; nextCheckInTime: string | null };
  function standIn(job: Partial<Job> = {}, usual: { checkout?: string; checkIn?: string } = { checkout: "11:00", checkIn: "16:00" }) {
    const row: Job = { id: "job-1", status: "scheduled", checkoutDate: "2026-10-18", checkoutTime: "11:00 AM", nextCheckInDate: "2026-10-18", nextCheckInTime: "4:00 PM", ...job };
    const moved: number[] = [];
    const engine = { jobs: () => [row], setJobTimes: async (input: { checkout: number }) => (moved.push(input.checkout), { applied: true }) } as unknown as CleanerCore;
    const desk: LateCheckoutDesk = {
      root: mkdtempSync(join(tmpdir(), "late-checkout-")),
      now: () => new Date("2026-10-14T15:00:00.000Z"),
      engine: () => engine,
      timeZone: () => "America/New_York",
      usualCheckout: () => usual.checkout,
      usualCheckIn: () => usual.checkIn,
      propertyLabel: () => "Harbor Cottage",
      cleanerName: () => "Rosa",
      issueApproval: (_target, _fingerprint, next) => ({ code: "ok-code", question: next }),
      redeem: () => true,
    };
    return { desk, moved };
  }

  it("uses the usual check-in time when the next check-in has none yet", async () => {
    const { desk } = standIn({ nextCheckInTime: null });
    const reply = await setLateCheckout(desk, { checkout: "2026-10-18", time: "17:00" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toContain("4:00 PM");
  });

  it("refuses a time at or before the current checkout", async () => {
    const { desk, moved } = standIn();
    for (const time of ["01:00", "11:00"]) {
      const reply = await setLateCheckout(desk, { checkout: "2026-10-18", time, confirmation: "ok-code" });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error).toContain("later");
    }
    expect(moved).toEqual([]);
  });

  it("names the property in the preview", async () => {
    const reply = await setLateCheckout(standIn().desk, { checkout: "2026-10-18", time: "13:00" });
    if (!reply.ok) throw new Error(reply.error);
    expect(String(reply.result.next)).toContain("Harbor Cottage");
  });
});
