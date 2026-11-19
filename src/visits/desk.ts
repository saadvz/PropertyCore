import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIXER_FILE, readFixer } from "../fixer-core/store";
import { readHubFile } from "../hub/store";
import { buildVisits, type VisitRecord } from "./derive";
import type { CodePerson } from "./events";
import { visitLogFor } from "./store";
import { clockText } from "./wording";

/**
 * Visit records for one property (#237): list the records, the log's health, and whose each lock code is. It reads
 * the log and never writes a lock or message event: those come only from the engines and the lock connection (#180).
 */

export interface VisitReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

const DAY = 86_400_000;
export const MAX_LIST_DAYS = 31;
const ok = (structured: Record<string, unknown>): VisitReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): VisitReply => ({ text, isError: true });
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

export class VisitDesk {
  constructor(
    private readonly root: string,
    private readonly deps: { now: () => Date },
  ) {}

  private timeZone(): string | undefined {
    try {
      return readHubFile(this.root)?.property.timeZone || undefined;
    } catch {
      return undefined;
    }
  }

  private proIds(): Set<string> {
    if (!existsSync(join(this.root, FIXER_FILE))) return new Set();
    try {
      return new Set(readFixer(this.root).pros.map((pro) => pro.id));
    } catch {
      return new Set();
    }
  }

  /** The records whose window starts between `from` and `to` (local dates, inclusive), at most 31 days. */
  listVisits(input: { from?: unknown; to?: unknown }): VisitReply {
    const timeZone = this.timeZone();
    if (!timeZone) return fail("The property has no time zone yet, so its visits can't be placed. Set the property's time zone first.");
    const now = this.deps.now();
    if (input.from !== undefined && !isDate(input.from)) return fail("Give from as a date, like 2027-01-04.");
    if (input.to !== undefined && !isDate(input.to)) return fail("Give to as a date, like 2027-01-31.");
    const to = isDate(input.to) ? Date.parse(`${input.to}T00:00:00Z`) + 2 * DAY : now.getTime() + 2 * DAY;
    const from = isDate(input.from) ? Date.parse(`${input.from}T00:00:00Z`) - DAY : to - 9 * DAY;
    if (to <= from) return fail("from must be on or before to.");
    if (to - from > (MAX_LIST_DAYS + 3) * DAY) return fail(`List at most ${MAX_LIST_DAYS} days at a time.`);
    const log = visitLogFor(this.root, this.deps.now);
    const derived = buildVisits(log.read(), { timeZone, codeNames: log.codeNames(), now });
    const visits = derived.visits.filter((visit) => Date.parse(visit.window.from) >= from && Date.parse(visit.window.from) < to).map((visit) => this.view(visit, timeZone));
    return ok({ visits, cleanMinutes: derived.cleanMinutes, sends: false });
  }

  private view(visit: VisitRecord, timeZone: string): Record<string, unknown> {
    const local = (at: string) => clockText(at, timeZone);
    return {
      id: visit.id,
      kind: visit.kind,
      who: visit.who.name,
      window: { ...visit.window, local: `${local(visit.window.from)} to ${local(visit.window.until)}` },
      lock: visit.lock,
      ...(visit.arrival ? { arrival: { ...visit.arrival, local: local(visit.arrival.at) } } : {}),
      ...(visit.departure ? { departure: { ...visit.departure, local: local(visit.departure.at) } } : {}),
      ...(visit.minutes !== undefined ? { minutes: visit.minutes } : {}),
      flags: visit.flags.map((flag) => flag.kind),
      rules: visit.rules,
    };
  }

  /** How the log reads: lines, skipped lines, and the last lock event, so a quiet lock can be noticed. */
  health(): VisitReply {
    const log = visitLogFor(this.root, this.deps.now);
    return ok({ ...log.health(), codes: Object.keys(log.codeNames()).length, sends: false });
  }

  /** Saves whose a lock code is, by the lock's own name for it, after the host says so. `none` forgets it. */
  nameLockCode(input: { codeName?: unknown; person?: unknown; proId?: unknown }): VisitReply {
    if (typeof input.codeName !== "string" || !input.codeName.trim() || input.codeName.length > 80) return fail("Give the lock's name for the code, like Cleaner.");
    if (/\d(?:[\s.\-_/]*\d){3,}/.test(input.codeName)) return fail("Give the code's name as the lock shows it, never the code itself.");
    let person: CodePerson | null;
    if (input.person === "none") person = null;
    else if (input.person === "cleaner" || input.person === "host" || input.person === "guest" || input.person === "shared") person = { role: input.person };
    else if (input.person === "pro") {
      if (typeof input.proId !== "string" || !this.proIds().has(input.proId)) return fail("Give the id of a pro saved in Fixer Core.");
      person = { role: "pro", proId: input.proId };
    } else return fail("person is cleaner, pro, host, guest, shared or none.");
    const codes = visitLogFor(this.root, this.deps.now).nameCode(input.codeName, person);
    return ok({ saved: true, codes });
  }
}

export function visitDeskFor(root: string, deps: { now: () => Date }): VisitDesk {
  return new VisitDesk(root, deps);
}
