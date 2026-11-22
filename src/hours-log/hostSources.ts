import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readGuestFacts, readGuestMessages, type FactSave, type GuestMessageRecord } from "../guest-messages/store";
import { TOPIC_LABELS } from "../guest-messages/facts";
import { readBookingEmails, type BookingEmailRecord } from "../hub/bookingEmails";
import type { BookingPlatform } from "../hub/bookingSources";
import { readGuestCodes, type GuestCodesFile } from "../locks/guestCodes";
import { readDoorLocks, type DoorLocksFile } from "../locks/settings";
import { readOversight } from "../oversight/store";
import type { ExpectedVisit } from "../oversight/visits";
import { readStayCheck } from "../stay-check/store";
import type { MessageEvent } from "../visits/events";
import { VISIT_EVENTS_DIR, VisitLog } from "../visits/store";
import type { RowFact } from "./fact";
import { readHostSteps, type HostStep } from "./hostSteps";

/**
 * The hours log's owner rows for the host's own steps in the newer features (#18): approved texts and guest
 * replies, late checkouts, house facts and house rules, locks, standing codes, guest codes, expected visits,
 * bookings from other platforms, upkeep schedules, and setup. Each comes from that feature's own record of
 * the host's yes, and only that: Property Core's own work in the same features (a sweep, a lock's event, a
 * booking its reader applied, a guest message it took, a rule it moved) gives no row here.
 */

/** What these sources read from a property's folder. Each list is empty when its record is missing or can't be read. */
export interface HostRecords {
  /** `host-steps.jsonl`: the host's steps in features that keep no time of their own. */
  hostSteps: HostStep[];
  /** `guest-messages.jsonl`: approved replies and allowed late checkouts only. */
  guestYes: GuestMessageRecord[];
  /** `guest-facts.json`: each of the host's saves, with each saved fact's own time for a file from before #18. */
  factSaves: FactSave[];
  /** `stay-check.json`'s last save of the house rules, for a save from before #18. */
  rulesSavedAt?: string;
  /** `booking-emails.jsonl`: only the lines the host said yes to: another platform's booking, or a cancellation called off. */
  bookingYes: BookingEmailRecord[];
  /** `oversight.json`: the expected visits the host saved. */
  expected: ExpectedVisit[];
  /** The visit log's texts that went out as the host's own approved message. */
  hostTexts: Pick<MessageEvent, "id" | "at" | "role">[];
  /** `door-locks.json`, for steps from before #18. */
  locks?: Pick<DoorLocksFile, "activeAt" | "standing" | "devices" | "doors">;
  /** `guest-codes.json`, for steps from before #18. */
  guestCodes?: Pick<GuestCodesFile, "mode" | "modeAt" | "leases">;
  /** A flow the host turned on, or activated, and when. */
  activations: { flow: "cleaning" | "supplies" | "fixer"; at: string; how: "on" | "activate" }[];
}

const safe = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const iso = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The service's own audit of flows turned on and off, in the account's folder, for this property: only the host's. */
function flowsTurnedOn(root: string): HostRecords["activations"] {
  const path = join(root, "..", "..", "service-audit.jsonl");
  if (basename(join(root, "..")) !== "properties" || !existsSync(path)) return [];
  const property = basename(root);
  const out: HostRecords["activations"] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = safe(() => JSON.parse(line) as { at?: unknown; actor?: unknown; property?: unknown; flow?: unknown; on?: unknown });
    if (!entry || entry.actor !== "host" || entry.property !== property || entry.on !== true || !iso(entry.at)) continue;
    if (entry.flow === "cleaning" || entry.flow === "supplies" || entry.flow === "fixer") out.push({ flow: entry.flow, at: entry.at, how: "on" });
  }
  return out;
}

function settingsActivated(root: string, file: string, flow: "supplies" | "fixer"): HostRecords["activations"] {
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const raw = safe(() => JSON.parse(readFileSync(path, "utf8")) as { settings?: { activatedAt?: unknown } });
  const at = raw?.settings?.activatedAt;
  return iso(at) ? [{ flow, at, how: "activate" }] : [];
}

/** Reads the records these sources use. Never throws: a missing or unreadable record is empty. */
export function readHostRecords(root: string): HostRecords {
  const facts = safe(() => readGuestFacts(root));
  const factSaves: FactSave[] = [...(facts?.history ?? [])];
  for (const fact of facts?.facts ?? []) {
    if (iso(fact.savedAt) && !factSaves.some((save) => save.topic === fact.topic && save.at === fact.savedAt)) factSaves.push({ at: fact.savedAt, topic: fact.topic });
  }
  const stay = existsSync(join(root, "stay-check.json")) ? safe(() => readStayCheck(root)) : undefined;
  const visitLog = existsSync(join(root, VISIT_EVENTS_DIR)) ? new VisitLog(root) : undefined;
  const hostTexts = (visitLog ? (safe(() => visitLog.read()) ?? []) : []).flatMap((event) =>
    event.type === "message" && event.direction === "out" && event.label === "host-message" && iso(event.at) ? [{ id: event.id, at: event.at, role: event.role }] : [],
  );
  const locks = existsSync(join(root, "door-locks.json")) ? safe(() => readDoorLocks(root)) : undefined;
  const guestCodes = existsSync(join(root, "guest-codes.json")) ? safe(() => readGuestCodes(root)) : undefined;
  return {
    hostSteps: safe(() => readHostSteps(root)) ?? [],
    guestYes: (safe(() => readGuestMessages(root)) ?? []).filter((record) => (record.event === "reply-approved" || record.event === "late-checkout") && iso(record.at)),
    factSaves,
    ...(iso(stay?.rulesSavedAt) ? { rulesSavedAt: stay!.rulesSavedAt } : {}),
    bookingYes: (safe(() => readBookingEmails(root)) ?? []).filter((record) => (record.hostConfirmed === true || record.outcome === "called-off") && iso(record.at)),
    expected: existsSync(join(root, "oversight.json")) ? (safe(() => readOversight(root).visits) ?? []) : [],
    hostTexts,
    ...(locks ? { locks } : {}),
    ...(guestCodes ? { guestCodes } : {}),
    activations: [...flowsTurnedOn(root), ...settingsActivated(root, "fixer.json", "fixer"), ...settingsActivated(root, "supply.json", "supplies")],
  };
}

const FLOW_NAMES = { cleaning: "Cleaner Core", supplies: "Supply Core", fixer: "Fixer Core" } as const;
const PLATFORM_NAMES: Record<BookingPlatform, string> = { airbnb: "Airbnb", vrbo: "Vrbo", booking: "Booking.com", direct: "your own site", other: "another platform" };
const ROLE_NAMES: Record<MessageEvent["role"], string> = { cleaner: "the cleaner", pro: "a pro", host: "yourself", observer: "an observer", group: "the cleaning group" };
const RELEASE_WORDS: Record<string, string> = { automatic: "automatic", ask: "ask first", off: "off" };

const owner = (kind: RowFact["kind"], at: string, task: string, reference: string): RowFact => ({ kind, actor: "host", log: "owner", participant: "", at, task, reference, onSite: false, timing: "rule" });

/** One host step as its owner row. Steps from before #18 found in a feature's own file give the same row, so one is never two. */
function stepFact(step: HostStep): RowFact | undefined {
  const about = step.about;
  const ref = step.ref;
  switch (step.kind) {
    case "activate":
      return owner("setup", step.at, `Activated ${about ?? "a flow"}`, `Setup, ${about ?? "activate"}`);
    case "locks-on":
      return owner("lock-setup", step.at, `Connected the locks${about ? ` (${about})` : ""} and approved them for the cleaner's and pros' codes`, "Connected locks");
    case "locks-off":
      return owner("lock-setup", step.at, "Switched back to the saved door code", "Connected locks, off");
    case "lock-settings":
      return owner("lock-setup", step.at, "Approved how door codes go out", "Connected locks, settings");
    case "standing-add":
      return owner("standing-code", step.at, `Approved a standing code for ${about ?? "a person"}`, `Standing code ${ref ?? "added"}`);
    case "standing-invite":
      return owner("standing-code", step.at, `Approved sending ${about ?? "a person"} the invite again`, `Standing code ${ref ?? "invite"}, invite`);
    case "standing-link":
      return owner("standing-code", step.at, `Approved a new code link for ${about ?? "a person"}`, `Standing code ${ref ?? "link"}, link`);
    case "standing-remove":
      return owner("standing-code", step.at, `Removed ${about ? `${about}'s` : "a"} standing code`, `Standing code ${ref ?? "removed"}, removed`);
    case "guest-codes-mode":
      return owner("guest-codes", step.at, `Chose how guest door codes work: ${RELEASE_WORDS[about ?? ""] ?? about ?? "changed"}`, "Guest codes, mode");
    case "guest-code-make":
      return owner("guest-codes", step.at, `Approved a guest door code for ${about ?? "a stay"}`, `Guest code ${ref ?? "stay"}`);
    case "guest-code-link":
      return owner("guest-codes", step.at, `Approved a new guest code link for ${about ?? "a stay"}`, `Guest code ${ref ?? "stay"}, link`);
    case "lease-add":
      return owner("guest-codes", step.at, `Approved a lease door code for ${about ?? "a tenant"}`, `Lease ${ref ?? "added"}`);
    case "lease-change":
      return owner("guest-codes", step.at, `Changed ${about ? `${about}'s` : "a"} move-out day`, `Lease ${ref ?? "changed"}, move-out`);
    case "lease-remove":
      return owner("guest-codes", step.at, `Removed ${about ? `${about}'s` : "a"} lease door code`, `Lease ${ref ?? "removed"}, removed`);
    case "lease-link":
      return owner("guest-codes", step.at, `Approved a new code link for ${about ?? "a tenant"}`, `Lease ${ref ?? "link"}, link`);
    case "rules-save":
      return owner("house-rules", step.at, `Saved the house rules${about ? ` (${about} rule${about === "1" ? "" : "s"})` : ""}`, "House rules");
    case "rules-add":
      return owner("house-rules", step.at, "Added a house rule", "House rules");
    case "check-time":
      return owner("house-rules", step.at, `Set the nightly check time${about ? ` to ${about}` : ""}`, "House rules, check time");
    case "stay-allow":
      return owner("house-rules", step.at, `Allowed something for the stay checking in ${about ?? "soon"}`, `House rules, stay ${about ?? ""}`.trim());
    case "flag-false":
      return owner("house-rules", step.at, `Marked a nightly ${about ?? "stay check"} flag as wrong`, `House rules, ${about ?? "flag"} flag`);
    case "upkeep-save":
      return owner("save-upkeep", step.at, `Saved the upkeep schedule${about ? `: ${about}` : ""}`, `Fixer Core upkeep ${ref ?? "item"}`);
    case "upkeep-remove":
      return owner("save-upkeep", step.at, `Removed ${about ?? "an item"} from the upkeep schedule`, `Fixer Core upkeep ${ref ?? "item"}, removed`);
  }
}

/** The host's own steps in the newer features, as owner rows (#18). */
export function hostStepRows(records: HostRecords): RowFact[] {
  const out: RowFact[] = [];
  for (const step of records.hostSteps) {
    const fact = stepFact(step);
    if (fact) out.push(fact);
  }
  // Records from before #18 kept their own time of the host's yes: the same rows the steps give.
  if (records.rulesSavedAt) out.push(owner("house-rules", records.rulesSavedAt, "Saved the house rules", "House rules"));
  const locks = records.locks;
  if (locks?.activeAt) out.push(owner("lock-setup", locks.activeAt, `Connected the locks${lockNames(locks)} and approved them for the cleaner's and pros' codes`, "Connected locks"));
  for (const person of locks?.standing ?? []) {
    if (iso(person.addedAt)) out.push(owner("standing-code", person.addedAt, `Approved a standing code for ${person.name}`, `Standing code ${person.id}`));
    if (iso(person.removedAt)) out.push(owner("standing-code", person.removedAt, `Removed ${person.name}'s standing code`, `Standing code ${person.id}, removed`));
  }
  const codes = records.guestCodes;
  if (codes?.mode && iso(codes.modeAt)) out.push(owner("guest-codes", codes.modeAt, `Chose how guest door codes work: ${RELEASE_WORDS[codes.mode] ?? codes.mode}`, "Guest codes, mode"));
  for (const lease of codes?.leases ?? []) {
    if (iso(lease.addedAt)) out.push(owner("guest-codes", lease.addedAt, `Approved a lease door code for ${lease.name}`, `Lease ${lease.id}`));
    if (iso(lease.removedAt)) out.push(owner("guest-codes", lease.removedAt, `Removed ${lease.name}'s lease door code`, `Lease ${lease.id}, removed`));
  }
  return out;
}

function lockNames(locks: NonNullable<HostRecords["locks"]>): string {
  const names = locks.doors.flatMap((id) => locks.devices.find((device) => device.id === id)?.name ?? []);
  return names.length ? ` (${names.join(", ")})` : "";
}

/** Approved texts and guest replies, allowed late checkouts, house facts, other platforms' bookings, expected visits and setup. */
export function hostRecordRows(records: HostRecords): RowFact[] {
  const out: RowFact[] = [];
  for (const text of records.hostTexts) out.push(owner("approve-text", text.at, `Approved a text to ${ROLE_NAMES[text.role] ?? "the cleaner"}`, `Text ${text.id}`));
  for (const record of records.guestYes) {
    if (record.event === "reply-approved") out.push(owner("approve-guest-reply", record.at, "Approved a reply to a guest's message", `Guest message ${record.id}`));
    else if (record.lateCheckout) out.push(owner("allow-late-checkout", record.at, `Allowed a late checkout until ${record.lateCheckout.time} on ${record.lateCheckout.checkout}`, `Late checkout ${record.id}`));
  }
  for (const save of records.factSaves) {
    const label = TOPIC_LABELS[save.topic];
    out.push(owner("house-facts", save.at, save.learnedFrom ? `Answered a guest's question and kept it as the ${label} fact` : save.topic === "rules" ? "Saved the house rules for guests" : `Saved the ${label} house fact`, `House facts, ${save.topic}`));
  }
  for (const record of records.bookingYes) {
    const parsed = record.parsed;
    const where = PLATFORM_NAMES[parsed?.platform ?? "airbnb"];
    const dates = parsed?.checkIn?.date && parsed.checkout?.date ? `, ${parsed.checkIn.date} to ${parsed.checkout.date}` : "";
    const what = record.outcome === "called-off" || parsed?.kind === "cancelled" ? "Approved calling off" : parsed?.kind === "changed" ? "Approved the change to" : "Approved";
    out.push(owner("approve-booking-email", record.at, `${what} a booking from ${where}${dates}`, `Booking email ${record.bodyHash ?? record.at}`));
  }
  for (const visit of records.expected) {
    const when = `${visit.date}${visit.from && visit.to ? `, ${visit.from} to ${visit.to}` : ""}`;
    if (iso(visit.savedAt)) out.push(owner("expected-visit", visit.savedAt, `Logged an expected visit: ${visit.who} on ${when}`, `Expected visit ${visit.id}`));
    if (iso(visit.cancelledAt)) out.push(owner("expected-visit", visit.cancelledAt, `Cancelled the expected visit: ${visit.who} on ${when}`, `Expected visit ${visit.id}, cancelled`));
  }
  for (const flow of records.activations) {
    out.push(owner("setup", flow.at, flow.how === "on" ? `Turned on ${FLOW_NAMES[flow.flow]} for the property` : `Activated ${FLOW_NAMES[flow.flow]}`, `Setup, ${FLOW_NAMES[flow.flow]} ${flow.how}`));
  }
  return out;
}
