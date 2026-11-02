import type { IntentType, InterpretContext } from "../src/intent";

/**
 * The visitor scenario catalog as data: each basic text a visitor sends, at a point in the flow, and the
 * intent it should be read as. Row 1's first text is answered by the TOUR keyword consent gate before
 * any intent is read, so it is not here. The catalog tests (visitorScenarios.test.ts) send these through the real
 * text path; `npm run eval:visitor-model` sends them through the configured model. Only 555 numbers.
 */

export type CatalogSetup = "unbooked" | "booked";

export interface CatalogEntry {
  row: string;
  setup: CatalogSetup;
  text: string;
  intent: IntentType;
}

export const CATALOG: readonly CatalogEntry[] = [
  { row: "2", setup: "unbooked", text: "What times do you have?", intent: "ASK_OPEN_TIMES" },
  { row: "2", setup: "unbooked", text: "Any openings Tuesday?", intent: "ASK_OPEN_TIMES" },
  { row: "2b", setup: "booked", text: "Ok what times are available?", intent: "ASK_OPEN_TIMES" },
  { row: "4", setup: "unbooked", text: "How much is 1A?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "4", setup: "unbooked", text: "Is there parking?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "5", setup: "unbooked", text: "How do I apply?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "5", setup: "unbooked", text: "What's the deposit?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "5", setup: "unbooked", text: "How long is the lease?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "6", setup: "unbooked", text: "Where is it?", intent: "ASK_DIRECTIONS" },
  { row: "6", setup: "unbooked", text: "What's the address?", intent: "ASK_DIRECTIONS" },
  { row: "7", setup: "unbooked", text: "Is there a gym?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "8", setup: "booked", text: "When is my tour?", intent: "ASK_MY_TOUR" },
  { row: "8", setup: "booked", text: "What time is my tour again?", intent: "ASK_MY_TOUR" },
  { row: "9", setup: "booked", text: "Can I change the time for the tour?", intent: "RESCHEDULE_TOUR" },
  { row: "9", setup: "booked", text: "Can we do Thursday instead?", intent: "RESCHEDULE_TOUR" },
  { row: "9", setup: "booked", text: "could we push it back a bit", intent: "RESCHEDULE_TOUR" },
  { row: "10", setup: "booked", text: "Cancel my tour", intent: "CANCEL_TOUR" },
  { row: "11", setup: "booked", text: "How long does the tour take?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "11", setup: "booked", text: "Do I need ID?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "11", setup: "booked", text: "Can I bring someone?", intent: "ASK_PROPERTY_QUESTION" },
  { row: "16", setup: "booked", text: "How do I apply?", intent: "ASK_PROPERTY_QUESTION" },
];

/** What the interpreter knows about the demo property at that point: two units, booked or not. */
export function catalogContext(entry: CatalogEntry): InterpretContext {
  const booked = entry.setup === "booked";
  return {
    message: entry.text,
    step: booked ? "ready" : "choose-unit",
    units: [{ name: "Unit 1A" }, { name: "Unit 2B" }],
    timeChoices: [],
    today: { year: 2026, month: 9, day: 28 },
    timezone: "America/New_York",
    remainingStops: [],
    doors: [],
    ...(booked ? { reservedUnit: "Unit 1A", hasCancelableTour: true } : {}),
  };
}
