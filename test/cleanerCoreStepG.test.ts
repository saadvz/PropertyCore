import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CALENDAR_URL_REFUSAL, calendarUrlAllowed, openCleanerCore, readPublicCalendar, REVIEW_KINDS, reviewAlert, runSmoke, scratchTenant, type CleanerText, type ReviewKind } from "../src/cleaner-core";

function requiredTenant(id: "scratch-lane" | "scratch-court") {
  const tenant = scratchTenant(id);
  if (!tenant) throw new Error(`${id} is missing.`);
  return tenant;
}

const lane = requiredTenant("scratch-lane");
const court = requiredTenant("scratch-court");

const ADDRESS = lane.property.address;
const OWNER = lane.ownerPhone;
const CLEANER = lane.cleanerPhone;
const CHECKOUT_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.";
const OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const OFFER_2PM = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 2:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const STALE_ALERT = reviewAlert("stale-source", ADDRESS);
const UNCERTAIN_ALERT = reviewAlert("uncertain-sms", ADDRESS, { day: "Sunday, Oct 18", about: "offer" });
const EXPOSURE_ALERT = reviewAlert("possible-code-exposure", ADDRESS);
const FRESH = "2026-10-14T15:00:00.000Z";
const EXACT = "2026-10-14T18:00:00.000Z";
const STALE = "2026-10-14T18:00:00.001Z";

const feed = (name: string) => readFileSync(join("src/cleaner-core/fixtures", name), "utf8");

afterEach(() => {
  delete process.env.CLEANER_CORE_ENABLED;
});

function sink() {
  const sent: CleanerText[] = [];
  return { sent, send(text: CleanerText) { sent.push(text); } };
}

function engine(box: ReturnType<typeof sink>, clock: { at: string }, extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
  return openCleanerCore({
    enabled: true,
    tenantId: lane.id,
    property: lane.property,
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    consented: true,
    sink: box,
    now: () => new Date(clock.at),
    watchFreshness: true,
    ...extra,
  });
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("step G safety gates", () => {
  const HOLD = `The cleaning at ${ADDRESS} is waiting for the cleaner to reply YES.`;

  it("holds the Guesty Lite feed, the smoke default, and a replay when no cleaner has opted in", async () => {
    const box = sink();
    const clock = { at: FRESH };
    const job = engine(box, clock, { watchFreshness: false });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    await job.receive({ id: "again", from: OWNER, text: "YES" });
    const replayed = await job.replay();
    expect(box.sent.filter((text) => text.kind === "offer" || text.body.startsWith("Turnover at"))).toEqual([]);
    expect(box.sent.filter((text) => text.body === HOLD)).toEqual([{ to: OWNER, body: HOLD, kind: "held" }]);
    expect(replayed.sent).toEqual([]);
    expect(job.jobs().some((item) => item.status === "offered")).toBe(false);

    const smoke = await runSmoke({ CLEANER_CORE_ENABLED: "1" });
    expect(smoke.sent.filter((text) => text.kind === "offer" || text.body.startsWith("Turnover at"))).toEqual([]);
    expect(smoke.sent.filter((text) => text.body === HOLD)).toEqual([{ to: OWNER, body: HOLD, kind: "held" }]);
    expect(smoke.jobs?.some((item) => item.status === "offered")).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "cleaner-no-cleaner-"));
    try {
      const first = await runSmoke({ CLEANER_CORE_ENABLED: "1" }, undefined, { dataDir: dir });
      const second = await runSmoke({ CLEANER_CORE_ENABLED: "1" }, undefined, { dataDir: dir, ops: [{ type: "replay" }] });
      expect(first.sent.filter((text) => text.kind === "offer")).toEqual([]);
      expect(first.sent.filter((text) => text.body === HOLD)).toEqual([{ to: OWNER, body: HOLD, kind: "held" }]);
      expect(second.sent).toEqual([]);
      expect(second.outbox?.filter((item) => item.body === HOLD && item.status === "sent")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds the cleaning offer only inside the cleaner text choke point", () => {
    const needle = "Reply YES to schedule it, or STOP to opt out.";
    const hits = sourceFiles("src").filter((path) => readFileSync(path, "utf8").includes(needle)).sort();
    expect(hits).toEqual(["src/cleaner-core/cleanerTexts.ts"]);
  });

  it("sends nothing when the flag is off, including a stale feed and a review", async () => {
    const box = sink();
    const clock = { at: FRESH };
    const job = openCleanerCore({
      enabled: false,
      tenantId: lane.id,
      property: lane.property,
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      consented: true,
      sink: box,
      now: () => new Date(clock.at),
      watchFreshness: true,
    });
    const polled = await job.pollFeed(feed("guesty-lite-scratch.ics"));
    const review = await job.fileReview("stale-source");
    expect(polled.sent).toEqual([]);
    expect(review.sent).toEqual([]);
    expect(box.sent).toEqual([]);
  });

  it("holds a new offer once the feed is past three missed hourly polls, alerts the host once, and sends the offer after a fresh read", async () => {
    const exact = sink();
    const exactClock = { at: FRESH };
    const onTime = engine(exact, exactClock, { pin: lane.pin, hostName: lane.hostName });
    await onTime.pollFeed(feed("guesty-lite-scratch.ics"));
    await onTime.receive({ id: "opt", from: CLEANER, text: "YES" });
    await onTime.receive({ id: "checkout", from: OWNER, text: "YES" });
    exactClock.at = EXACT;
    const still = await onTime.receive({ id: "checkin", from: OWNER, text: "YES" });
    expect(still.sent).toEqual([{ to: CLEANER, body: OFFER, kind: "offer" }]);

    const box = sink();
    const clock = { at: FRESH };
    const job = engine(box, clock, { pin: lane.pin, hostName: lane.hostName });
    const opened = await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(opened.sent.map((text) => text.kind)).toEqual(["host-checkout", "opt-in"]);
    await job.receive({ id: "opt", from: CLEANER, text: "YES" });
    await job.receive({ id: "checkout", from: OWNER, text: "YES" });
    clock.at = STALE;
    const blocked = await job.receive({ id: "checkin", from: OWNER, text: "YES" });
    expect(blocked.sent).toEqual([{ to: OWNER, body: STALE_ALERT, kind: "review" }]);
    expect(box.sent.filter((text) => text.kind === "offer")).toEqual([]);
    job.stampFetchedAt(FRESH);
    const repeat = await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(repeat.sent).toEqual([]);
    job.stampFetchedAt(STALE);
    const fresh = await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(fresh.sent).toEqual([{ to: CLEANER, body: OFFER, kind: "offer" }]);
    expect(job.reviews().filter((item) => item.kind === "stale-source" && item.status === "open")).toEqual([]);
  });

  it("keeps a newer host checkout when a stale feed names a different day", async () => {
    const box = sink();
    const clock = { at: FRESH };
    const job = engine(box, clock, { pin: lane.pin, hostName: lane.hostName });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "opt", from: CLEANER, text: "YES" });
    await job.receive({ id: "two", from: OWNER, text: "2:00 PM" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    expect(box.sent.filter((text) => text.kind === "offer")).toEqual([{ to: CLEANER, body: OFFER_2PM, kind: "offer" }]);
    clock.at = STALE;
    job.stampFetchedAt(FRESH);
    const moved = await job.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(moved.sent).toEqual([]);
    expect(job.jobs().find((item) => item.id === "stay-anita@guesty.com")).toMatchObject({
      checkoutDate: "2026-10-18",
      checkoutTime: "2:00 PM",
    });
  });

  it("restores a backup and a later tick sends nothing, keeping the opt-out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-backup-"));
    const backup = join(dir, "turn.db");
    try {
      const clock = { at: FRESH };
      const first = engine(sink(), clock, { dataDir: dir, sqlite: true, pin: lane.pin, hostName: lane.hostName });
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      await first.receive({ id: "opt", from: CLEANER, text: "YES" });
      await first.receive({ id: "out", from: OWNER, text: "YES" });
      await first.receive({ id: "in", from: OWNER, text: "YES" });
      await first.receive({ id: "stop", from: OWNER, text: "STOP" });
      first.backup(backup);
      const bytes = readFileSync(backup);
      expect(bytes.includes(Buffer.from(lane.pin))).toBe(false);
      expect(bytes.toString("utf8").includes("pinSeal")).toBe(true);
      writeFileSync(join(dir, "cleaner-core.json"), JSON.stringify({
        schemaVersion: 1,
        tenantId: lane.id,
        jobs: [],
        hostFacts: [],
        tombstones: [],
        outbox: [],
        inboundIds: [],
        transcript: [],
        optedOut: false,
        injurySent: [],
        blocks: [],
      }));
      first.restore(backup);
      const clock2 = { at: FRESH };
      const next = engine(sink(), clock2, { dataDir: dir, sqlite: true, pin: lane.pin, hostName: lane.hostName });
      const ticked = await next.pollFeed(feed("guesty-lite-scratch.ics"));
      expect(ticked.sent).toEqual([]);
      expect(next.outbox().some((item) => item.kind === "offer" && item.status === "sent")).toBe(true);
      expect(next.jobs()[0]?.textsBlocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a finished turn without sending again", async () => {
    const box = sink();
    const clock = { at: FRESH };
    const job = engine(box, clock, { pin: lane.pin, hostName: lane.hostName });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "opt", from: CLEANER, text: "YES" });
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    const before = box.sent.length;
    const replayed = await job.replay();
    expect(replayed.sent).toEqual([]);
    expect(box.sent).toHaveLength(before);
    expect(job.outbox().some((item) => item.kind === "offer" && item.status === "sent")).toBe(true);
  });

  it("leaves an accepted offer uncertain after a crash and does not send it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-halt-"));
    try {
      const clock = { at: FRESH };
      const firstBox = sink();
      const first = engine(firstBox, clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName, halt: "after-accept" });
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      await first.receive({ id: "opt", from: CLEANER, text: "YES" });
      await first.receive({ id: "out", from: OWNER, text: "YES" });
      await expect(first.receive({ id: "in", from: OWNER, text: "YES" })).rejects.toThrow(/after-accept/);
      expect(firstBox.sent.filter((text) => text.kind === "offer")).toHaveLength(1);
      const secondBox = sink();
      const second = engine(secondBox, clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName });
      const resumed = await second.replay();
      expect(resumed.sent).toEqual([{ to: OWNER, body: UNCERTAIN_ALERT, kind: "review" }]);
      expect(secondBox.sent.filter((text) => text.kind === "offer")).toEqual([]);
      const retried = await second.receive({ id: "retry-1", from: OWNER, text: "RETRY" });
      expect(retried.sent).toEqual([{ to: CLEANER, body: OFFER, kind: "offer" }]);
      const retriedAgain = await second.receive({ id: "retry-2", from: OWNER, text: "RETRY" });
      expect(retriedAgain.sent).toEqual([]);
      const again = await second.replay();
      expect(again.sent).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends an uncertain offer once when the host tells Grok to retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-halt-grok-"));
    try {
      const clock = { at: FRESH };
      const first = engine(sink(), clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName, halt: "after-accept" });
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      await first.receive({ id: "opt", from: CLEANER, text: "YES" });
      await first.receive({ id: "out", from: OWNER, text: "YES" });
      await expect(first.receive({ id: "in", from: OWNER, text: "YES" })).rejects.toThrow(/after-accept/);
      const secondBox = sink();
      const second = engine(secondBox, clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName });
      expect((await second.replay()).sent).toEqual([{ to: OWNER, body: UNCERTAIN_ALERT, kind: "review" }]);
      const retried = await second.hostRetry("grok-retry-1");
      expect(retried.sent).toEqual([{ to: CLEANER, body: OFFER, kind: "offer" }]);
      expect((await second.hostRetry("grok-retry-2")).sent).toEqual([]);
      expect((await second.hostRetry("grok-retry-1")).reason).toBe("duplicate");
      expect((await second.replay()).sent).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the door code after a crash that saved clearance, and only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-pin-halt-"));
    try {
      const clock = { at: "2026-10-18T16:00:00.000Z" };
      const first = engine(sink(), clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName, halt: "before-pin", watchFreshness: false });
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      await first.receive({ id: "opt", from: CLEANER, text: "YES" });
      await first.receive({ id: "out", from: OWNER, text: "YES" });
      await first.receive({ id: "in", from: OWNER, text: "YES" });
      await first.receive({ id: "yes", from: CLEANER, text: "YES" });
      await expect(first.receive({ id: "left", from: OWNER, text: "guests have left" })).rejects.toThrow(/before-pin/);
      expect(first.outbox().some((item) => item.kind === "pin")).toBe(false);
      const secondBox = sink();
      const second = engine(secondBox, clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName, watchFreshness: false });
      const resumed = await second.runReminders();
      expect(resumed.sent.find((text) => text.kind === "pin")).toEqual({
        to: CLEANER,
        kind: "pin",
        body: `Guests have left ${ADDRESS}. Door code: ${lane.pin}. This code is only for you. Reply DONE when the cleaning is finished.`,
      });
      expect(resumed.sent.filter((text) => text.kind === "pin")).toHaveLength(1);
      const third = await engine(sink(), clock, { dataDir: dir, pin: lane.pin, hostName: lane.hostName, watchFreshness: false }).runReminders();
      expect(third.sent.filter((text) => text.kind === "pin")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reviews a code-like inbound once and does not store the digits", async () => {
    const box = sink();
    const clock = { at: FRESH };
    const job = engine(box, clock, { pin: lane.pin, hostName: lane.hostName });
    const exposed = await job.receive({ id: "code", from: CLEANER, text: lane.pin });
    expect(exposed.sent).toEqual([{ to: OWNER, body: EXPOSURE_ALERT, kind: "review" }]);
    expect(job.transcript().join("\n").includes(lane.pin)).toBe(false);
    expect(job.outbox().map((item) => item.body).join("\n").includes(lane.pin)).toBe(false);
    expect(job.revealPin("cleaner")).toBe(lane.pin);
    expect(job.revealPin("observer")).toBeUndefined();
    expect(job.revealPin("owner")).toBeUndefined();
  });

  it("opens each review once", async () => {
    const clock = { at: FRESH };
    const job = engine(sink(), clock);
    for (const kind of REVIEW_KINDS) {
      const detail = kind === "missed-reminder"
        ? { day: "Wednesday, Oct 14", about: "reminder" as const }
        : kind === "uncertain-sms"
          ? { day: "Wednesday, Oct 14", about: "offer" as const }
          : undefined;
      const first = await job.fileReview(kind as ReviewKind);
      const second = await job.fileReview(kind as ReviewKind);
      expect(first.sent).toEqual([{ to: OWNER, body: reviewAlert(kind, ADDRESS, detail), kind: "review" }]);
      expect(second.sent).toEqual([]);
    }
    expect(job.reviews()).toHaveLength(REVIEW_KINDS.length);
    expect(job.health()).toMatchObject({
      ok: true,
      sends: false,
      note: "Cleaner Core health. This check does not send texts.",
      openReviews: REVIEW_KINDS.length,
    });
  });

  it("keeps Lane and Court reviews, backups, and counters apart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-tenants-"));
    const backup = join(dir, "lane.db");
    try {
      const clock = { at: FRESH };
      const laneBox = sink();
      const laneJob = engine(laneBox, clock, { dataDir: dir, sqlite: true });
      await laneJob.pollFeed(feed("guesty-lite-scratch.ics"));
      await laneJob.fileReview("same-day-capacity");
      laneJob.backup(backup);
      const courtBox = sink();
      const courtJob = openCleanerCore({
        enabled: true,
        tenantId: court.id,
        property: court.property,
        ownerPhone: court.ownerPhone,
        cleaner: { phone: court.cleanerPhone, approved: true },
        consented: true,
        sink: courtBox,
        now: () => new Date(clock.at),
        dataDir: dir,
        sqlite: true,
        watchFreshness: true,
      });
      await courtJob.readSource((await import("../src/hub/sources")).googleCalendarFixtureSource(feed("google-court-stay.json")));
      expect(courtJob.reviews()).toEqual([]);
      expect(courtBox.sent.every((text) => text.to === court.ownerPhone || text.to === court.cleanerPhone)).toBe(true);
      expect(laneBox.sent.every((text) => text.to === OWNER || text.to === CLEANER)).toBe(true);
      const laneAgain = engine(sink(), clock, { dataDir: dir, sqlite: true });
      laneAgain.restore(backup);
      const courtAgain = openCleanerCore({
        enabled: true,
        tenantId: court.id,
        property: court.property,
        ownerPhone: court.ownerPhone,
        cleaner: { phone: court.cleanerPhone, approved: true },
        consented: true,
        sink: sink(),
        now: () => new Date(clock.at),
        dataDir: dir,
        sqlite: true,
      });
      expect(laneAgain.reviews().map((item) => item.kind)).toEqual(["same-day-capacity"]);
      expect(courtAgain.jobs().map((item) => item.id)).toEqual(["google:evt-court"]);
      expect(laneAgain.health().openReviews).toBe(1);
      expect(courtAgain.health().openReviews).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a calendar URL that is not public https", async () => {
    expect(calendarUrlAllowed("https://example.com/feed.ics")).toBe(true);
    expect(calendarUrlAllowed("http://example.com/feed.ics")).toBe(false);
    expect(calendarUrlAllowed("https://127.0.0.1/feed.ics")).toBe(false);
    expect(calendarUrlAllowed("https://10.1.2.3/feed.ics")).toBe(false);
    expect(calendarUrlAllowed("https://192.168.1.9/feed.ics")).toBe(false);
    const redirected = await readPublicCalendar("https://example.com/feed.ics", async () => ({ status: 302, url: "https://127.0.0.1/feed.ics", async text() { return "BEGIN:VCALENDAR"; } }));
    expect(redirected).toEqual({ ok: false, reason: CALENDAR_URL_REFUSAL });
    const priv = await readPublicCalendar("https://10.0.0.8/feed.ics", async () => ({ status: 200, url: "https://10.0.0.8/feed.ics", async text() { return "BEGIN:VCALENDAR"; } }));
    expect(priv).toEqual({ ok: false, reason: CALENDAR_URL_REFUSAL });
  });
});
