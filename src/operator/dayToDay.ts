import { z } from "zod";
import { describeOperatorUpdate, inboxPhoneVisitorLabel } from "../alerts/describeUpdate";
import { exceptionEventId, timeRequestEventId } from "../alerts/operatorEvents";
import { UPLOAD_BACKUP_FIRST } from "../backup/handoff";
import { CHECKSUM_COVERS, CHECKSUM_COVERS_RESULT, PortableBackupError } from "../backup/portable";
import { revokeConfirmQuestion } from "../core/availabilityCopy";
import { TourCoreError } from "../core/TourCore";
import { MONTH_NUMBER } from "../core/spokenTime";
import { addDays, formatDay, formatTime, isValidTimeZone, localDateOf, timeOnDay, type LocalDate } from "../core/timezone";
import { UNSET_ZONE_LINE } from "../setup/storedTimeZone";
import { UnavailableModeError } from "../createTourCore";
import { InvalidTransitionError, isRunningReservation } from "../domain/stateMachine";
import { AuditExportLinks } from "./auditExportLinks";
import { isHostedRailway } from "../install/deployment";
import { DRIVE_NOT_SET_UP_LINE } from "../install/stateView";
import type { SettingName } from "../install/secretStore";
import { googleClientConfig } from "../storage/googleOAuth";
import { envelope } from "./milestones";
import type { OperatorServices } from "./services";
import { exportAudit, formatAuditDaySummary, parseLocalDate } from "./auditExport";
import {
  answerFlaggedQuestion,
  clearHold,
  describeChangeTarget,
  inspectException,
  listExceptions,
  placeHold,
  planFlaggedAnswer,
  resolveException,
  revokeTour,
  saveSendOptedOutLine,
  saveSendUnreachableLine,
  sendThisQuestion,
  visitorAnswerText,
  ISSUE_ALREADY_HANDLED,
  type OperatorException,
} from "./exceptions";
import { resolvePropertyId } from "./resolve";
import { SetupInputError } from "../setup/setupActions";
import {
  approveTourTimeRequest,
  declineTourTimeRequest,
  inspectTourTimeRequest,
  listTourTimeRequests,
  proposeTourTime,
  rescheduleTour,
  scheduleOneOffTour,
} from "./tourTimes";
import { currentReservation, findTour, inspectTourSummary, inspectTourView, isFutureBooking, midSentence, tourSnapshots, tourSummary, visitorNameOf } from "./tours";
import { joinList as joinNames } from "./tourDayWords";
import type { OperatorTool, ToolContext } from "./tools";
import { tool } from "./defineTool";

/**
 * Day-to-day tools. Each one calls the same engine functions as the older
 * tool it replaces. Writes report done, blocked, or next.
 */

const Property = z.string().max(200).optional().describe("Which property: its name, address or propertyId. Leave out when there's only one.");
const TourRef = z.string().min(3).max(200).describe("The tourRef from get_tours or get_inbox. Never show it to the landlord.");
const ExceptionId = z.string().min(3).max(60).describe("The exceptionId from get_inbox. Never show it to the landlord.");
const Code = z.string().max(20).optional().describe("Only after the landlord explicitly said yes to the exact question this tool returned earlier.");
const Unit = z.string().min(1).max(100).describe('The unit, e.g. "Unit 101" or "101".');

function withChecksumCovers(result: Record<string, unknown>): Record<string, unknown> {
  return { ...result, checksumCovers: CHECKSUM_COVERS_RESULT };
}

function noteBlockedBackup(result: Record<string, unknown>): Record<string, unknown> {
  return result.status === "blocked" ? withChecksumCovers(result) : result;
}

function blockedOf(err: unknown): { message: string; code: string } | undefined {
  if (err instanceof SetupInputError || err instanceof TourCoreError) return { message: err.message, code: err.code };
  if (err instanceof PortableBackupError) return { message: err.message, code: "BACKUP_FAILED" };
  if (err instanceof UnavailableModeError) return { message: err.message, code: "UNAVAILABLE" };
  if (err instanceof InvalidTransitionError) {
    return { message: "I can't make that change to this tour right now. Nothing was changed.", code: "INVALID_TRANSITION" };
  }
  return undefined;
}

/** Turns an older tool result into the milestone write shape. A yes/no ask is next. */
export function toMilestoneWrite(ctx: ToolContext, propertyId: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
  const message = typeof raw.summary === "string" ? raw.summary : "Done.";
  const { status: _status, summary: _summary, instructions: _instructions, ...rest } = raw;
  if (raw.status === "needs-confirmation") return envelope(ctx, propertyId, "next", message, rest);
  return envelope(ctx, propertyId, "done", message, rest);
}

export async function attemptWrite(ctx: ToolContext, propertyId: string | undefined, run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return toMilestoneWrite(ctx, propertyId, await run());
  } catch (err) {
    const blocked = blockedOf(err);
    if (!blocked) throw err;
    return envelope(ctx, propertyId, "blocked", blocked.message, {}, blocked.code);
  }
}

function propertyIdOf(ctx: ToolContext, property: string | undefined): string | undefined {
  if (!property) return undefined;
  return resolvePropertyId(ctx.services.workspace, property);
}

export function reservationFingerprint(reservation: { id: string; status: string; updatedAt: string }): string {
  return `${reservation.id}|${reservation.status}|${reservation.updatedAt}`;
}

/** Local computer link when that's all we have; hosted public URL with a short-lived token. */
export function auditExportFileLink(ctx: ToolContext, propertyId: string, exportId: string, file: string): { openOnTourCoreComputer?: string } {
  const inst = ctx.installation;
  const hosted = inst && isHostedRailway(inst.deploymentMode());
  const publicBase = hosted ? inst.publicBaseUrl() : undefined;
  if (hosted && publicBase) {
    const minted = new AuditExportLinks(inst.runtime, () => inst.now()).issue(propertyId, exportId, file);
    return { openOnTourCoreComputer: AuditExportLinks.downloadUrl(publicBase, propertyId, exportId, file, minted.token) };
  }
  const local = ctx.localUrl?.();
  return local ? { openOnTourCoreComputer: AuditExportLinks.localUrl(local, propertyId, exportId, file) } : {};
}

/** Derived from the published setup. Setting a zone removes it. Not stored as an exception. */
function unsetZoneInboxItems(services: OperatorServices, propertyId: string | undefined): Array<Record<string, unknown>> {
  const ids = propertyId ? [propertyId] : services.workspace.propertyIds();
  const items: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    if (!services.workspace.has(id)) continue;
    const saved = services.workspace.load(id);
    if (saved.state.status !== "PUBLISHED_FOR_DEMO" || saved.state.removedAt) continue;
    if (isValidTimeZone(saved.config.property.timezone)) continue;
    items.push({
      kind: "issue",
      property: saved.config.property.name,
      what: "Time zone needed",
      summary: UNSET_ZONE_LINE,
      status: "open",
    });
  }
  return items;
}

function inboxKind(item: OperatorException): "flagged-question" | "help" | "door" | "issue" {
  if (item.kind === "unanswered-question" || item.kind === "handler-failed") return "flagged-question";
  if (item.kind === "needs-help") return "help";
  if (item.kind === "door-system" || item.kind === "off-route-door" || item.kind === "access-problem") return "door";
  return "issue";
}

export function exceptionLine(item: OperatorException) {
  return {
    exceptionId: item.exceptionId,
    tourRef: item.tourRef,
    property: item.property,
    visitorName: item.visitorName,
    unitName: item.unitName,
    what: item.title,
    summary: item.summary,
    tourStatus: item.tourStatus,
    accessBlocked: item.accessBlocked,
    when: item.when,
    status: item.status,
    ...(item.proposeDraft === false ? { proposeDraft: false as const } : {}),
    ...(item.resolution ? { resolution: item.resolution.note, ...(item.resolution.approvedFact ? { approvedFact: item.resolution.approvedFact } : {}) } : {}),
    nextSteps: item.nextSteps,
  };
}

function exceptionItem(item: OperatorException) {
  return { kind: inboxKind(item), ...exceptionLine(item) };
}

function installationOf(ctx: ToolContext) {
  if (!ctx.installation) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  return ctx.installation;
}

const MONTH_AND_DAY =
  /^(january|february|march|april|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|may)\.?\s+(\d{1,2})$/i;

function realCalendarDay(date: LocalDate): boolean {
  if (date.month < 1 || date.month > 12 || date.day < 1) return false;
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return utc.getUTCFullYear() === date.year && utc.getUTCMonth() === date.month - 1 && utc.getUTCDate() === date.day;
}

/**
 * Day input for export_records only. YYYY-MM-DD goes through parseLocalDate
 * with no year change. A month and day, or M/D, with no year is the most
 * recent past one in the property's zone. Booking does not use this.
 */
export function parseExportDay(input: string, today: LocalDate): { ok: true; day?: LocalDate } | { ok: false } {
  const text = input.trim();
  const word = text.toLowerCase();
  if (word === "today") return { ok: true };
  if (word === "yesterday") return { ok: true, day: addDays(today, -1) };
  const iso = parseLocalDate(text);
  if (iso) return realCalendarDay(iso) ? { ok: true, day: iso } : { ok: false };
  const named = MONTH_AND_DAY.exec(text);
  const numeric = named ? undefined : /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  const month = named ? MONTH_NUMBER[named[1]!.toLowerCase()] : numeric ? Number(numeric[1]) : undefined;
  const day = named ? Number(named[2]) : numeric ? Number(numeric[2]) : undefined;
  if (!month || !day) return { ok: false };
  // Checked against a leap year, so Feb 29 is a real month and day; the year used is the latest past one that has it.
  if (!realCalendarDay({ year: 2000, month, day })) return { ok: false };
  const passed = month < today.month || (month === today.month && day <= today.day);
  for (let year = passed ? today.year : today.year - 1; year > today.year - 9; year--) {
    if (realCalendarDay({ year, month, day })) return { ok: true, day: { year, month, day } };
  }
  return { ok: false };
}

/** Landlord line for get_tours. Texting with no booking is not a tour. */
export function tourListSummary(happening: string[], coming: string[]): string {
  const nowLine =
    happening.length === 0 ? "" : happening.length === 1 ? `1 tour happening now: ${happening[0]}.` : `${happening.length} tours happening now: ${joinNames(happening)}.`;
  const laterLine =
    coming.length === 0 ? "" : coming.length === 1 ? `1 tour coming up: ${coming[0]}.` : `${coming.length} tours coming up: ${joinNames(coming)}.`;
  if (!nowLine && !laterLine) return "No tours right now.";
  return [nowLine, laterLine].filter(Boolean).join(" ");
}

export const DAY_TO_DAY_TOOLS: OperatorTool[] = [
  tool({
    name: "get_tours",
    title: "Show tours",
    kind: "read",
    description:
      "Tours in progress and bookings for later, or one tour in detail when tourRef is set. Only a tour actually in progress counts as happening now. A booking for later counts as coming up. A visitor who is only texting, with no booked tour, is not a tour and is not counted. None reads \"No tours right now.\" One future booking reads \"1 tour coming up: {name} at {time} on {day}.\" When someone is touring and also has a later booking, the active row is the running tour and the later booking is their next booking, not a second tour. Never show tourRef to the landlord.",
    input: z.strictObject({ property: Property, tourRef: TourRef.optional() }),
    run: async (ctx, i) => {
      if (i.tourRef) {
        const tour = await findTour(ctx.services, i.tourRef);
        const attention = (await listExceptions(ctx.services, { propertyId: tour.propertyId })).filter((item) => item.tourRef === i.tourRef).map(exceptionItem);
        const view = inspectTourView(tour);
        return { summary: inspectTourSummary(view), tour: view, needsAttention: attention };
      }
      const propertyId = propertyIdOf(ctx, i.property);
      const now = ctx.now();
      const active = [];
      const happeningNames: string[] = [];
      const later: { at: number; line: string; view: Record<string, unknown> }[] = [];
      for (const tour of await tourSnapshots(ctx.services, { propertyId })) {
        const current = currentReservation(tour);
        if (current && isRunningReservation(current.status)) {
          active.push(tourSummary(tour));
          happeningNames.push(visitorNameOf(tour));
          continue;
        }
        const future = tour.bundle.reservations
          .filter((reservation) => isFutureBooking(reservation, now) && reservation.slotStart)
          .sort((a, b) => Date.parse(a.slotStart!) - Date.parse(b.slotStart!))[0];
        if (!future?.slotStart) continue;
        later.push({
          at: Date.parse(future.slotStart),
          line: `${visitorNameOf(tour)} at ${timeOnDay(new Date(future.slotStart), tour.config.property.timezone)}`,
          view: { ...tourSummary(tour), upcoming: true },
        });
      }
      later.sort((a, b) => a.at - b.at || a.line.localeCompare(b.line));
      return {
        summary: tourListSummary(happeningNames, later.map((item) => item.line)),
        active,
        upcoming: later.map((item) => item.view),
      };
    },
  }),
  tool({
    name: "schedule_tour",
    title: "Book or move a tour",
    kind: "change",
    description:
      "Books a one-off for a visitor who asked, or moves an existing tour. Pass phone, unit, and startsAt to book. Pass tourRef, reservationId, or visitor, plus the new time, to move. The first call asks. Call again with confirmationCode only after a clear yes. A time outside touring hours needs acknowledgeOutsideHours true after they agree to that. Does not change regular hours. Same refusals as booking or moving a tour today, including a paused property. Refuses on a property that isn't published.",
    input: z.strictObject({
      property: Property,
      phone: z.string().min(7).max(30).optional().describe("The visitor's phone number, when booking a tour they asked for."),
      visitorName: z.string().min(1).max(80).optional(),
      unit: Unit.optional(),
      startsAt: z.string().min(1).max(80).optional().describe('The time, such as "3:15 PM today".'),
      tourRef: TourRef.optional(),
      reservationId: z.string().min(3).max(40).optional(),
      visitor: z.string().min(1).max(80).optional().describe("The visitor's name, when moving a tour."),
      newStartsAt: z.string().min(1).max(80).optional().describe("The new time, when moving a tour."),
      confirmationCode: Code,
      acknowledgeOutsideHours: z.boolean().optional(),
    }),
    run: async (ctx, i) => {
      const propertyId = propertyIdOf(ctx, i.property);
      return attemptWrite(ctx, propertyId, async () => {
        const moving = !!(i.tourRef || i.reservationId || i.visitor);
        if (i.phone && moving) throw new SetupInputError("TOUR_UNCLEAR", "Should I book a new tour, or move one they already have?");
        if (i.phone) {
          if (!i.unit || !i.startsAt) throw new SetupInputError("TOUR_UNCLEAR", "To book a new tour, I need their phone number, the unit, and the time.");
          return scheduleOneOffTour(ctx, {
            property: i.property,
            phone: i.phone,
            visitorName: i.visitorName,
            unit: i.unit,
            startsAt: i.startsAt,
            confirmationCode: i.confirmationCode,
            acknowledgeOutsideHours: i.acknowledgeOutsideHours,
          });
        }
        const when = i.newStartsAt ?? i.startsAt;
        if (!moving || !when) throw new SetupInputError("TOUR_UNCLEAR", "Who's the tour for, or which tour should I move?");
        return rescheduleTour(ctx, {
          tourRef: i.tourRef,
          reservationId: i.reservationId,
          visitor: i.visitor,
          newStartsAt: when,
          confirmationCode: i.confirmationCode,
          acknowledgeOutsideHours: i.acknowledgeOutsideHours,
        });
      });
    },
  }),
  tool({
    name: "cancel_tour",
    title: "Call off a tour",
    kind: "change",
    description:
      "Calls one tour off for good and switches off its door access. The visitor is told. This cannot be undone. The first call asks. Call again with confirmationCode only after a clear yes. When they are touring and also have a later booking, this calls off the running tour.",
    input: z.strictObject({
      tourRef: TourRef,
      reason: z.string().min(1).max(300),
      confirmationCode: Code,
    }),
    run: async (ctx, i) =>
      attemptWrite(ctx, undefined, async () => {
        const target = await describeChangeTarget(ctx.services, i.tourRef, "revoke");
        const fingerprint = reservationFingerprint(target.reservation);
        if (!i.confirmationCode) {
          const tz = target.tour.config.property.timezone;
          const when = target.reservation.slotStart
            ? { time: formatTime(new Date(target.reservation.slotStart), tz), day: formatDay(new Date(target.reservation.slotStart), tz) }
            : undefined;
          const question = revokeConfirmQuestion(midSentence(target.name), target.unit, when);
          const confirmation = ctx.confirmations.issue("revoke", i.tourRef, fingerprint, question);
          return { status: "needs-confirmation", summary: question, confirmation };
        }
        ctx.confirmations.redeem(i.confirmationCode, "revoke", i.tourRef, fingerprint);
        const tour = await revokeTour(ctx.services, i.tourRef, i.reason);
        const after = await findTour(ctx.services, i.tourRef);
        const grants = after.bundle.accessGrants.filter((grant) => grant.reservationId === target.reservation.id);
        return {
          summary: `${target.name}'s tour is called off and their access is switched off.`,
          tour,
          accessSwitchedOff: grants.every((grant) => grant.status === "REVOKED"),
        };
      }),
  }),
  tool({
    name: "hold_tour",
    title: "Hold or resume one tour",
    kind: "change",
    description:
      "on pauses one running tour and switches its doors off. off resumes that tour. Doors still open only when policy allows. The first call asks. Call again with confirmationCode only after a clear yes. Pass a reason when hold is on.",
    input: z.strictObject({
      tourRef: TourRef,
      hold: z.enum(["on", "off"]),
      reason: z.string().min(1).max(300).optional(),
      confirmationCode: Code,
    }),
    run: async (ctx, i) =>
      attemptWrite(ctx, undefined, async () => {
        const change = i.hold === "on" ? "hold" : "resume";
        const target = await describeChangeTarget(ctx.services, i.tourRef, change);
        const fingerprint = reservationFingerprint(target.reservation);
        const action = i.hold === "on" ? "hold" : "resume";
        if (i.hold === "on" && !i.reason) throw new SetupInputError("REASON_MISSING", "Why should I put this tour on hold?");
        if (!i.confirmationCode) {
          const question =
            i.hold === "on"
              ? `Pause ${midSentence(target.name)}'s tour of ${target.unit}? Their doors will be switched off until you resume it.`
              : `Resume ${midSentence(target.name)}'s tour of ${target.unit}? Doors on their route can open again during their tour time.`;
          const confirmation = ctx.confirmations.issue(action, i.tourRef, fingerprint, question);
          return { status: "needs-confirmation", summary: question, confirmation };
        }
        ctx.confirmations.redeem(i.confirmationCode, action, i.tourRef, fingerprint);
        const tour = i.hold === "on" ? await placeHold(ctx.services, i.tourRef, i.reason!) : await clearHold(ctx.services, i.tourRef);
        return {
          summary: i.hold === "on" ? `${target.name}'s tour is paused. No doors will open until you resume it.` : `${target.name}'s tour is resumed.`,
          tour,
          hold: i.hold,
        };
      }),
  }),
  tool({
    name: "get_inbox",
    title: "Show what needs the landlord",
    kind: "read",
    description:
      "Everything waiting on the landlord: flagged questions (a fair-housing item has proposeDraft false), help requests, door problems, custom-time requests, and a published property with no time zone (Time zone needed, no id). Pass exceptionId or tourTimeRequestId for one item. Pass eventId for one alert. Each item that had an alert includes its eventId. When the visitor has no name, the summary starts Visitor at {number}, {place}:. Never show ids to the landlord.",
    input: z.strictObject({
      property: Property,
      exceptionId: ExceptionId.optional(),
      tourTimeRequestId: z.string().min(3).max(40).optional(),
      eventId: z.string().min(8).max(90).optional().describe("The eventId from an alert. Never show it to the landlord."),
      includeHandled: z.boolean().optional(),
    }),
    run: async (ctx, i) => {
      const announced = (id: string) => (ctx.installation?.outbox.get(id) ? { eventId: id } : {});
      if (i.eventId) {
        const record = installationOf(ctx).outbox.get(i.eventId);
        if (!record) throw new SetupInputError("UPDATE_NOT_FOUND", "I couldn't find that update.");
        const update = await describeOperatorUpdate(ctx.services, record.event, ctx.now(), { inbox: true });
        const instructions = typeof update.instructions === "string" ? update.instructions.replaceAll("answer_flagged_question", "resolve_issue") : update.instructions;
        const eventId = record.event.eventId;
        return {
          ...update,
          ...(instructions ? { instructions } : {}),
          eventId,
          ...("issue" in update && update.issue ? { issue: { ...update.issue, eventId } } : {}),
          ...("request" in update && update.request ? { request: { ...update.request, eventId } } : {}),
        };
      }
      if (i.exceptionId) {
        const item = await inspectException(ctx.services, i.exceptionId);
        const who = inboxPhoneVisitorLabel(item.visitorName) ?? item.visitorName;
        return {
          summary: `${who}${item.unitName ? `, ${item.unitName}` : ""}: ${item.summary}`,
          item: { ...exceptionItem(item), ...announced(exceptionEventId(item.exceptionId)), question: item.question, tour: item.tour, recentMessages: item.recentMessages },
        };
      }
      if (i.tourTimeRequestId) return { ...await inspectTourTimeRequest(ctx, i.tourTimeRequestId), ...announced(timeRequestEventId(i.tourTimeRequestId)) };
      const propertyId = propertyIdOf(ctx, i.property);
      const issues = await listExceptions(ctx.services, { propertyId, includeClosed: i.includeHandled });
      const times = await listTourTimeRequests(ctx, { property: i.property, includeHandled: i.includeHandled });
      const requests = ((times.requests as Array<Record<string, unknown>> | undefined) ?? []).map((request) => ({
        kind: "custom-time" as const,
        ...request,
        ...(typeof request.tourTimeRequestId === "string" ? announced(timeRequestEventId(request.tourTimeRequestId)) : {}),
      }));
      const zoneNeeded = i.includeHandled ? [] : unsetZoneInboxItems(ctx.services, propertyId);
      const items = [...zoneNeeded, ...issues.map((item) => ({ ...exceptionItem(item), ...announced(exceptionEventId(item.exceptionId)) })), ...requests];
      const open = items.filter((item) => {
        const status = (item as { status?: string }).status;
        return item.kind === "custom-time" ? status === "waiting" : status === "open";
      }).length;
      return {
        summary: open ? `${open} thing${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you.` : "Nothing needs you right now.",
        items,
      };
    },
  }),
  tool({
    name: "reply_to_time_request",
    title: "Reply to a custom time",
    kind: "change",
    description:
      "approve, decline, or propose a custom time. approve asks first and needs confirmationCode after a clear yes. A time outside touring hours also needs acknowledgeOutsideHours true. propose needs newStartsAt. decline tells the visitor and leaves their current booking. Same refusals as approving, declining, or offering a time today, including a paused property and a request whose time already passed.",
    input: z.strictObject({
      action: z.enum(["approve", "decline", "propose"]),
      tourTimeRequestId: z.string().min(3).max(40),
      newStartsAt: z.string().min(1).max(80).optional(),
      note: z.string().max(300).optional(),
      confirmationCode: Code,
      acknowledgeOutsideHours: z.boolean().optional(),
    }),
    run: async (ctx, i) =>
      attemptWrite(ctx, undefined, async () => {
        if (i.action === "approve") {
          return approveTourTimeRequest(ctx, {
            tourTimeRequestId: i.tourTimeRequestId,
            confirmationCode: i.confirmationCode,
            acknowledgeOutsideHours: i.acknowledgeOutsideHours,
          });
        }
        if (i.action === "decline") return declineTourTimeRequest(ctx, { tourTimeRequestId: i.tourTimeRequestId, note: i.note });
        if (!i.newStartsAt) throw new SetupInputError("TIME_UNCLEAR", "What time should I offer them?");
        return proposeTourTime(ctx, { tourTimeRequestId: i.tourTimeRequestId, newStartsAt: i.newStartsAt });
      }),
  }),
  tool({
    name: "resolve_issue",
    title: "Answer or close an issue",
    kind: "change",
    description:
      "answer texts the visitor through the approved-answer path and saves the fact. A fair-housing item with no draft is refused: This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled. The first answer call asks, and the quoted text is exactly what the visitor will get. Call again with confirmationCode only after a clear yes. close marks the issue handled with a note and changes nothing else. A handler-failed reply texts them and does not save a fact.",
    input: z.strictObject({
      action: z.enum(["answer", "close"]),
      exceptionId: ExceptionId,
      approvedFact: z.string().min(1).max(300).optional(),
      appliesTo: z.enum(["property", "unit"]).optional(),
      resolutionNote: z.string().min(1).max(500).optional(),
      confirmationCode: Code,
    }),
    run: async (ctx, i) =>
      attemptWrite(ctx, undefined, async () => {
        if (i.action === "close") {
          if (!i.resolutionNote) throw new SetupInputError("NOTE_MISSING", "Add a short note for how this was handled.");
          const { alreadyResolved, exception } = await resolveException(ctx.services, i.exceptionId, i.resolutionNote, ctx.now());
          const already = exception.kind === "handler-failed" ? ISSUE_ALREADY_HANDLED : "That was already marked handled.";
          return {
            summary: alreadyResolved ? already : `Marked handled: ${exception.visitorName}, ${exception.title.toLowerCase()}.`,
            issue: exceptionItem(exception),
          };
        }
        if (!i.approvedFact) throw new SetupInputError("FACT_MISSING", "I need the answer in your own words before I can add it.");
        const plan = await planFlaggedAnswer(ctx.services, { exceptionId: i.exceptionId, approvedFact: i.approvedFact, appliesTo: i.appliesTo }, ctx.now());
        const item = plan.exception;
        const fingerprint = `${item.exceptionId}|${plan.appliesTo}|${plan.field ?? ""}|${plan.fact}|${plan.sendOnly ? "send" : "save"}`;
        if (!i.confirmationCode) {
          if (plan.sendOnly) {
            const confirmation = ctx.confirmations.issue("answer", item.exceptionId, fingerprint, sendThisQuestion(plan.who, plan.fact));
            return { status: "needs-confirmation", summary: confirmation.question, confirmation, savedToSetup: false, visitorWillReceive: plan.fact };
          }
          const visitorWillReceive = visitorAnswerText(item.question!, plan.fact);
          const confirmation = ctx.confirmations.issue("answer", item.exceptionId, fingerprint, sendThisQuestion(plan.who, visitorWillReceive, { save: true }));
          return { status: "needs-confirmation", summary: confirmation.question, confirmation, visitorWillReceive };
        }
        ctx.confirmations.redeem(i.confirmationCode, "answer", item.exceptionId, fingerprint);
        const out = await answerFlaggedQuestion(ctx.services, { exceptionId: item.exceptionId, approvedFact: i.approvedFact, appliesTo: i.appliesTo }, ctx.now());
        if (plan.sendOnly) return { summary: `Sent to ${plan.who}.`, ...out };
        const saved = out as { approvedFact?: string; sendMissed?: "opted-out" | "unreachable"; visitorAnswered?: boolean; needsRecheck?: boolean };
        const answer = (saved.approvedFact ?? plan.fact).replace(/\.$/, "");
        if (saved.sendMissed === "opted-out") return { summary: saveSendOptedOutLine(answer, plan.who), ...out };
        if (saved.sendMissed === "unreachable") return { summary: saveSendUnreachableLine(answer, plan.who), ...out };
        return {
          summary: `Saved "${answer}"${out.visitorAnswered ? ` and sent it to ${plan.who}` : "; their tour isn't running, so they weren't texted"}.${out.needsRecheck ? " The setup changed, so run the readiness check and a practice tour again before publishing." : ""}`,
          ...out,
        };
      }),
  }),
  tool({
    name: "export_records",
    title: "Export records",
    kind: "change",
    description:
      `A day's audit export, or a readable export when kind is readable. Day is today (default), yesterday, YYYY-MM-DD, a month and day like Sept 28, or M/D. A month and day with no year means the most recent past one. Every landlord can export. A readable export is for people to read. It is not a backup. Each embedded tour keeps only that day's events and grants. A grant belongs to the day it was issued, and to the next day only if a door was used after midnight. Practice-tour denials are counted apart from visitors who were turned away. When only practice tours were denied, the summary says "No visitors were turned away." and then the practice-tour denial count.`,
    input: z.strictObject({
      kind: z.enum(["day", "readable"]).optional(),
      property: Property,
      day: z.string().max(20).optional(),
    }),
    run: async (ctx, i) => {
      if (i.kind === "readable") return installationOf(ctx).backups.createExport();
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { config } = ctx.services.workspace.load(id);
      const parsed = parseExportDay(i.day ?? "today", localDateOf(ctx.now(), config.property.timezone));
      if (!parsed.ok) return envelope(ctx, id, "blocked", "I couldn't read that date. Which day? Say today or a date like Sept 28.", {}, "DAY_UNREADABLE");
      const out = await exportAudit(ctx.services, id, { day: parsed.day, now: ctx.now() });
      const s = out.summary;
      return {
        summary: formatAuditDaySummary(s),
        totals: s,
        reference: `Audit export ${out.exportId}, saved with ${ctx.services.workspace.load(id).config.property.name}'s tour records on the Tour Core computer.`,
        accessGrants: out.accessGrants,
        denials: out.denials,
        files: out.files.map((file) => ({ file, ...auditExportFileLink(ctx, id, out.exportId, file) })),
      };
    },
  }),
  tool({
    name: "backup_records",
    title: "Back up records",
    kind: "change",
    description:
      `create builds a portable backup. confirm_destination records the Google Drive folder (provider google_drive, folderName Tour Core). confirm_stored records the file name and checksum after the file is saved. status says whether a backup is due. decline records that portable backups were skipped. On a hosted install, say "Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive." When records are already on this computer, or Google Drive is still waiting for approval, say "Your records stay on this computer. Portable backups stay off until Google Drive is connected." Declining stays possible. On a demo, declining keeps records on this computer. ${CHECKSUM_COVERS}`,
    input: z.strictObject({
      action: z.enum(["create", "confirm_destination", "confirm_stored", "status", "decline"]),
      reason: z.enum(["operator", "publish", "content", "tour", "routine"]).optional(),
      provider: z.literal("google_drive").optional(),
      folderName: z.string().min(1).max(80).optional(),
      accountLabel: z.string().trim().min(1).max(80).optional(),
      fileName: z.string().min(8).max(120).optional(),
      checksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    run: async (ctx, i) =>
      noteBlockedBackup(await attemptWrite(ctx, undefined, async () => {
        const backups = installationOf(ctx).backups;
        if (i.action === "status") return withChecksumCovers(backups.status());
        if (i.action === "decline") {
          const inst = installationOf(ctx);
          if (inst.records.model() !== "HOSTED_P0_VOLUME" && inst.records.provider() === "NOT_CONFIGURED") {
            inst.records.useLocalDemo();
            const google = googleClientConfig(inst.env(), (name) => inst.secrets.get(name as SettingName));
            if (!google.clientId || !google.clientSecret) {
              backups.decline();
              return withChecksumCovers({ summary: DRIVE_NOT_SET_UP_LINE });
            }
          }
          return withChecksumCovers(backups.decline());
        }
        if (i.action === "create") return withChecksumCovers(backups.create(i.reason));
        if (i.action === "confirm_destination") {
          if (!i.provider || !i.folderName) throw new SetupInputError("DESTINATION_MISSING", "What should the backup folder be called?");
          return withChecksumCovers(backups.confirmDestination({ provider: i.provider, folderName: i.folderName, accountLabel: i.accountLabel }));
        }
        if (!i.fileName || !i.checksum) throw new SetupInputError("BACKUP_MISMATCH", "That doesn't match the backup Tour Core created. Nothing was marked as stored.");
        return withChecksumCovers(backups.confirmStored({ fileName: i.fileName, checksum: i.checksum }));
      })),
  }),
  tool({
    name: "restore_records",
    title: "Restore records",
    kind: "change",
    description:
      `upload opens a short-lived upload. preview checks the file and changes nothing. import restores it only after confirmationCode from a clear yes. If this Tour Core already has records, pass recovery replace only after they explicitly choose replacement. Logins are not in the backup. A backup up to 50 MB is accepted. An upload over that cap is refused with a message that states the cap. Every expired upload says to send the file again, including a second look and a file that arrived before the link expired. Upload the backup file first is only for a live link with no file. An older ID check is named in the import summary: it now uses the basic identity form, and the landlord can ask for no form. Start a new upload with restore_records, action upload. ${CHECKSUM_COVERS}`,
    input: z.strictObject({
      action: z.enum(["upload", "preview", "import"]),
      uploadId: z.string().regex(/^art_[A-Za-z0-9_-]{20,80}$/).optional(),
      recovery: z.enum(["replace"]).optional(),
      confirmationCode: Code,
    }),
    run: async (ctx, i) =>
      noteBlockedBackup(await attemptWrite(ctx, undefined, async () => {
        const backups = installationOf(ctx).backups;
        if (i.action === "upload") return withChecksumCovers(backups.beginRestore());
        if (!i.uploadId) throw new SetupInputError("UPLOAD_MISSING", UPLOAD_BACKUP_FIRST);
        if (i.action === "preview") return withChecksumCovers(backups.preview(i.uploadId));
        const preview = backups.preview(i.uploadId);
        if (preview.replaceRequired && i.recovery !== "replace") {
          throw new SetupInputError("REPLACE_REQUIRED", "This Tour Core already has records. Restoring would replace them. Nothing was changed.");
        }
        const fingerprint = `${i.uploadId}:${i.recovery ?? "restore"}:${String(preview.checksum)}`;
        const question = preview.replaceRequired
          ? "Replace the records on this Tour Core with this backup? Logins for texting and updates are not in the backup."
          : "Restore this backup onto this Tour Core? Logins for texting and updates are not in the backup.";
        if (!i.confirmationCode) {
          const confirmation = ctx.confirmations.issue("import-backup", i.uploadId, fingerprint, question);
          return withChecksumCovers({ status: "needs-confirmation", summary: confirmation.question, confirmation, requiresConfirmation: true, lines: preview.lines });
        }
        ctx.confirmations.redeem(i.confirmationCode, "import-backup", i.uploadId, fingerprint);
        return withChecksumCovers(backups.importBackup(i.uploadId, i.recovery));
      })),
  }),
];
