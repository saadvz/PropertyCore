import { join } from "node:path";
import { zonedParts } from "../core/timezone";
import { ConfirmationBook } from "../operator/confirmations";
import { buildMonth, isMonth, type Month } from "./month";
import { OWNER_RULES_VERSION } from "./ownerRules";
import { DEFAULT_COLUMNS, sheetRows } from "./sheet";
import { readRecords } from "./sources";
import { checkSettings, HoursFileError, readHours, writeHours, type HoursSettings } from "./store";

/**
 * The hours log's desk for one property (#238): the host reviews and confirms each month in chat, and the
 * agent writes the confirmed month to the host's own spreadsheet with its own connector. Property Core holds
 * no Google token, and texts nobody.
 */

export interface HoursReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface HoursDeps {
  now: () => Date;
}

const CONFIRM_ACTION = "hours-confirm";
const MONTH_HELP = "Give the month as YYYY-MM, like 2026-10.";
const APPROVAL_STALE = "That code has expired, was used, or the rows changed since. Call review_hours again and show the host the month as it is now.";
const NOT_CONFIRMED = "The host hasn't confirmed this month yet. Call review_hours, show them the month, and confirm it with their yes first.";
const CHANGED = "The rows changed since the host confirmed this month, or the owner-row rules did. Call review_hours again and confirm it with the host before exporting.";
const NOT_EXPORTED = "Call export_hours for this month first, write its logs to the host's spreadsheet, then call it again with stored: true.";

const ok = (structured: Record<string, unknown>): HoursReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): HoursReply => ({ text, isError: true });

const monthName = (month: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));

export class HoursDesk {
  private readonly approvals: ConfirmationBook;

  constructor(
    private readonly root: string,
    private readonly deps: HoursDeps,
  ) {
    this.approvals = new ConfirmationBook(30 * 60_000, () => deps.now().getTime(), { file: join(root, "hours-approvals.json") });
  }

  private month(month: string): Month {
    const file = readHours(this.root);
    const kept = file.months[month]?.ownerFacts;
    return buildMonth(readRecords(this.root), month, file.settings, kept ? { kept } : {});
  }

  /** A broken hours.json is a plain refusal, and nothing is written over it. */
  private guarded(run: () => HoursReply): HoursReply {
    try {
      return run();
    } catch (error) {
      if (error instanceof HoursFileError) return fail(error.message);
      throw error;
    }
  }

  /** True once the month has ended at the property. */
  private over(month: string): boolean {
    const timeZone = readRecords(this.root).timeZone ?? "America/New_York";
    const p = zonedParts(this.deps.now(), timeZone);
    return month < `${p.year}-${String(p.month).padStart(2, "0")}`;
  }

  /** The month's rows by log, what needs the host, the checkout check, and a code for the host's yes. With the code, it confirms. */
  review(month: unknown, confirmation?: unknown): HoursReply {
    return this.guarded(() => this.reviewMonth(month, confirmation));
  }

  private reviewMonth(month: unknown, confirmation?: unknown): HoursReply {
    if (!isMonth(month)) return fail(MONTH_HELP);
    const built = this.month(month);
    const file = readHours(this.root);
    const mark = file.months[month];
    const summary = {
      month,
      logs: built.logs.map((log) => ({ name: log.name, hours: log.hours, rows: log.rows.map(({ id: _id, log: _log, kind: _kind, timing, ...row }) => ({ ...row, timing })) })),
      needs: built.needs,
      reconcile: built.reconcile,
      ...(mark ? { confirmed: { at: mark.confirmedAt, stillMatches: mark.fingerprint === built.fingerprint && mark.rulesVersion === OWNER_RULES_VERSION, ...(mark.exportedAt ? { exportedAt: mark.exportedAt } : {}) } } : {}),
    };
    if (!this.over(month)) return { ...ok({ ...summary, next: `${monthName(month)} isn't over yet, so it can't be confirmed. Show the host the rows so far if they asked.` }), text: `${monthName(month)} isn't over yet, so it can't be confirmed. ${JSON.stringify(summary)}` };
    if (typeof confirmation === "string" && confirmation.trim()) {
      try {
        this.approvals.redeem(confirmation, CONFIRM_ACTION, month, built.fingerprint);
      } catch {
        return fail(APPROVAL_STALE);
      }
      file.months[month] = { confirmedAt: this.deps.now().toISOString(), fingerprint: built.fingerprint, rulesVersion: built.rulesVersion, rows: built.rows.length, ownerFacts: built.ownerFacts };
      writeHours(this.root, file);
      return ok({ month, confirmed: true, rows: built.rows.length, next: "Confirmed. Call export_hours with this month to write it to the host's spreadsheet." });
    }
    const totals = built.logs.map((log) => `${log.name} ${log.hours} hours`).join(", ");
    const question = `Confirm the ${monthName(month)} hours log: ${built.rows.length} rows${totals ? ` (${totals})` : ""}${built.needs.length ? `, with ${built.needs.length} thing${built.needs.length === 1 ? "" : "s"} to check first` : ""}?`;
    return ok({
      ...summary,
      confirmation: this.approvals.issue(CONFIRM_ACTION, month, built.fingerprint, question),
      next: "Show the host each log's rows and every line in needs. Ask the question in confirmation.question. Only after their yes, call review_hours again with this month and the code. Don't tell the host what counts toward any tax test.",
    });
  }

  /** A confirmed month's logs as spreadsheet rows, in the host's columns. With stored: true, records that the agent wrote them. */
  export(month: unknown, stored?: unknown): HoursReply {
    return this.guarded(() => this.exportMonth(month, stored));
  }

  private exportMonth(month: unknown, stored?: unknown): HoursReply {
    if (!isMonth(month)) return fail(MONTH_HELP);
    const file = readHours(this.root);
    const mark = file.months[month];
    if (!mark) return fail(NOT_CONFIRMED);
    const built = this.month(month);
    if (mark.fingerprint !== built.fingerprint || mark.rulesVersion !== OWNER_RULES_VERSION) return fail(CHANGED);
    if (stored === true) {
      if (mark.handedOut?.fingerprint !== built.fingerprint) return fail(NOT_EXPORTED);
      file.months[month] = { ...mark, exportedAt: this.deps.now().toISOString() };
      writeHours(this.root, file);
      return ok({ month, exported: true, next: "Tell the host the month is in their spreadsheet." });
    }
    const columns = file.settings.columns ?? DEFAULT_COLUMNS;
    file.months[month] = { ...mark, handedOut: { at: this.deps.now().toISOString(), fingerprint: built.fingerprint } };
    writeHours(this.root, file);
    return ok({
      month,
      ...(file.settings.sheet ? { sheet: file.settings.sheet } : {}),
      logs: built.logs.map((log) => ({ name: log.name, tab: `${log.name} ${month}`, rows: sheetRows(log.rows, columns) })),
      next: `Write each log to the host's spreadsheet${file.settings.sheet ? `, ${file.settings.sheet}` : ""}, with the spreadsheet connector they already use with you: Google Sheets, Excel, or another. Its rows as given, header first, one tab per log unless the host keeps them elsewhere. If none is connected, or you don't know which spreadsheet, ask the host where they want the log written, and save it with save_hours_settings. Change no cell. Then call export_hours with this month and stored: true.`,
    });
  }

  /** The host's codes, minutes, columns, owner name and spreadsheet. Each given field replaces the saved one. */
  saveSettings(input: HoursSettings): HoursReply {
    return this.guarded(() => this.save(input));
  }

  private save(input: HoursSettings): HoursReply {
    const file = readHours(this.root);
    const next: HoursSettings = { ...file.settings };
    for (const key of ["codes", "kindCodes", "columns", "ownerName", "sheet"] as const) {
      if (input[key] !== undefined) (next as Record<string, unknown>)[key] = input[key];
    }
    const refusal = checkSettings(next);
    if (refusal) return fail(refusal);
    writeHours(this.root, { ...file, settings: next });
    return ok({ saved: true, settings: next, next: "Saved. Months the host already confirmed need a new review if their rows changed." });
  }
}

export function hoursDeskFor(root: string, deps: HoursDeps): HoursDesk {
  return new HoursDesk(root, deps);
}
