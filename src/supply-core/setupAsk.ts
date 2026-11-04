import type { AskQuestion } from "../cleaner-core/setupAsk";
import type { SupplyFile } from "./store";

/**
 * Supply Core's setup, one step at a time, in Cleaner Core's `ask` shape: Supply Core names the
 * fields and choices, and Grok asks one short question per message in its own words.
 */

export type SupplyStep = "property" | "items" | "sources" | "mode" | "caps" | "check-time" | "routine" | "review";

export interface SupplyAsk {
  step: SupplyStep;
  tool: string;
  questions: AskQuestion[];
}

const ITEM_QUESTIONS: AskQuestion[] = [
  { field: "name", ask: "an item the property always needs restocked", required: true, example: "Paper towels" },
  {
    field: "preferred",
    ask: "which product the host prefers",
    required: true,
    how: "Search with your shopping tools and show 3 to 4 product cards. Save the one they pick: its title, store, https link, pack size, and price in cents.",
  },
  {
    field: "backup",
    ask: "whether they want a backup product, and which",
    required: false,
    options: [
      { value: "yes", label: "Pick a backup" },
      { value: "no", label: "No backup" },
    ],
    how: "Show the remaining cards, or search again.",
  },
  { field: "qtyPerOrder", ask: "how many to buy each time", required: true, default: "1" },
  {
    field: "storeNote",
    ask: "which store to buy it from",
    required: true,
    how: "If the host prefers a store, use it and note its caveats. Otherwise suggest one with the reason: price per unit, delivery time, membership or minimum order, and whether you can check out there. Save one line under 160 characters.",
  },
  {
    field: "schedule",
    ask: "how often to reorder it",
    required: true,
    options: [
      { value: "every", label: "Every…" },
      { value: "bookings", label: "By bookings" },
      { value: "custom", label: "Other" },
    ],
    how: "Every: a number of days (1 to 365) or a day of the month (1 to 28). By bookings: once every so many stays (1 to 50). Other: write an RRULE from their words, call preview_schedule, and read the next 3 dates back before saving.",
  },
];

const MORE: AskQuestion = {
  field: "more",
  ask: "Anything else to add?",
  required: true,
  options: [
    { value: "yes", label: "Add another" },
    { value: "no", label: "That's all" },
  ],
  how: "That's all calls save_supply_item with { done: true }.",
};

export function supplySetupAsk(file: SupplyFile, standalone: boolean): SupplyAsk | undefined {
  if (file.settings.activatedAt) return undefined;
  const s = file.settings;
  if (standalone && !s.property) {
    return {
      step: "property",
      tool: "save_supply_settings",
      questions: [
        { field: "property.name", ask: "the property's name", required: true },
        { field: "property.address", ask: "the delivery address", required: true },
        { field: "property.timeZone", ask: "the property's time zone", required: true, example: "America/New_York" },
      ],
    };
  }
  if (!file.setup.itemsDone || file.items.length === 0) {
    return { step: "items", tool: "save_supply_item", questions: file.items.length > 0 ? [MORE, ...ITEM_QUESTIONS] : ITEM_QUESTIONS };
  }
  if (standalone && !file.setup.sourcesDone && file.items.some((item) => item.schedule.kind === "bookings")) {
    return {
      step: "sources",
      tool: "save_supply_sources",
      questions: [
        {
          field: "source",
          ask: "where the bookings come from",
          required: true,
          options: [
            { value: "google", label: "Google Calendar" },
            { value: "link", label: "A calendar link" },
          ],
          how: "A calendar link goes on your secure card: call save_supply_sources with uploadLink { name }, then POST JSON {\"url\": \"<link>\"} to uploadUrl from your own cloud computer. When that's all, call it with done: true.",
        },
      ],
    };
  }
  if (!s.mode) {
    return {
      step: "mode",
      tool: "save_supply_settings",
      questions: [
        {
          field: "mode",
          ask: "whether to order hands-off or stop at checkout for their yes",
          required: true,
          options: [
            { value: "hands-off", label: "Hands-off" },
            { value: "checkout", label: "Stop at checkout" },
          ],
          default: "checkout",
        },
      ],
    };
  }
  if (!file.setup.capsDone) {
    return {
      step: "caps",
      tool: "save_supply_settings",
      questions: [
        {
          field: "caps",
          ask: "whether they want a spending cap",
          required: true,
          options: [
            { value: "order", label: "Per order" },
            { value: "month", label: "Per month" },
            { value: "both", label: "Both" },
            { value: "none", label: "No cap" },
          ],
          how: "No cap saves perOrderCapCents and perMonthCapCents as null.",
        },
        { field: "perOrderCapCents", ask: "the most one order can cost", required: false, when: "caps is order or both", example: "7500 for $75" },
        { field: "perMonthCapCents", ask: "the most to spend in a month", required: false, when: "caps is month or both", example: "30000 for $300" },
      ],
    };
  }
  if (!s.checkTime) {
    return { step: "check-time", tool: "save_supply_settings", questions: [{ field: "checkTime", ask: "what time each day to check and order", required: true, default: "10:00" }] };
  }
  if (!file.setup.routineCreated) {
    return {
      step: "routine",
      tool: "save_supply_settings",
      questions: [
        {
          field: "routineCreated",
          ask: "nothing: create the Supply Core Check routine yourself",
          required: true,
          how: "Create the scheduled routine in supply-template/routines/supply-core-check.md, daily at checkTime, then call save_supply_settings with routineCreated: true.",
        },
      ],
    };
  }
  return {
    step: "review",
    tool: "activate_supplies",
    questions: [{ field: "activate", ask: "whether to start: summarize the list, mode, caps, and check time in your own words", required: true, options: [{ value: "activate", label: "Activate" }] }],
  };
}
