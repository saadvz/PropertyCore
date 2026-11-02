import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import type { Reservation } from "../src/domain/model";
import { LLMIntentInterpreter, type LanguageModel } from "../src/intent";
import type { InterpretContext } from "../src/intent/model";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import {
  addInboundModelMs,
  inboundSmsLine,
  intentModelTimeoutMs,
  runInboundSmsTiming,
  smsCorrelationId,
  timeOutboundSend,
} from "../src/messaging/inboundTiming";
import { PropertyWorkspace } from "../src/setup/workspace";
import { InMemoryStore, type CollectionName } from "../src/storage/Store";
import { handleVisitorText } from "../src/visitor/conversation";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { VisitorDemoRegistry, VisitorDemoSession } from "../src/visitor/session";
import { VerificationLinks } from "../src/visitor/verificationLinks";

const MONDAY_7AM = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York").getTime();
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function phases(lines: string[]): string[] {
  return lines.map((line) => /phase=(\S+)/.exec(line)?.[1] ?? "");
}

describe("inbound sms timing", () => {
  it("logs one correlation id, and finishes processing before the first send", async () => {
    const lines: string[] = [];
    const correlation = smsCorrelationId("sendblue", "SM123");
    await runInboundSmsTiming(correlation, (line) => lines.push(line), async () => {
      await timeOutboundSend(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return "sent";
      });
      await timeOutboundSend(async () => "again");
    });
    expect(phases(lines)).toEqual([
      "webhook_received",
      "processing_finished",
      "send_requested",
      "send_returned",
      "send_requested",
      "send_returned",
      "done",
    ]);
    expect(lines.filter((line) => line.includes("phase=processing_finished"))).toHaveLength(1);
    expect(lines.every((line) => line.startsWith(`inbound sms correlation=${correlation} `))).toBe(true);
    const returned = lines.find((line) => line.includes("phase=send_returned"))!;
    expect(returned).toMatch(/sendMs=[1-9]/);
    expect(returned).toMatch(/tourCoreMs=\d+/);
    expect(await timeOutboundSend(async () => "plain")).toBe("plain");
  });

  it("still logs processing_finished when nothing is sent", async () => {
    const lines: string[] = [];
    await runInboundSmsTiming("sms:test:none", (line) => lines.push(line), async () => undefined);
    expect(phases(lines)).toEqual(["webhook_received", "processing_finished", "done"]);
    const done = lines.at(-1)!;
    expect(done).toMatch(/modelMs=0 sendMs=0/);
    expect(Number(/tourCoreMs=(\d+)/.exec(done)?.[1])).toBe(Number(/elapsedMs=(\d+)/.exec(done)?.[1]));
  });

  it("caps a hung intent model at 6s and counts that wait", async () => {
    expect(intentModelTimeoutMs()).toBe(6000);
    expect(intentModelTimeoutMs(undefined)).toBe(6000);
    expect(intentModelTimeoutMs(10_000)).toBe(6000);
    expect(intentModelTimeoutMs(1000)).toBe(1000);
    expect(intentModelTimeoutMs(0)).toBe(6000);

    const lines: string[] = [];
    const model: LanguageModel = {
      name: "slow",
      async complete() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("model down");
      },
    };
    const ctx: InterpretContext = {
      message: "hmm",
      step: "touring",
      units: [{ name: "Unit 101" }],
      timeChoices: [],
      remainingStops: [],
      doors: [],
    };
    await runInboundSmsTiming("sms:test:model", (line) => lines.push(line), async () => {
      await expect(new LLMIntentInterpreter(model, { timeoutMs: 10_000 }).interpret(ctx)).rejects.toThrow(/model down/);
    });
    expect(lines.at(-1)).toMatch(/modelMs=[1-9]/);
    expect(inboundSmsLine({ correlation: "sms:test:model", elapsedMs: 40, modelMs: 20, sendMs: 15 }, "done")).toBe(
      "inbound sms correlation=sms:test:model phase=done elapsedMs=40 modelMs=20 sendMs=15 tourCoreMs=25",
    );
    addInboundModelMs(50);
  });
});

describe("release of unconfirmed operator tours", () => {
  function harness() {
    const root = mkdtempSync(join(tmpdir(), "tourcore-release-"));
    roots.push(root);
    const workspace = new PropertyWorkspace(root);
    const registry = new VisitorDemoRegistry();
    const saved: string[] = [];
    const router = new MessagingConversations({
      workspace,
      registry,
      transport: () => new DemoMessagingAdapter(() => undefined, "MESSAGING"),
      links: new VerificationLinks({ baseUrl: () => undefined }),
      realNow: () => MONDAY_7AM,
      onSaved: (session) => saved.push(session.id),
    });
    return { registry, router, saved };
  }

  function session(store: InMemoryStore, tourId: string, kind: "messaging" | "visitor-demo" = "messaging") {
    return new VisitorDemoSession("prop_100_alfred_way", loadConfig(), tourId, {
      realNow: () => MONDAY_7AM,
      store,
      kind,
      transport: new DemoMessagingAdapter(() => undefined, "MESSAGING"),
    });
  }

  function countLists(store: InMemoryStore) {
    const counts = { reservations: 0, messages: 0, any: 0 };
    const orig = store.list.bind(store);
    store.list = (async (collection: CollectionName) => {
      counts.any += 1;
      if (collection === "reservations") counts.reservations += 1;
      if (collection === "messages") counts.messages += 1;
      return orig(collection);
    }) as InMemoryStore["list"];
    return counts;
  }

  it("scans a shared store once and skips the save when nobody is waiting", async () => {
    const { registry, router, saved } = harness();
    const shared = new InMemoryStore();
    const other = new InMemoryStore();
    for (let i = 0; i < 40; i++) {
      await shared.put("reservations", {
        id: `res_${i}`,
        propertyId: "prop_100_alfred_way",
        prospectId: "prs",
        unitId: "apt_101",
        routeId: "route",
        allowedRoute: ["door"],
        status: "RESERVED",
        createdAt: new Date(MONDAY_7AM).toISOString(),
        updatedAt: new Date(MONDAY_7AM).toISOString(),
      } as Reservation);
    }
    const sessions = [session(shared, "tour_a"), session(shared, "tour_b"), session(shared, "tour_c"), session(shared, "tour_d")];
    for (const item of sessions) registry.add(item);
    registry.add(session(other, "tour_browser", "visitor-demo"));

    const before = countLists(shared);
    const started = Date.now();
    for (const item of sessions) {
      await item.releaseUnconfirmedOperatorTour();
      await item.record();
    }
    const beforeMs = Date.now() - started;
    const beforeCounts = { ...before };
    before.reservations = 0;
    before.messages = 0;
    before.any = 0;

    const afterStarted = Date.now();
    await router.releaseUnconfirmed();
    const afterMs = Date.now() - afterStarted;

    expect(beforeCounts.reservations).toBeGreaterThan(before.reservations);
    expect(beforeCounts.messages).toBeGreaterThan(before.messages);
    expect(before.reservations).toBe(1);
    expect(before.messages).toBe(0);
    expect(before.any).toBe(1);
    expect(saved).toEqual([]);
    expect(beforeMs).toBeGreaterThanOrEqual(0);
    expect(afterMs).toBeLessThan(1000);
  });

  it("clears a stale confirm prompt and still saves a live one", async () => {
    const { registry, router, saved } = harness();
    const store = new InMemoryStore();
    const confirmBy = new Date(MONDAY_7AM + 86_400_000).toISOString();
    await store.put("reservations", {
      id: "res_hold",
      propertyId: "prop_100_alfred_way",
      prospectId: "prs",
      unitId: "apt_101",
      routeId: "route",
      allowedRoute: ["door"],
      status: "RESERVED",
      awaitingVisitorConfirm: { kind: "OPERATOR_SCHEDULED", confirmBy },
      createdAt: new Date(MONDAY_7AM).toISOString(),
      updatedAt: new Date(MONDAY_7AM).toISOString(),
    } as Reservation);

    const stale = session(store, "tour_stale");
    stale.expect("intro", { kind: "confirm-operator-tour", confirmBy });
    const live = session(store, "tour_live");
    live.reservationId = "res_hold";
    live.expect("intro", { kind: "confirm-operator-tour", confirmBy });
    registry.add(stale);
    registry.add(live);

    let scans = 0;
    for (const item of [stale, live]) {
      const orig = item.core.releaseExpiredOperatorScheduled.bind(item.core);
      item.core.releaseExpiredOperatorScheduled = async () => {
        scans += 1;
        return orig();
      };
    }
    await router.releaseUnconfirmed();
    expect(scans).toBe(1);
    expect(stale.pendingClarification).toBeUndefined();
    expect(live.pendingClarification?.awaiting).toEqual({ kind: "confirm-operator-tour", confirmBy });
    expect(saved.sort()).toEqual([live.id, stale.id].sort());
  });
});

describe("booking texts stay inside the reply budget", () => {
  it("books from the texting YES without a second consent question", async () => {
    const sent: string[] = [];
    const transport = new DemoMessagingAdapter((line) => sent.push(line), "MESSAGING");
    const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "tour_time", {
      realNow: () => MONDAY_7AM,
      transport,
      kind: "messaging",
    });
    const steps = ["TOUR", "YES", "1", "2:00 pm"];
    const timings: { step: string; elapsedMs: number; tourCoreMs: number; sendMs: number }[] = [];
    for (const step of steps) {
      const lines: string[] = [];
      await runInboundSmsTiming(smsCorrelationId("demo", step), (line) => lines.push(line), () =>
        handleVisitorText(session, "+15550102000", step, { provider: "test", providerMessageId: step }),
      );
      const done = lines.at(-1)!;
      timings.push({
        step,
        elapsedMs: Number(/elapsedMs=(\d+)/.exec(done)?.[1]),
        tourCoreMs: Number(/tourCoreMs=(\d+)/.exec(done)?.[1]),
        sendMs: Number(/sendMs=(\d+)/.exec(done)?.[1]),
      });
      expect(phases(lines)[0]).toBe("webhook_received");
      expect(phases(lines)).toContain("processing_finished");
      expect(phases(lines).indexOf("processing_finished")).toBeLessThan(phases(lines).indexOf("send_requested"));
      expect(Number(/elapsedMs=(\d+)/.exec(done)?.[1])).toBeLessThan(10_000);
    }
    const booked = sent.join("\n");
    expect(booked).toContain("Great, you're booked for");
    expect(booked).toContain("please fill out this short form");
    expect(booked).not.toContain("Is it OK if I text you");
    expect(timings.every((step) => step.tourCoreMs < 10_000 && step.sendMs <= step.elapsedMs)).toBe(true);
  });
});
