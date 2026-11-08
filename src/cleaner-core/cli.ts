import { readFileSync } from "node:fs";
import { fixedCodePort } from "./doorPort";
import { pathToFileURL } from "node:url";
import { cleanerCoreEnabled } from "./flag";
import { HaltError, openCleanerCore, type CleanerCoreOptions, type CleanerText, type HealthReport, type JobView, type MessagingView, type OutboxView, type SetupView, type SyncState } from "./core";
import type { SourceRecord } from "./freshness";
import { isReviewKind, type AuditEvent, type ReviewItem, type ReviewKind } from "./review";
import type { FeedBlock } from "../hub/calendar";
import { isScratchTestNumber } from "./scratch";
import { googleCalendarFixtureSource, notionFixtureSource } from "../hub/sources";
import { scratchTenant, SCRATCH_TENANTS } from "./tenants";

type MessagingOpt = NonNullable<CleanerCoreOptions["messaging"]>;

/**
 * Launch: `npx tsx src/cleaner-core/cli.ts doctor` or
 * `CLEANER_CORE_ENABLED=1 npx tsx src/cleaner-core/cli.ts smoke`.
 * Ready: doctor prints JSON and `"sends": false`. Smoke exits 0 only after the Scratch script finishes.
 * Teardown: the process exits. It does not listen.
 * Drive: smoke reads a Guesty Lite-style iCal feed and texts the test owner.
 * With no arguments it asks the host, accepts the proposed times, and confirms the cleaning.
 * It does not text a door code unless `--with-pin` is set, and then only after the cleaner opts in
 * and the host says the guests have left. The printed JSON redacts that code.
 * `--reply`, `--feed`, `--then-feed`, `--google`, `--remind`, `--data`, and `--now` run in argument order.
 * `--no-poll` reloads a data directory without reading the feed again.
 * `--google` reads a fixture through the Google Calendar adapter. `--closed` syncs with no open conversation.
 * `--tenant scratch-court` is the second Scratch tenant. It does not read Scratch Lane's calendar on its own.
 */
export interface DoctorReport {
  ok: true;
  enabled: boolean;
  sends: false;
  note: string;
}

export interface SmokeReply {
  from: string;
  text: string;
}

export type SmokeOp =
  | { type: "poll"; ical: string }
  | { type: "google"; body: string }
  | { type: "notion"; body: string }
  | { type: "reply"; from: string; text: string }
  | { type: "group-reply"; from: string; text: string }
  | { type: "confirm-times"; checkout: string; checkIn: string }
  | { type: "resume" }
  | { type: "remind" }
  | { type: "now"; iso: string }
  | { type: "fail"; n: number }
  | { type: "fetched-at"; iso: string }
  | { type: "review"; kind: ReviewKind }
  | { type: "replay" }
  | { type: "backup"; file: string }
  | { type: "restore"; file: string };

export interface SmokeReport {
  ok: boolean;
  reason?: "disabled";
  flag?: true;
  property?: string;
  checkout?: string;
  nextArrival?: string;
  sent: CleanerText[];
  pinRecipients: string[];
  jobs?: JobView[];
  outbox?: OutboxView[];
  transcript?: string[];
  blocks?: FeedBlock[];
  tenant?: string;
  sync?: SyncState;
  messaging?: MessagingView;
  setup?: SetupView;
  reviews?: ReviewItem[];
  health?: HealthReport;
  sources?: SourceRecord[];
  audit?: AuditEvent[];
  halted?: "after-accept" | "before-pin";
}

const LANE = scratchTenant("scratch-lane");
if (!LANE) throw new Error("Scratch Lane is missing.");
const OWNER = LANE.ownerPhone;
const NOW = "2026-10-14T15:00:00.000Z";

/** Same-day Scratch turnover. The later stay is first. The checkout date is folded. */
const SCRATCH_ICAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-b",
  "DTSTART;VALUE=DATE:20261018",
  "DTEND;VALUE=DATE:20261020",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261016",
  "DTEND;VALUE=DATE:202610",
  " 18",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

export function runDoctor(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const enabled = cleanerCoreEnabled(env);
  return {
    ok: true,
    enabled,
    sends: false,
    note: enabled ? "Cleaner Core is on. doctor does not send texts." : "Cleaner Core is off. Touring texts are unchanged.",
  };
}

export async function runSmoke(
  env: NodeJS.ProcessEnv = process.env,
  replies?: SmokeReply[],
  extra?: {
    ops?: SmokeOp[];
    dataDir?: string;
    withPin?: boolean;
    groupPhones?: string[];
    approved?: boolean;
    tenantId?: string;
    closed?: boolean;
    stepE?: boolean;
    onboard?: boolean;
    stepF?: boolean;
    messaging?: MessagingOpt;
    stepG?: boolean;
    watchFreshness?: boolean;
    sqlite?: boolean;
    staleAfterMs?: number;
    halt?: "after-accept" | "before-pin";
    backupDir?: string;
    groupChat?: { hostName: string; cleanerName: string; extra?: { phone: string; name: string }[] };
  },
): Promise<SmokeReport> {
  if (extra?.onboard) return runOnboardingSmoke(env, extra);
  const tenant = scratchTenant(extra?.tenantId ?? "scratch-lane");
  if (!tenant) throw new Error("Unknown Scratch tenant.");
  const ops = extra?.ops ?? defaultOps(replies);
  for (const op of ops) {
    if ((op.type === "reply" || op.type === "group-reply") && !isScratchTestNumber(op.from)) {
      throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${op.from}.`);
    }
  }
  if (!cleanerCoreEnabled(env)) return { ok: false, reason: "disabled", sent: [], pinRecipients: [] };
  const sent: CleanerText[] = [];
  let now = NOW;
  let failures = 0;
  const conversation = extra?.closed ? "closed" : "open";
  const core = openCleanerCore({
    enabled: true,
    tenantId: tenant.id,
    property: tenant.property,
    ownerPhone: tenant.ownerPhone,
    cleaner: { phone: tenant.cleanerPhone, approved: extra?.approved !== false },
    ...(extra?.withPin ? { access: fixedCodePort(tenant.pin), hostName: tenant.hostName } : {}),
    ...(extra?.groupPhones?.length ? { groupPhones: extra.groupPhones } : {}),
    ...(extra?.messaging ? { messaging: extra.messaging } : {}),
    consented: true,
    sink: {
      send: (text) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("send failed");
        }
        sent.push(text);
      },
    },
    now: () => new Date(now),
    ...(extra?.dataDir ? { dataDir: extra.dataDir } : {}),
    ...(extra?.watchFreshness ? { watchFreshness: true } : {}),
    ...(extra?.sqlite ? { sqlite: true } : {}),
    ...(extra?.staleAfterMs ? { staleAfterMs: extra.staleAfterMs } : {}),
    ...(extra?.halt ? { halt: extra.halt } : {}),
    ...(extra?.backupDir ? { backupDir: extra.backupDir } : {}),
    ...(extra?.groupChat ? { groupChat: extra.groupChat } : {}),
  });
  let halted: "after-accept" | "before-pin" | undefined;
  try {
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      if (!op) continue;
      if (op.type === "now") now = op.iso;
      else if (op.type === "fail") failures += op.n;
      else if (op.type === "poll") await core.pollFeed(op.ical, { conversation });
      else if (op.type === "google") await core.readSource(googleCalendarFixtureSource(op.body), { conversation });
      else if (op.type === "notion") await core.readSource(notionFixtureSource(op.body), { conversation });
      else if (op.type === "reply") await core.receive({ id: `smoke-op-${index}`, from: op.from, text: op.text });
      else if (op.type === "group-reply") await core.receive({ id: `smoke-op-${index}`, from: op.from, text: op.text, channel: "group" });
      else if (op.type === "confirm-times") await core.confirmHostTimes({ checkout: op.checkout, checkIn: op.checkIn });
      else if (op.type === "resume") await core.resumeJob();
      else if (op.type === "fetched-at") core.stampFetchedAt(op.iso);
      else if (op.type === "review") await core.fileReview(op.kind);
      else if (op.type === "replay") await core.replay();
      else if (op.type === "backup") core.backup(op.file);
      else if (op.type === "restore") core.restore(op.file);
      else await core.runReminders();
    }
  } catch (err) {
    if (!(err instanceof HaltError)) throw err;
    halted = err.point;
  }
  const jobs = core.jobs();
  const primary = jobs.find((job) => job.status === "done" || job.status === "cleared" || job.status === "in_progress") ?? jobs.find((job) => job.status === "confirmed") ?? jobs.find((job) => job.checkoutAt);
  const report: SmokeReport = {
    ok: true,
    flag: true,
    property: tenant.property.address,
    ...(primary?.checkoutAt ? { checkout: primary.checkoutAt } : {}),
    ...(primary?.nextCheckInAt ? { nextArrival: primary.nextCheckInAt } : {}),
    sent,
    pinRecipients: sent.filter((text) => text.kind === "pin").map((text) => text.to),
    jobs,
    outbox: core.outbox(),
    transcript: core.transcript(),
    blocks: core.blocks(),
    ...(extra?.stepE || extra?.stepF ? { tenant: tenant.id, sync: core.lastSync() } : {}),
    ...(extra?.messaging ? { messaging: core.messagingView() } : {}),
    ...(extra?.stepG
      ? { reviews: core.reviews(), health: core.health(), sources: core.sourceHealth(), audit: core.auditTrail(), ...(halted ? { halted } : {}) }
      : {}),
  };
  return redactReport(report, [tenant.pin, ...SCRATCH_TENANTS.map((item) => item.pin)]);
}

async function runOnboardingSmoke(
  env: NodeJS.ProcessEnv,
  extra: { ops?: SmokeOp[]; dataDir?: string },
): Promise<SmokeReport> {
  if (!cleanerCoreEnabled(env)) return { ok: false, reason: "disabled", sent: [], pinRecipients: [] };
  const sent: CleanerText[] = [];
  let now = NOW;
  const core = openCleanerCore({
    enabled: true,
    tenantId: "onboarding-draft",
    property: { id: "onboarding-draft", address: "Scratch setup", timeZone: "America/New_York" },
    ownerPhone: "+15555550120",
    cleaner: { phone: "+15555550121", approved: true },
    consented: false,
    isolate: true,
    sink: {
      send: (text) => {
        sent.push(text);
      },
    },
    now: () => new Date(now),
    ...(extra.dataDir ? { dataDir: extra.dataDir } : {}),
  });
  core.beginOnboarding();
  const ops = extra.ops ?? [];
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (!op) continue;
    if (op.type === "now") now = op.iso;
    else if (op.type === "poll") core.attachPreview("guesty-lite", op.ical);
    else if (op.type === "notion") core.attachPreview("notion", op.body);
    else if (op.type === "reply") await core.answerOnboarding({ id: `smoke-op-${index}`, from: op.from, text: op.text });
  }
  const setup = core.setupView();
  const report: SmokeReport = {
    ok: true,
    flag: true,
    property: setup?.address || "Scratch setup",
    sent,
    pinRecipients: sent.filter((text) => text.kind === "pin").map((text) => text.to),
    jobs: core.jobs(),
    outbox: core.outbox(),
    transcript: core.transcript(),
    blocks: core.blocks(),
    tenant: "onboarding-draft",
    ...(setup ? { setup } : {}),
  };
  return redactReport(report, SCRATCH_TENANTS.map((item) => item.pin));
}

function redactReport(report: SmokeReport, pins: string[]): SmokeReport {
  let json = JSON.stringify(report);
  for (const pin of pins) {
    if (pin) json = json.split(pin).join("[redacted]");
  }
  return JSON.parse(json) as SmokeReport;
}

function defaultOps(replies?: SmokeReply[]): SmokeOp[] {
  const ops: SmokeOp[] = [{ type: "poll", ical: SCRATCH_ICAL }];
  if (replies) {
    for (const reply of replies) ops.push({ type: "reply", from: reply.from, text: reply.text });
    return ops;
  }
  ops.push({ type: "reply", from: OWNER, text: "YES" }, { type: "reply", from: OWNER, text: "YES" }, { type: "reply", from: OWNER, text: "YES" });
  return ops;
}

const DOCTOR_USAGE = "Usage: tsx src/cleaner-core/cli.ts doctor";
const SMOKE_USAGE = "Usage: tsx src/cleaner-core/cli.ts smoke [--data <dir>] [--no-poll] [--feed <file>] [--then-feed <file>] [--google <file>] [--notion <file>] [--onboard] [--group-mode cleaner-only|native|mirrored] [--group-capable] [--participant <role>=<phone>] [--tenant scratch-lane|scratch-court] [--closed] [--now <iso>] [--remind] [--fail-sends <n>] [--with-pin] [--unapproved] [--group <phone>] [--group-chat] [--group-extra <phone>] [--group-reply <from>=<text>] [--confirm-times <checkout>|<check-in>] [--resume] [--reply <from>=<text> ...]";

export function parseSmokeArgs(argv: string[]): { replies?: SmokeReply[]; ops: SmokeOp[]; dataDir?: string; explicit: boolean; withPin: boolean; approved: boolean; groupPhones: string[]; tenantId: string; closed: boolean; stepE: boolean; stepF: boolean; stepG: boolean; onboard: boolean; messaging?: MessagingOpt; watchFreshness: boolean; sqlite: boolean; staleAfterMs?: number; halt?: "after-accept" | "before-pin"; backupDir?: string; groupChat: boolean; groupExtra?: string } {
  const ops: SmokeOp[] = [];
  const replies: SmokeReply[] = [];
  const groupPhones: string[] = [];
  let dataDir: string | undefined;
  let noPoll = false;
  let sawReply = false;
  let explicit = false;
  let withPin = false;
  let approved = true;
  let tenantId = "scratch-lane";
  let closed = false;
  let stepE = false;
  let stepF = false;
  let stepG = false;
  let watchFreshness = false;
  let sqlite = false;
  let staleAfterMs: number | undefined;
  let halt: "after-accept" | "before-pin" | undefined;
  let backupDir: string | undefined;
  let onboard = false;
  let groupChat = false;
  let groupExtra: string | undefined;
  let groupMode: "cleaner-only" | "native" | "mirrored" | undefined;
  let groupCapable = false;
  const participants: MessagingOpt["participants"] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reply") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --reply needs <from>=<text>. ${SMOKE_USAGE}`);
      sawReply = true;
      explicit = true;
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`smoke --reply must look like <from>=<text>. Got ${value}. ${SMOKE_USAGE}`);
      const from = value.slice(0, eq);
      const rawText = value.slice(eq + 1);
      const text = rawText.startsWith("@") ? readFileSync(rawText.slice(1), "utf8").trim() : rawText;
      if (text.length === 0) throw new Error(`smoke --reply text is empty for ${from}. ${SMOKE_USAGE}`);
      if (!isScratchTestNumber(from)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${from}.`);
      replies.push({ from, text });
      ops.push({ type: "reply", from, text });
      continue;
    }
    if (arg === "--feed" || arg === "--then-feed") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a fixture path. ${SMOKE_USAGE}`);
      explicit = true;
      ops.push({ type: "poll", ical: readFileSync(value, "utf8") });
      continue;
    }
    if (arg === "--google") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --google needs a fixture path. ${SMOKE_USAGE}`);
      explicit = true;
      stepE = true;
      ops.push({ type: "google", body: readFileSync(value, "utf8") });
      continue;
    }
    if (arg === "--notion") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --notion needs a fixture path. ${SMOKE_USAGE}`);
      explicit = true;
      stepE = true;
      stepF = true;
      ops.push({ type: "notion", body: readFileSync(value, "utf8") });
      continue;
    }
    if (arg === "--onboard") {
      explicit = true;
      stepF = true;
      onboard = true;
      continue;
    }
    if (arg === "--group-mode") {
      const value = argv[++i];
      if (value !== "cleaner-only" && value !== "native" && value !== "mirrored") {
        throw new Error(`smoke --group-mode must be cleaner-only, native, or mirrored. ${SMOKE_USAGE}`);
      }
      explicit = true;
      stepF = true;
      groupMode = value;
      continue;
    }
    if (arg === "--group-capable") {
      explicit = true;
      stepF = true;
      groupCapable = true;
      continue;
    }
    if (arg === "--participant") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--") || !value.includes("=")) throw new Error(`smoke --participant needs <role>=<phone>. ${SMOKE_USAGE}`);
      const eq = value.indexOf("=");
      const role = value.slice(0, eq);
      const phone = value.slice(eq + 1);
      if (role !== "owner" && role !== "manager" && role !== "observer" && role !== "cleaner") {
        throw new Error(`smoke --participant role must be owner, manager, observer, or cleaner. ${SMOKE_USAGE}`);
      }
      if (!isScratchTestNumber(phone)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${phone}.`);
      explicit = true;
      stepF = true;
      participants.push({ phone, role });
      continue;
    }
    if (arg === "--tenant") {
      const value = argv[++i];
      const tenant = value ? scratchTenant(value) : undefined;
      if (!tenant) throw new Error(`smoke --tenant must be scratch-lane or scratch-court. ${SMOKE_USAGE}`);
      explicit = true;
      stepE = true;
      tenantId = tenant.id;
      continue;
    }
    if (arg === "--closed") {
      explicit = true;
      stepE = true;
      closed = true;
      continue;
    }
    if (arg === "--data") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --data needs a directory. ${SMOKE_USAGE}`);
      explicit = true;
      dataDir = value;
      continue;
    }
    if (arg === "--now") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --now needs an ISO time. ${SMOKE_USAGE}`);
      explicit = true;
      ops.push({ type: "now", iso: value });
      continue;
    }
    if (arg === "--remind") {
      explicit = true;
      ops.push({ type: "remind" });
      continue;
    }
    if (arg === "--fail-sends") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`smoke --fail-sends needs a number. ${SMOKE_USAGE}`);
      explicit = true;
      ops.push({ type: "fail", n: Number(value) });
      continue;
    }
    if (arg === "--no-poll") {
      explicit = true;
      noPoll = true;
      continue;
    }
    if (arg === "--with-pin") {
      explicit = true;
      withPin = true;
      continue;
    }
    if (arg === "--unapproved") {
      explicit = true;
      approved = false;
      continue;
    }
    if (arg === "--group-chat") {
      explicit = true;
      groupChat = true;
      continue;
    }
    if (arg === "--group-extra") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --group-extra needs a Scratch test number. ${SMOKE_USAGE}`);
      if (!isScratchTestNumber(value)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${value}.`);
      explicit = true;
      groupChat = true;
      groupExtra = value;
      continue;
    }
    if (arg === "--group-reply") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --group-reply needs <from>=<text>. ${SMOKE_USAGE}`);
      explicit = true;
      groupChat = true;
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`smoke --group-reply must look like <from>=<text>. Got ${value}. ${SMOKE_USAGE}`);
      const from = value.slice(0, eq);
      const text = value.slice(eq + 1);
      if (!isScratchTestNumber(from)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${from}.`);
      if (text.length === 0) throw new Error(`smoke --group-reply text is empty for ${from}. ${SMOKE_USAGE}`);
      ops.push({ type: "group-reply", from, text });
      continue;
    }
    if (arg === "--confirm-times") {
      const value = argv[++i];
      if (value === undefined || !value.includes("|")) throw new Error(`smoke --confirm-times needs <checkout>|<check-in>. ${SMOKE_USAGE}`);
      explicit = true;
      groupChat = true;
      const [checkout, checkIn] = value.split("|");
      if (!checkout || !checkIn) throw new Error(`smoke --confirm-times needs <checkout>|<check-in>. ${SMOKE_USAGE}`);
      ops.push({ type: "confirm-times", checkout, checkIn });
      continue;
    }
    if (arg === "--resume") {
      explicit = true;
      groupChat = true;
      ops.push({ type: "resume" });
      continue;
    }
    if (arg === "--group") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --group needs a Scratch test number. ${SMOKE_USAGE}`);
      if (!isScratchTestNumber(value)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${value}.`);
      explicit = true;
      groupPhones.push(value);
      continue;
    }
    if (arg === "--watch-freshness") {
      explicit = true;
      stepG = true;
      watchFreshness = true;
      continue;
    }
    if (arg === "--stale-after") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`smoke --stale-after needs a number of milliseconds. ${SMOKE_USAGE}`);
      explicit = true;
      stepG = true;
      staleAfterMs = Number(value);
      continue;
    }
    if (arg === "--fetched-at") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --fetched-at needs an ISO time. ${SMOKE_USAGE}`);
      explicit = true;
      stepG = true;
      watchFreshness = true;
      ops.push({ type: "fetched-at", iso: value });
      continue;
    }
    if (arg === "--review") {
      const value = argv[++i];
      if (value === undefined || !isReviewKind(value)) throw new Error(`smoke --review needs a review kind. ${SMOKE_USAGE}`);
      explicit = true;
      stepG = true;
      ops.push({ type: "review", kind: value });
      continue;
    }
    if (arg === "--replay") {
      explicit = true;
      stepG = true;
      ops.push({ type: "replay" });
      continue;
    }
    if (arg === "--backup" || arg === "--restore" || arg === "--backup-dir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke ${arg} needs a path. ${SMOKE_USAGE}`);
      explicit = true;
      stepG = true;
      sqlite = true;
      if (arg === "--backup") ops.push({ type: "backup", file: value });
      else if (arg === "--restore") ops.push({ type: "restore", file: value });
      else backupDir = value;
      continue;
    }
    if (arg === "--crash") {
      const value = argv[++i];
      if (value !== "before-pin" && value !== "after-accept") throw new Error(`smoke --crash needs before-pin or after-accept. ${SMOKE_USAGE}`);
      explicit = true;
      stepG = true;
      halt = value;
      continue;
    }
    throw new Error(`Unexpected argument ${arg ?? ""}. ${SMOKE_USAGE}`);
  }
  if (!onboard && !noPoll && !ops.some((op) => op.type === "poll" || op.type === "google" || op.type === "notion")) {
    if (tenantId !== "scratch-lane") throw new Error(`scratch-court needs --google, --notion, or --feed. It does not read Scratch Lane's calendar. ${SMOKE_USAGE}`);
    ops.unshift({ type: "poll", ical: SCRATCH_ICAL });
  }
  const messaging = groupMode
    ? { requested: groupMode === "cleaner-only" ? "cleaner-only" as const : "group" as const, capable: groupMode === "native" && groupCapable, participants }
    : undefined;
  const gate = { stepG, watchFreshness, sqlite, ...(staleAfterMs ? { staleAfterMs } : {}), ...(halt ? { halt } : {}), ...(backupDir ? { backupDir } : {}) };
  if (!explicit) {
    return { ops: defaultOps(undefined), ...(dataDir ? { dataDir } : {}), explicit, withPin, approved, groupPhones, tenantId, closed, stepE, stepF, onboard, groupChat, ...gate };
  }
  return { ops, ...(sawReply ? { replies } : {}), ...(dataDir ? { dataDir } : {}), explicit, withPin, approved, groupPhones, tenantId, closed, stepE, stepF, onboard, groupChat, ...(groupExtra ? { groupExtra } : {}), ...(messaging ? { messaging } : {}), ...gate };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "doctor") {
    const extra = process.argv[3];
    if (extra !== undefined) throw new Error(`Unexpected argument ${extra}. ${DOCTOR_USAGE}`);
    process.stdout.write(`${JSON.stringify(runDoctor(), null, 2)}\n`);
    return;
  }
  if (command === "smoke") {
    const parsed = parseSmokeArgs(process.argv.slice(3));
    const report = await runSmoke(process.env, parsed.explicit ? [] : undefined, {
      ops: parsed.ops,
      ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
      ...(parsed.withPin ? { withPin: true } : {}),
      ...(parsed.approved ? {} : { approved: false }),
      ...(parsed.groupPhones.length ? { groupPhones: parsed.groupPhones } : {}),
      tenantId: parsed.tenantId,
      ...(parsed.closed ? { closed: true } : {}),
      ...(parsed.stepE ? { stepE: true } : {}),
      ...(parsed.stepF ? { stepF: true } : {}),
      ...(parsed.onboard ? { onboard: true } : {}),
      ...(parsed.messaging ? { messaging: parsed.messaging } : {}),
      ...(parsed.stepG ? { stepG: true } : {}),
      ...(parsed.watchFreshness ? { watchFreshness: true } : {}),
      ...(parsed.sqlite ? { sqlite: true } : {}),
      ...(parsed.staleAfterMs ? { staleAfterMs: parsed.staleAfterMs } : {}),
      ...(parsed.halt ? { halt: parsed.halt } : {}),
      ...(parsed.backupDir ? { backupDir: parsed.backupDir } : {}),
      ...(parsed.groupChat
        ? {
            groupChat: {
              hostName: "Cory",
              cleanerName: "Maria",
              ...(parsed.groupExtra ? { extra: [{ phone: parsed.groupExtra, name: "Alex" }] } : {}),
            },
          }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exit(2);
    return;
  }
  if (command === "health") {
    let dataDir: string | undefined;
    let tenantId = "scratch-lane";
    let nowIso: string | undefined;
    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === "--data") {
        dataDir = process.argv[++i];
        if (!dataDir) throw new Error("health --data needs a directory.");
        continue;
      }
      if (arg === "--tenant") {
        tenantId = process.argv[++i] ?? "";
        continue;
      }
      if (arg === "--now") {
        nowIso = process.argv[++i];
        if (!nowIso) throw new Error("health --now needs an ISO time.");
        continue;
      }
      throw new Error(`Unexpected argument ${arg ?? ""}. Usage: tsx src/cleaner-core/cli.ts health [--data <dir>] [--tenant scratch-lane|scratch-court] [--now <iso>]`);
    }
    const tenant = scratchTenant(tenantId);
    if (!tenant) throw new Error("Unknown Scratch tenant.");
    const clock = nowIso ? new Date(nowIso) : new Date();
    const core = openCleanerCore({
      enabled: cleanerCoreEnabled(),
      tenantId: tenant.id,
      property: tenant.property,
      ownerPhone: tenant.ownerPhone,
      cleaner: { phone: tenant.cleanerPhone, approved: true },
      consented: true,
      sink: { send() { throw new Error("health does not send"); } },
      now: () => clock,
      ...(dataDir ? { dataDir } : {}),
    });
    process.stdout.write(`${JSON.stringify(core.health(), null, 2)}\n`);
    return;
  }
  process.stderr.write(`${DOCTOR_USAGE}\n${SMOKE_USAGE}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : "Cleaner Core failed"}\n`);
    process.exit(1);
  });
}
