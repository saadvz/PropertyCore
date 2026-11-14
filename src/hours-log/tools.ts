import { ROW_KINDS } from "./codes";
import type { HoursDesk, HoursReply } from "./desk";
import { COLUMN_FIELDS } from "./sheet";
import { MAX_CODES, MAX_MINUTES, type HoursSettings } from "./store";

/** The hours log's tools (#238), as tools/list shows them. Each one takes `property` on the shared service. */

const MONTH_ARG = { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "The month, as YYYY-MM, like 2026-10." };

const REVIEW = {
  name: "review_hours",
  title: "Review a month of hours",
  description:
    "The hours log for one month: one row per work session, in separate logs for the owner, the cleaner, each pro, and Property Core's own work, built fresh from the cleanings, repairs, supply orders and the host's approvals. Owner rows are only what the host did; the system never writes owner time for its own work. Gives what needs the host and each checkout with no cleaning, and a code: show the host the rows and ask the question, then call again with confirmation only after their yes. Never give tax advice, or say what counts toward any tax test: that's for the host and their advisor.",
  inputSchema: { type: "object", properties: { month: MONTH_ARG, confirmation: { type: "string", maxLength: 40 } }, required: ["month"], additionalProperties: false },
};

const EXPORT = {
  name: "export_hours",
  title: "Export a month to the Sheet",
  description:
    "A month the host confirmed, as rows for their Google Sheet in their own columns, one log each. Write them with your own Google Sheets connector exactly as given, then call again with stored: true. Refused when the rows changed since the host confirmed: review the month again first.",
  inputSchema: { type: "object", properties: { month: MONTH_ARG, stored: { type: "boolean" } }, required: ["month"], additionalProperties: false },
};

const SETTINGS = {
  name: "save_hours_settings",
  title: "Hours log settings",
  description: `The host's own hours log setup, only as the host says: their activity codes (each with its group, activity and the minutes one of the owner's actions under it usually takes; unset minutes are 0), which code each row kind uses, their Sheet's columns in order with their headers, the name on owner rows, and their Sheet's name or link. Each field given replaces the saved one. Row kinds: ${ROW_KINDS.join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      codes: {
        type: "array",
        maxItems: MAX_CODES,
        items: {
          type: "object",
          properties: { code: { type: "string", maxLength: 80 }, group: { type: "string", maxLength: 80 }, activity: { type: "string", maxLength: 80 }, minutes: { type: "integer", minimum: 0, maximum: MAX_MINUTES } },
          required: ["code", "group", "activity"],
          additionalProperties: false,
        },
      },
      kindCodes: { type: "object", properties: Object.fromEntries(ROW_KINDS.map((kind) => [kind, { type: "string", maxLength: 80 }])), additionalProperties: false },
      columns: {
        type: "array",
        minItems: 1,
        maxItems: COLUMN_FIELDS.length,
        items: { type: "object", properties: { field: { type: "string", enum: [...COLUMN_FIELDS] }, header: { type: "string", maxLength: 80 } }, required: ["field", "header"], additionalProperties: false },
      },
      ownerName: { type: "string", maxLength: 80 },
      sheet: { type: "string", maxLength: 300 },
    },
    additionalProperties: false,
  },
};

export const HOURS_TOOLS: readonly Record<string, unknown>[] = [REVIEW, EXPORT, SETTINGS];
export const HOURS_TOOL_NAMES: ReadonlySet<string> = new Set(HOURS_TOOLS.map((tool) => tool.name as string));

const SETTING_KEYS = ["codes", "kindCodes", "columns", "ownerName", "sheet"] as const;

/** Answers one hours log tool. Undefined when the name isn't one of them. */
export async function handleHoursTool(desk: HoursDesk, name: string, args: unknown): Promise<HoursReply | undefined> {
  if (!HOURS_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (name === "review_hours") return desk.review(input.month, input.confirmation);
  if (name === "export_hours") return desk.export(input.month, input.stored);
  const unknown = Object.keys(input).filter((key) => !(SETTING_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) return { text: `There's no setting called ${unknown.join(", ")}.`, isError: true };
  if (input.codes !== undefined && !Array.isArray(input.codes)) return { text: "Give codes as a list.", isError: true };
  if (input.columns !== undefined && !Array.isArray(input.columns)) return { text: "Give columns as a list.", isError: true };
  if (input.kindCodes !== undefined && (typeof input.kindCodes !== "object" || input.kindCodes === null || Array.isArray(input.kindCodes))) return { text: "Give kindCodes as row kind to code.", isError: true };
  return desk.saveSettings(input as HoursSettings);
}
