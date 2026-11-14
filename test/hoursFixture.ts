import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A made-up property folder for the hours log (#238): its hub, Cleaner Core's records, Fixer Core's and
 * Supply Core's, for October 2026 in New York. Made-up names and 555 numbers only; no door code anywhere.
 */

export const TZ = "America/New_York";
export const PROPERTY_ID = "prp_scratchlane";

export interface Fixture {
  root: string;
  write(name: string, body: unknown): void;
  cleanup(): void;
}

export function emptyFolder(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hours-"));
  return {
    root,
    write(name, body) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(body, null, 2));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const hub = {
  schemaVersion: 1,
  property: { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: TZ, checkoutTime: "11:00", checkInTime: "16:00" },
  calendars: [],
  stays: [
    { checkIn: "2026-10-01", checkout: "2026-10-04", kind: "stay" },
    { checkIn: "2026-10-10", checkout: "2026-10-12", kind: "stay" },
    { checkIn: "2026-10-20", checkout: "2026-10-25", kind: "stay" },
    { checkIn: "2026-10-26", checkout: "2026-10-28", kind: "block" },
  ],
};

export const live = {
  propertyId: PROPERTY_ID,
  business: "Lane Stays",
  hostName: "Sam",
  host: "+15555550100",
  cleaner: "+15555550111",
  cleanerName: "Ana",
  pay: {
    job_oct4: { amountCents: 9000, venmo: "ana-cleans", owedAt: "2026-10-04T18:00:00.000Z", lastShownAt: "2026-10-04T18:00:00.000Z", reminders: 0, paidAt: "2026-10-05T13:30:00.000Z", how: "venmo", confirmedBy: "landlord" },
    job_oct12: { amountCents: 9000, venmo: "ana-cleans", owedAt: "2026-10-12T18:00:00.000Z", lastShownAt: "2026-10-12T18:00:00.000Z", reminders: 0, paidAt: "2026-10-13T12:00:00.000Z", how: "venmo", confirmedBy: "receipt-email" },
  },
};

const job = (id: string, checkoutDate: string, extra: Record<string, unknown>) => ({
  id,
  departingUid: `${id}-uid`,
  arrivingUid: null,
  checkoutDate,
  nextCheckInDate: null,
  sameDay: false,
  version: 1,
  sourceSequence: 1,
  contentHash: "x",
  canceled: false,
  declined: false,
  announced: null,
  started: false,
  done: false,
  ...extra,
});

export const engine = {
  schemaVersion: 1,
  tenantId: PROPERTY_ID,
  jobs: [
    // 11:05 AM to 1:35 PM New York time: 2.5 hours.
    job("job_oct4", "2026-10-04", { started: true, done: true, startedAt: "2026-10-04T15:05:00.000Z", doneAt: "2026-10-04T17:35:00.000Z" }),
    // No START: the arrival time Grok saved is the start.
    job("job_oct12", "2026-10-12", { done: true, arrivalAt: "2026-10-12T15:00:00.000Z", doneAt: "2026-10-12T17:00:00.000Z" }),
    // The 2026-10-25 checkout had no cleaning yet; this one was called off.
    job("job_oct25", "2026-10-25", { canceled: true }),
  ],
  hostFacts: [{ jobId: "job_oct4", field: "checkout", version: 1, minutes: 660, at: "2026-10-03T22:00:00.000Z" }],
  tombstones: [],
  outbox: [],
  inboundIds: [],
  transcript: [],
  optedOut: false,
  injurySent: [],
  blocks: [],
};

export const fixer = {
  settings: { checkInBufferMinutes: 60, cleaningMinutes: 180, askCleaner: true, activatedAt: "2026-09-01T00:00:00.000Z" },
  setup: {},
  pros: [{ id: "pro_drip", name: "Drip Plumbing", trades: ["plumbing"], preferredFor: [], reach: { phone: "+15555550122" }, status: "saved", source: "host", addedAt: "2026-09-01T00:00:00.000Z" }],
  upkeep: [],
  jobs: [
    {
      id: "job_sink",
      trade: "plumbing",
      what: "Kitchen sink leaks",
      source: "cleaner",
      photos: [],
      urgency: "soon",
      state: "done",
      hostGo: { at: "2026-10-06T14:00:00.000Z" },
      quotePick: { proId: "pro_drip", at: "2026-10-07T15:00:00.000Z" },
      candidates: [],
      picked: [],
      contacts: [],
      booking: {
        proId: "pro_drip",
        from: "2026-10-08T13:00:00.000Z",
        until: "2026-10-08T15:00:00.000Z",
        access: "code",
        hostYes: { at: "2026-10-07T16:00:00.000Z" },
        revisedQuote: { cents: 18000, at: "2026-10-08T13:30:00.000Z", by: "pro", hostYes: { at: "2026-10-08T13:45:00.000Z" } },
        fingerprint: "f",
      },
      done: { at: "2026-10-08T14:30:00.000Z", by: "pro-page" },
      cost: { cents: 18000, by: "pro", at: "2026-10-08T14:30:00.000Z" },
      news: [],
      createdAt: "2026-10-06T13:00:00.000Z",
    },
    {
      id: "job_gutter",
      trade: "gutters",
      what: "Clean the gutters",
      source: "upkeep",
      photos: [],
      urgency: "flexible",
      state: "done",
      candidates: [],
      picked: [],
      contacts: [],
      booking: { proId: "pro_drip", from: "2026-10-15T13:00:00.000Z", until: "2026-10-15T14:00:00.000Z", access: "host", fingerprint: "g" },
      // The agent marked it done, and the host typed the cost.
      done: { at: "2026-10-15T14:10:00.000Z", by: "agent" },
      cost: { cents: 12000, by: "host", at: "2026-10-16T12:00:00.000Z" },
      news: [],
      createdAt: "2026-10-14T13:00:00.000Z",
    },
  ],
};

export const supply = {
  settings: { priceJumpPct: 20, bufferDays: 3, activatedAt: "2026-09-01T00:00:00.000Z" },
  setup: {},
  items: [{ id: "itm_towels", name: "Paper towels", qtyPerOrder: 2, preferred: { title: "Example towels", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400, pickedAt: "2026-09-01T00:00:00.000Z" }, storeNote: "", schedule: { kind: "every", days: 21 }, savedAt: "2026-09-01T00:00:00.000Z" }],
  draft: [],
  orders: [
    { id: "ord_rules", at: "2026-10-09T14:00:00.000Z", store: "Example Mart", items: [{ itemId: "itm_towels", product: "preferred", qty: 2, unitCents: 2400 }], totalCents: 4800, chargedCents: 4800, source: "schedule", approvedBy: "rules", status: "delivered" },
    { id: "ord_card", at: "2026-10-18T19:00:00.000Z", store: "Example Mart", items: [{ itemId: "itm_towels", product: "preferred", qty: 1, unitCents: 2400 }], totalCents: 2400, chargedCents: 2400, orderNumber: "EM-1001", source: "cleaner", approvedBy: "grok-card", status: "placed" },
    { id: "ord_self", at: "2026-10-22T20:00:00.000Z", store: "Example Mart", items: [{ itemId: "itm_towels", product: "preferred", qty: 1, unitCents: 2400 }], totalCents: 2400, chargedCents: 2400, source: "host", approvedBy: "host-browser", status: "placed" },
    // Placed in September, so not in October's log.
    { id: "ord_sept", at: "2026-09-28T14:00:00.000Z", store: "Example Mart", items: [], totalCents: 0, chargedCents: 0, source: "schedule", approvedBy: "landlord", status: "delivered" },
  ],
  carts: [],
  lowReports: [],
};

/** A property folder holding every record above. */
export function octoberFolder(): Fixture {
  const f = emptyFolder();
  f.write("hub.json", hub);
  f.write("cleaner-live.json", live);
  f.write("cleaner-job/cleaner-core.json", engine);
  f.write("fixer.json", fixer);
  f.write("supply.json", supply);
  return f;
}
