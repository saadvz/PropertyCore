import { FIELD_WORDS, missingProfileFields, PROFILE_FIELDS, profileSummaryLine, type ProfileField } from "../config/unitProfile";
import type { ConfigIssue, ConfigSection } from "../config/validateConfig";
import { slotStartMinutes } from "../core/schedule";
import { tourWindows } from "../core/tourWindows";
import { formatClockTime, friendlyTimeZone, spokenClockTime } from "../core/timezone";
import type { DryTourGroup, DryTourResult } from "./dryTour";
import type { ReadinessResult } from "./readiness";
import {
  CHOICE_LABELS,
  describeDays,
  describeInterval,
  describeMinutes,
  doorFollowsUnitName,
  reviewSetup,
  suggestRoute,
  visitorHelpLines,
  type SetupDraft,
} from "./setupActions";
import { isCurrent, statusLabel, type SavedProperty, type TourRecord } from "./workspace";
import { describeHistory } from "../audit/describe";
import { PROPERTY_TYPE_LABELS, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { verificationSummaryRows } from "./verification";
import { formatDay, formatShortDateTime, formatTime } from "../core/timezone";
import type { ExportBundle } from "../export/exportBundle";

/**
 * View models for any setup surface. They carry only plain language plus ids
 * the surface needs to call actions. Anything technical sits under a `dev`
 * key, which the browser server strips unless developer mode is on.
 */

export const SETUP_STEPS = [
  { id: "property", title: "Property" },
  { id: "units", title: "Units" },
  { id: "doors", title: "Doors" },
  { id: "routes", title: "Routes" },
  { id: "hours", title: "Tour hours" },
  { id: "verification", title: "Verification" },
  { id: "services", title: "Records and messages" },
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number]["id"];

/** 23:59 is said as midnight. Other hours keep the clock with minutes. */
function hoursRangeLabel(start: string, end: string): string {
  if (start === "23:59" || end === "23:59") return `${spokenClockTime(start)} to ${spokenClockTime(end)}`;
  return `${formatClockTime(start)}-${formatClockTime(end)}`;
}

export interface Fix {
  step: SetupStep;
  label: string;
  unitId?: string;
}

export interface IssueView {
  message: string;
  unitId?: string;
  fix?: Fix;
  dev: { code: string; detail?: string };
}

const UNIT_CODES = ["NO_UNITS", "UNIT_NAME_MISSING", "DUPLICATE_UNIT_ID", "FACT_TOO_LONG", "TOO_MANY_FACTS", "BUILDING_ACCESS_MISSING", "APARTMENT_OR_CONDO_ONE_UNIT"];
const DOOR_CODES = ["NO_ENTRANCE", "DOOR_NAME_MISSING", "DUPLICATE_DOOR_ID", "UNIT_DOOR_MISSING", "UNIT_DOOR_UNKNOWN", "UNIT_DOOR_NOT_UNIT", "UNIT_DOOR_SHARED"];

/** Where to send the operator to fix a problem, in words they'd use. */
export function fixFor(code: string, section?: ConfigSection, unitId?: string): Fix | undefined {
  const withUnit = unitId ? { unitId } : {};
  if (UNIT_CODES.includes(code)) return { step: "units", label: "Fix units", ...withUnit };
  if (DOOR_CODES.includes(code)) return { step: "doors", label: "Fix doors", ...withUnit };
  switch (section) {
    case "property":
      return { step: "property", label: "Fix property details" };
    case "hours":
      return { step: "hours", label: "Fix tour hours" };
    case "routes":
      return { step: "routes", label: "Fix route", ...withUnit };
    case "units":
      return { step: "units", label: "Fix units", ...withUnit };
    case "verification":
      return { step: "verification", label: "Change verification" };
    case "services":
      return { step: "services", label: "Change records and messages" };
    default:
      return undefined;
  }
}

function issueView(issue: ConfigIssue): IssueView {
  const fix = fixFor(issue.code, issue.section, issue.unitId);
  return {
    message: issue.message,
    ...(issue.unitId ? { unitId: issue.unitId } : {}),
    ...(fix ? { fix } : {}),
    dev: { code: issue.code, ...(issue.detail ? { detail: issue.detail } : {}) },
  };
}

export const DOOR_KIND_LABELS = { ENTRANCE: "Entrance", UNIT: "Unit door", COMMON: "Hallway or shared door" } as const;

export const VERIFICATION_OPTIONS = [
  {
    mode: "basic-form" as const,
    title: "Basic identity form (recommended)",
    recommended: true,
    explanation:
      "Before the tour, visitors fill out a short form with their legal first and last name, email and phone number. It keeps a record of who they say they are, but it doesn't prove who they are.",
  },
  {
    mode: "none" as const,
    title: "No form",
    recommended: false,
    explanation: "Without a form, anyone who texts can book a tour and get in without telling you who they are.",
  },
];

export const COMMON_TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
].map((id) => ({ id, label: `${friendlyTimeZone(id)} (${id.split("/").pop()!.replace(/_/g, " ")})` }));

function servicesView(draft: SetupDraft) {
  const demo = draft.storageMode === "memory" && draft.messagingMode === "demo" && draft.accessMode === "durin-mock";
  const live = draft.messagingMode === "live";
  return {
    allDemo: demo,
    messaging: {
      mode: draft.messagingMode,
      options: [
        { mode: "demo" as const, title: "Demo messaging", explanation: "Messages to visitors appear on screen. Nothing is actually texted." },
        {
          mode: "live" as const,
          title: "Visitor texting",
          explanation: "Visitors text a real number from their own phone and get real replies. Uses the messaging provider connected for this installation, unless this building is on local test texts.",
        },
      ],
    },
    items: [
      {
        title: draft.storageMode === "memory" ? "Demo records" : CHOICE_LABELS.storage[draft.storageMode],
        text: "Tour records are kept on this computer.",
        dev: { mode: draft.storageMode, adapter: "InMemoryStore" },
      },
      {
        title: live ? "Visitor texting" : "Demo messaging",
        text: live
          ? "Visitors text the property's number and get real replies. Practice tours and the visitor demo still use demo messaging."
          : "Messages to visitors appear on screen. Nothing is actually texted.",
        demo: !live,
        dev: { mode: draft.messagingMode, adapter: live ? "MessagingProvider" : "DemoMessagingAdapter" },
      },
      {
        title: draft.accessMode === "durin-mock" ? "Door access demo mode" : CHOICE_LABELS.access[draft.accessMode],
        text: "Tour Core only asks the door system to unlock a door after its own safety checks pass.",
        dev: { mode: draft.accessMode, adapter: "MockDurinAccessAdapter" },
      },
    ],
  };
}

export function draftView(draft: SetupDraft) {
  const review = reviewSetup(draft);
  const issues = review.issues.map(issueView);
  const doorName = (id: string) => draft.doors.find((d) => d.id === id)?.name ?? "(a door that no longer exists)";
  const th = draft.tourHours;
  const entrances = draft.doors.filter((d) => d.kind === "ENTRANCE");

  const units = draft.units.map((u) => {
    const route = draft.routes.find((r) => r.unitId === u.id);
    const door = draft.doors.find((d) => d.id === u.doorId);
    return {
      id: u.id,
      name: u.name,
      summary: u.summary,
      facts: u.facts,
      details: unitDetailsView(u),
      door: door ? { id: door.id, name: door.name } : undefined,
      doorFollowsName: doorFollowsUnitName(draft, u.id),
      entryInstructions: u.entryInstructions,
      route: route?.stops.length
        ? { doorIds: route.stops.map((s) => s.doorId), doorNames: route.stops.map((s) => doorName(s.doorId)), directions: route.directions ?? "" }
        : undefined,
      suggestedRoute: suggestRoute(draft, u.id),
      issues: issues.filter((i) => i.unitId === u.id),
      dev: { id: u.id, doorId: u.doorId },
    };
  });

  const hoursValid = !issues.some((i) => i.fix?.step === "hours");
  const windows = tourWindows(th).map((w) => {
    const label = `${describeDays(w.days)}, ${hoursRangeLabel(w.start, w.end)}`;
    const toursPerDay = slotStartMinutes({ ...th, start: w.start, end: w.end }).length;
    return { days: w.days, start: w.start, end: w.end, label, toursPerDay, summary: `${label}. That's up to ${toursPerDay} tour${toursPerDay === 1 ? "" : "s"} a day.` };
  });
  const tourHours = {
    ...th,
    windows,
    /** Every window, "Mon-Fri, 9:00 AM-5:00 PM; Sat, Sun, 9:00 AM-8:00 PM". */
    label: windows.map((w) => w.label).join("; "),
    daysLabel: describeDays(th.days),
    hoursLabel: hoursRangeLabel(th.start, th.end),
    lengthLabel: describeMinutes(th.tourLengthMinutes),
    spacingLabel: describeInterval(th.slotEveryMinutes),
    earlyLabel: describeMinutes(th.earlyArrivalMinutes),
    valid: hoursValid,
    /** Only when the schedule is valid; an overlapping schedule has no honest count. */
    toursPerDay: hoursValid ? Math.max(0, ...windows.map((w) => w.toursPerDay)) : undefined,
    /** One sentence per window, so different weekend hours show up too. */
    summary: hoursValid ? windows.map((w) => w.summary).join(" ") : undefined,
  };

  const property = {
    id: draft.property.id,
    name: draft.property.name,
    address: draft.property.address,
    displayName: draft.property.displayName,
    propertyType: draft.property.propertyType,
    propertyTypeLabel: draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : undefined,
    buildingAccess: draft.property.buildingAccess,
    entryInstructionsDecided: draft.property.entryInstructionsDecided,
    timezone: draft.property.timezone,
    timezoneLabel: friendlyTimeZone(draft.property.timezone),
    facts: draft.property.facts,
  };

  const services = servicesView(draft);
  const reviewCards = [
    {
      step: "property" as SetupStep,
      title: property.name,
      rows: [
        ...(property.address !== property.name ? [property.address] : []),
        property.propertyTypeLabel ?? "Property type not chosen yet",
        ...(property.buildingAccess === "UNIT_ONLY" ? ["Building entrance: visitors get in on their own"] : []),
        ...(property.buildingAccess === "BUILDING_AND_UNIT" ? ["Building entrance: you control it"] : []),
        ...(property.timezone ? [`Timezone: ${property.timezoneLabel}`] : []),
        ...property.facts,
      ],
    },
    {
      step: "hours" as SetupStep,
      title: "Tours",
      rows: [
        ...(windows.length > 1 ? windows.map((w) => w.label) : [tourHours.daysLabel, tourHours.hoursLabel]),
        `Each tour lasts ${tourHours.lengthLabel}, and a new one can start every ${tourHours.spacingLabel}`,
        `Visitors can get in up to ${tourHours.earlyLabel} early`,
      ],
    },
    ...units.map((u) => ({
      step: "units" as SetupStep,
      unitId: u.id,
      title: u.name,
      rows: [u.summary || "No description yet", ...u.facts],
      route: { step: "routes" as SetupStep, text: u.route ? u.route.doorNames.join(" \u2192 ") : "No route yet" },
    })),
    {
      step: "verification" as SetupStep,
      title: "Verification",
      rows: verificationSummaryRows(draft.verificationMode, draft.verificationValidForDays),
    },
    {
      step: "services" as SetupStep,
      title: "Records and messages",
      rows: [
        ...services.items.map((s) => s.title),
        `Alerts go to: ${draft.operator.name}`,
        ...visitorHelpLines(draft.operator),
      ],
    },
  ];

  return {
    property,
    operator: {
      name: draft.operator.name,
      visitorContact: draft.operator.visitorContact ?? "",
    },
    units,
    doors: draft.doors.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      kindLabel: DOOR_KIND_LABELS[d.kind],
      unitName: draft.units.find((u) => u.doorId === d.id)?.name,
      removable: d.kind === "COMMON" || (d.kind === "ENTRANCE" && entrances.length > 1),
    })),
    tourHours,
    verification: { mode: draft.verificationMode, reuseForDays: draft.verificationValidForDays, options: VERIFICATION_OPTIONS },
    services,
    steps: SETUP_STEPS.map((s) => ({ ...s, issueCount: issues.filter((i) => i.fix?.step === s.id).length })),
    issues,
    reviewCards,
    canSave: review.canSave,
    dev: { propertyId: draft.property.id, modes: { verification: draft.verificationMode, messaging: draft.messagingMode, storage: draft.storageMode, access: draft.accessMode } },
  };
}
export type DraftView = ReturnType<typeof draftView>;

export function readinessView(result: ReadinessResult) {
  return {
    passed: result.passed,
    headline: result.passed ? "Everything's ready." : "A few things need fixing first.",
    checks: result.checks.map((c) => ({
      id: c.id,
      label: c.label,
      ok: c.ok,
      problems: c.details.map((p) => {
        const fix = fixFor(p.code, p.section, p.unitId);
        return { message: p.message, ...(fix ? { fix } : {}), dev: { code: p.code, ...(p.detail ? { detail: p.detail } : {}) } };
      }),
    })),
    advisories: result.advisories ?? [],
  };
}

const GROUP_TITLES: Record<DryTourGroup, string> = { journey: "The visitor's journey", safety: "Safety test", wrapup: "Finishing up" };

export function dryTourView(result: DryTourResult) {
  return {
    passed: result.passed,
    headline: result.passed ? "Practice tour passed." : "The practice tour stopped.",
    failure: result.failure,
    groups: (Object.keys(GROUP_TITLES) as DryTourGroup[])
      .map((group) => ({
        id: group,
        title: GROUP_TITLES[group],
        items: result.checks.filter((c) => c.group === group).map((c) => ({ label: c.label, outcome: c.outcome, ok: c.ok, detail: c.detail, dev: { id: c.id } })),
      }))
      .filter((g) => g.items.length),
    messages: (result.messages ?? []).map((m) => ({ time: m.time, to: m.audience === "OPERATOR" ? "Alert to your team" : "Text to the visitor", body: m.body })),
    recordsSaved: !!result.bundle,
    dev: { devLines: result.devLines ?? [], auditEventCount: result.audit.length },
  };
}

/**
 * Whether the operator's latest edits are in the saved setup. Valid edits are
 * saved automatically; edits with problems are kept as a draft until fixed.
 */
export function saveStateView(draft: SetupDraft, unsaved: boolean) {
  if (!unsaved) return { state: "saved" as const, label: "All changes saved" };
  const count = validateConfig(draft).length;
  return {
    state: "draft" as const,
    label: `Changes kept as a draft until ${count === 1 ? "1 problem is" : `${count} problems are`} fixed`,
  };
}

/** A unit's leasing details for the setup screens: one line, what's missing, and the values as editable text. */
export function unitDetailsView(u: SetupDraft["units"][number]) {
  const text = (f: ProfileField): string => {
    const v = u.profile?.[f];
    if (!v) return "";
    if (v.status === "NOT_PROVIDED") return "not provided";
    const value = v.value as unknown;
    if (f === "bedrooms") return value === 0 ? "studio" : String(value);
    if (f === "monthlyRent") return `$${(value as { amount: number }).amount.toLocaleString("en-US")}`;
    if (f === "availability") return (value as { now?: boolean; text: string }).now ? "now" : (value as { text: string }).text;
    if (f === "furnished") return value ? "furnished" : "unfurnished";
    return String(value);
  };
  return {
    line: profileSummaryLine(u),
    missing: missingProfileFields(u).map((f) => FIELD_WORDS[f]),
    inputs: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, text(f)])) as Record<ProfileField, string>,
  };
}

export function propertySummary(
  saved: SavedProperty | undefined,
  draft: SetupDraft | undefined,
  unsaved: boolean,
  extra: { tourCount?: number; activeVisitorDemo?: string; messagingLine?: string; needsAttention?: { visitorPhone: string; problem: string }[] } = {},
) {
  const config = saved?.config ?? draft!;
  const state = saved?.state;
  const readinessCurrent = !!state && isCurrent(state.readiness, state);
  const practiceCurrent = !!state && isCurrent(state.dryTour, state);
  return {
    id: config.property.id,
    name: config.property.name,
    address: config.property.address,
    saved: !!saved,
    unsavedChanges: unsaved,
    save: saveStateView(draft ?? config, unsaved),
    status: saved ? state!.status : ("IN_PROGRESS" as const),
    statusLabel: saved ? statusLabel(saved) : "Setup in progress",
    published: state?.status === "PUBLISHED_FOR_DEMO",
    readinessPassed: readinessCurrent && !!state?.readiness?.passed,
    practicePassed: practiceCurrent && !!state?.dryTour?.passed,
    hasHistory: (extra.tourCount ?? 0) > 0,
    activeVisitorDemo: extra.activeVisitorDemo,
    /** The texting number visitors use for this property, when one is connected. */
    messagingLine: extra.messagingLine,
    /** Text-message tours that couldn't be picked up after a restart. No doors were opened for them. */
    needsAttention: (extra.needsAttention ?? []).map((n) => ({ message: `A text-message tour with ${n.visitorPhone} couldn't be picked up after a restart. Please reach out to them.`, dev: { problem: n.problem } })),
    dev: { propertyId: config.property.id, configHash: state?.configHash, safetyHash: state?.safetyHash, recordsFolder: state?.dryTour?.recordsFolder },
  };
}

// ------------------------------------------------------------ tour records

const OUTCOME_LABELS: Record<TourRecord["outcome"], string> = {
  passed: "Passed",
  stopped: "Stopped early",
  "in-progress": "In progress",
  finished: "Finished",
};

const KIND_LABELS: Record<TourRecord["kind"], string> = { practice: "Practice tour", "visitor-demo": "Visitor demo", messaging: "Text message tour" };

export function tourListView(records: TourRecord[], timeZone: string) {
  return records.map((r) => ({
    id: r.tourId,
    label: formatShortDateTime(new Date(r.ranAt), timeZone),
    kindLabel: KIND_LABELS[r.kind],
    outcomeLabel: OUTCOME_LABELS[r.outcome],
    ok: r.outcome === "passed" || r.outcome === "finished" ? true : r.outcome === "stopped" ? false : null,
    visitorName: r.visitorName,
  }));
}

const ACCESS_TYPES = new Set(["ACCESS_ALLOWED", "ACCESS_DENIED", "ACCESS_REVOKED"]);

/** Everything the operator needs to reopen one tour: conversation, access decisions, safety, timeline. */
export function tourDetailView(record: TourRecord, bundle: ExportBundle, config: TourCoreConfig) {
  const tz = config.property.timezone;
  const timeline = describeHistory(bundle.auditEvents, { ...bundle, operatorName: config.operator.name }, tz);
  const conversation =
    record.conversation?.map((m) => ({
      from: m.from,
      text: m.text,
      time: formatTime(new Date(m.at), tz),
      ...(m.delivery || m.interpretation ? { dev: { ...m.delivery, ...(m.interpretation ? { interpretation: m.interpretation } : {}) } } : {}),
    })) ??
    bundle.messages
      .filter((m) => m.audience === "PROSPECT")
      .map((m) => ({ from: m.direction === "INBOUND" ? ("visitor" as const) : ("tourcore" as const), text: m.body, time: formatTime(new Date(m.at), tz) }));
  const unit = config.units.find((u) => u.id === (record.unitId ?? bundle.reservations[0]?.unitId));
  const reservation = bundle.reservations[0];
  return {
    id: record.tourId,
    title: KIND_LABELS[record.kind],
    visitorPhone: record.kind === "messaging" ? record.visitorPhone : undefined,
    ranAtLabel: formatShortDateTime(new Date(record.ranAt), tz),
    outcomeLabel: OUTCOME_LABELS[record.outcome],
    ok: record.outcome === "passed" || record.outcome === "finished",
    failure: record.failure,
    visitorName: record.visitorName ?? bundle.prospects[0]?.name,
    unitName: unit?.name,
    tourTime: reservation?.slotStart ? `${formatDay(new Date(reservation.slotStart), tz)}, ${formatTime(new Date(reservation.slotStart), tz)}` : undefined,
    conversation,
    safetyChecks: record.checks ? dryTourView({ passed: record.outcome === "passed", ranAt: record.ranAt, checks: record.checks, audit: [] }).groups : undefined,
    accessDecisions: timeline.filter((e) => ACCESS_TYPES.has(e.dev.type)),
    safetyEvents: timeline.filter((e) => e.tone === "blocked"),
    timeline,
    dev: { tourId: record.tourId, auditEventCount: bundle.auditEvents.length },
  };
}
