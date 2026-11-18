import type { HoursRow } from "./month";

/** The host's spreadsheet (#238), in Google Sheets, Excel or another: the columns, in the host's order and with their own headers. */

export const COLUMN_FIELDS = ["date", "start", "end", "property", "participant", "code", "category", "activity", "task", "reference", "where", "hours"] as const;
export type ColumnField = (typeof COLUMN_FIELDS)[number];

export interface Column {
  field: ColumnField;
  header: string;
}

/** The issue's twelve columns. */
export const DEFAULT_COLUMNS: readonly Column[] = [
  { field: "date", header: "Date" },
  { field: "start", header: "Start" },
  { field: "end", header: "End" },
  { field: "property", header: "Property" },
  { field: "participant", header: "Participant" },
  { field: "code", header: "Activity code" },
  { field: "category", header: "Category" },
  { field: "activity", header: "Activity" },
  { field: "task", header: "Task" },
  { field: "reference", header: "Supporting reference" },
  { field: "where", header: "On site or remote" },
  { field: "hours", header: "Hours" },
];

/** The header row, then one row of text per hours row, ready for the spreadsheet. */
export function sheetRows(rows: readonly HoursRow[], columns: readonly Column[]): string[][] {
  const cell = (row: HoursRow, field: ColumnField) => (field === "hours" ? row.hours.toFixed(2) : row[field]);
  return [columns.map((column) => column.header), ...rows.map((row) => columns.map((column) => cell(row, column.field)))];
}
