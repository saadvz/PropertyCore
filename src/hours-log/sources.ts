import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dollarsText, type PayRecord } from "../cleaner-core/payments";
import { FIXER_FILE, readFixer, type FixerFile } from "../fixer-core/store";
import { readHubFile, type Stay } from "../hub/store";
import { readSupply, SUPPLY_FILE, type SupplyFile } from "../supply-core/store";
import type { RowFact } from "./fact";
import { routeFact } from "./ownerRules";

export type { RowFact } from "./fact";

/**
 * Where the hours log's rows come from (#238): the records Property Core already keeps in a property's
 * folder. Each source is a pure function of those records, so the rows can always be rebuilt. Nothing
 * here writes a file or texts anyone.
 */

/** The fields of a Cleaner Core job the log reads. The engine keeps more. */
export interface CleaningJob {
  id: string;
  checkoutDate: string;
  canceled?: boolean;
  declined?: boolean;
  done?: boolean;
  arrivalAt?: string;
  startedAt?: string;
  doneAt?: string;
}

/** A time the host gave for a cleaning, in chat. */
export interface HostTime {
  jobId: string;
  field: "checkout" | "checkin";
  version: number;
  at?: string;
  /** The checkout it was given for, on a time a moved date cleared. Else the job's own. */
  checkoutDate?: string;
}

/** Everything in a property's folder the log reads. A missing record is empty. */
export interface PropertyRecords {
  propertyName?: string;
  timeZone?: string;
  stays: Stay[];
  cleanerName?: string;
  /** What the group calls the host, else the business name: the owner's name until the host sets one. */
  hostName?: string;
  cleaningJobs: CleaningJob[];
  hostTimes: HostTime[];
  pay: Record<string, PayRecord>;
  fixer?: FixerFile;
  supply?: SupplyFile;
}

export type RowSource = (records: PropertyRecords) => RowFact[];

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The engine's own slice for this property: a file of several tenants, or the flat one-tenant shape. */
function engineSlice(root: string, tenantId: string | undefined): Record<string, unknown> | undefined {
  const file = readJson(join(root, "cleaner-job", "cleaner-core.json"));
  if (!file) return undefined;
  const tenants = file.tenants as Record<string, Record<string, unknown>> | undefined;
  if (tenants && typeof tenants === "object") return tenantId ? tenants[tenantId] : undefined;
  if (typeof file.tenantId === "string" && tenantId && file.tenantId !== tenantId) return undefined;
  return file;
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** Reads the property folder's records. Never throws on a missing or unreadable file: that record is empty. */
export function readRecords(root: string): PropertyRecords {
  const hub = (() => {
    try {
      return readHubFile(root);
    } catch {
      return undefined;
    }
  })();
  const live = readJson(join(root, "cleaner-live.json")) ?? {};
  const slice = engineSlice(root, typeof live.propertyId === "string" ? live.propertyId : undefined) ?? {};
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const safe = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const property = hub?.property ?? {};
  const propertyName = str(property.nickname) ?? str(property.address);
  const cleanerName = str(live.cleanerName);
  const hostName = str(live.hostName) ?? str(live.business);
  const fixer = existsSync(join(root, FIXER_FILE)) ? safe(() => readFixer(root)) : undefined;
  const supply = existsSync(join(root, SUPPLY_FILE)) ? safe(() => readSupply(root)) : undefined;
  return {
    ...(propertyName ? { propertyName } : {}),
    ...(property.timeZone ? { timeZone: property.timeZone } : {}),
    stays: hub?.stays ?? [],
    ...(cleanerName ? { cleanerName } : {}),
    ...(hostName ? { hostName } : {}),
    cleaningJobs: list<CleaningJob>(slice.jobs),
    // The times a moved date cleared are still the host's: the engine keeps them for this log.
    hostTimes: [...list<HostTime>(slice.hostFacts), ...list<HostTime>(slice.clearedHostFacts)],
    pay: live.pay && typeof live.pay === "object" ? (live.pay as Record<string, PayRecord>) : {},
    ...(fixer ? { fixer } : {}),
    ...(supply ? { supply } : {}),
  };
}

const checkoutOf = (records: PropertyRecords, jobId: string) => records.cleaningJobs.find((job) => job.id === jobId)?.checkoutDate;

/** Cleaner Core: each finished cleaning in the cleaner's log, and the host's own times and pay marks. */
export const cleanerRows: RowSource = (records) => {
  const out: RowFact[] = [];
  const cleaner = records.cleanerName ?? "Cleaner";
  for (const job of records.cleaningJobs) {
    if (!job.done || job.canceled || job.declined || !job.doneAt) continue;
    const start = job.startedAt ?? job.arrivalAt;
    const needs = job.startedAt ? undefined : start ? "No START text, so the cleaning starts at the arrival time saved for it." : "No START text or arrival time, so the cleaning has no hours.";
    out.push({
      kind: "cleaning",
      actor: "cleaner",
      log: "cleaner",
      participant: cleaner,
      at: start ?? job.doneAt,
      ...(start ? { until: job.doneAt } : {}),
      task: `Turnover cleaning after the ${job.checkoutDate} checkout`,
      reference: `Cleaner Core job ${job.id}`,
      onSite: true,
      timing: job.startedAt ? "measured" : "scheduled",
      ...(needs ? { needs } : {}),
    });
  }
  for (const time of records.hostTimes) {
    if (!time.at) continue;
    const checkout = time.checkoutDate ?? checkoutOf(records, time.jobId);
    out.push({
      kind: "confirm-times",
      actor: "host",
      log: "owner",
      participant: "",
      at: time.at,
      task: `Gave the cleaner's ${time.field === "checkout" ? "checkout" : "next check-in"} time${checkout ? ` for the ${checkout} checkout` : ""}`,
      reference: `Cleaner Core job ${time.jobId}, host time ${time.field} v${time.version}`,
      onSite: false,
      timing: "rule",
    });
  }
  for (const [jobId, pay] of Object.entries(records.pay)) {
    if (!pay?.paidAt) continue;
    const checkout = checkoutOf(records, jobId);
    const what = `${dollarsText(pay.amountCents)}${checkout ? ` for the ${checkout} cleaning` : ""}${pay.how ? ` (${pay.how === "venmo" ? "Venmo" : "other"})` : ""}`;
    // Only the landlord's own pay mark is the host's. One taken from a receipt email, or one that doesn't
    // say, is the system's record.
    const system = pay.confirmedBy !== "landlord";
    out.push({
      kind: system ? "record-payment" : "pay-cleaner",
      actor: system ? "system" : "host",
      log: system ? "property-core" : "owner",
      participant: system ? "Property Core" : "",
      at: pay.paidAt,
      task: system ? `Recorded the cleaner's pay of ${what}${pay.confirmedBy === "receipt-email" ? " from a receipt email" : ""}` : `Paid the cleaner ${what}`,
      reference: `Cleaner Core job ${jobId}, pay record`,
      onSite: false,
      timing: system ? "system" : "rule",
    });
  }
  return out;
};

/** Fixer Core: each finished visit in the pro's own log, and each of the host's approvals. */
export const fixerRows: RowSource = (records) => {
  const file = records.fixer;
  if (!file) return [];
  const out: RowFact[] = [];
  const proName = (id: string) => file.pros.find((pro) => pro.id === id)?.name ?? "A pro";
  for (const job of file.jobs) {
    const ref = `Fixer Core job ${job.id}`;
    const repair = `${job.trade} repair: ${job.what}`;
    const host = (kind: RowFact["kind"], at: string | undefined, task: string) => {
      if (at) out.push({ kind, actor: "host", log: "owner", participant: "", at, task, reference: ref, onSite: false, timing: "rule" });
    };
    host("approve-repair", job.hostGo?.at, `Approved the ${repair}`);
    if (job.quotePick) host("pick-quote", job.quotePick.at, `Picked ${proName(job.quotePick.proId)}'s quote for the ${repair}`);
    const booking = job.booking;
    if (booking) {
      host("approve-booking", booking.hostYes?.at, `Approved ${proName(booking.proId)}'s booking for the ${repair}`);
      if (booking.revisedQuote) host("approve-price", booking.revisedQuote.hostYes?.at, `Approved the new price of ${dollarsText(booking.revisedQuote.cents)} for the ${repair}`);
    }
    for (const moved of job.reschedules ?? []) host("reschedule-repair", moved.at, `Moved the visit for the ${repair}${moved.reason ? `: ${moved.reason}` : ""}`);
    if (job.cost?.by === "host") host("record-cost", job.cost.at, `Recorded the cost of ${dollarsText(job.cost.cents)} for the ${repair}`);
    if (job.done?.by === "host") host("confirm-repair", job.done.at, `Confirmed the ${repair} is done`);
    // The job's record of each of the host's approvals: the same facts as above, so one whose live field is
    // still there adds nothing, and one whose field was replaced (a moved visit, a second price) comes back.
    for (const step of job.hostSteps ?? []) {
      const pro = step.proId ? proName(step.proId) : "a pro";
      const cents = dollarsText(step.cents ?? 0);
      const task =
        step.kind === "approve-repair" ? `Approved the ${repair}`
        : step.kind === "pick-quote" ? `Picked ${pro}'s quote for the ${repair}`
        : step.kind === "approve-booking" ? `Approved ${pro}'s booking for the ${repair}`
        : step.kind === "approve-price" ? `Approved the new price of ${cents} for the ${repair}`
        : step.kind === "record-cost" ? `Recorded the cost of ${cents} for the ${repair}`
        : `Confirmed the ${repair} is done`;
      host(step.kind, step.at, task);
    }
    if (job.state === "done" && booking && job.done) {
      const end = booking.extendedUntil ?? booking.until;
      const doneAt = Date.parse(job.done.at);
      const until = doneAt > Date.parse(booking.from) && doneAt <= Date.parse(end) ? job.done.at : end;
      const cost = job.cost ? `, cost ${dollarsText(job.cost.cents)} from the ${job.cost.by === "host" ? "host" : job.cost.by === "pro" ? "pro" : "agent"}` : "";
      out.push({
        kind: "repair-visit",
        actor: "pro",
        log: `pro:${booking.proId}`,
        participant: proName(booking.proId),
        at: booking.from,
        until,
        task: `${job.trade} visit: ${job.what}`,
        reference: `${ref}${cost}`,
        onSite: true,
        timing: "scheduled",
      });
    }
  }
  return out;
};

/** Supply Core: each order as purchasing rows. The host's approval or own order is theirs; the agent's placing is Property Core's. */
export const supplyRows: RowSource = (records) => {
  const file = records.supply;
  if (!file) return [];
  const out: RowFact[] = [];
  const itemName = (id: string) => file.items.find((item) => item.id === id)?.name ?? "an item";
  const linesOf = (items: { itemId: string; qty: number }[]) => items.map((line) => `${itemName(line.itemId)} x${line.qty}`).join(", ");
  for (const order of file.orders) {
    const task = orderTask(order.store, linesOf(order.items), order.chargedCents);
    const reference = `Supply Core order ${order.id}${order.orderNumber ? `, store order ${order.orderNumber}` : ""}`;
    const base = { at: order.at, task, reference, onSite: false };
    if (order.approvedBy === "host-browser") {
      out.push({ ...base, kind: "place-order", actor: "host", log: "owner", participant: "", timing: "rule" });
      continue;
    }
    if (order.approvedBy === "landlord" || order.approvedBy === "grok-card") out.push({ ...base, kind: "approve-order", actor: "host", log: "owner", participant: "", timing: "rule" });
    out.push({ ...base, kind: "auto-order", actor: "system", log: "property-core", participant: "Property Core", timing: "system" });
  }
  // The host's yes to a held cart, kept by Supply Core. While its order is there, the order's rows stand. An
  // unconfirmed order removed as not placed gives back that order's owner fact exactly, so a month confirmed
  // with it keeps one row. A cart that never became an order is its own row.
  const orders = new Set(file.orders.map((order) => order.id));
  // A cart still in the file hasn't closed or become an order yet, even one past its time that no Supply
  // call has swept: its row waits, so it never reads as not placed and then becomes an order too.
  const pending = new Set(file.carts.flatMap((cart) => (cart.approvalId ? [cart.approvalId] : [])));
  for (const approval of file.approvals ?? []) {
    if (approval.orderId && orders.has(approval.orderId)) continue;
    if (pending.has(approval.id)) continue;
    const lines = linesOf(approval.items);
    const owner = { kind: "approve-order" as const, actor: "host" as const, log: "owner" as const, participant: "", onSite: false, timing: "rule" as const };
    if (approval.orderId) {
      out.push({ ...owner, at: approval.orderAt ?? approval.at, task: orderTask(approval.store, lines, approval.totalCents), reference: `Supply Core order ${approval.orderId}` });
      continue;
    }
    out.push({ ...owner, at: approval.at, task: `Approved a supply order from ${approval.store}${lines ? `: ${lines}` : ""}, ${dollarsText(approval.totalCents)}. It wasn't placed.`, reference: `Supply Core approval ${approval.id}` });
  }
  return out;
};

/** A supply order's task line, the same for the order and for its kept approval. */
export function orderTask(store: string, lines: string, cents: number): string {
  return `Supply order from ${store}${lines ? `: ${lines}` : ""}, ${dollarsText(cents)}`;
}

/**
 * The owners' own entries on their standing lock codes: arrival, departure and time on site, measured.
 * Waiting on the smart-lock connection (saadvz/PropertyCore#180) and the lock partner's event shape, so it
 * gives nothing yet. When it lands, each entry is one row: kind "owner-on-site", actor "host", log "owner",
 * timing "measured", from the entry to the exit, with the lock event as its reference.
 */
export const ownerLockEntries: RowSource = () => [];

export const DEFAULT_SOURCES: readonly RowSource[] = [cleanerRows, fixerRows, supplyRows, ownerLockEntries];

const factKey = (fact: RowFact) => `${fact.kind}|${fact.reference}|${fact.at}`;

/**
 * Every fact the sources find, and the kept ones, each sent to the log it belongs in, once, oldest first.
 * `kept` are owner facts saved with a confirmed month, so a host's approval stays in that month after its
 * record was replaced (a rescheduled booking, a second price, a cleaning's moved dates).
 */
export function rawFacts(records: PropertyRecords, sources: readonly RowSource[] = DEFAULT_SOURCES, kept: readonly RowFact[] = []): RowFact[] {
  const seen = new Set<string>();
  const out: RowFact[] = [];
  for (const fact of [...sources.flatMap((source) => source(records)), ...kept].map(routeFact)) {
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.reference.localeCompare(b.reference) || a.kind.localeCompare(b.kind));
}

/**
 * The host's facts at the same instant came from one action in chat, like saving both cleaning times, or
 * marking a repair done with its cost: they are one owner row, so its minutes are counted once.
 */
export function mergeMoments(facts: readonly RowFact[]): RowFact[] {
  const out: RowFact[] = [];
  const owner = new Map<string, RowFact>();
  for (const fact of facts) {
    if (fact.log !== "owner" || fact.timing !== "rule") {
      out.push(fact);
      continue;
    }
    const first = owner.get(fact.at);
    if (!first) {
      const copy = { ...fact };
      owner.set(fact.at, copy);
      out.push(copy);
      continue;
    }
    if (!first.task.split("; ").includes(fact.task)) first.task = `${first.task}; ${fact.task}`;
    if (!first.reference.split("; ").includes(fact.reference)) first.reference = `${first.reference}; ${fact.reference}`;
  }
  return out;
}

/** Every row's fact: the sources' and the kept ones, routed, once each, with one owner row per action. */
export function factsFrom(records: PropertyRecords, sources: readonly RowSource[] = DEFAULT_SOURCES, kept: readonly RowFact[] = []): RowFact[] {
  return mergeMoments(rawFacts(records, sources, kept));
}
