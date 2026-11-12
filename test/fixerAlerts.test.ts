import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { GrokRoutineWebhookSink } from "../src/alerts/operatorEvents";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { readFixer, writeFixer } from "../src/fixer-core/store";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { FileRuntimeStore } from "../src/storage/runtimeStore";

/** A Fixer-only property wakes the account's alerts routine. Made-up pros, 555 numbers, example.com hooks. */

const NOW = new Date("2026-11-12T15:00:00.000Z");
const A = "prp_aaaaaaaaaa";
const HOST = "+15555550100";
const JOE = "+15555550142";
const ROUTINE = { url: "https://example.com/hook", key: "made-up-key-123" };

const dirs: string[] = [];
afterEach(() => {
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const text = (body: string) => ({ id: `m${++n}`, from: JOE, text: body });

/** An active Fixer desk with Joe saved, and a routine webhook that records each POST (or fails). */
async function setup(extra: Partial<FixerDeps> & { failing?: boolean } = {}) {
  const account = mkdtempSync(join(tmpdir(), "fixer-alerts-acct-"));
  const root = mkdtempSync(join(tmpdir(), "fixer-alerts-prop-"));
  dirs.push(account, root);
  hubFor(root, { now: () => NOW }).saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const people = () => peopleFor(account, { now: () => NOW });
  people().savePropertyPeople(A, HOST, []);
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const notes: string[] = [];
  const desk = fixerDeskFor(root, {
    now: () => NOW,
    propertyId: A,
    people,
    routine: () => ROUTINE,
    alertFetch: async (url, init) => {
      posts.push({ url, headers: init.headers, body: init.body });
      return { status: extra.failing ? 500 : 200 };
    },
    notifyHost: async (_id, note) => {
      notes.push(note);
      return true;
    },
    ...extra,
  });
  await desk.savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE } });
  const file = readFixer(root);
  file.settings.activatedAt = NOW.toISOString();
  writeFixer(root, file);
  return { root, desk, posts, notes };
}

const outbox = (root: string) => new OperatorEventOutbox(new FileRuntimeStore(join(root, "fixer-alerts")), () => new GrokRoutineWebhookSink({ url: () => undefined, key: () => undefined }));

describe("Fixer Core's alerts", () => {
  it("wakes the routine with repairs.update holding only four fields", async () => {
    const w = await setup();
    await w.desk.proInbound(text("Running 10 minutes late"));
    await vi.waitFor(() => expect(w.posts).toHaveLength(1));
    const sent = JSON.parse(w.posts[0]!.body);
    expect(Object.keys(sent).sort()).toEqual(["eventId", "eventType", "occurredAt", "schemaVersion"]);
    expect(sent.eventType).toBe("repairs.update");
    expect(w.posts[0]!.url).toBe(ROUTINE.url);
    expect(w.posts[0]!.body).not.toContain("+1555");
    expect(w.posts[0]!.body).not.toContain("late");
  });

  it("three notes make one pending wake-up", async () => {
    const w = await setup({ failing: true });
    for (const words of ["one", "two", "three"]) await w.desk.proInbound(text(`Note ${words}`));
    await vi.waitFor(() => expect(w.posts.length).toBeGreaterThan(0));
    const pending = outbox(w.root).records().filter((r) => r.status === "pending" && r.event.eventType === "repairs.update");
    expect(pending).toHaveLength(1);
  });

  it("with Cleaner Core on, notes go through Cleaner Core and nothing is sent", async () => {
    const w = await setup({ cleaningOn: () => true });
    await w.desk.proInbound(text("Running late"));
    expect(w.notes).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.posts).toEqual([]);
    expect(outbox(w.root).records()).toEqual([]);
  });

  it("with no routine, the note waits in check_fixes news and nothing is sent", async () => {
    const w = await setup({ routine: () => undefined });
    await w.desk.proInbound(text("Running late"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.posts).toEqual([]);
    expect(outbox(w.root).records()).toEqual([]);
    expect(readFixer(w.root).news?.some((item) => item.text.includes("Running late"))).toBe(true);
  });
});
