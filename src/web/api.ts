import { applySetupCommand, COMMON_TIME_ZONES, createPropertySetup, describeHistory, draftView, dryTourView, inferTimeZone, propertySummary, PropertyWorkspace, readinessView, SETUP_STEPS, SetupInputError, tourDetailView, tourListView } from "../setup";
import { liveTourView, VisitorDemoRegistry, VisitorDemoSession, visitorView } from "../visitor";
import { z } from "zod";
import { visitorTeamName } from "../sms/templates";
import { checkMessaging } from "../createTourCore";
import { TourCoreError } from "../core/TourCore";
import { formatDay, formatTime, friendlyTimeZone as friendlyZone, zonedParts, zonedTimeToUtc } from "../core/timezone";
import { toE164 } from "../messaging/Messenger";
import { auditExportFile } from "../operator/auditExport";
import { defaultMessagingMode, persistSession, type OperatorServices } from "../operator/services";
import { rememberWaiter } from "../setup/pauseWaiters";
import { checkedConfig as checkedSetup, publishProperty, readinessForProperty, runPracticeTour } from "../operator/setupFlow";
import type { VerificationLinks } from "../visitor/verificationLinks";

/**
 * The browser's API for both the operator and the visitor phone. Every
 * handler delegates to the setup engine or the visitor session over the real
 * Tour Core engine; no product rule lives here. Anything under a `dev` key is
 * removed unless developer mode is on, so operators and visitors never see
 * codes, adapter names, internal ids or file paths.
 */

export interface ApiContext extends OperatorServices {
  workspace: PropertyWorkspace;
  visitors?: VisitorDemoRegistry;
  links?: VerificationLinks;
  dev: boolean;
}

const IdentityForm = z.object({
  firstName: z.string().trim().min(1, "Please enter your first name.").max(80),
  lastName: z.string().trim().min(1, "Please enter your last name.").max(80),
  email: z.email("Please enter a valid email address.").max(200),
  phone: z.string().trim().min(7, "Please enter your phone number.").max(30),
});

const LINK_PROBLEMS = {
  unknown: "This link isn't valid. Text the property to get a new one.",
  expired: "This link has expired. Text the property and I'll send a new one.",
  used: "This form has already been completed. Check your messages for your tour details.",
} as const;

export type ApiResult =
  | { status: number; json: unknown }
  | { status: number; download: { filename: string; contentType: string; content: string } };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function handleApi(ctx: ApiContext, method: string, path: string, body: unknown): Promise<ApiResult> {
  try {
    const result = await route(ctx, method, path, (body ?? {}) as Record<string, unknown>);
    return "download" in result ? result : { status: result.status, json: ctx.dev ? result.json : stripDev(result.json) };
  } catch (err) {
    if (err instanceof SetupInputError) return errorResult(ctx, 400, err.code, err.message);
    if (err instanceof TourCoreError) return errorResult(ctx, 400, err.code, err.message);
    if (err instanceof ApiError) return errorResult(ctx, err.status, err.code, err.message);
    return errorResult(ctx, 500, "INTERNAL", "Something went wrong. Your saved setup is safe.", err);
  }
}

function errorResult(ctx: ApiContext, status: number, code: string, message: string, err?: unknown): ApiResult {
  const dev = ctx.dev ? { dev: { code, ...(err ? { error: String(err instanceof Error ? err.stack : err) } : {}) } } : {};
  return { status, json: { error: { message, ...dev } } };
}

const ok = (json: unknown) => ({ status: 200, json });

async function route(ctx: ApiContext, method: string, path: string, body: Record<string, unknown>): Promise<ApiResult> {
  const ws = ctx.workspace;
  if (!ctx.visitors) {
    ctx.visitors = new VisitorDemoRegistry();
    ctx.visitors.useApprovedContent((id) => (ws.has(id) ? ws.load(id).config : undefined));
    ctx.visitors.useAvailability((id) => (ws.has(id) ? ws.load(id).state : undefined));
    ctx.visitors.usePauseWaiters((id, waiter) => rememberWaiter(ws.root, id, waiter));
  }
  const visitors = ctx.visitors;
  const now = ctx.now?.() ?? new Date();
  const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  if (method === "GET" && parts[0] === "meta") {
    return ok({ dev: ctx.dev, steps: SETUP_STEPS, timeZones: COMMON_TIME_ZONES });
  }

  if (method === "POST" && parts[0] === "timezone" && parts[1] === "suggest") {
    const guess = inferTimeZone(String(body.address ?? ""));
    return ok({ timezone: guess.timezone, label: friendlyZone(guess.timezone), basis: guess.basis });
  }

  // ------------------------------------------ identity form for real phones

  if (parts[0] === "verify" && parts[1]) {
    const links = ctx.links;
    const check = links?.check(parts[1]) ?? ({ ok: false, reason: "unknown" } as const);
    if (!check.ok) return { status: 410, json: { ok: false, message: LINK_PROBLEMS[check.reason] } };
    const session = visitors.find(check.entry.sessionId);
    if (!session) return { status: 410, json: { ok: false, message: LINK_PROBLEMS.unknown } };
    if (method === "GET") {
      const minutes = Math.max(1, Math.round((check.entry.expiresAt - (ctx.now?.() ?? new Date()).getTime()) / 60_000));
      return ok({ ok: true, property: session.config.property.name, expiresInMinutes: minutes });
    }
    if (method === "POST") {
      const form = IdentityForm.safeParse(body);
      if (!form.success) return { status: 400, json: { ok: false, message: form.error.issues[0]?.message ?? "Please check the form." } };
      if (toE164(form.data.phone) !== check.entry.phone) {
        return { status: 400, json: { ok: false, message: "That phone number doesn't match the one you're texting from. Please use the same number." } };
      }
      const reservation = await session.reservation();
      const currentCheck = reservation?.verificationId ? await session.store.get("verifications", reservation.verificationId) : undefined;
      const now = (ctx.now?.() ?? new Date()).getTime();
      const staleCheck = !!currentCheck && currentCheck.status === "PASSED" && Date.parse(currentCheck.validUntil) <= now;
      if (((await session.stage()) !== "identity" && !staleCheck) || session.reservationId !== check.entry.reservationId) {
        links!.markUsed(parts[1]);
        return { status: 410, json: { ok: false, message: LINK_PROBLEMS.used } };
      }
      // Used before acting, so a crash mid-submit can never let the same link be used twice.
      links!.markUsed(parts[1]);
      await session.act("submitIdentity", form.data, { text: "Submitted the identity form." });
      await persistSession(ctx, session);
      const after = await session.reservation();
      const latest = after?.verificationId ? await session.store.get("verifications", after.verificationId) : undefined;
      const passed = !!latest && latest.status === "PASSED" && Date.parse(latest.validUntil) > (ctx.now?.() ?? new Date()).getTime();
      return ok({
        ok: passed,
        message: passed ? "Thanks, you're all set! Check your messages for your tour details." : `Thanks. We couldn't confirm your details, so the ${visitorTeamName(session.config.operator.name)} will reach out.`,
      });
    }
  }

  // --------------------------------------------------------- visitor phone

  if (parts[0] === "visitor-demos" && parts[1]) {
    const session = visitors.get(parts[1]);
    if (method === "GET" && !parts[2]) return ok({ visitor: await visitorView(session) });
    if (method === "GET" && parts[2] === "live") return ok({ live: await liveTourView(session) });
    if (method === "GET" && parts[2] === "times") {
      const tz = session.config.property.timezone;
      const times = (await session.rescheduleOptions()).map((s) => ({ startsAt: s.start.toISOString(), label: `${formatDay(s.start, tz)}, ${s.label}` }));
      if (!ctx.dev) return ok({ times });
      const p = zonedParts(session.clock.now(), tz);
      const pad = (n: number) => String(n).padStart(2, "0");
      return ok({ times, anyTime: { now: `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}` } });
    }
    const saveAndShowLive = async () => {
      await persistSession(ctx, session);
      return ok({ live: await liveTourView(session) });
    };
    if (method === "POST" && parts[2] === "reschedule") {
      if (body.localTime === undefined) await session.reschedule(String(body.startsAt ?? ""));
      else {
        // Developer mode only: any wall-clock time at the property, outside tour hours included.
        if (!ctx.dev) throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(body.localTime));
        if (!m) throw new ApiError(400, "INVALID_TIME", "Pick a date and time.");
        const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
        const start = zonedTimeToUtc({ year, month, day, hour, minute }, session.config.property.timezone);
        await session.reschedule(start.toISOString(), { outsideTourHours: true });
      }
      return saveAndShowLive();
    }
    // Developer mode only: never available to a normal operator.
    if (method === "POST" && parts[2] === "move-to-now") {
      if (!ctx.dev) throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");
      await session.moveTourToNow();
      return saveAndShowLive();
    }
    if (method === "POST" && parts[2] === "actions" && parts[3]) {
      await session.act(parts[3], body.input);
      await persistSession(ctx, session);
      return ok({ visitor: await visitorView(session) });
    }
  }

  // ------------------------------------------------------------ properties

  if (parts[0] !== "properties") throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");

  if (parts.length === 1) {
    if (method === "GET") return ok({ properties: await Promise.all(ws.propertyIds().map((id) => summaryFor(ctx, id))) });
    if (method === "POST") {
      const draft = createPropertySetup({
        address: String(body.address ?? ""),
        name: body.name === undefined ? undefined : String(body.name),
        propertyType: body.propertyType ? String(body.propertyType) : undefined,
        timezone: body.timezone ? String(body.timezone) : undefined,
        existingPropertyIds: ws.propertyIds(),
        messagingMode: defaultMessagingMode(ctx.installedMessaging?.()),
      });
      ws.saveDraft(draft);
      return ok(await propertyPayload(ctx, draft.property.id));
    }
  }

  const id = parts[1]!;
  const action = parts[2];

  if (method === "GET" && !action) return ok(await propertyPayload(ctx, id));

  if (method === "POST" && action === "commands" && parts[3]) {
    const { draft } = ws.openDraft(id);
    ws.persistEdit(applySetupCommand(draft, parts[3], body.input, { everPublished: ws.wasEverPublished(id) }), now);
    return ok(await propertyPayload(ctx, id));
  }

  if (method === "POST" && action === "discard") {
    ws.discardDraft(id);
    return ok(ws.has(id) ? await propertyPayload(ctx, id) : { discarded: true });
  }

  if (method === "POST" && action === "readiness") {
    const { result, savedChanges } = await readinessForProperty(ctx, id, now);
    return ok({ readiness: readinessView(result), savedChanges, summary: await summaryFor(ctx, id) });
  }

  if (method === "POST" && action === "visitor-demos") {
    const config = await checkedConfig(ctx, id, now);
    if ("readiness" in config) return ok({ readiness: config.readiness, summary: await summaryFor(ctx, id) });
    const session = visitors.add(new VisitorDemoSession(id, config.config, ws.newVisitorTourId(id, now)));
    const { record, bundle } = await session.record();
    ws.recordVisitorDemo(id, record, bundle);
    return ok({ sessionId: session.id, visitorUrl: `/visitor?s=${encodeURIComponent(session.id)}`, summary: await summaryFor(ctx, id) });
  }

  if (method === "POST" && action === "practice") {
    const outcome = await runPracticeTour(ctx, id, { unitId: typeof body.unitId === "string" ? body.unitId : undefined, now });
    if (outcome.kind === "unchecked-changes") throw uncheckedChanges();
    if (outcome.kind === "not-ready") return ok({ readiness: readinessView(outcome.readiness), summary: await summaryFor(ctx, id) });
    const view = dryTourView(outcome.result);
    return ok({
      practice: { ...view, tourId: outcome.state.dryTour?.tourId, dev: { ...view.dev, recordsFolder: outcome.state.dryTour?.recordsFolder } },
      summary: await summaryFor(ctx, id),
    });
  }

  if (method === "POST" && action === "publish") {
    const result = await publishProperty(ctx, id, now);
    if (result.published) return ok({ published: true, summary: await summaryFor(ctx, id) });
    return ok({
      published: false,
      blockers: result.blockers.map((b) => ({ message: b.message, next: nextStepFor(b.code), dev: { code: b.code } })),
      summary: await summaryFor(ctx, id),
    });
  }

  if (method === "GET" && action === "messaging") {
    const { draft } = ws.openDraft(id);
    const checks = await checkMessaging(draft);
    return ok({
      mode: draft.messagingMode,
      line: ctx.endpoints?.forProperty(id)?.address,
      connected: checks.every((c) => c.ok),
      checks: checks.map((c) => ({ label: c.label, ok: c.ok, message: c.message, dev: { code: c.code } })),
    });
  }

  if (method === "GET" && action === "tours") {
    const { config } = ws.load(id);
    const tourId = parts[3];
    if (!tourId) return ok({ tours: tourListView(ws.listTours(id), config.property.timezone) });
    if (parts[4] === "export") return download(ws, id, parts[5], tourId);
    const tour = ws.loadTour(id, tourId);
    if (!tour) throw new ApiError(404, "TOUR_NOT_FOUND", "I couldn't find that tour.");
    const view = tourDetailView(tour.record, tour.bundle, config);
    return ok({ tour: { ...view, dev: { ...view.dev, folder: tour.folder } } });
  }

  if (method === "GET" && action === "history") {
    const { config, state } = ws.load(id);
    const latest = ws.latestPracticeTour(id);
    if (!latest) return ok({ available: false });
    const entries = describeHistory(latest.bundle.auditEvents, { ...latest.bundle, operatorName: config.operator.name }, config.property.timezone);
    const tz = config.property.timezone;
    // A practice tour runs now but simulates the next open tour time; show both so the dates make sense.
    const ranAt = new Date(state.dryTour?.ranAt ?? latest.bundle.exportedAt);
    const simulated = latest.bundle.reservations[0]?.slotStart;
    return ok({
      available: true,
      ranAt: ranAt.toISOString(),
      ranAtLabel:
        `Run ${formatDay(ranAt, tz)} at ${formatTime(ranAt, tz)}` +
        (simulated ? `, practicing a ${formatTime(new Date(simulated), tz)} tour on ${formatDay(new Date(simulated), tz)}.` : "."),
      entries,
      dev: { folder: latest.folder },
    });
  }

  if (method === "GET" && action === "export") return download(ws, id, parts[3]);

  // Audit exports made by an operator tool (e.g. "Export today's audit" in Grok Bot).
  if (method === "GET" && action === "audit-exports" && parts[3] && parts[4]) {
    const file = auditExportFile(ws, id, parts[3], parts[4]);
    if (!file) throw new ApiError(404, "NOT_FOUND", "That export doesn't exist.");
    return { status: 200, download: { filename: `${id}-${parts[3]}-${parts[4]}`, ...file } };
  }

  throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");
}

function uncheckedChanges(): ApiError {
  return new ApiError(409, "UNCHECKED_CHANGES", "Some changes still need fixing. Open the review to see what's left.");
}

/** The saved setup, once it's free of unchecked changes and passes readiness (run automatically if needed). */
async function checkedConfig(ctx: ApiContext, id: string, now: Date) {
  const gate = await checkedSetup(ctx, id, now);
  if (gate.kind === "unchecked-changes") throw uncheckedChanges();
  if (gate.kind === "not-ready") return { readiness: readinessView(gate.readiness) };
  return { config: gate.config };
}

function download(ws: PropertyWorkspace, id: string, file: string | undefined, tourId?: string): ApiResult {
  if (file !== "records.json" && file !== "history.csv") throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");
  const files = ws.exportTour(id, tourId);
  if (!files) throw new ApiError(404, "NO_RECORDS", "There are no tour records yet. Run a practice tour first.");
  const json = file === "records.json";
  return {
    status: 200,
    download: {
      filename: `${id}${tourId ? `-${tourId}` : ""}-${json ? "tour-records.json" : "tour-history.csv"}`,
      contentType: json ? "application/json" : "text/csv",
      content: json ? files.json : files.csv,
    },
  };
}

function nextStepFor(code: string): { action: "readiness" | "practice" | "review"; label: string } {
  if (code.startsWith("READINESS") || code === "TEXTING_NOT_ATTACHED") return { action: "readiness", label: "Run readiness check" };
  if (code.startsWith("DRY_TOUR")) return { action: "practice", label: "Run a practice tour" };
  return { action: "review", label: "Review setup" };
}

async function summaryFor(ctx: ApiContext, id: string) {
  const ws = ctx.workspace;
  const { draft, unsavedChanges } = ws.openDraft(id);
  const active = await ctx.visitors?.activeFor(id);
  return propertySummary(ws.has(id) ? ws.load(id) : undefined, draft, unsavedChanges, {
    tourCount: ws.has(id) ? ws.listTours(id).length : 0,
    activeVisitorDemo: active?.id,
    messagingLine: ctx.endpoints?.forProperty(id)?.address,
    needsAttention: ctx.needsAttention?.(id),
  });
}

async function propertyPayload(ctx: ApiContext, id: string) {
  const { draft } = ctx.workspace.openDraft(id);
  return { summary: await summaryFor(ctx, id), view: draftView(draft) };
}

/** Removes developer-only details (any `dev` key) from a response. */
export function stripDev(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDev);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "dev").map(([k, v]) => [k, stripDev(v)]));
  }
  return value;
}
