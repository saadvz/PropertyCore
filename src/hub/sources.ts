import { interpretFeed, isCalendarBlock, type FeedBlock, type FeedRead, type Turnover } from "./calendar";

export type BookingSourceKind = "guesty-lite" | "ical" | "google-calendar" | "notion";

export type SourcePermission = "granted" | "missing" | "insufficient";

export interface SourceSnapshot {
  kind: BookingSourceKind;
  /** `guesty-lite`, `google-calendar`, `notion`, or `ical:<slug>` for one of several saved calendar links. */
  sourceId: string;
  /** A hash of the calendar link this was read from, never the link. Ties the snapshot to the link, not the name. */
  origin?: string;
  tenantId: string;
  turnovers: Turnover[];
  blocks: FeedBlock[];
  /** Absent on Guesty and Google reads, which are already authorized fixtures. */
  permission?: SourcePermission;
  /** When the agent read the source. The engine decides whether that read is stale. */
  fetchedAt?: string;
  /** Host-facing sentence when permission is missing or insufficient. Not a send. */
  fallback?: string;
}

export interface SourceRef {
  kind: BookingSourceKind;
  uid: string;
}

export interface JobProvenance {
  jobId: string;
  sources: SourceRef[];
}

/**
 * One read of one booking source. A live Google Calendar connector implements
 * this same method. The demo ships only the fixture reader. See
 * docs/cleaner-core-v5.1-step-e-rationale.md for the live connector.
 */
export interface BookingSource {
  readonly kind: BookingSourceKind;
  read(): Promise<SourceSnapshot>;
}

export interface SourceConflict {
  jobId: string;
  checkoutDate: string;
  otherCheckoutDate: string;
}

export interface NormalizedSources {
  feed: FeedRead;
  conflicts: SourceConflict[];
  provenance: JobProvenance[];
}

export const BOOKING_SOURCE_KINDS = ["guesty-lite", "ical", "google-calendar", "notion"] as const satisfies readonly BookingSourceKind[];

const SOURCE_ORDER: BookingSourceKind[] = [...BOOKING_SOURCE_KINDS];

export const NOTION_PERMISSION_MISSING =
  "I can't read that Notion database. Permission is missing, so I did not sync bookings and I did not send a cleaning text.";
export const NOTION_PERMISSION_INSUFFICIENT =
  "I can't read that Notion database. Permission is not enough to read it, so I did not sync bookings and I did not send a cleaning text.";

export function guestyLiteSource(ical: string, tenantId: string): BookingSource {
  return {
    kind: "guesty-lite",
    async read() {
      const feed = interpretFeed(ical);
      return { kind: "guesty-lite", sourceId: "guesty-lite", tenantId, turnovers: feed.turnovers, blocks: feed.blocks };
    },
  };
}

/** One read of one saved calendar link. `sourceId` is `ical:<slug>`, so several links sit side by side. */
export function icalSource(body: string, tenantId: string, sourceId: string): BookingSource {
  return {
    kind: "ical",
    async read() {
      const feed = interpretFeed(body);
      return { kind: "ical", sourceId, tenantId, turnovers: feed.turnovers, blocks: feed.blocks };
    },
  };
}

/** The part of a Calendar API `events.list` response that Grok's own connector hands over. */
export interface GoogleEventList {
  timeZone?: string;
  items: unknown[];
}

/** One read of events Grok already fetched. The property id is the tenant, so the engine accepts it. */
export function googleCalendarSource(list: GoogleEventList, tenantId: string): BookingSource {
  return googleCalendarFixtureSource(JSON.stringify({ ...list, tenantId }));
}

/**
 * Reads a saved Calendar API `events.list` document. No network and no credentials.
 * A cancelled event is omitted, which is how a removed event leaves the snapshot.
 */
export function googleCalendarFixtureSource(body: string): BookingSource {
  return {
    kind: "google-calendar",
    async read() {
      return readGoogleCalendarFixture(body);
    },
  };
}

export function readGoogleCalendarFixture(body: string): SourceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Google Calendar fixture is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Google Calendar fixture is not a calendar.");
  const record = parsed as { tenantId?: unknown; timeZone?: unknown; items?: unknown };
  if (typeof record.tenantId !== "string" || record.tenantId.trim() === "") {
    throw new Error("Google Calendar fixture needs a tenantId.");
  }
  const timeZone = typeof record.timeZone === "string" && record.timeZone.trim() !== "" ? record.timeZone : "America/New_York";
  const items = Array.isArray(record.items) ? record.items : [];
  const stays: Turnover[] = [];
  const blocks: FeedBlock[] = [];
  for (const item of items) {
    const event = readGoogleEvent(item, timeZone);
    if (!event) continue;
    if (event.block) {
      blocks.push({ uid: event.uid, summary: event.summary });
      continue;
    }
    stays.push({
      id: event.uid,
      departingUid: event.uid,
      arrivingUid: null,
      checkInDate: event.checkInDate,
      checkoutDate: event.checkOutDate,
      nextCheckInDate: null,
      sameDay: false,
      sequence: event.sequence,
      contentHash: "",
    });
  }
  return {
    kind: "google-calendar",
    sourceId: "google-calendar",
    tenantId: record.tenantId,
    turnovers: linkStays(stays),
    blocks,
  };
}

/**
 * Guesty Lite is the aggregator when it has the stay. Saved calendar links follow in the order given,
 * then Google, then Notion.
 * Same check-in or same checkout is one booking. A block never becomes a stay.
 * Dates on the merged job come from the earlier source. A later date disagreement
 * is a conflict and does not open a second job. Provenance lists every source uid.
 */
export function normalizeSnapshots(snapshots: SourceSnapshot[]): NormalizedSources {
  const ordered = SOURCE_ORDER.flatMap((kind) => snapshots.filter((snapshot) => snapshot.kind === kind && snapshot.permission !== "missing" && snapshot.permission !== "insufficient"));
  const tagged: { kind: BookingSourceKind; sourceId: string; stay: Turnover }[] = [];
  for (const snapshot of ordered) {
    for (const stay of snapshot.turnovers) tagged.push({ kind: snapshot.kind, sourceId: snapshot.sourceId, stay });
  }
  const kept: { stay: Turnover; sources: SourceRef[] }[] = [];
  const used = new Set<string>();
  const conflicts: SourceConflict[] = [];
  for (const item of tagged) {
    const key = `${item.sourceId}:${item.stay.id}`;
    if (used.has(key)) continue;
    used.add(key);
    const match = kept.find((other) => sameBooking(other.stay, item.stay));
    if (!match) {
      kept.push({ stay: item.stay, sources: [{ kind: item.kind, uid: item.stay.id }] });
      continue;
    }
    match.sources.push({ kind: item.kind, uid: item.stay.id });
    if (item.stay.checkoutDate !== match.stay.checkoutDate) {
      conflicts.push({ jobId: match.stay.id, checkoutDate: match.stay.checkoutDate, otherCheckoutDate: item.stay.checkoutDate });
    }
  }
  const turnovers = linkStays(kept.map((item) => item.stay));
  const provenance = kept.map((item) => ({ jobId: item.stay.id, sources: item.sources }));
  const blocks = ordered.flatMap((snapshot) => snapshot.blocks);
  return { feed: { turnovers, blocks }, conflicts, provenance };
}

/**
 * Reads a saved Notion database query. No network and no Notion write.
 * Missing or insufficient permission returns a fallback and no rows.
 * A canceled or removed row is omitted, which is how it leaves the snapshot.
 */
export function notionFixtureSource(body: string): BookingSource {
  return {
    kind: "notion",
    async read() {
      return readNotionFixture(body);
    },
  };
}

export function readNotionFixture(body: string): SourceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Notion fixture is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Notion fixture is not a database.");
  const record = parsed as { tenantId?: unknown; timeZone?: unknown; permission?: unknown; fetchedAt?: unknown; columns?: unknown; rows?: unknown };
  const tenantId = typeof record.tenantId === "string" ? record.tenantId.trim() : "";
  const timeZone = typeof record.timeZone === "string" && record.timeZone.trim() !== "" ? record.timeZone : "America/New_York";
  const permission = notionPermission(record.permission);
  const fetchedAt = typeof record.fetchedAt === "string" && record.fetchedAt.trim() !== "" ? record.fetchedAt : undefined;
  if (permission !== "granted") {
    return {
      kind: "notion",
      sourceId: "notion",
      tenantId,
      turnovers: [],
      blocks: [],
      permission,
      fallback: permission === "insufficient" ? NOTION_PERMISSION_INSUFFICIENT : NOTION_PERMISSION_MISSING,
      ...(fetchedAt ? { fetchedAt } : {}),
    };
  }
  if (tenantId === "") throw new Error("Notion fixture needs a tenantId.");
  const columns = notionColumns(record.columns);
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const stays: Turnover[] = [];
  const blocks: FeedBlock[] = [];
  for (const row of rows) {
    const event = readNotionRow(row, columns, timeZone);
    if (!event || event.drop) continue;
    if (event.block) {
      blocks.push({ uid: event.uid, summary: event.summary });
      continue;
    }
    stays.push({
      id: event.uid,
      departingUid: event.uid,
      arrivingUid: null,
      checkInDate: event.checkInDate,
      checkoutDate: event.checkOutDate,
      nextCheckInDate: null,
      sameDay: false,
      sequence: event.sequence,
      contentHash: "",
    });
  }
  return {
    kind: "notion",
    sourceId: "notion",
    tenantId,
    turnovers: linkStays(stays),
    blocks,
    permission: "granted",
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

export function linkStays(turnovers: Turnover[]): Turnover[] {
  return turnovers.map((stay) => {
    const next = turnovers
      .filter((other) => other.id !== stay.id && other.checkInDate >= stay.checkoutDate)
      .sort((a, b) => a.checkInDate.localeCompare(b.checkInDate) || a.id.localeCompare(b.id))[0];
    const nextCheckInDate = next?.checkInDate ?? null;
    const arrivingUid = next?.id ?? null;
    return {
      ...stay,
      nextCheckInDate,
      arrivingUid,
      sameDay: nextCheckInDate === stay.checkoutDate,
      contentHash: `${stay.checkoutDate}|${nextCheckInDate ?? ""}|${arrivingUid ?? ""}`,
    };
  });
}

function sameBooking(primary: Turnover, other: Turnover): boolean {
  if (primary.checkoutDate === other.checkoutDate) return true;
  return primary.checkInDate !== "" && primary.checkInDate === other.checkInDate;
}

interface GoogleEvent {
  uid: string;
  summary: string;
  checkInDate: string;
  checkOutDate: string;
  sequence: number;
  block: boolean;
}

function readGoogleEvent(item: unknown, timeZone: string): GoogleEvent | undefined {
  if (!item || typeof item !== "object") return undefined;
  const event = item as {
    id?: unknown;
    status?: unknown;
    summary?: unknown;
    description?: unknown;
    sequence?: unknown;
    eventType?: unknown;
    start?: { date?: unknown; dateTime?: unknown };
    end?: { date?: unknown; dateTime?: unknown };
  };
  if (typeof event.status === "string" && event.status.toLowerCase() === "cancelled") return undefined;
  if (typeof event.id !== "string" || event.id.trim() === "") return undefined;
  const checkInDate = googleDate(event.start, timeZone);
  const checkOutDate = googleDate(event.end, timeZone);
  if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) return undefined;
  const summary = typeof event.summary === "string" ? event.summary : "";
  const description = typeof event.description === "string" ? event.description : "";
  const sequence = typeof event.sequence === "number" && Number.isFinite(event.sequence) ? event.sequence : 0;
  const eventType = typeof event.eventType === "string" ? event.eventType : "";
  const block = eventType === "outOfOffice" || isCalendarBlock(summary, description);
  return { uid: `google:${event.id}`, summary, checkInDate, checkOutDate, sequence, block };
}

function googleDate(field: { date?: unknown; dateTime?: unknown } | undefined, timeZone: string): string | undefined {
  if (!field) return undefined;
  if (typeof field.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(field.date)) return field.date;
  if (typeof field.dateTime !== "string") return undefined;
  const instant = new Date(field.dateTime);
  if (Number.isNaN(instant.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

const STAY_STATUS = new Set(["stay", "reserved", "booked", "confirmed"]);
const BLOCK_STATUS = new Set(["block", "blocked", "owner block"]);
const DROP_STATUS = new Set(["canceled", "cancelled", "removed"]);

function notionPermission(value: unknown): SourcePermission {
  if (typeof value !== "string" || value.trim() === "") return "missing";
  const text = value.trim().toLowerCase();
  if (text === "read" || text === "granted") return "granted";
  if (text === "insufficient" || text === "comment" || text === "denied") return "insufficient";
  return "missing";
}

function notionColumns(value: unknown): { date: string; end: string; status: string } {
  const record = value && typeof value === "object" ? (value as { date?: unknown; end?: unknown; status?: unknown }) : {};
  return {
    date: typeof record.date === "string" && record.date.trim() !== "" ? record.date : "date",
    end: typeof record.end === "string" && record.end.trim() !== "" ? record.end : "end",
    status: typeof record.status === "string" && record.status.trim() !== "" ? record.status : "status",
  };
}

interface NotionRow {
  uid: string;
  summary: string;
  checkInDate: string;
  checkOutDate: string;
  sequence: number;
  block: boolean;
  drop: boolean;
}

function readNotionRow(row: unknown, columns: { date: string; end: string; status: string }, timeZone: string): NotionRow | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") return undefined;
  const statusValue = record[columns.status];
  const status = typeof statusValue === "string" ? statusValue.trim().toLowerCase() : "";
  if (DROP_STATUS.has(status)) return { uid: `notion:${record.id}`, summary: status, checkInDate: "", checkOutDate: "", sequence: 0, block: false, drop: true };
  const checkInDate = notionDate(record[columns.date], timeZone);
  const checkOutDate = notionDate(record[columns.end], timeZone);
  if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) return undefined;
  const block = BLOCK_STATUS.has(status) || isCalendarBlock(status, "");
  if (!block && !STAY_STATUS.has(status)) return undefined;
  const summary = typeof statusValue === "string" ? statusValue.trim() : "Block";
  return { uid: `notion:${record.id}`, summary, checkInDate, checkOutDate, sequence: 1, block, drop: false };
}

function notionDate(value: unknown, timeZone: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
