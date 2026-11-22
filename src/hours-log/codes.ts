/**
 * The hours log's row kinds and activity codes (#238). Each host can set their own codes. Until the
 * tester's list (about 40 codes in 7 groups) arrives, these placeholders are the first set: one or more
 * row kinds per code, in groups that become the Category column.
 */

export const ROW_KINDS = [
  "cleaning",
  "confirm-times",
  "pay-cleaner",
  "record-payment",
  "repair-visit",
  "approve-repair",
  "approve-booking",
  "approve-price",
  "pick-quote",
  "reschedule-repair",
  "record-cost",
  "confirm-repair",
  "approve-order",
  "place-order",
  "auto-order",
  "owner-on-site",
  "package-drop",
  "bring-in",
  // The host's own steps in the newer features (#18).
  "approve-text",
  "approve-guest-reply",
  "allow-late-checkout",
  "house-facts",
  "house-rules",
  "lock-setup",
  "standing-code",
  "guest-codes",
  "expected-visit",
  "approve-booking-email",
  "save-upkeep",
  "setup",
] as const;

export type RowKind = (typeof ROW_KINDS)[number];

/**
 * The row kinds before #18. A month the host confirmed before #18 is built with these alone, so its rows and
 * fingerprint stay exactly as confirmed (see `ROW_KIND_SET`). A month confirmed since keeps every kind.
 */
export const V1_ROW_KINDS: ReadonlySet<RowKind> = new Set<RowKind>(ROW_KINDS.slice(0, ROW_KINDS.indexOf("approve-text")));

/** Which set of row kinds a month is built with: 1 before #18, 2 since. Saved on each month the host confirms. */
export const ROW_KIND_SET = 2;

export function rowKindsFor(set: number | undefined): ReadonlySet<RowKind> | undefined {
  return set === undefined || set < 2 ? V1_ROW_KINDS : undefined;
}

export function isRowKind(value: unknown): value is RowKind {
  return typeof value === "string" && (ROW_KINDS as readonly string[]).includes(value);
}

export interface ActivityCode {
  /** What goes in the Activity code column, like CLN-1. */
  code: string;
  /** The code's group: the Category column. */
  group: string;
  /** The Activity column. */
  activity: string;
  /**
   * The host's own minutes for one of the owner's actions under this code, like 5 for an approval in chat.
   * Unset is 0: the system never makes up the owner's time.
   */
  minutes?: number;
}

export const DEFAULT_CODES: readonly ActivityCode[] = [
  { code: "CLN-1", group: "Cleaning and turnover", activity: "Turnover cleaning" },
  { code: "CLN-2", group: "Cleaning and turnover", activity: "Cleaning times and scheduling" },
  { code: "PAY-1", group: "Payments and bookkeeping", activity: "Pay a cleaner or vendor" },
  { code: "PAY-2", group: "Payments and bookkeeping", activity: "Record a payment or cost" },
  { code: "REP-1", group: "Repairs and upkeep", activity: "Repair or upkeep visit" },
  { code: "REP-2", group: "Repairs and upkeep", activity: "Approve a repair, booking or quote" },
  { code: "REP-3", group: "Repairs and upkeep", activity: "Confirm a repair is done" },
  { code: "PUR-1", group: "Purchasing", activity: "Approve a supply order" },
  { code: "PUR-2", group: "Purchasing", activity: "Place a supply order" },
  { code: "SITE-1", group: "On site", activity: "Owner on site" },
  { code: "PKG-1", group: "Packages", activity: "Package delivered" },
  { code: "PKG-2", group: "Packages", activity: "Bring a package inside" },
  { code: "CLN-3", group: "Cleaning and turnover", activity: "Approve a text to the cleaner" },
  { code: "GST-1", group: "Guests", activity: "Approve a guest reply or late checkout" },
  { code: "GST-2", group: "Guests", activity: "House rules and house facts" },
  { code: "GST-3", group: "Guests", activity: "Approve a booking or a cancellation" },
  { code: "ACC-1", group: "Locks and access", activity: "Lock settings and door codes" },
  { code: "ACC-2", group: "Locks and access", activity: "Expected visits" },
  { code: "REP-4", group: "Repairs and upkeep", activity: "Upkeep schedule" },
  { code: "SET-1", group: "Setup", activity: "Setup and onboarding" },
];

export const DEFAULT_KIND_CODES: Readonly<Record<RowKind, string>> = {
  cleaning: "CLN-1",
  "confirm-times": "CLN-2",
  "pay-cleaner": "PAY-1",
  "record-payment": "PAY-2",
  "repair-visit": "REP-1",
  "approve-repair": "REP-2",
  "approve-booking": "REP-2",
  "approve-price": "REP-2",
  "pick-quote": "REP-2",
  "reschedule-repair": "REP-2",
  "record-cost": "PAY-2",
  "confirm-repair": "REP-3",
  "approve-order": "PUR-1",
  "place-order": "PUR-2",
  "auto-order": "PUR-2",
  "owner-on-site": "SITE-1",
  "package-drop": "PKG-1",
  "bring-in": "PKG-2",
  "approve-text": "CLN-3",
  "approve-guest-reply": "GST-1",
  "allow-late-checkout": "GST-1",
  "house-facts": "GST-2",
  "house-rules": "GST-2",
  "approve-booking-email": "GST-3",
  "lock-setup": "ACC-1",
  "standing-code": "ACC-1",
  "guest-codes": "ACC-1",
  "expected-visit": "ACC-2",
  "save-upkeep": "REP-4",
  setup: "SET-1",
};
