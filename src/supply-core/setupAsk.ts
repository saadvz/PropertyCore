import type { AskQuestion } from "../hub/ask";
import type { Hub } from "../hub/hub";
import type { SupplyFile } from "./store";

/**
 * Supply Core's setup, one step at a time, in Cleaner Core's `ask` shape: Supply Core names the
 * fields and choices, and the agent asks one short question per message in its own words. The words
 * here are Grok's; src/hosted/supplyWording.ts gives Muse its own.
 */

export type SupplyStep = "property" | "list" | "stores" | "schedule" | "products" | "sources" | "accounts" | "mode" | "caps" | "check-time" | "routine" | "review";

export interface SupplyAsk {
  step: SupplyStep;
  tool: string;
  questions: AskQuestion[];
}

const LIST_QUESTION: AskQuestion = {
  field: "names",
  ask: "What do you want restocked regularly? List everything, up to 30 items.",
  required: true,
  example: "Paper towels, dish soap, coffee pods",
  how: "Ask in one message. Split their answer into items, read the list back once to confirm, then call save_supply_list with the names.",
};

const STORE_QUESTIONS: AskQuestion[] = [
  {
    field: "primary",
    ask: "which one store to buy the whole list from",
    required: true,
    how:
      "Before searching for products, look at the whole draft list, the delivery address, and how soon things are needed. The property is usually empty, so offer only stores that ship to the door from their own site (like Walmart, Target, Sam's Club, or Costco) or same-day services whose driver can leave it at the door (like Instacart, Uber Eats, DoorDash, or Walmart and Target same-day). Never offer pickup, anything that needs a signature, a third-party seller inside a marketplace, or a local store that doesn't deliver to the address. Offer only stores you can actually check out with now, through a connector or the store's own checkout. Suggest the one store that covers the whole list in time; if none does, the fewest that do. Name any membership it needs and ask whether the host has it. Save its name and channel: shipping or same-day.",
  },
  {
    field: "fast",
    ask: "whether to add a same-day store for when the main store can't make a deadline, like a cleaner's report the day before the next guest",
    required: false,
    options: [
      { value: "yes", label: "Add a same-day store" },
      { value: "no", label: "No, just the main store" },
    ],
    default: "yes",
    how: "Use the same rules. Save it as fast with channel same-day.",
  },
];

const SCHEDULE_HOW =
  "Every: a number of days (1 to 365) or a day of the month (1 to 28). By bookings: once every so many stays (1 to 50). Other: write an RRULE from their words, call preview_schedule, and read the next 3 dates back before saving.";

const SCHEDULE_OPTIONS = [
  { value: "every", label: "Every…" },
  { value: "bookings", label: "By bookings" },
  { value: "custom", label: "Other" },
];

/** Asked before any product, so a shared schedule never interrupts the product picks. */
const SCHEDULE_QUESTIONS: AskQuestion[] = [
  {
    field: "sameSchedule",
    ask: "whether one schedule fits every item on the list, or each gets its own",
    required: true,
    options: [
      { value: "same", label: "Same for everything" },
      { value: "each", label: "Set each one" },
    ],
    how: "Set each one saves save_supply_settings { sharedSchedule: null }, and each item's schedule is asked with its product.",
  },
  {
    field: "sharedSchedule",
    ask: "how often to reorder everything",
    required: false,
    when: "sameSchedule is same",
    options: SCHEDULE_OPTIONS,
    how: `${SCHEDULE_HOW} Save it with save_supply_settings { sharedSchedule }. Every item then uses it.`,
  },
];

/** Product cards first, then a choice card the host can tap: cards alone have no button. */
export const CARDS =
  "Show 3 to 4 product cards from the plan's stores only. Then, right after the cards, show a choice card with one option per product, by its short name, so the host can tap their pick. Never list products as text.";

const ITEM_QUESTIONS: AskQuestion[] = [
  {
    field: "preferred",
    ask: "which product the host prefers",
    required: true,
    how: `${CARDS} Save the one they pick: its title, store, https link, pack size, and price in cents.`,
  },
  {
    field: "backup",
    ask: "whether they want a backup product, and which",
    required: false,
    options: [
      { value: "yes", label: "Pick a backup" },
      { value: "no", label: "No backup" },
    ],
    how: `For a backup: ${CARDS} Use the products they didn't pick, or search again.`,
  },
  { field: "qtyPerOrder", ask: "how many to buy each time", required: true, default: "1" },
  {
    field: "schedule",
    ask: "how often to reorder it",
    required: true,
    options: SCHEDULE_OPTIONS,
    how: SCHEDULE_HOW,
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
  how: "Add another: call save_supply_list with the new names, then pick their products. That's all calls save_supply_item with { done: true }.",
};

/** The plan's store names: the main store, then the same-day one. */
export function planStores(file: SupplyFile): string[] {
  const plan = file.settings.stores;
  return plan ? [plan.primary.name, ...(plan.fast ? [plan.fast.name] : [])] : [];
}

/** The next setup question. The property and the booking calendars are the hub's: a step another flow finished is skipped. */
export function supplySetupAsk(file: SupplyFile, hub: Hub): SupplyAsk | undefined {
  if (file.settings.activatedAt) return undefined;
  const s = file.settings;
  const place = hub.property();
  if (!place.address || !place.timeZone) {
    return {
      step: "property",
      tool: "save_supply_settings",
      questions: [
        { field: "property.address", ask: "the property's delivery address", required: true },
        { field: "property.timeZone", ask: "nothing: work out the time zone from the address", required: true, example: "America/New_York", how: "Ask only if the address could be in more than one time zone." },
        { field: "property.name", ask: "nothing unless the host offers one: the name defaults to the street address", required: false },
      ],
    };
  }
  if (!file.setup.itemsDone || file.items.length === 0) {
    if (file.items.length === 0 && file.draft.length === 0) return { step: "list", tool: "save_supply_list", questions: [LIST_QUESTION] };
    if (!s.stores) return { step: "stores", tool: "save_supply_stores", questions: STORE_QUESTIONS };
    if (file.items.length === 0 && file.draft.length >= 2 && !file.setup.scheduleAsked) return { step: "schedule", tool: "save_supply_settings", questions: SCHEDULE_QUESTIONS };
    const perItem = s.sharedSchedule ? ITEM_QUESTIONS.filter((q) => q.field !== "schedule") : ITEM_QUESTIONS;
    if (file.draft.length > 0) return { step: "products", tool: "save_supply_item", questions: perItem };
    return { step: "products", tool: "save_supply_item", questions: [MORE] };
  }
  if (!hub.calendarsDone() && file.items.some((item) => item.schedule.kind === "bookings")) {
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
  const unready = planStores(file).filter((name) => !(s.storesReady ?? []).some((ready) => ready.toLowerCase() === name.toLowerCase()));
  if (unready.length > 0) {
    return {
      step: "accounts",
      tool: "save_supply_settings",
      questions: unready.map((name) => ({
        field: "storesReady",
        ask: `whether you can check out at ${name}`,
        required: true,
        how: `Check it yourself, without placing an order: open ${name}, confirm you're signed in (a saved login in Vault or its connector), that the delivery address is the property's, and that a payment method is ready (a saved card, Shop Pay, Link, or X Money). If anything is missing, tell the host what and help them connect it: hand them your computer for the sign-in, or ask them to add a payment method in Vault. Never ask for a password or card number in chat. When it's ready, call save_supply_settings with storesReady: ["${name}"].`,
      })),
    };
  }
  return {
    step: "review",
    tool: "activate_supplies",
    questions: [{ field: "activate", ask: "whether to start: summarize the list, mode, caps, and check time in your own words", required: true, options: [{ value: "activate", label: "Activate" }] }],
  };
}
