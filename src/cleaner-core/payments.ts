import { addDays, localDateOf, zonedTimeToUtc } from "../core/timezone";

/**
 * Paying the cleaner. Cleaner Core never sends money: it keeps what each cleaning is owed and
 * builds a Venmo link the landlord taps. These helpers hold no state.
 */

/** Pay per cleaning, in cents: $1 to $1,000. */
export const MIN_PAY_CENTS = 100;
export const MAX_PAY_CENTS = 100_000;
/** An unpaid cleaning comes back in check_now at most this many times after the first. */
export const MAX_PAY_REMINDERS = 3;

/** The landlord's payment choice, saved in the property file. */
export interface PaymentSettings {
  on: boolean;
  rateCents?: number;
  venmo?: string;
  /** When payments last went from off (or unsaved) to on. Cleanings done before it are never owed. */
  onSince?: string;
  savedAt: string;
}

/** One cleaning's pay. The amount and username are copied when it becomes owed. */
export interface PayRecord {
  amountCents: number;
  venmo: string;
  owedAt: string;
  /** When check_now last returned it. */
  lastShownAt: string;
  reminders: number;
  paidAt?: string;
  how?: "venmo" | "other";
  confirmedBy?: "landlord" | "receipt-email";
}

const USERNAME = /^[A-Za-z0-9_-]{5,30}$/;

/** A Venmo username with one leading @ dropped, or undefined. A phone number or email never passes. */
export function venmoUsername(input: string): string | undefined {
  const trimmed = input.trim();
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!USERNAME.test(name) || /^\d+$/.test(name)) return undefined;
  return name;
}

/** Dollars as whole cents within the bounds, or undefined. */
export function payCents(dollars: number): number | undefined {
  if (!Number.isFinite(dollars)) return undefined;
  const cents = Math.round(dollars * 100);
  return cents >= MIN_PAY_CENTS && cents <= MAX_PAY_CENTS ? cents : undefined;
}

/** Like "$85.00" or "$1,000.00". */
export function dollarsText(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The cleaner's public Venmo profile, for the landlord to check before saving. */
export function venmoProfileLink(username: string): string {
  return `https://venmo.com/u/${encodeURIComponent(username)}`;
}

/** A prefilled, private Venmo payment. `label` is the property's nickname, never its address. */
export function venmoPayLink(input: { username: string; cents: number; label: string; day: string }): string {
  const query = new URLSearchParams({
    txn: "pay",
    amount: (input.cents / 100).toFixed(2),
    audience: "private",
    note: `${input.label} cleaning ${input.day}`,
  });
  return `https://venmo.com/${encodeURIComponent(input.username)}?${query.toString()}`;
}

/** 9:00 AM at the property on the day after `lastShownAt`'s local date. */
export function nextReminderAt(lastShownAt: string, timeZone: string): string {
  const next = addDays(localDateOf(new Date(lastShownAt), timeZone), 1);
  return zonedTimeToUtc({ ...next, hour: 9, minute: 0 }, timeZone).toISOString();
}
