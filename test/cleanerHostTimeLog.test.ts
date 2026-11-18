import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core";

/**
 * #238 follow-up: when a stay's dates move, Cleaner Core clears the host's cleaning times and asks again.
 * The cleared times are kept, with the checkout they were given for, so the hours log still has the host's
 * work. Made-up address and 555 numbers.
 */

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const NOW = "2026-10-14T15:00:00.000Z";
const MONDAY_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.";
const ANITA = "stay-anita@guesty.com";

const feed = (name: string) => readFileSync(join("src/cleaner-core/fixtures", name), "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(dir: string, sent: CleanerText[] = []) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    consented: true,
    sink: { send: (text: CleanerText) => void sent.push(text) },
    now: () => new Date(NOW),
    dataDir: dir,
  });
}

/** The host gives 1:00 PM for checkout and keeps the check-in, then the stay moves a day. */
async function movedAfterTimes() {
  const dir = mkdtempSync(join(tmpdir(), "cleaner-times-"));
  dirs.push(dir);
  const sent: CleanerText[] = [];
  const job = open(dir, sent);
  await job.pollFeed(feed("guesty-lite-scratch.ics"));
  await job.receive({ id: "t1", from: OWNER, text: "1:00 PM" });
  await job.receive({ id: "t2", from: OWNER, text: "YES" });
  await job.receive({ id: "t3", from: OWNER, text: "YES" });
  await job.pollFeed(feed("guesty-lite-date-moved.ics"));
  const stored = () => JSON.parse(readFileSync(join(dir, "cleaner-core.json"), "utf8")) as Record<string, unknown> & { hostFacts: { jobId: string; field: string }[]; clearedHostFacts?: Record<string, unknown>[] };
  return { dir, job, sent, stored };
}

describe("cleaning times a moved date clears are kept (#238 follow-up)", () => {
  it("keeps each cleared time with the checkout it was given for", async () => {
    const { stored } = await movedAfterTimes();
    const file = stored();
    expect(file.hostFacts.filter((fact) => fact.jobId === ANITA)).toEqual([]);
    expect(file.clearedHostFacts).toEqual([
      { jobId: ANITA, field: "checkout", version: 1, minutes: 780, at: NOW, checkoutDate: "2026-10-18" },
      { jobId: ANITA, field: "checkin", version: 1, minutes: 960, at: NOW, checkoutDate: "2026-10-18" },
    ]);
  });

  it("still asks the host for the new time, as before", async () => {
    const { sent, job } = await movedAfterTimes();
    expect(sent.at(-1)?.body).toBe(MONDAY_Q);
    expect(job.jobs().find((item) => item.id === ANITA)).toMatchObject({ checkoutDate: "2026-10-19", checkoutTime: null });
  });

  it("keeps the cleared times across a restart", async () => {
    const { dir, stored } = await movedAfterTimes();
    const before = stored().clearedHostFacts;
    expect(before).toHaveLength(2);
    const again = open(dir);
    await again.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(stored().clearedHostFacts).toEqual(before);
  });

  it("an older store with none loads and saves", async () => {
    const { dir, stored } = await movedAfterTimes();
    const file = stored();
    delete file.clearedHostFacts;
    writeFileSync(join(dir, "cleaner-core.json"), JSON.stringify(file));
    const again = open(dir);
    await again.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(stored().clearedHostFacts ?? []).toEqual([]);
  });

  it("keeps at most 200, the oldest dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-times-"));
    dirs.push(dir);
    const job = open(dir);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "t1", from: OWNER, text: "1:00 PM" });
    const path = join(dir, "cleaner-core.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    file.clearedHostFacts = Array.from({ length: 200 }, (_, i) => ({ jobId: `old_${i}`, field: "checkout", version: 1, minutes: 660, at: NOW, checkoutDate: "2026-09-01" }));
    writeFileSync(path, JSON.stringify(file));
    await open(dir).pollFeed(feed("guesty-lite-date-moved.ics"));
    const kept = (JSON.parse(readFileSync(path, "utf8")) as { clearedHostFacts: Record<string, unknown>[] }).clearedHostFacts;
    expect(kept).toHaveLength(200);
    expect(kept[0]).toMatchObject({ jobId: "old_1" });
    expect(kept.at(-1)).toMatchObject({ jobId: ANITA, field: "checkout", minutes: 780, checkoutDate: "2026-10-18" });
  });
});
