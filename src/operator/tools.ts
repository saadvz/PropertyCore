import { z } from "zod";
import type { Installation } from "../install/installation";
import type { ConnectorScope } from "../mcp/scopes";
import { secretValues } from "../install/settings";
import { HOSTED_ADMIN_TOOLS } from "../install/hostedAdminTools";
import type { ReportedClient } from "../playbooks/select";
import { INSTALLATION_TOOLS } from "../install/tools";
import { hoursAlreadyChosen, MILESTONE_TOOLS, settingsSentence } from "./milestones";
import { installedMessaging } from "../install/status";
import { addressConfirmQuestion, nextAddressPartQuestion, savedFullAddress } from "../setup/address";
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES, SETUP_PROPERTY_TYPES, validateConfig } from "../config/tourCoreConfig";
import { extractValues, FIELD_WORDS, missingProfileFields, nextProfileQuestion, parseBulkUnitDetails, profileSummaryLine } from "../config/unitProfile";
import { formatPhone } from "../core/phone";
import { formatDay, formatTime, spokenTimeZone, UnsetTimeZoneError } from "../core/timezone";
import { UNSET_ZONE_LINE } from "../setup/storedTimeZone";
import { applyZoneSwitchAnswer, commitZoneAnswer, fieldsToHold, guessedZoneName, heldZoneFields, holdZoneSwitchFields, mergedZoneDetails, rememberZoneSwitch, switchHoldReply, switchQuestionForOffer, zoneReply, zoneSwitchAnswer, zoneSwitchQuestion } from "./zoneCopy";
import { revokeConfirmQuestion } from "../core/availabilityCopy";
import { TourCoreError } from "../core/TourCore";
import { PortableBackupError } from "../backup/portable";
import { InvalidTransitionError } from "../domain/stateMachine";
import { checkMessaging, UnavailableModeError } from "../createTourCore";
import type { MessagingLedger } from "../messaging/ledger";
import { applySetupCommand } from "../setup/commands";
import { draftView, readinessView, saveStateView } from "../setup/presenters";
import { reuseDaysRefusal } from "../config/validateConfig";
import { parseDays, parseMinutes, parseTimeOfDay } from "../setup/parse";
import { planTourHours } from "./hoursPlan";
import type { DryTourCheck, DryTourResult } from "../setup/dryTour";
import type { ReadinessResult } from "../setup/readiness";
import { condoNextQuestion, createPropertySetup, localTestModeSentence, modeSentence, operatorFacingPropertyName, OperatorTeamCopy, SetupInputError, tourableSpacesQuestion, visitorHelpLines, visitorHelpQuestion, type SetupDraft } from "../setup/setupActions";
import { NO_FORM_QUESTION } from "../setup/verification";
import { usesLocalMessaging } from "../messaging/propertyScope";
import { operatorUnitName } from "../visitor/identity";
import { isHostedRailway } from "../install/deployment";
import { statusLabel, type PublishBlocker } from "../setup/workspace";
import { rememberCanonical, revertCanonical } from "../storage/canonical";
import { StorageConflictError, StorageUnavailableError, StoreBusyError } from "../storage/errors";
import { pauseTours, removeProperty, resumeTours, unitPausedFlag } from "./availability";
import { exportAudit, formatAuditDaySummary, parseLocalDate } from "./auditExport";
import { AuditExportLinks } from "./auditExportLinks";
import type { ConfirmationBook } from "./confirmations";
import {
  answerFlaggedQuestion,
  planFlaggedAnswer,
  clearHold,
  describeChangeTarget,
  findException,
  inspectException,
  ISSUE_ALREADY_HANDLED,
  listExceptions,
  placeHold,
  resolveException,
  revokeTour,
  saveSendOptedOutLine,
  saveSendUnreachableLine,
  sendThisQuestion,
  visitorAnswerText,
  type OperatorException,
} from "./exceptions";
import { matchDoor, requireUnit, resolvePropertyId } from "./resolve";
import { defaultMessagingMode, type OperatorServices } from "./services";
import { publishGuards, publishProperty, readinessForProperty, runPracticeTour, visitorTexting } from "./setupFlow";
import { findTour, inspectTourSummary, inspectTourView, listActiveTours, midSentence } from "./tours";
import { approveTourTimeRequest, declineTourTimeRequest, inspectTourTimeRequest, listTourTimeRequests, proposeTourTime, rescheduleTour, scheduleOneOffTour } from "./tourTimes";
import { attemptWrite, DAY_TO_DAY_TOOLS } from "./dayToDay";
import { injectLocalSms, readLocalOutbox } from "./localSms";

/**
 * Tour Core's operator tool contract: a narrow, provider-neutral list of
 * typed actions any agent host (Grok Bot today) can call. Every tool
 * validates its input and calls the same setup, tour and exception actions
 * the browser uses. There is deliberately no tool that opens a door, mints
 * access or edits records directly: door access is only ever requested by a
 * visitor's own tour, through Tour Core's policy, to Durin.
 *
 * Results are plain language. Fields ending in "Id" or "Ref" are handles to
 * pass back to later tools; operators never need to see them.
 */

export interface ToolContext {
  services: OperatorServices;
  confirmations: ConfirmationBook;
  now: () => Date;
  /** Where the operator can open Tour Core on this computer (for export downloads and secure setup). */
  localUrl?: () => string | undefined;
  /** This installation (manifest, provider settings, alerts), for the installation tools. */
  installation?: Installation;
  /** Visitor messaging settings changed: drop any cached connection so the next message uses them. */
  resetMessaging?: () => void;
  /** The OAuth client calling this tool, when the request was authenticated that way. */
  caller?: { clientId?: string };
  /** Who called MCP initialize. Picks a playbook only. Never changes a gate. */
  client?: ReportedClient;
  /** Drops process memory (sessions, ledger, pending OAuth) after a hosted demo reset. */
  forgetLiveState?: () => void;
  /** Shared inbound/outbound de-duplication for this process, including local SMS inject. */
  messagingLedger?: MessagingLedger;
  /**
   * Set only by an HTTP connector. Unset keeps the full engine catalog
   * (browser, in-process tests, eval harness).
   */
  connector?: ConnectorScope;
}

export type ToolKind = "read" | "change" | "consequential";

export interface OperatorTool {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: z.ZodObject;
  run: (ctx: ToolContext, input: never) => Promise<Record<string, unknown>>;
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<Record<string, unknown>>;
}): OperatorTool {
  return def as unknown as OperatorTool;
}

// ------------------------------------------------------------------ inputs

const Property = z.string().max(200).optional().describe("Which property: its name, address or propertyId. Leave out when there's only one.");
const Unit = z.string().min(1).max(100).describe('The unit, e.g. "Unit 101" or "101".');
const TourRef = z.string().min(3).max(200).describe("The tourRef from list_active_tours or an exception. Never show it to the operator.");
const ExceptionId = z.string().min(3).max(60).describe("The exceptionId from list_exceptions. Never show it to the operator.");
const Code = z.string().max(20).optional().describe("Only after the operator explicitly said yes to the exact question this tool returned earlier.");
const Facts = z.array(z.string().max(300)).max(30);
const UnitValue = z.union([z.string().max(300), z.number(), z.boolean()]).optional();
const Duration = z.union([z.number().int(), z.string().max(40)]);

// ----------------------------------------------------------------- helpers

/** The shared services, with this installation's texting (when there is one) visible to setup and publishing. */
function servicesOf(ctx: ToolContext): OperatorServices {
  const installation = ctx.installation;
  if (!installation) return ctx.services;
  return { ...ctx.services, installedMessaging: () => installedMessaging(installation) };
}

const PROPERTY_TYPE_CHOICES = SETUP_PROPERTY_TYPES.map((t) => ({ choice: t, label: PROPERTY_TYPE_LABELS[t] }));

/** The next property question Tour Core wants asked, so the setup order depends on the property type. */
function propertyNextQuestion(
  draft: SetupDraft,
  options: { cityJustSaved?: boolean } = {},
): { nextQuestion: string; choices?: { choice: string; label: string }[]; suggestedName?: string; confirmAddress?: boolean } | undefined {
  const canonical = draft.property.canonicalAddress;
  const part = nextAddressPartQuestion(canonical, options);
  if (part) return { nextQuestion: part };
  if (canonical?.postalCode && !draft.property.addressConfirmed) {
    const nextQuestion = addressConfirmQuestion(canonical);
    if (nextQuestion) return { nextQuestion, confirmAddress: true };
  }
  if (!draft.property.propertyType) return { nextQuestion: "What type of property is this?", choices: [...PROPERTY_TYPE_CHOICES] };
  const condo = condoNextQuestion(draft);
  if (condo) return condo;
  if (draft.units.length) return visitorHelpQuestion(draft);
  const spaces = tourableSpacesQuestion(draft);
  return spaces ? { nextQuestion: spaces.question, ...(spaces.suggestedName ? { suggestedName: spaces.suggestedName } : {}) } : undefined;
}

/** Drops nextQuestion when the summary already asks it. Choices and the confirm flag stay. */
function exposeFollow<T extends { nextQuestion: string }>(summary: string, follow: T | undefined) {
  if (!follow) return {};
  if (!summary.includes(follow.nextQuestion)) return follow;
  const { nextQuestion: _dropped, ...rest } = follow;
  return rest;
}

/** The visitor-facing texting and door lines, kept apart: texting can be live while door access is demo. */
function subsystemLines(ctx: ToolContext, id: string, draft: SetupDraft) {
  const services = servicesOf(ctx);
  const texting = visitorTexting(services, id, draft.messagingMode);
  const local = usesLocalMessaging(draft, services.installedMessaging?.());
  return {
    texting,
    lines: [`Visitor texting: ${texting.label}`, `Door access: ${draft.accessMode === "durin-mock" ? "Demo" : "Connected"}`],
    sentence: local
      ? localTestModeSentence(draft.accessMode === "durin-mock")
      : modeSentence(texting.state === "connected", draft.accessMode === "durin-mock"),
  };
}

/** Local computer link when that's all we have; hosted public URL with a short-lived token. */
function auditExportFileLink(ctx: ToolContext, propertyId: string, exportId: string, file: string): { openOnTourCoreComputer?: string } {
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

function openDraft(ctx: ToolContext, property: string | undefined): { id: string; draft: SetupDraft } {
  const id = resolvePropertyId(ctx.services.workspace, property);
  return { id, draft: ctx.services.workspace.openDraft(id).draft };
}

/** Runs one setup edit through the same command table the browser uses, then saves (or keeps a draft). */
function edit(ctx: ToolContext, id: string, draft: SetupDraft, command: string, input: unknown) {
  const next = applySetupCommand(draft, command, input);
  ctx.services.workspace.persistEdit(next, ctx.now());
  return setupState(ctx, id);
}

function setupState(ctx: ToolContext, id: string) {
  const ws = ctx.services.workspace;
  const { draft, unsavedChanges } = ws.openDraft(id);
  const problems = validateConfig(draft).map((i) => i.message);
  return {
    saved: saveStateView(draft, unsavedChanges).label,
    status: ws.has(id) ? statusLabel(ws.load(id)) : "Setup in progress",
    problems,
  };
}

function setupSnapshot(ctx: ToolContext, id: string) {
  const { draft } = ctx.services.workspace.openDraft(id);
  const view = draftView(draft);
  const saved = ctx.services.workspace.has(id) ? ctx.services.workspace.load(id) : undefined;
  const pausedUnits = saved ? saved.config.units.filter((unit) => unitPausedFlag(saved.state, unit.id)).map((unit) => operatorUnitName(draft.property, unit.name)) : [];
  return {
    propertyId: id,
    name: operatorFacingPropertyName(draft),
    address: view.property.address,
    ...(saved ? { paused: !!saved.state.paused || pausedUnits.length === saved.config.units.length && saved.config.units.length > 0, removed: !!saved.state.removedAt, ...(pausedUnits.length ? { pausedUnits } : {}) } : {}),
    ...(draft.property.displayName ? { propertyName: draft.property.displayName } : {}),
    propertyType: draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : "Not chosen yet",
    ...(draft.property.buildingAccess ? { buildingAccess: draft.property.buildingAccess === "UNIT_ONLY" ? "Unit door only" : "Building entrance and unit door" } : {}),
    ...(view.property.timezone ? { timezone: `${view.property.timezoneLabel} (${view.property.timezone})` } : {}),
    propertyFacts: view.property.facts,
    units: view.units.map((u) => ({
      unitId: u.id,
      name: u.name,
      description: u.summary || undefined,
      facts: u.facts,
      door: u.door?.name,
      route: u.route ? u.route.doorNames.join(" \u2192 ") : undefined,
      directions: u.route?.directions || undefined,
      ...(draft.units.find((unit) => unit.id === u.id)?.entryInstructions ? { entryInstructions: draft.units.find((unit) => unit.id === u.id)!.entryInstructions } : {}),
      ...(saved ? { paused: unitPausedFlag(saved.state, u.id) } : {}),
    })),
    doors: view.doors.map((d) => ({ doorId: d.id, name: d.name, kind: d.kindLabel, ...(d.unitName ? { forUnit: d.unitName } : {}) })),
    tourHours: view.tourHours.summary ?? view.tourHours.label,
    tourLength: view.tourHours.lengthLabel,
    newTourEvery: view.tourHours.spacingLabel,
    earlyArrival: view.tourHours.earlyLabel,
    verification: view.reviewCards.find((c) => c.step === "verification")?.rows ?? [],
    recordsAndMessages: view.services.items.map((s) => s.title),
    visitorTexting: subsystemLines(ctx, id, draft).texting.label,
    doorAccess: draft.accessMode === "durin-mock" ? "Demo" : "Connected",
    alertsGoTo: view.operator.name,
    ...(view.operator.visitorContact ? { visitorHelpNumber: formatPhone(view.operator.visitorContact) } : {}),
    ...setupState(ctx, id),
  };
}

/** The one tourable space on a single-family home. Multi-unit properties stay unspecified. */
function soleSingleFamilyUnit(draft: SetupDraft) {
  return draft.property.propertyType === "SINGLE_FAMILY" && draft.units.length === 1 ? draft.units[0] : undefined;
}

function unitDetailsView(ctx: ToolContext, id: string) {
  const { draft } = ctx.services.workspace.openDraft(id);
  const missing = draft.units.map((u) => ({ unit: operatorUnitName(draft.property, u.name), missing: missingProfileFields(u).map((f) => FIELD_WORDS[f]) })).filter((m) => m.missing.length);
  const facing = draft.units.map((u) => ({ ...u, name: operatorUnitName(draft.property, u.name) }));
  const next = nextProfileQuestion(facing);
  const lines = facing.map(profileSummaryLine);
  return {
    summary: next ? `${lines.join("\n")}\n\n${next.question}` : `${lines.join("\n")}\n\nDoes that look right?`,
    lines,
    complete: !next,
    missing,
    ...(next ? { nextQuestion: next.question } : {}),
    instructions: next
      ? "Read the lines back, then ask nextQuestion. Only the operator's words count; if they don't know or don't want it listed, pass that as their answer."
      : 'Read the lines back and ask "Does that look right?" before moving on to doors and routes.',
  };
}

const MESSAGING_CHOICES = [
  { choice: "live", label: "Real texts to visitors' phones", recommended: true },
  { choice: "local", label: "Local test texts for this building (no real texts are sent)", recommended: false },
  { choice: "demo", label: "Practice only: texts show on screen, nobody is texted", recommended: false },
] as const;

const RECORDS_CHOICES = [
  { choice: "this-computer", label: "On this computer", available: true },
  { choice: "google-drive", label: "A folder in your Google Drive", available: false, note: "Coming next; not available yet." },
] as const;

function readinessOut(result: ReadinessResult, savedChanges: boolean) {
  const view = readinessView(result);
  return {
    passed: result.passed,
    summary: view.headline,
    checks: view.checks.map((c) => ({ check: c.label, ok: c.ok, problems: c.problems.map((p) => p.message) })),
    lines: [
      ...view.checks.map((c) => (c.ok ? `\u2713 ${c.label}` : `\u2717 ${c.label}: ${c.problems.map((p) => p.message).join(" ")}`)),
      ...view.advisories,
    ],
    advisories: view.advisories,
    savedChanges,
  };
}

const PROOF: Record<string, (c: DryTourCheck) => string | undefined> = {
  inquiry: () => undefined,
  reserved: () => "Booking worked",
  consent: () => "Consent to texts and tour records was recorded",
  identity: (c) => (c.label === "No identity form" ? "No identity form" : "Verification worked"),
  ready: () => undefined,
  early_arrival: () => "Early arrival was denied",
  entrance: () => "Entrance access was allowed at the right time",
  unit_door: (c) => `${c.label.replace(/^Visitor enters /, "")} access was allowed`,
  duplicate: () => "A repeated request didn't create a second access grant",
  wrong_door: (c) => `${c.label.replace(/^Visitor tries /, "")} (not on the route) was turned away before any door was unlocked`,
  completed: () => "Tour completed",
  revoked: () => "Every door was locked again afterwards",
  follow_up: () => "Follow-up worked",
  t15_questions: () => "The 15-minutes-left questions text was sent",
  t5_warning: () => "The 5-minute extra-time offer was sent",
  extension_granted: () => "A one-time 10-minute extension was granted",
  overstay_end: () => "The tour-end text was sent (no extra time taken)",
  overstay_plus5: () => "The 5-minutes-after check-in was sent",
  overstay_closed: () => "The tour was closed 15 minutes after the end",
  records: () => "Tour records were saved",
};

function proofPoints(result: DryTourResult): string[] {
  return result.checks.flatMap((c) => {
    if (!c.ok) return [`\u2717 ${c.label}${c.detail ? `: ${c.detail}` : ""}`];
    const text = (PROOF[c.id] ?? ((x: DryTourCheck) => x.label))(c);
    if (!text) return [];
    if (c.skipped) return [`\u2013 ${text}: ${c.detail ?? "Skipped."}`];
    return [`\u2713 ${text}`];
  });
}

function exceptionLine(x: OperatorException) {
  return {
    exceptionId: x.exceptionId,
    tourRef: x.tourRef,
    property: x.property,
    visitorName: x.visitorName,
    unitName: x.unitName,
    what: x.title,
    summary: x.summary,
    tourStatus: x.tourStatus,
    accessBlocked: x.accessBlocked,
    when: x.when,
    status: x.status,
    ...(x.proposeDraft === false ? { proposeDraft: false as const } : {}),
    ...(x.resolution ? { resolution: x.resolution.note, ...(x.resolution.approvedFact ? { approvedFact: x.resolution.approvedFact } : {}) } : {}),
    nextSteps: x.nextSteps,
  };
}

function needsConfirmation(ctx: ToolContext, action: string, target: string, fingerprint: string, question: string, details: Record<string, unknown> = {}) {
  const request = ctx.confirmations.issue(action, target, fingerprint, question);
  return {
    status: "needs-confirmation",
    summary: question,
    confirmation: request,
    instructions: "Ask the operator exactly this question. Call this tool again with confirmationCode only if they clearly say yes.",
    ...details,
  };
}

const reservationFingerprint = (r: { id: string; status: string; updatedAt: string }) => `${r.id}|${r.status}|${r.updatedAt}`;

function parseHours(input: { days?: string | string[]; start?: string; end?: string; tourLength?: string | number; newTourEvery?: string | number; earlyArrival?: string | number }) {
  const out: Record<string, unknown> = {};
  if (input.days !== undefined) {
    const text = Array.isArray(input.days) ? input.days.join(", ") : input.days;
    const days = parseDays(text);
    if (!days) throw new SetupInputError("TOUR_DAYS_UNREADABLE", `I didn't understand the days "${text}". Try "weekdays", "every day" or "Mon-Sat".`);
    out.days = days;
  }
  for (const key of ["start", "end"] as const) {
    if (input[key] === undefined) continue;
    const t = parseTimeOfDay(input[key]!);
    if (!t) throw new SetupInputError("TOUR_TIME_UNREADABLE", `I didn't understand the time "${input[key]}". Try something like "9am" or "5:30 PM".`);
    out[key] = t;
  }
  const minutes = (v: string | number | undefined, label: string) => {
    if (v === undefined) return undefined;
    const n = typeof v === "number" ? v : parseMinutes(v);
    if (n === undefined) throw new SetupInputError("TOUR_MINUTES_UNREADABLE", `I didn't understand ${label} "${v}". Try "45 minutes" or "an hour".`);
    return n;
  };
  const length = minutes(input.tourLength, "the tour length");
  const spacing = minutes(input.newTourEvery, "how often tours start");
  const early = minutes(input.earlyArrival, "the early-arrival time");
  if (length !== undefined) out.tourLengthMinutes = length;
  if (spacing !== undefined) out.slotEveryMinutes = spacing;
  if (early !== undefined) out.earlyArrivalMinutes = early;
  return out;
}

// ------------------------------------------------------------------- tools

export const OPERATOR_TOOLS: OperatorTool[] = [
  // ---------------------------------------------------- setup: property
  tool({
    name: "list_properties",
    title: "List properties",
    kind: "read",
    description: "Every property set up in Tour Core, with its status. Removed properties are omitted. Paused properties say so. Use first when the operator hasn't said which property.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const ws = ctx.services.workspace;
      const properties = ws
        .propertyIds()
        .filter((id) => !ws.has(id) || !ws.load(id).state.removedAt)
        .map((id) => {
          const { draft } = ws.openDraft(id);
          const saved = ws.has(id) ? ws.load(id) : undefined;
          return {
            propertyId: id,
            name: operatorFacingPropertyName(draft),
            address: draft.property.address,
            status: saved ? statusLabel(saved) : "Setup in progress",
            ...(saved ? { paused: !!saved.state.paused || (saved.config.units.length > 0 && saved.config.units.every((unit) => (saved.state.pausedUnitIds ?? []).includes(unit.id))) } : {}),
          };
        });
      return { summary: properties.length ? `${properties.length} ${properties.length === 1 ? "property" : "properties"}.` : "No properties are set up yet.", properties };
    },
  }),
  tool({
    name: "get_property_setup",
    title: "Get property setup",
    kind: "read",
    description: "The property's current setup: address, units, doors, routes, tour hours, verification, messaging, whether tours are paused or the property was removed, and any problems. Read-only.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { draft } = ctx.services.workspace.openDraft(id);
      const setup = setupSnapshot(ctx, id);
      const published = ctx.services.workspace.has(id) && ctx.services.workspace.load(id).state.status === "PUBLISHED_FOR_DEMO";
      return { summary: `${setup.name}: ${setup.status}.`, setup, ...(published ? {} : propertyNextQuestion(draft)) };
    },
  }),
  tool({
    name: "create_property_setup",
    title: "Start a property setup",
    kind: "change",
    description:
      "Starts a new property from its street address. The address is what visitors hear unless the operator gives a public property name themselves: never suggest or invent one. A US address needs a street, city, state and ZIP. Ask for one missing part at a time and keep every part already given. A missing street is nextQuestion (\"What's the street address?\"). A missing state is nextQuestion (\"What state is it in?\") before any city question. A city saved while the state is still missing is kept, and the reply is \"Got it. What state is that in?\". Ask nextQuestion (\"What city should I use?\") only once the street and state are saved, and save it with update_property_details city. If the ZIP is missing, ask nextQuestion (\"What ZIP code should I use?\") and save it with update_property_details postalCode. Then ask them to confirm the one-line read-back (\"Did I get that right: ...?\") before property type. A unit in the address is read back between the street and the city. Never guess the type from the address. The time zone is guessed from the state, or from the ZIP when no state is saved. A street with neither leaves the time zone unset. Do not mention a time zone until a state is known. A street typed on its own keeps its suffix. A guessed time zone updates only before the address is confirmed, and never on a property that was published or already had a confirmed address or an operator-set zone. When the summary already asks the next question, nextQuestion is omitted. Ask the summary once. Visitor texting is connected automatically when this Tour Core has it. A new property starts with tour hours Monday–Friday, 9:00 AM–5:00 PM, 45-minute tours, a new tour every hour, and 10 minutes early, until the operator changes them with set_tour_hours. If a property with that address already exists, it's returned instead of creating a second one. Also the tool for the installation step that offers another property after one is already published.",
    input: z.strictObject({
      address: z.string().min(1).max(200).describe("The property's street address, as the operator confirmed it."),
      name: z.string().max(120).optional().describe("Only a property or building name the operator said themselves. Leave out otherwise; the address is used."),
      propertyType: z.enum(PROPERTY_TYPES).optional().describe("Only once the operator said which type it is."),
      timezone: z.string().max(60).optional().describe('Only if the operator said it, e.g. "Eastern" or "America/Chicago".'),
    }),
    run: async (ctx, i) => {
      const ws = ctx.services.workspace;
      const existing = ws.findByAddress(i.address);
      if (existing) {
        const address = savedFullAddress(ws.openDraft(existing).draft.property);
        return { status: "already-exists", summary: `${address} is already set up. I'll keep working on that one.`, setup: setupSnapshot(ctx, existing) };
      }
      const messagingMode = defaultMessagingMode(servicesOf(ctx).installedMessaging?.());
      const draft = createPropertySetup({ address: i.address, name: i.name, propertyType: i.propertyType, timezone: i.timezone, existingPropertyIds: ws.propertyIds(), messagingMode });
      ws.saveDraft(draft);
      const follow = propertyNextQuestion(draft);
      const guessed = guessedZoneName("", "", draft, i.timezone !== undefined);
      const summary = zoneReply(`Started ${draft.property.name}.`, "", guessed, guessed ? follow?.nextQuestion : undefined);
      return {
        status: "created",
        summary,
        ...(guessed ? { timezoneGuess: guessed } : {}),
        ...exposeFollow(summary, follow),
        setup: setupSnapshot(ctx, draft.property.id),
      };
    },
  }),
  tool({
    name: "update_property_details",
    title: "Update property details",
    kind: "change",
    description:
      "Changes the property's type, address, street, city, state, ZIP, public name, time zone, approved property facts, apartment or condo building-door control, or optional entry instructions. The name is only one the operator said (an empty name goes back to using the address). A street, city, state or ZIP does not invent the rest of the address, and each part already given is kept. A street with no state or ZIP leaves the time zone unset until one of those gives a zone. Changing the state when a ZIP is already saved runs the ZIP check. On a mismatch, ask \"That ZIP doesn't look like it's in {state}. Which one should I fix, the ZIP or the state?\" and save nothing until they answer. Ask for one missing part at a time: \"What's the street address?\", then \"What state is it in?\" before any city question. A guessed time zone updates only before the address is confirmed, and never on a property that was published or already had a confirmed address or an operator-set zone. When the summary already asks the next question, nextQuestion is omitted. Ask the summary once. When a state change would move a locked time zone, ask the switch question first, on its own: \"Tours still run on {current zone} time. Should I switch to {new zone} time?\" Do not add the next setup question until they answer. timezone \"yes\" switches to the offered zone. timezone \"no\" keeps the current zone. A named zone such as \"Pacific\" or \"keep Eastern\" is that choice. A ZIP is not a yes and does not switch. A ZIP or other detail sent while that question is open is held, not saved yet. The reply is \"Before I save that, one thing. Tours still run on {current zone} time. Should I switch to {new zone} time?\" Once they answer, what they sent while the question was open is saved. Do not send it again. A city given while the state is still missing is kept, and the reply is \"Got it. What state is that in?\". Ask \"What city should I use?\" only once the street and state are saved. confirmAddress is true only after they agree to the one-line read-back. Facts must be the operator's own words. For an apartment or condo, buildingAccess is BUILDING_AND_UNIT or UNIT_ONLY from \"Do you control the building entrance, or only the unit door?\"; entryInstructions is how visitors get in and find the unit, sent only after identity verification. If they skip that, pass skipEntryInstructions true and store nothing. Returns nextQuestion when something still has to be asked, and that question comes before property type until the address is confirmed. After the rest of the setup is saveable, nextQuestion is \"What number can stuck visitors call? Pick one someone answers during tour hours.\" visitorContact is that optional number visitors see and call; it is never the team's private alert line. Saving, changing, or clearing it keeps a published property published and does not require a new readiness check or practice tour. If they skip it, pass skipVisitorHelp true so the question is not asked again.",
    input: z.strictObject({
      property: Property,
      propertyType: z.enum(PROPERTY_TYPES).optional().describe("From the operator's answer to \"What type of property is this?\" Use APARTMENT_OR_CONDO for one apartment or condo unit, not a whole building."),
      name: z.string().max(120).optional().describe("Only a property or building name the operator said. Empty removes it."),
      address: z.string().max(200).optional(),
      street: z.string().max(120).optional().describe("The street address the operator gave. Don't invent one."),
      city: z.string().max(80).optional().describe("The city the operator gave. Don't invent one. Kept even when the state is still missing."),
      state: z
        .string()
        .max(40)
        .optional()
        .describe(
          'The state the operator gave, such as NJ or New Jersey. Don\'t invent one. If it isn\'t a US state, the reprompt is exactly: "I didn\'t catch that state. Which state is it, like NJ or New Jersey?"',
        ),
      postalCode: z.string().max(10).optional().describe("The ZIP code the operator gave. Five digits. Don't invent one. Kept even when another part is still missing."),
      confirmAddress: z.boolean().optional().describe("True only after the operator agreed the read-back address is right."),
      timezone: z.string().max(60).optional(),
      facts: Facts.optional().describe("The full list of approved property facts, in the operator's words."),
      alertName: z.string().max(120).optional().describe(`Who should hear about problems. ${OperatorTeamCopy.hint()} Rendered exactly as entered.`),
      alertContact: z.string().max(200).optional(),
      visitorContact: z
        .string()
        .max(30)
        .optional()
        .describe("Optional number visitors see and call if they get stuck. Pick one someone answers during tour hours. Empty clears it. Never the team's private alert line."),
      skipVisitorHelp: z
        .boolean()
        .optional()
        .describe("True when the operator explicitly skips the optional visitor help number. Records the skip so the question is not asked again."),
      buildingAccess: z
        .enum(["BUILDING_AND_UNIT", "UNIT_ONLY"])
        .optional()
        .describe('Apartment or condo: BUILDING_AND_UNIT if they control the building entrance, UNIT_ONLY if they only control the unit door.'),
      entryInstructions: z
        .string()
        .max(500)
        .optional()
        .describe("Optional landlord words for getting in and finding the unit. Skip or empty stores nothing; never send a blank line."),
      skipEntryInstructions: z
        .boolean()
        .optional()
        .describe("True when the operator skips the optional entry-instructions question. Stores nothing and does not ask again."),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const pending = switchQuestionForOffer(draft);
      const answer = zoneSwitchAnswer(draft, i.timezone);
      if (pending && !answer.answered) {
        const incoming = fieldsToHold(i);
        if (holdZoneSwitchFields(draft, incoming)) ctx.services.workspace.persistEdit(draft, ctx.now());
        return { summary: incoming ? switchHoldReply(pending) : pending, setup: setupSnapshot(ctx, id) };
      }
      const held = heldZoneFields(draft);
      const stateBefore = draft.property.canonicalAddress?.state.trim() ?? "";
      const timezoneBefore = draft.property.timezone;
      const timezone = answer.answered ? answer.timezone : i.timezone;
      const everPublished = ctx.services.workspace.wasEverPublished(id);
      const apply = (dropPostal: boolean) => {
        const details = mergedZoneDetails(i, held, timezone, dropPostal);
        let result = applySetupCommand(draft, "setPropertyDetails", {
          name: details.name,
          address: details.address,
          propertyType: details.propertyType,
          timezone: details.timezone,
          facts: details.facts,
          street: details.street,
          city: details.city,
          state: details.state,
          postalCode: details.postalCode,
          confirmAddress: details.confirmAddress,
          buildingAccess: details.buildingAccess,
          entryInstructions: details.entryInstructions,
          skipEntryInstructions: details.skipEntryInstructions,
        }, { everPublished });
        if (details.alertName !== undefined || details.alertContact !== undefined || details.visitorContact !== undefined || details.skipVisitorHelp) {
          result = applySetupCommand(result, "setAlertContact", {
            name: details.alertName,
            contact: details.alertContact,
            visitorContact: details.visitorContact,
            skipVisitorHelp: details.skipVisitorHelp,
          });
        }
        applyZoneSwitchAnswer(result, answer);
        rememberZoneSwitch(result, stateBefore, timezone !== undefined);
        ctx.services.workspace.persistEdit(result, ctx.now());
        return result;
      };
      const next = answer.answered ? commitZoneAnswer(apply) : apply(false);
      const setup = setupSnapshot(ctx, id);
      const switchQuestion = zoneSwitchQuestion(stateBefore, next, timezone !== undefined);
      const guessed = guessedZoneName(stateBefore, timezoneBefore, next, timezone !== undefined);
      const follow = propertyNextQuestion(next, { cityJustSaved: i.city !== undefined || held?.city !== undefined });
      if (switchQuestion) return { summary: zoneReply(`Updated ${setup.name}.`, switchQuestion, ""), setup };
      const summary = guessed
        ? zoneReply(`Updated ${setup.name}.`, "", guessed, follow?.nextQuestion)
        : `Updated ${setup.name}. ${setup.saved}.`;
      return { summary, ...exposeFollow(summary, follow), setup };
    },
  }),

  // ------------------------------------------------ setup: units, doors
  tool({
    name: "list_units",
    title: "List units",
    kind: "read",
    description: "The tourable units with their description, approved facts, own door, route, and whether that unit is paused for new bookings.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { draft } = openDraft(ctx, i.property);
      const { units } = setupSnapshot(ctx, id);
      return { summary: units.length ? units.map((u) => operatorUnitName(draft.property, u.name)).join(", ") : "No units yet.", units };
    },
  }),
  tool({
    name: "add_unit",
    title: "Add a unit",
    kind: "change",
    description:
      'Adds one tourable unit or space. In a multifamily home its own door is added with it (named "<unit> Door" unless the operator names it). In a single-family home there\'s one space, the whole home: leave name out to call it "Main Home" (or pass the operator\'s own name); its door is the home\'s entrance ("Front Door" unless the operator names it) and its route is set automatically. In an apartment or condo, name is the unit number (required; "4B" is stored as "Unit 4B"); its unit door is added and the route waits until they say whether they control the building entrance. Never make up a unit number. Description and facts must be the operator\'s words.',
    input: z.strictObject({
      property: Property,
      name: z.string().min(1).max(100).optional().describe("The unit or space name the operator gave. Required except for a single-family home. For an apartment or condo this is the unit number."),
      description: z.string().max(300).optional(),
      facts: Facts.optional(),
      doorName: z.string().max(100).optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      if (!i.name && draft.property.propertyType !== "SINGLE_FAMILY") throw new SetupInputError("UNIT_NAME_MISSING", draft.property.propertyType === "APARTMENT_OR_CONDO" ? "What's the unit number?" : "What's the unit called? Use the operator's own name for it, like \"1A\".");
      const state = edit(ctx, id, draft, "addUnit", { name: i.name, summary: i.description, facts: i.facts, doorName: i.doorName });
      const setup = setupSnapshot(ctx, id);
      const unit = setup.units.find((u) => !draft.units.some((d) => d.id === u.unitId));
      const after = ctx.services.workspace.openDraft(id).draft;
      return { summary: `Added ${unit ? operatorUnitName(after.property, unit.name) : "a unit"} with ${unit?.door}.${unit?.route ? ` Route: ${unit.route}.` : ""}`, unit, ...state, ...propertyNextQuestion(after) };
    },
  }),
  tool({
    name: "update_unit",
    title: "Update a unit",
    kind: "change",
    description:
      'Renames a unit or changes its description or approved facts (facts replace the whole list). Only the operator\'s words. For an apartment or condo, the new name is cased the same way as add_unit ("loft" → "Unit Loft", "4b" → "Unit 4B"), and the street-plus-unit nickname and matching unit door are refreshed. The confirmation echoes that stored display name ("Updated Unit Loft."), not the raw input.',
    input: z.strictObject({
      property: Property,
      unit: Unit,
      newName: z.string().max(100).optional(),
      alsoRenameDoor: z.boolean().optional().describe("Rename the unit's door to match, if it still has the suggested name."),
      description: z.string().max(300).optional(),
      facts: Facts.optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      let next = draft;
      if (i.description !== undefined || i.facts !== undefined) next = applySetupCommand(next, "setUnitDetails", { unitId: unit.id, summary: i.description, facts: i.facts });
      if (i.newName !== undefined) next = applySetupCommand(next, "renameUnit", { unitId: unit.id, name: i.newName, alsoRenameDoor: i.alsoRenameDoor });
      ctx.services.workspace.persistEdit(next, ctx.now());
      const setup = setupSnapshot(ctx, id);
      const updated = setup.units.find((u) => u.unitId === unit.id);
      const after = ctx.services.workspace.openDraft(id).draft;
      return { summary: `Updated ${operatorUnitName(after.property, updated?.name ?? unit.name)}.`, unit: updated, ...setupState(ctx, id) };
    },
  }),
  tool({
    name: "set_unit_details",
    title: "Save unit details",
    kind: "change",
    description:
      'Saves each unit\'s leasing details from the operator\'s own words: bedrooms, bathrooms, monthly rent and availability (required), plus square footage, floor, parking, laundry, pets, utilities, furnished and features. Pass a natural answer covering several units in "details" (e.g. "1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for $2,800"), and/or per-unit values in "units". On a single-family home with exactly one unit, omit the unit name and Tour Core uses that unit. A single-family home with no unit yet returns "Add the house as a unit first, then I\'ll save these details." Multi-unit properties still need a unit. "I don\'t know", "not sure", "not available yet" or "don\'t list the price" are saved as not provided. Never fill in values yourself. Returns a summary to read back and the one question for anything still missing.',
    input: z.strictObject({
      property: Property,
      details: z.string().max(2000).optional().describe("The operator's answer, as they said it."),
      units: z
        .array(
          z.strictObject({
            unit: Unit.optional().describe("Which unit. Leave out on a single-family home that has exactly one unit."),
            bedrooms: UnitValue,
            bathrooms: UnitValue,
            monthlyRent: UnitValue,
            availability: UnitValue,
            squareFeet: UnitValue,
            floor: UnitValue,
            parking: UnitValue,
            laundry: UnitValue,
            pets: UnitValue,
            utilities: UnitValue,
            furnished: UnitValue,
            features: UnitValue,
          }),
        )
        .max(50)
        .optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      let next = draft;
      const touched = new Set<string>();
      let unknownUnits: string[] = [];
      if (draft.property.propertyType === "SINGLE_FAMILY" && draft.units.length === 0) {
        throw new SetupInputError("UNIT_DETAILS_NOT_FOUND", "Add the house as a unit first, then I'll save these details.");
      }
      if (i.details) {
        const bulk = parseBulkUnitDetails(i.details, draft.units.map((u) => u.name));
        unknownUnits = bulk.unknownUnits;
        for (const entry of bulk.units) {
          const unit = requireUnit(next, entry.unit);
          next = applySetupCommand(next, "setUnitProfile", { unitId: unit.id, values: entry.values });
          touched.add(unit.id);
        }
        if (!bulk.units.length) {
          const only = soleSingleFamilyUnit(next);
          const values = extractValues(i.details);
          if (only && Object.keys(values).length) {
            next = applySetupCommand(next, "setUnitProfile", { unitId: only.id, values });
            touched.add(only.id);
            unknownUnits = [];
          }
        }
      }
      for (const entry of i.units ?? []) {
        const { unit: ref, ...values } = entry;
        const unit = ref ? requireUnit(next, ref) : soleSingleFamilyUnit(next);
        if (!unit) {
          throw new SetupInputError("UNIT_DETAILS_NOT_FOUND", `I couldn't match those details to a unit. The units are ${draft.units.map((u) => operatorUnitName(draft.property, u.name)).join(", ") || "none yet"}.`);
        }
        next = applySetupCommand(next, "setUnitProfile", { unitId: unit.id, values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) });
        touched.add(unit.id);
      }
      if (!touched.size) {
        if (draft.property.propertyType === "SINGLE_FAMILY" && draft.units.length === 0) {
          throw new SetupInputError("UNIT_DETAILS_NOT_FOUND", "Add the house as a unit first, then I'll save these details.");
        }
        throw new SetupInputError("UNIT_DETAILS_NOT_FOUND", `I couldn't match those details to a unit. The units are ${draft.units.map((u) => operatorUnitName(draft.property, u.name)).join(", ") || "none yet"}.`);
      }
      ctx.services.workspace.persistEdit(next, ctx.now());
      return { ...unitDetailsView(ctx, id), ...(unknownUnits.length ? { notOnFile: unknownUnits } : {}), ...setupState(ctx, id) };
    },
  }),
  tool({
    name: "get_unit_details",
    title: "Review unit details",
    kind: "read",
    description: "Each unit's leasing details as short lines to read back, which required details are still missing, and the one question to ask next. Read-only.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => unitDetailsView(ctx, resolvePropertyId(ctx.services.workspace, i.property)),
  }),
  tool({
    name: "list_doors",
    title: "List doors",
    kind: "read",
    description: "Every door on file: entrances, unit doors and hallway doors. Use this to map routes; never assume a door exists.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { doors } = setupSnapshot(ctx, id);
      return { summary: doors.length ? doors.map((d) => d.name).join(", ") : "No doors yet.", doors };
    },
  }),
  tool({
    name: "add_door",
    title: "Add a door",
    kind: "change",
    description: "Adds an entrance or a hallway/shared door the operator described. Unit doors come with add_unit. Only add doors the operator actually named. For an apartment or condo that controls the building entrance, adding that entrance completes the route (building entrance + unit door).",
    input: z.strictObject({
      property: Property,
      name: z.string().min(1).max(100),
      kind: z.enum(["entrance", "hallway"]).describe("entrance = a way into the building; hallway = an inside or shared door on the way to a unit."),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const state = edit(ctx, id, draft, "addDoor", { name: i.name, kind: i.kind === "entrance" ? "ENTRANCE" : "COMMON" });
      const after = ctx.services.workspace.openDraft(id).draft;
      const added = after.doors.find((door) => !draft.doors.some((previous) => previous.id === door.id));
      return {
        summary: `Added ${added?.name ?? i.name.trim()}.`,
        ...(added ? { door: { name: added.name, kind: added.kind } } : {}),
        ...state,
        ...propertyNextQuestion(after),
      };
    },
  }),

  // --------------------------------------------------------- routes
  tool({
    name: "get_route",
    title: "Get a unit's route",
    kind: "read",
    description: "The doors a visitor to this unit passes through, in order, plus a suggested route when none is saved.",
    input: z.strictObject({ property: Property, unit: Unit }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      const view = draftView(draft).units.find((u) => u.id === unit.id)!;
      const name = (d: string) => draft.doors.find((x) => x.id === d)?.name ?? "a door that no longer exists";
      return {
        summary: view.route ? `${operatorUnitName(draft.property, unit.name)}: ${view.route.doorNames.join(" \u2192 ")}` : `${operatorUnitName(draft.property, unit.name)} doesn't have a route yet.`,
        unit: operatorUnitName(draft.property, unit.name),
        route: view.route?.doorNames,
        directions: view.route?.directions || undefined,
        suggested: view.route ? undefined : view.suggestedRoute.map(name),
        problems: view.issues.map((p) => p.message),
        propertyId: id,
      };
    },
  }),
  tool({
    name: "preview_route",
    title: "Preview a route",
    kind: "read",
    description:
      "Works out which doors on file the operator meant, in order, WITHOUT saving. Use before set_route and show the operator the result. Unknown doors are never created; ambiguous ones come back as a question.",
    input: z.strictObject({
      property: Property,
      unit: Unit,
      doors: z.array(z.string().min(1).max(100)).min(1).max(12).describe('Doors in walking order, in the operator\'s words, e.g. ["lobby entrance", "unit door"].'),
    }),
    run: async (ctx, i) => {
      const { draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      const resolved: string[] = [];
      const questions: string[] = [];
      const unknown: string[] = [];
      for (const ref of i.doors) {
        const m = matchDoor(draft, ref, unit);
        if (m.kind === "exact" || m.kind === "inferred") resolved.push(m.item.name);
        else if (m.kind === "ambiguous") questions.push(`"${ref}" could be ${m.candidates.map((d) => d.name).join(" or ")}. Which one?`);
        else unknown.push(ref);
      }
      const known = draft.doors.map((d) => d.name);
      if (unknown.length) {
        return {
          status: "unknown-doors",
          summary: `I don't have ${unknown.map((u) => `"${u}"`).join(" or ")} on file. The doors are ${known.join(", ") || "none yet"}. Should I add a new door, or did you mean one of these?`,
          knownDoors: known,
        };
      }
      if (questions.length) return { status: "needs-clarification", summary: questions.join(" "), questions };
      const ids = resolved.map((n) => draft.doors.find((d) => d.name === n)!.id);
      const check = applySetupCommand(draft, "setRoute", { unitId: unit.id, doorIds: ids });
      const problems = validateConfig(check).filter((p) => p.section === "routes" && p.unitId === unit.id).map((p) => p.message);
      return {
        status: problems.length ? "has-problems" : "ok",
        summary: `I have: ${resolved.join(" \u2192 ")}.${problems.length ? ` But: ${problems.join(" ")}` : " Is that right?"}`,
        unit: operatorUnitName(draft.property, unit.name),
        route: resolved,
        problems,
      };
    },
  }),
  tool({
    name: "set_route",
    title: "Save a unit's route",
    kind: "change",
    description:
      "Saves the doors for one unit in walking order. Door names must match doors on file exactly (use preview_route first and pass its names). Invalid routes are refused, never saved.",
    input: z.strictObject({
      property: Property,
      unit: Unit,
      doors: z.array(z.string().min(1).max(100)).min(1).max(12).describe("Exact door names from preview_route or list_doors, in walking order."),
      directions: z.string().max(300).optional().describe("The operator's own directions from the entrance to the unit."),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      const doors = i.doors.map((ref) => {
        const m = matchDoor(draft, ref);
        if (m.kind === "exact") return m.item;
        const hint =
          m.kind === "inferred"
            ? ` Did you mean ${m.item.name}?`
            : m.kind === "ambiguous"
              ? ` It could be ${m.candidates.map((d) => d.name).join(" or ")}.`
              : ` The doors are ${draft.doors.map((d) => d.name).join(", ") || "none yet"}.`;
        throw new SetupInputError("ROUTE_DOOR_UNKNOWN", `"${ref}" isn't a door on file.${hint} Nothing was saved.`);
      });
      const state = edit(ctx, id, draft, "setRoute", { unitId: unit.id, doorIds: doors.map((d) => d.id), directions: i.directions, onlyIfValid: true });
      return { summary: `Saved ${operatorUnitName(draft.property, unit.name)}: ${doors.map((d) => d.name).join(" \u2192 ")}.`, ...state };
    },
  }),

  // --------------------------------------------------- hours, policy
  tool({
    name: "get_tour_hours",
    title: "Get tour hours",
    kind: "read",
    description: "When people can tour: days, hours, tour length, how often tours start, and how early visitors can get in. A new property starts at Monday–Friday, 9:00 AM–5:00 PM until the operator changes it.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const s = setupSnapshot(ctx, id);
      return { summary: s.tourHours, tourHours: s.tourHours, tourLength: s.tourLength, newTourEvery: s.newTourEvery, earlyArrival: s.earlyArrival };
    },
  }),
  tool({
    name: "set_tour_hours",
    title: "Set tour hours",
    kind: "change",
    description:
      'Sets tour hours from everyday words: days ("weekdays", "Mon-Sat", "every day"), start/end ("9am", "5 PM"). Different days can have different hours (weekdays 9-5, weekends 9-8): one call per set of days. Once hours are saved, new days are added and the days not named keep their hours; pass replace only when the operator says to replace all the hours. Also tour length, how often a new tour starts, early arrival ("10 minutes"). Only pass what the operator said; defaults stay visible. A new property starts at Monday–Friday, 9:00 AM–5:00 PM, 45-minute tours, hourly starts, and 10 minutes early. Tours have to end later the same day. Tours must last 15 minutes to 4 hours, and starts must be 15 minutes to 8 hours apart. Hours are structural: a published property goes back to draft until readiness, a practice tour, and publish. After those hours are published, open visitor conversations use them on the next inbound text.',
    input: z.strictObject({
      property: Property,
      days: z.union([z.string().max(80), z.array(z.string().max(20)).max(7)]).optional(),
      start: z.string().max(20).optional(),
      end: z.string().max(20).optional(),
      replace: z.boolean().optional().describe("True only when the operator says these hours replace all the saved ones."),
      tourLength: Duration.optional(),
      newTourEvery: Duration.optional(),
      earlyArrival: Duration.optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const parsed = parseHours(i);
      const plan = planTourHours(draft, parsed, !i.replace && hoursAlreadyChosen(ctx, id));
      if ("blocked" in plan) return { summary: plan.blocked, status: "blocked" };
      if ("ask" in plan) return { summary: plan.ask, status: "next" };
      ctx.services.workspace.persistEdit(plan.next, ctx.now());
      const state = setupState(ctx, id);
      ctx.services.workspace.noteTourHoursConfirmed(id, ctx.now().toISOString());
      const s = setupSnapshot(ctx, id);
      return { summary: s.tourHours, tourLength: s.tourLength, newTourEvery: s.newTourEvery, earlyArrival: s.earlyArrival, ...state };
    },
  }),
  tool({
    name: "get_verification_policy",
    title: "Get visitor verification",
    kind: "read",
    description: "How visitors confirm who they are before any door opens. The basic identity form includes how many days before a visitor fills it out again. No form reads back as No identity form.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const { draft } = openDraft(ctx, i.property);
      const view = draftView(draft);
      const none = draft.verificationMode === "none";
      return {
        summary: view.reviewCards.find((c) => c.step === "verification")!.rows.join(". "),
        current: none ? "none" : "basic-form",
        ...(none ? {} : { reuseForDays: draft.verificationValidForDays }),
        choices: view.verification.options.map((option) => ({
          choice: option.mode,
          label: option.title,
          recommended: option.recommended,
          explanation: option.explanation,
        })),
      };
    },
  }),
  tool({
    name: "set_verification_policy",
    title: "Set visitor verification",
    kind: "change",
    description: "Chooses a basic identity form (recommended) or no form. No form asks first, because anyone who texts could book and get in without saying who they are. Optionally how many days before a visitor fills out the form again.",
    input: z.strictObject({
      property: Property,
      level: z.enum(["basic-form", "none"]).optional(),
      reuseForDays: z.number().int().optional(),
      confirmationCode: Code,
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      if (i.level === "none" && draft.verificationMode !== "none") {
        const fingerprint = `none|${draft.verificationMode}`;
        if (!i.confirmationCode) return needsConfirmation(ctx, "no-form", id, fingerprint, NO_FORM_QUESTION);
        ctx.confirmations.redeem(i.confirmationCode, "no-form", id, fingerprint);
      }
      const reuse = reuseDaysRefusal(i.reuseForDays);
      if (reuse) throw new SetupInputError("VERIFICATION_REUSE_INVALID", reuse);
      const state = edit(ctx, id, draft, "setVerificationPolicy", {
        mode: i.level,
        reuseForDays: i.reuseForDays,
        ...(i.level === "none" ? { confirm: true } : {}),
      });
      return { summary: setupSnapshot(ctx, id).verification.join(". "), ...state };
    },
  }),
  tool({
    name: "get_services",
    title: "Get messaging and records",
    kind: "read",
    description:
      'How visitors are texted and whether this property is connected to the touring number, where tour records are kept, and door access mode, each on its own (texting can be live while door access is demo). For local or test-mode texting, messaging.current is "test" (never "live") and the status line is "Visitor texting: test mode". The summary is "Texting is in test mode, so texts don\'t reach real phones. Real visitors won\'t get anything until live texting is turned on. Door access is still in demo mode, so no physical locks will open." — do not say texting is live and do not name the texting service. Never contains credentials.',
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const checks = await checkMessaging(draft).catch(() => [{ label: "Visitor messaging", ok: false, message: "Couldn't check visitor messaging right now." }]);
      const line = ctx.services.endpoints?.forProperty(id)?.address;
      const modes = subsystemLines(ctx, id, draft);
      return {
        summary: modes.sentence,
        lines: modes.lines,
        messaging: {
          current: usesLocalMessaging(draft, servicesOf(ctx).installedMessaging?.()) ? "test" : draft.messagingMode,
          visitorTexting: modes.texting.label,
          connected: checks.every((c) => c.ok),
          checks: checks.map((c) => ({ check: c.label, ok: c.ok, message: c.message })),
          ...(line ? { textingNumber: line } : {}),
          ...("problem" in modes.texting ? { problem: modes.texting.problem } : {}),
          choices: MESSAGING_CHOICES,
        },
        records: { current: "this-computer", choices: RECORDS_CHOICES },
        doorAccess: "Demo: no physical locks open. Tour Core only asks the door system to unlock a door after its own safety checks pass.",
        alertsGoTo: draft.operator.name,
      };
    },
  }),
  tool({
    name: "set_services",
    title: "Set messaging and records",
    kind: "change",
    description:
      'Chooses how visitors are texted for this building: "live" for real texts through the installation\'s messaging provider, "local" for QA test texts on this building only (other published buildings stay as they are), or "demo" for practice only. "sendblue" is accepted as an older name for "live". Local summary: "Texting is in test mode, so texts don\'t reach real phones. Real visitors won\'t get anything until live texting is turned on. Door access is still in demo mode, so no physical locks will open." Do not say texting is live and do not name the texting service. Does not change the installation provider and does not touch saved Sendblue, Twilio, or Photon credentials. Records stay on this computer. Door access mode can\'t be changed here. Credentials are never set through chat.',
    input: z.strictObject({ property: Property, messaging: z.enum(["live", "sendblue", "demo", "local"]).optional(), records: z.enum(["this-computer", "google-drive"]).optional() }),
    run: async (ctx, i) => {
      if (i.records === "google-drive") throw new SetupInputError("STORAGE_UNAVAILABLE", "Keeping records in Google Drive isn't available yet. They'll stay on this computer for now.");
      const { id, draft } = openDraft(ctx, i.property);
      const messagingMode = i.messaging === "sendblue" ? "live" : i.messaging === "local" ? "live" : i.messaging;
      const messagingProvider = i.messaging === "local" ? "local" : undefined;
      const state = edit(ctx, id, draft, "setServices", { messagingMode, ...(messagingProvider ? { messagingProvider } : {}) });
      return { summary: subsystemLines(ctx, id, ctx.services.workspace.openDraft(id).draft).sentence, ...state };
    },
  }),

  // ------------------------------------------- review, checks, publish
  tool({
    name: "review_property_setup",
    title: "Review the setup",
    kind: "read",
    description:
      'Everything on one page, as short lines to read back to the operator ("Here\'s what I have: ..."): the address, property type, each tourable unit with its details and route, tour hours, verification, visitor texting and door access, and the visitor help number (or "not set"). A single-family home\'s unit heading is the street line (same helper as operatorUnitName), never "Main Home". Multifamily, apartment and condo units keep their stored names. Plus anything still missing. No addresses of Tour Core itself or other technical details.',
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const view = draftView(draft);
      const modes = subsystemLines(ctx, id, draft);
      const lines = [
        draft.property.address,
        ...(draft.property.displayName ? [`Called: ${draft.property.displayName}`] : []),
        draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : "Property type: not chosen yet",
        ...(draft.property.buildingAccess === "UNIT_ONLY" ? ["Building entrance: visitors get in on their own"] : []),
        ...(draft.property.buildingAccess === "BUILDING_AND_UNIT" ? ["Building entrance: you control it"] : []),
        ...(draft.units[0]?.entryInstructions ? [`Entry instructions: ${draft.units[0].entryInstructions}`] : []),
        "",
        ...view.units.flatMap((u) => [operatorUnitName(draft.property, u.name), `  ${u.details.line.slice(u.details.line.indexOf(" \u2014 ") + 3)}`, `  Route: ${u.route ? u.route.doorNames.join(" \u2192 ") : "not set yet"}`]),
        ...(view.units.length ? [] : ["No tourable units yet"]),
        "",
        `Tours: ${view.tourHours.summary ?? view.tourHours.label}`,
        `Verification: ${view.reviewCards.find((c) => c.step === "verification")!.rows[0]}`,
        ...modes.lines,
        ...visitorHelpLines(draft.operator),
        settingsSentence(draft.verificationMode, !!ctx.installation?.files.state().skipped?.OPERATOR_ALERTS),
      ];
      return {
        summary: view.canSave ? "Setup looks complete." : `${view.issues.length} thing${view.issues.length === 1 ? "" : "s"} still need${view.issues.length === 1 ? "s" : ""} an answer.`,
        lines,
        modes: modes.sentence,
        ...("problem" in modes.texting ? { textingProblem: modes.texting.problem } : {}),
        canSave: view.canSave,
        ...setupState(ctx, id),
        ...(ctx.services.workspace.has(id) && ctx.services.workspace.load(id).state.status === "PUBLISHED_FOR_DEMO" ? {} : visitorHelpQuestion(draft)),
      };
    },
  }),
  tool({
    name: "run_readiness_check",
    title: "Run the readiness check",
    kind: "change",
    description:
      "Runs Tour Core's real readiness checks (property, hours, routes, verification, messaging, records, tour progress, door access, audit/export). One touring number covers every property on this Tour Core; a second property is not blocked for sharing it. Report the result as-is, including any advisory lines; never claim a check passed if it didn't. Never name Durin; say door access.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { result, savedChanges } = await readinessForProperty(ctx.services, id, ctx.now());
      return readinessOut(result, savedChanges);
    },
  }),
  tool({
    name: "run_dry_tour",
    title: "Run a practice tour",
    kind: "change",
    description:
      "Runs one complete practice tour through the real engine (no one is texted, no real door opens) and returns the proof points: booking, verification, early denial, entrance (kept for a single-family home, even when that door is also the unit door), the unit door on a unit-door-only apartment or condo, later unit doors, off-route denial, duplicate, the T-15 questions text, the T-5 extra-time offer, a one-time 10-minute extension, completion, follow-up, and a second path through tour-end, the +5 leave check-in, and the +15 close. The +15 close names the visitor help number when one is set. Uses a deterministic simulated clock. A 15-minute tour skips T-15 with a reason (it would be the start). The last slot of the day still runs; extra time or the second path is skipped with a reason if it cannot apply. Nobody waits.",
    input: z.strictObject({ property: Property, unit: Unit.optional() }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unitId = i.unit ? requireUnit(draft, i.unit).id : undefined;
      const outcome = await runPracticeTour(ctx.services, id, { unitId, now: ctx.now() });
      if (outcome.kind === "unchecked-changes") {
        return { passed: false, status: "blocked", summary: "Some setup changes still need fixing before a practice tour can run.", problems: setupState(ctx, id).problems };
      }
      if (outcome.kind === "not-ready") return { passed: false, status: "not-ready", summary: "The readiness check found problems, so the practice tour didn't run.", readiness: readinessOut(outcome.readiness, false) };
      const r = outcome.result;
      return { passed: r.passed, summary: r.passed ? "Practice tour passed." : `The practice tour stopped: ${r.failure}`, proofPoints: proofPoints(r), ...(r.failure ? { failure: r.failure } : {}), status: statusLabel(ctx.services.workspace.load(id)) };
    },
  }),
  tool({
    name: "publish_demo_property",
    title: "Publish for demo",
    kind: "consequential",
    description:
      'Publishes the property for demo so visitors can start tours. Only works when the saved setup is valid and both the readiness check and a practice tour passed for this exact setup. Open conversations then use these published settings (hours, units, and so on) on every inbound text. First call returns a yes/no question; ask it and call again with confirmationCode only after an explicit yes. For a real texting provider the summary includes "Visitors can start a tour by texting your touring number." Leave that line out entirely when this building is on local or test-only texts.',
    input: z.strictObject({ property: Property, confirmationCode: Code }),
    run: async (ctx, i) => {
      const ws = ctx.services.workspace;
      const services = servicesOf(ctx);
      const id = resolvePropertyId(ws, i.property);
      const blocked = (list: PublishBlocker[]) => {
        const texting = list.find((b) => b.code.startsWith("TEXTING_"));
        return {
          published: false,
          status: "blocked",
          summary: texting ? texting.message : "It can't be published yet.",
          blockers: list.map((b) => b.message),
          ...(texting
            ? {
                remediation:
                  texting.code === "TEXTING_NOT_CONNECTED"
                    ? "Fix it yourself: call set_services with messaging sendblue, then run_readiness_check and run_dry_tour again, then ask the publish question again. Don't ask the operator how to text people."
                    : "Call run_readiness_check (it connects the touring number to this property and says what's wrong), fix what it reports, run_dry_tour, then ask the publish question again.",
              }
            : {}),
        };
      };
      const saved = ws.has(id) ? ws.load(id) : undefined;
      const blockers = saved
        ? [...publishGuards(services, id, saved.config.messagingMode), ...(await ws.publishBlockers(id, ctx.now()))]
        : [{ code: "NOT_SAVED", message: "Finish the setup answers first." }];
      if (blockers.length) return blocked(blockers);
      const { config, state } = saved!;
      const modes = subsystemLines(ctx, id, config);
      if (state.status === "PUBLISHED_FOR_DEMO") {
        return {
          published: true,
          status: "already-published",
          summary: `${config.property.name} is already published for demo. ${modes.sentence}`,
          instructions: "This property is already published. Tell the operator that. Do not ask them to publish again.",
        };
      }
      const fingerprint = `${state.configHash}|${state.readiness?.checkedAt}|${state.dryTour?.ranAt}`;
      if (!i.confirmationCode) return needsConfirmation(ctx, "publish", id, fingerprint, `Everything passed. Do you want me to publish ${config.property.name} for demo?`);
      ctx.confirmations.redeem(i.confirmationCode, "publish", id, fingerprint);
      const result = await publishProperty(services, id, ctx.now());
      if (!result.published) return blocked(result.blockers);
      const realPhones = modes.texting.state === "connected" && !usesLocalMessaging(config, services.installedMessaging?.());
      const again = ctx.services.workspace.load(id);
      return {
        published: true,
        status: again.state.status === "PUBLISHED_FOR_DEMO" ? "published" : "unpublished",
        summary: `${config.property.name} is published for demo.${realPhones ? " Visitors can start a tour by texting your touring number." : ""} ${modes.sentence}`,
        modes: modes.sentence,
        instructions: "Publishing finished. Tell the operator the property is published, using summary. Do not say it still needs a yes.",
      };
    },
  }),

  // -------------------------------------------------------- local SMS QA
  tool({
    name: "inject_local_sms",
    title: "Inject a local visitor text",
    kind: "change",
    description:
      "QA only. Sends a visitor SMS into Tour Core as if it arrived on the local loopback (same path as POST /webhooks/local → handleProviderWebhook → conversations.receive). Leave property out to deliver on the shared touring line without naming a place: two or more published places are asked which place, and one published place skips that question. Set hasMedia when the inbound is a photo; Tour Core does not forward the file. A photo alone is told it can't take photos yet; a photo plus a question it can't answer is one combined text and is flagged. Refuses unless a property on that send is on local test texts. Never against a building that uses the installation's live texting or practice texts. No real text is sent.",
    input: z.strictObject({
      from: z.string().min(7).max(30).describe("The visitor's phone number."),
      text: z.string().max(1600).optional().describe("The visitor's text, one message. Leave empty when they only sent a photo."),
      to: z.string().min(7).max(30).optional().describe("The property's local touring number. Leave out to use the property's attached line, or the shared loopback when property is left out."),
      property: z.string().max(200).optional().describe("Which property: its name, address or propertyId. Leave out to send on the shared touring line without naming a place."),
      id: z.string().max(80).optional().describe("Optional inbound id for de-duplication. Leave out to mint one."),
      hasMedia: z.boolean().optional().describe("True when the inbound includes a photo or other attachment. Tour Core does not forward the file. A photo alone is told it can't take photos yet; a photo plus a question it can't answer is one combined text and is flagged."),
      listingProperty: z.string().max(200).optional().describe("Listing deep link: the place this first text is for (street, public name, or property id). Leave out when the text itself should choose."),
    }),
    run: (ctx, i) => injectLocalSms(ctx, i),
  }),
  tool({
    name: "read_local_outbox",
    title: "Read the local SMS outbox",
    kind: "read",
    description:
      "QA only. Returns outbound local-loopback replies for a conversation as separate bubbles in send order (body, timestamp, and templateId when the bubble came from the visitor template registry). Never one concatenated blob. Refuses unless that property is on local test texts.",
    input: z.strictObject({
      from: z.string().min(7).max(30).optional().describe("The visitor's phone number. Leave out to list every prospect bubble."),
      property: Property,
    }),
    run: async (ctx, i) => readLocalOutbox(ctx, i),
  }),

  // -------------------------------------------------------- live tours
  tool({
    name: "list_active_tours",
    title: "Show active tours",
    kind: "read",
    description: "Visitor tours happening now: who, which unit, tour time (including any extra time), status, and where they are. When someone is touring and also has a later booking, this is the running tour; the later booking is listed as their next booking.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = i.property ? resolvePropertyId(ctx.services.workspace, i.property) : undefined;
      const tours = await listActiveTours(ctx.services, id);
      return { summary: tours.length ? `${tours.length} active tour${tours.length === 1 ? "" : "s"}.` : "No tours are active right now.", tours };
    },
  }),
  tool({
    name: "inspect_tour",
    title: "Inspect a tour",
    kind: "read",
    description: "What's happening on one tour: status, latest activity, questions, access grant times, access denials, recent messages, and anything that needs the team. Tour time includes extra time if the window was extended. When someone is touring and also has a later booking, this is the running tour and the later booking is their next booking. The summary names the status once (do not repeat Cancelled, Called off, Finished, or other terminal states).",
    input: z.strictObject({ tourRef: TourRef }),
    run: async (ctx, i) => {
      const tour = await findTour(ctx.services, i.tourRef);
      const attention = (await listExceptions(ctx.services, { propertyId: tour.propertyId })).filter((x) => x.tourRef === i.tourRef).map(exceptionLine);
      const view = inspectTourView(tour);
      return { summary: inspectTourSummary(view), tour: view, needsAttention: attention };
    },
  }),

  // -------------------------------------------------------- exceptions
  tool({
    name: "list_exceptions",
    title: "Show what needs attention",
    kind: "read",
    description: "The queue of issues that need the team: unanswered questions, help requests, door problems, off-route attempts, paused tours, failed identity checks, tours that couldn't be restored, a failed text to you titled \"A text to you didn't go out\", and a visitor text Tour Core could not handle (handler-failed: the visitor was told the team will reply here; next step is to tell you what to say so you can text them, or to book or change their tour). A fair-housing question is flagged with proposeDraft false. The visitor already got: Good question for the {team}. I've passed it along, and they'll text you back here. The inbox title is Possible fair-housing question. The inbox summary is They asked: \"{question}\" with a period after the quote when the question does not already end in . ? or !, then This may touch on fair housing, so there's no draft. Only you can answer this one. They were told you'd text them back here. Next step: Mark it handled once you've replied. That sentence is not repeated. A double quote inside the visitor's words is shown as a single quote. An injury is titled Possible injury. Its ending follows the latest attempt: They were told to call 911 if someone is hurt, and that you'd text them here. when that text went out, They were told to call 911 and that you couldn't be reached when the 911 text went out and the alert did not, Our text telling them to call 911 didn't go out, so they haven't heard back yet when the 911 text was blocked or failed, or They've opted out of texts, so they weren't texted back this time. They were already told to call 911 when it was skipped after STOP and an earlier 911 text got through, or They've opted out of texts, so they weren't texted back this time. Our earlier text telling them to call 911 didn't go out when that earlier text did not. When the 911 text is queued, the ending is They were sent a text to call 911 if someone is hurt, but we can't confirm it reached them. After STOP, when that earlier text is queued, the ending is They've opted out of texts, so they weren't texted back this time. Our earlier text telling them to call 911 was sent, but we can't confirm it reached them. When a queued 911 text also has a failed team alert, the ending is We sent them a text to call 911 and said you couldn't be reached, but we can't confirm it got to them. All three use Call them now, then mark it handled. The next step is Text or call them now, then mark it handled, or Call them now, then mark it handled when the 911 text did not go out or was skipped. A fair-housing text that also got the 911 line keeps this title and replaces that last sentence with the injury ending. A text to you didn't go out is not listed when the record before it is an injury help request. A grant that couldn't be saved after unlock is \"Tour Core couldn't save the visit record, so the tour was paused.\" A records check that fails before unlock keeps the door locked and does not open an issue. \"Visitor hasn't confirmed leaving\" stays open until they text DONE or the operator marks it handled; after-close alerts stop at 24 hours.",
    input: z.strictObject({ property: Property, includeHandled: z.boolean().optional() }),
    run: async (ctx, i) => {
      const id = i.property ? resolvePropertyId(ctx.services.workspace, i.property) : undefined;
      const list = await listExceptions(ctx.services, { propertyId: id, includeClosed: i.includeHandled });
      const open = list.filter((x) => x.status === "open").length;
      return { summary: open ? `${open} thing${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} attention.` : "Nothing needs attention right now.", exceptions: list.map(exceptionLine) };
    },
  }),
  tool({
    name: "inspect_exception",
    title: "Open an issue",
    kind: "read",
    description: "One issue in detail: what happened, the visitor's words, where the tour stands, recent messages, and what the team can do next.",
    input: z.strictObject({ exceptionId: ExceptionId }),
    run: async (ctx, i) => {
      const x = await inspectException(ctx.services, i.exceptionId);
      return { summary: `${x.visitorName}${x.unitName ? `, ${x.unitName}` : ""}: ${x.summary}`, issue: { ...exceptionLine(x), question: x.question, nextSteps: x.nextSteps, tour: x.tour, recentMessages: x.recentMessages } };
    },
  }),
  tool({
    name: "resolve_exception",
    title: "Mark an issue handled",
    kind: "change",
    description: "Closes one issue with the operator's note. Changes nothing else: no tour, access or setup change. For a leaving issue, marking it handled also ends after-close visitor alerts for that closed tour, even if a later booking is held. A repeat on a handler-failed issue (couldn't handle their text) returns exactly That's already been handled.",
    input: z.strictObject({ exceptionId: ExceptionId, resolutionNote: z.string().min(1).max(500) }),
    run: async (ctx, i) => {
      const { alreadyResolved, exception } = await resolveException(ctx.services, i.exceptionId, i.resolutionNote, ctx.now());
      const already = exception.kind === "handler-failed" ? ISSUE_ALREADY_HANDLED : "That was already marked handled.";
      return { summary: alreadyResolved ? already : `Marked handled: ${exception.visitorName}, ${exception.title.toLowerCase()}.`, issue: exceptionLine(exception) };
    },
  }),
  tool({
    name: "answer_flagged_question",
    title: "Answer a flagged question with a new approved fact",
    kind: "consequential",
    description:
      "Only when the OPERATOR supplied the answer or the reply. A fair-housing flag has proposeDraft false: this tool refuses with This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled. The visitor already got: Good question for the {team}. I've passed it along, and they'll text you back here. Do not draft one. For an unanswered question: as soon as they give it (e.g. \"2 bedrooms\"), call this without a code. Tour Core works out how it will be saved and returns ONE question: Send this to {name} and save it for anyone who asks the same thing later? \"{visitorWillReceive}\" — the quoted text equals visitorWillReceive byte for byte, closing line included, never Continue?. After a clear yes, call again with confirmationCode. After yes, if they opted out: Saved \"{answer}\" for future questions. {who} has turned off texts from us, so I didn't send it and this is still open. If you can reach them another way, do that, then mark it handled. If the send fails for any other reason: Saved \"{answer}\" for future questions, but I couldn't text {who}, so nothing was sent and this is still open. If you can reach them another way, do that, then mark it handled. A repeat on an unanswered question returns exactly That question has already been handled. For a handler-failed issue, this texts the visitor from the Tour Core number and does not save an approved fact. The first call returns Send this to {who}? \"{reply}\" and the quoted text equals visitorWillReceive. After yes, when the text is in the outbox and the issue is closed, it returns exactly Sent to {who}. If the visitor can't be texted, it returns I couldn't text {who}, so nothing was sent and this is still open. If you can reach them another way, do that, then mark it handled. A repeat on a handler-failed issue returns exactly That's already been handled. Never make up or reword the answer.",
    input: z.strictObject({
      exceptionId: ExceptionId,
      approvedFact: z.string().min(1).max(300).describe("The operator's own words, e.g. \"2 bedrooms\" or \"Parking is included.\""),
      appliesTo: z.enum(["property", "unit"]).optional().describe("Only if the operator said: the whole property or just the visitor's unit. Tour Core decides otherwise."),
      confirmationCode: Code,
    }),
    run: async (ctx, i) => {
      const plan = await planFlaggedAnswer(ctx.services, { exceptionId: i.exceptionId, approvedFact: i.approvedFact, appliesTo: i.appliesTo }, ctx.now());
      const x = plan.exception;
      const who = plan.who;
      const fingerprint = `${x.exceptionId}|${plan.appliesTo}|${plan.field ?? ""}|${plan.fact}|${plan.sendOnly ? "send" : "save"}`;
      if (!i.confirmationCode) {
        if (plan.sendOnly) {
          return needsConfirmation(ctx, "answer", x.exceptionId, fingerprint, sendThisQuestion(who, plan.fact), { savedToSetup: false, visitorWillReceive: plan.fact });
        }
        const visitorWillReceive = visitorAnswerText(x.question!, plan.fact);
        return needsConfirmation(ctx, "answer", x.exceptionId, fingerprint, sendThisQuestion(who, visitorWillReceive, { save: true }), {
          visitorWillReceive,
        });
      }
      ctx.confirmations.redeem(i.confirmationCode, "answer", x.exceptionId, fingerprint);
      const out = await answerFlaggedQuestion(ctx.services, { exceptionId: x.exceptionId, approvedFact: i.approvedFact, appliesTo: i.appliesTo }, ctx.now());
      if (plan.sendOnly) {
        return { summary: `Sent to ${who}.`, ...out };
      }
      const saved = out as { approvedFact?: string; sendMissed?: "opted-out" | "unreachable"; visitorAnswered?: boolean; needsRecheck?: boolean };
      const answer = (saved.approvedFact ?? plan.fact).replace(/\.$/, "");
      if (saved.sendMissed === "opted-out") return { summary: saveSendOptedOutLine(answer, who), ...out };
      if (saved.sendMissed === "unreachable") return { summary: saveSendUnreachableLine(answer, who), ...out };
      return {
        summary: `Saved "${answer}"${out.visitorAnswered ? ` and sent it to ${who}` : "; their tour isn't running, so they weren't texted"}.${out.needsRecheck ? " The setup changed, so run the readiness check and a practice tour again before publishing." : ""}`,
        ...out,
      };
    },
  }),
  tool({
    name: "place_operator_hold",
    title: "Pause a tour",
    kind: "consequential",
    description:
      "Pauses one running tour: its doors are switched off and none open until the team resumes it. When the visitor also has a later booking, this pauses the tour that is in progress. First call returns a yes/no question; call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({ tourRef: TourRef, reason: z.string().min(1).max(300), confirmationCode: Code }),
    run: async (ctx, i) => {
      const target = await describeChangeTarget(ctx.services, i.tourRef, "hold");
      const fingerprint = reservationFingerprint(target.reservation);
      if (!i.confirmationCode) return needsConfirmation(ctx, "hold", i.tourRef, fingerprint, `Pause ${midSentence(target.name)}'s tour of ${target.unit}? Their doors will be switched off until you resume it.`);
      ctx.confirmations.redeem(i.confirmationCode, "hold", i.tourRef, fingerprint);
      const tour = await placeHold(ctx.services, i.tourRef, i.reason);
      return { summary: `${target.name}'s tour is paused. No doors will open until you resume it.`, tour };
    },
  }),
  tool({
    name: "clear_operator_hold",
    title: "Resume a paused tour",
    kind: "consequential",
    description:
      "Resumes a tour paused by the team or by a door-system problem. When the visitor also has a later booking, this resumes the tour that was paused. Doors still open only when Tour Core's policy allows (right time, right route). First call returns a yes/no question; call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({ tourRef: TourRef, confirmationCode: Code }),
    run: async (ctx, i) => {
      const target = await describeChangeTarget(ctx.services, i.tourRef, "resume");
      const fingerprint = reservationFingerprint(target.reservation);
      if (!i.confirmationCode) return needsConfirmation(ctx, "resume", i.tourRef, fingerprint, `Resume ${midSentence(target.name)}'s tour of ${target.unit}? Doors on their route can open again during their tour time.`);
      ctx.confirmations.redeem(i.confirmationCode, "resume", i.tourRef, fingerprint);
      const tour = await clearHold(ctx.services, i.tourRef);
      return { summary: `${target.name}'s tour is resumed.`, tour };
    },
  }),
  tool({
    name: "revoke_tour_access",
    title: "Call off a tour",
    kind: "consequential",
    description:
      "Calls off one tour for good: all its access is switched off and the visitor is told. This can't be undone. When the visitor is touring and also has a later booking, this calls off the running tour; the later booking then becomes the one you can call off or they can cancel by text. After any end (done, closed, called off, cancelled), conversation moves to that later booking. The result's tour object is the tour that was called off; a later or held booking is nextBooking, not tour. The confirm names that booking at {time} on {day} when it has a start time. When the called-off booking is not the tour they are on, the visitor is told Your tour at {time} on {day} has been called off, so the doors won't open for it. First call returns a yes/no question; call again with confirmationCode only after an explicit yes. Visitors can also cancel a booked tour by text in their own words; Tour Core confirms first (Cancel your {time} tour on {day}? Reply YES or NO.). YES: You're cancelled. Text me anytime if you want to book again. NO: Okay, your {time} tour on {day} stays booked. While they are touring and the cancel targets a later booking: Cancel your later tour at {time} on {day}? Your tour right now isn't affected. Reply YES or NO. YES: Done, I've cancelled your later tour at {time} on {day}. Your tour right now isn't affected. NO: Okay, your later tour at {time} on {day} stays booked. If they name the tour they are on (cancel my monday tour, cancel today's tour, cancel my 2pm tour, cancel this tour, cancel my current tour): You can't cancel the tour you're on, but you're free to wrap up whenever you like. Your later tour at {time} on {day} is still booked. Want me to cancel that one instead? Reply YES or NO. A touring visitor with no later booking who texts cancel hears You can't cancel the tour you're on, but you're free to wrap up whenever you like. Text me anytime if you want to book another tour. On hold or a door-system problem those refusal lines insert The {team} is still working on the problem and will text you here. after the first sentence. A reply that isn't a clear yes or no is flagged (I'll check with the {team} and get back to you.). STOP still opts out. When nothing is booked yet, that same cancel phrasing at the day menu, the time menu, or the property picker (a bare cancel is still STOP) clears the step and replies No problem, nothing's booked yet, so I'll stop here. Text me anytime if you want to pick a time. The next text from someone already opted in starts scheduling again, with no TOUR keyword. At the property picker, that next text asks which place again. A clear cancel ask is never treated as a missing property fact.",
    input: z.strictObject({ tourRef: TourRef, reason: z.string().min(1).max(300), confirmationCode: Code }),
    run: async (ctx, i) => {
      const target = await describeChangeTarget(ctx.services, i.tourRef, "revoke");
      const fingerprint = reservationFingerprint(target.reservation);
      if (!i.confirmationCode) {
        const tz = target.tour.config.property.timezone;
        const when = target.reservation.slotStart
          ? { time: formatTime(new Date(target.reservation.slotStart), tz), day: formatDay(new Date(target.reservation.slotStart), tz) }
          : undefined;
        return needsConfirmation(ctx, "revoke", i.tourRef, fingerprint, revokeConfirmQuestion(midSentence(target.name), target.unit, when));
      }
      ctx.confirmations.redeem(i.confirmationCode, "revoke", i.tourRef, fingerprint);
      const tour = await revokeTour(ctx.services, i.tourRef, i.reason);
      return { summary: `${target.name}'s tour is called off and their access is switched off.`, tour };
    },
  }),
  tool({
    name: "pause_tours",
    title: "Pause tours",
    kind: "consequential",
    description:
      "Pauses new bookings at a property or one unit. Already-booked tours can be kept or cancelled with a text, including a later booking held while someone is still touring; a tour in progress always finishes. Cancelling a later booking while they are touring texts that the later tour is cancelled and their tour right now isn't affected. The cancelled count is only tours actually cancelled, never one that already ended. First call returns a yes/no question; if tours are already booked, say keep or cancel (bookedTours) and call again with confirmationCode only after an explicit yes. Leave paused out, or pass paused true, to pause. Pass paused false to resume bookings. Omitting paused keeps today's result. Passing paused returns done, blocked, or next. This is not a hold on one visitor.",
    input: z.strictObject({
      property: Property,
      unit: z.string().max(100).optional().describe("One unit to pause. Leave out to pause the whole property."),
      bookedTours: z.enum(["keep", "cancel"]).optional().describe("When tours are already booked: keep them, or cancel them with a text."),
      paused: z.boolean().optional().describe("True pauses bookings. False resumes them. Leave it out to pause, the same as before."),
      confirmationCode: Code,
    }),
    run: (ctx, i) => {
      if (i.paused === undefined) return pauseTours(ctx, i);
      const propertyId = i.property ? resolvePropertyId(ctx.services.workspace, i.property) : undefined;
      return attemptWrite(ctx, propertyId, async () => (await (i.paused === false ? resumeTours(ctx, i) : pauseTours(ctx, i))) as Record<string, unknown>);
    },
  }),
  tool({
    name: "resume_tours",
    title: "Resume tours",
    kind: "consequential",
    description:
      "Resumes bookings at a paused property or unit. First call returns a yes/no question that includes how many waiting visitors will be texted that tours are back; call again with confirmationCode only after an explicit yes. Each waiting visitor who hasn't opted out is texted once, then the waiting list is cleared. A later visitor Tour, Hi, or book restarts booking the same way as a first text (a home gets the welcome and day list, not a leftover unit picker). Resuming the property clears every unit pause. Resuming one unit does not lift a property-wide pause. Removing a property instead drops the waiting list and does not send the back text.",
    input: z.strictObject({
      property: Property,
      unit: z.string().max(100).optional().describe("One unit to resume. Leave out to resume the whole property."),
      confirmationCode: Code,
    }),
    run: (ctx, i) => resumeTours(ctx, i),
  }),
  tool({
    name: "remove_property",
    title: "Remove a property",
    kind: "consequential",
    description:
      "Removes a property from the operator's list, including a setup that hasn't been published yet (complete or not). Finds it by id, name, or address. A published property's records are kept — including one sent back to draft that still has publishedAt, visitor tour or reservation records, or a publish event in its audit. A practice tour alone does not count. An unpublished setup is removed completely (units, doors, and routes go with it). Booked visitors get a cancel text that the property isn't offering tours anymore — not that they'll be texted when tours are back — and pending door access is switched off. Waiting visitors from a pause are not texted that tours are back; that list is dropped. A later text to the property's line gets a goodbye and cannot book. Refused while someone is on a tour. First call returns a yes/no question: unpublished uses the draft wording (it isn't published yet, so no visitors are affected, but everything entered for it will be deleted for good) whether or not the setup is complete. Published with no bookings says no one is booked, so no cancel texts go out; one booked visitor is singular (gets), two or more stay plural. Name the property by the operator-given name, or street plus unit when there is exactly one unit, otherwise the street line — never Main Home. Call again with confirmationCode only after an explicit yes. Say remove, never archive.",
    input: z.strictObject({ property: Property, confirmationCode: Code }),
    run: (ctx, i) => removeProperty(ctx, i),
  }),

  // ------------------------------------------------------------ export
  tool({
    name: "export_audit",
    title: "Export the audit",
    kind: "change",
    description: 'Exports one day\'s tour records for a property as a validated, provider-neutral file (JSON + CSV) and summarizes it, including each access grant\'s times and each denial. Each embedded tour keeps only that day\'s events and grants. A grant belongs to the day it was issued, and to the next day only if a door was used after midnight. Practice-tour denials are counted apart from visitors who were turned away. When only practice tours were denied, the summary says "No visitors were turned away." and then the practice-tour denial count. Day is "today" (default) or YYYY-MM-DD.',
    input: z.strictObject({ property: Property, day: z.string().max(20).optional() }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const day = !i.day || i.day.trim().toLowerCase() === "today" ? undefined : parseLocalDate(i.day);
      if (i.day && i.day.trim().toLowerCase() !== "today" && !day) throw new SetupInputError("DAY_UNREADABLE", 'Use "today" or a date like 2026-09-28.');
      const out = await exportAudit(ctx.services, id, { day, now: ctx.now() });
      const s = out.summary;
      return {
        summary: formatAuditDaySummary(s),
        totals: s,
        reference: `Audit export ${out.exportId}, saved with ${ctx.services.workspace.load(id).config.property.name}'s tour records on the Tour Core computer.`,
        accessGrants: out.accessGrants,
        denials: out.denials,
        files: out.files.map((f) => ({ file: f, ...auditExportFileLink(ctx, id, out.exportId, f) })),
      };
    },
  }),

  // ------------------------------------------------- custom tour times
  tool({
    name: "list_tour_time_requests",
    title: "List custom time requests",
    kind: "read",
    description:
      "Who is waiting on a tour time that isn't a regular slot, or on moving a tour. Say this when the operator asks who wants a different time or to show custom-time requests. Pending requests only by default. Withdrawn and expired requests are hidden unless you pass status withdrawn, expired, or all, or includeHandled. A withdrawn request includes They booked a regular time instead. An expired request includes That time has already passed, so I've let {who} know their request ran out. You can still book them a one-off time. After an expired request, use schedule_one_off_tour or reschedule_tour — do not approve or propose that same time. Listing expires a request whose time has already passed and texts the visitor once. Asking for a regular time moves a held or confirmed booking right away and withdraws a pending request. No schedule jargon.",
    input: z.strictObject({
      property: Property,
      includeHandled: z.boolean().optional().describe("Include requests that were already approved, declined, replaced, or withdrawn."),
      status: z.string().optional().describe('Filter: pending (default), withdrawn, expired, approved, declined, superseded, or all.'),
    }),
    run: (ctx, i) => listTourTimeRequests(ctx, i),
  }),
  tool({
    name: "inspect_tour_time_request",
    title: "Inspect a custom time request",
    kind: "read",
    description: "One custom-time request in plain language: who, which unit, the time they want, their current booking if they have one, and whether that time is outside normal touring hours. Includes place when there is a place they asked to tour: that place's name, never Main Home. A withdrawn request is shown as withdrawn with They booked a regular time instead. An expired request is shown with That time has already passed, so I've let {who} know their request ran out. You can still book them a one-off time. After that, book them with schedule_one_off_tour or move them with reschedule_tour. Inspecting expires a request whose time has already passed and texts the visitor once.",
    input: z.strictObject({
      tourTimeRequestId: z.string().min(3).max(40).describe("The tourTimeRequestId from list_tour_time_requests or a tour update. Never show it to the operator."),
    }),
    run: (ctx, i) => inspectTourTimeRequest(ctx, i.tourTimeRequestId),
  }),
  tool({
    name: "approve_tour_time_request",
    title: "Approve a custom time",
    kind: "consequential",
    description:
      "Approves a visitor's requested tour time as a one-off. Does not change the property's regular hours or which times are offered. First call returns one yes/no question that names the action and ends Move it? or Book it? — never Continue?. A move always includes both days: Move {who}'s tour from {time} on {day} to {newTime} on {newDay}?. \"This is a one-off. Your regular tour hours stay the same\" only when the time is outside tour hours. Call again with confirmationCode only after an explicit yes. If the result says outsideHours, the question is the stronger outside-hours confirmation: call again with confirmationCode and acknowledgeOutsideHours true only after they agree to that. If the visitor already booked a regular time, the request is withdrawn: return They booked a regular time instead. If that time has already passed, the request is expired: return That time has already passed, so I've let {who} know their request ran out. You can still book them a one-off time. Then use schedule_one_off_tour or reschedule_tour. The visitor is texted once that the team couldn't get to the request in time. If already expired, return That request already ran out because its time passed, and {who} has been told. You can still book them a one-off time. Do not text again. Do not approve. That request has already been handled is only for a request that was already approved or declined. Refused when tours at that property or unit are paused (Tours at {property} are paused. Resume them first.) — tell the operator that, no visitor text.",
    input: z.strictObject({
      tourTimeRequestId: z.string().min(3).max(40).describe("The tourTimeRequestId. Never show it to the operator."),
      confirmationCode: Code,
      acknowledgeOutsideHours: z.boolean().optional().describe("True only after the operator agreed to a one-off tour outside normal touring hours."),
    }),
    run: (ctx, i) => approveTourTimeRequest(ctx, i),
  }),
  tool({
    name: "decline_tour_time_request",
    title: "Decline a custom time",
    kind: "change",
    description: "Declines a requested time and tells the visitor. Their current booking, if they have one, stays booked or confirmed. Use this for \"decline\" or \"keep the current booking\". If the visitor already booked a regular time, the request is withdrawn: return They booked a regular time instead. If that time has already passed, the request is expired: return That time has already passed, so I've let {who} know their request ran out. You can still book them a one-off time. Then use schedule_one_off_tour or reschedule_tour. The visitor is texted the expiry line once, not a decline. If already expired, return That request already ran out because its time passed, and {who} has been told. You can still book them a one-off time. Do not text again. Do not decline again. That request has already been handled is only for a request that was already approved or declined.",
    input: z.strictObject({
      tourTimeRequestId: z.string().min(3).max(40).describe("The tourTimeRequestId. Never show it to the operator."),
      note: z.string().max(300).optional().describe("A short note in the operator's words. Optional."),
    }),
    run: (ctx, i) => declineTourTimeRequest(ctx, i),
  }),
  tool({
    name: "propose_tour_time",
    title: "Offer another time",
    kind: "change",
    description:
      "Offers the visitor a different time. Their current booking stays until they agree. When they already have a booking, return I asked {who} about {time} on {day}. Their current booking stays until they say yes. When nothing is booked yet, return Sent {who} {time} on {day}. Nothing's booked until they say yes. If the offer is the same time they asked for, the visitor hears The {team} can do {time} on {day} as a one-off. Otherwise: The {team} can't do {requestedTime} on {requestedDay}, but {proposedTime} on {proposedDay} works. Say the time in everyday words, like \"3:30 PM\". Use this when the operator wants to suggest another time. If the visitor already booked a regular time, the request is withdrawn: return They booked a regular time instead. If the requested time has already passed, the request is expired: return That request ran out because its time already passed, so your offer of {newTime} on {newDay} didn't go out. I've let {who} know, and you can still book them a one-off time. Then use schedule_one_off_tour or reschedule_tour. The visitor is texted the expiry line once — not the proposal. If already expired, return That request already ran out because its time passed, and {who} has been told. You can still book them a one-off time. Do not text again. That request has already been handled is only for a request that was already approved or declined.",
    input: z.strictObject({
      tourTimeRequestId: z.string().min(3).max(40).describe("The tourTimeRequestId. Never show it to the operator."),
      newStartsAt: z.string().min(1).max(80).describe('The time to offer, such as "3:30 PM" or "tomorrow at 11:15 AM".'),
    }),
    run: (ctx, i) => proposeTourTime(ctx, i),
  }),
  tool({
    name: "reschedule_tour",
    title: "Move a tour",
    kind: "consequential",
    description:
      "Moves a visitor's tour to a time the landlord is directing, including a one-off time that isn't a regular slot. Pass the visitor's name and the new time in everyday words. Does not change the property's regular hours. Refuses to move a tour in progress, including hold or a door-system problem ({who} is touring right now, so I can't move this tour. Once it ends, you can book them another time.). If they also have a later booking, that refusal asks whether to move that booking instead (Want me to move their {oldTime} on {oldDay} booking to {newTime} on {newDay} instead?). Outside hours uses the full mid-tour question ({who} is touring right now, so I can't move this tour. Their later booking is {oldTime} on {oldDay}, and {newTime} on {newDay} is outside your tour hours. Want me to move it there anyway?) — a plain yes with confirmationCode only is enough; do not pass acknowledgeOutsideHours. A yes moves the later booking, not the tour they are on, and the operator summary is Moved {who}'s later booking to {time} on {day}. That later-booking offer does not end Move it? and is not a one-off. A normal (not mid-tour) first call returns one yes/no question that names the old and new times and ends Move it? — never Continue?. \"This is a one-off. Your regular tour hours stay the same\" only when a normal move is outside tour hours. Call again with confirmationCode only after an explicit yes. A normal time outside touring hours needs confirmationCode and acknowledgeOutsideHours true. The visitor is told Your tour of {unit} has been moved to {time} on {day}. A confirmed booking adds You're all set. The identity-form step omits it. There is no second consent question. Refused when tours at that property or unit are paused (Tours at {property} are paused. Resume them first.) — tell the operator that, no visitor text.",
    input: z.strictObject({
      reservationId: z.string().min(3).max(40).optional().describe("The reservation, when you already have it. Never show it."),
      tourRef: TourRef.optional(),
      visitor: z.string().min(1).max(80).optional().describe('The visitor, as the operator said the name, e.g. "Testa".'),
      newStartsAt: z.string().min(1).max(80).describe('The new time, such as "3:15 PM today".'),
      confirmationCode: Code,
      acknowledgeOutsideHours: z.boolean().optional().describe("True only after the operator agreed to a one-off tour outside normal touring hours."),
    }),
    run: (ctx, i) => rescheduleTour(ctx, i),
  }),
  tool({
    name: "schedule_one_off_tour",
    title: "Set up a one-time tour",
    kind: "consequential",
    description:
      "Sets up a tour for a visitor who asked for it, including someone who hasn't texted in yet. Use this only when the operator is booking a time they asked for. Pass their phone, the unit, and the time in everyday words. Optional name. Does not change the property's regular hours or which times are offered. First call returns one yes/no question that names the visitor, unit, day and time, says only say yes if they asked, and ends Book it? — never Continue?. \"This is a one-off. Your regular tour hours stay the same\" only when the time is outside tour hours; inside hours still says they get a text to confirm. Call again with confirmationCode only after that explicit yes. A time outside normal touring hours returns a stronger question; call again with confirmationCode and acknowledgeOutsideHours true only after they agree. Tour Core texts first: Reply YES to confirm, NO to cancel, or STOP to opt out. YES continues to the booking confirmation, then the identity form when this place uses one. STOP opts out and sends only the standard opt-out confirmation. NO cancels and tells the team. A leftover menu number (digits only, such as 1 or 2) only re-prompts Reply YES to confirm, NO to cancel, or STOP to opt out — no team issue, no alert. A real question before they confirm is flagged for the team (the hold stays pending). If they never reply in time, the slot is released; unless they opted out they get exactly one text that the time was released, then no further texts. A leftover conversation still choosing a day or time, with nothing booked, does not block — the one-off replaces it; later replies (including a leftover menu number) go to the new confirmation, not the old menu. Refused if the property isn't published with live visitor texting, the number already said STOP, the time is in the past, it overlaps another tour (the running tour and every future or held booking, checked before asking and before booking; a failed book does not leave a leftover choosing-a-time entry), or they already have a tour in progress (TOUR_EXISTS: a booked or held reservation, a pending one-off waiting for YES or NO, an active access window, or a paused tour). Tell the operator the refusal word for word — no tool names. Booked or held: They already have a booked tour. I can move it or call it off. Then use reschedule_tour to move it or revoke_tour_access to call it off. Pending one-off: They already have a tour waiting for them to reply YES or NO. I can call it off, or we can wait for them to answer. Then use revoke_tour_access to call it off, or wait. Open tour window: They're on a tour right now. I can call it off. Then use revoke_tour_access. On hold: Their tour is on hold. I can resume it or call it off. Then use clear_operator_hold to resume it or revoke_tour_access to call it off. Keep the STOP / opt-out refusal.",
    input: z.strictObject({
      property: Property,
      phone: z.string().min(7).max(30).describe("The visitor's phone number."),
      visitorName: z.string().min(1).max(80).optional().describe("The visitor's name, if the operator said it."),
      unit: Unit,
      startsAt: z.string().min(1).max(80).describe('The tour time, such as "3:15 PM today" or "Monday at 11:15 AM".'),
      confirmationCode: Code,
      acknowledgeOutsideHours: z.boolean().optional().describe("True only after the operator agreed to a one-off tour outside normal touring hours."),
    }),
    run: (ctx, i) => scheduleOneOffTour(ctx, i),
  }),

  // ------------------------------------------------------ day to day
  ...DAY_TO_DAY_TOOLS,

  // ------------------------------------------------------ installation
  ...INSTALLATION_TOOLS,
  ...MILESTONE_TOOLS,
];

export const OPERATOR_TOOL_NAMES = [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS].map((t) => t.name);

export class UnknownToolError extends Error {}

export type ToolOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/**
 * The one entry point for any agent host: validate, run the Tour Core
 * action, and return plain language. Errors come back as a plain message
 * the operator can be told, never a stack or a code.
 */
export async function callOperatorTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolOutcome> {
  const def = [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS].find((t) => t.name === name);
  if (!def) throw new UnknownToolError(`There's no Tour Core tool called "${name}".`);
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => (i.code === "unrecognized_keys" ? `unexpected ${i.keys.join(", ")}` : i.path.join(".") || "input")))];
    return { ok: false, error: `That request doesn't fit ${def.name} (${fields.join("; ")}). Nothing was changed.` };
  }
  const drive = ctx.installation?.records.provider() === "GOOGLE_DRIVE_READY";
  const before = drive && def.kind !== "read" ? rememberCanonical(ctx.services.workspace.root) : undefined;
  try {
    const result = redactSecrets(await def.run(ctx, parsed.data as never)) as Record<string, unknown>;
    if (before) {
      try {
        await ctx.installation!.records.commitLocal();
      } catch (err) {
        revertCanonical(ctx.services.workspace.root, before);
        if (err instanceof StorageUnavailableError || err instanceof StorageConflictError || err instanceof StoreBusyError) return { ok: false, error: err.message };
        return { ok: false, error: "I couldn't save that to Google Drive, so it isn't confirmed." };
      }
    }
    return { ok: true, result };
  } catch (err) {
    if (err instanceof UnsetTimeZoneError) return { ok: false, error: UNSET_ZONE_LINE };
    if (err instanceof SetupInputError || err instanceof TourCoreError || err instanceof UnavailableModeError || err instanceof PortableBackupError || err instanceof StorageUnavailableError) return { ok: false, error: err.message };
    if (err instanceof InvalidTransitionError) return { ok: false, error: "That tour can't make that change from where it is now. Nothing was changed." };
    return { ok: false, error: "Something went wrong in Tour Core. Nothing else was changed." };
  }
}

/** Defense in depth: no tool result may carry a configured secret (environment or secure setup), whatever path produced it. */
export function redactSecrets(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const secrets = secretValues(env);
  if (!secrets.length) return value;
  const text = JSON.stringify(value);
  if (!secrets.some((s) => text.includes(s))) return value;
  return JSON.parse(secrets.reduce((t, s) => t.split(s).join("[hidden]"), text));
}
