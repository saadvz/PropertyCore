import type { AskQuestion } from "../hub/ask";
import type { Hub } from "../hub/hub";
import { cleanerAskQuestion } from "./texts";
import { TRADES, type FixerFile, type Pro, type Trade } from "./store";

/**
 * Fixer Core's setup, one step at a time, in Supply Core's `ask` shape: Fixer Core names the fields and
 * choices, and the agent asks one short question per message in its own words.
 */

export type FixerStep = "pros" | "ask-cleaner" | "alerts" | "upkeep" | "review";

export interface DraftPro {
  id: string;
  name: string;
  /** What the host still has to give before this pro can be confirmed. */
  needsYou: string[];
}

export interface FixerAsk {
  step: FixerStep;
  tool: string;
  questions: AskQuestion[];
  /** The agent's drafted pros by trade, with the gaps marked. Only on the pros step. */
  drafts?: { trade: Trade; pros: DraftPro[] }[];
  /** What stops Activate right now. Only on the review step. */
  blockers?: string[];
}

/** What a pro still needs before the host can confirm them. */
export function proGaps(pro: Pro): string[] {
  const gaps: string[] = [];
  const { phone, email, website, bookingUrl } = pro.reach;
  if (!phone && !email && !website && !bookingUrl) gaps.push("a way to reach them");
  return gaps;
}

/** The drafts, trade by trade in the trade list's order. A pro with two trades shows under both. */
function draftsByTrade(file: FixerFile): { trade: Trade; pros: DraftPro[] }[] {
  const drafts = file.pros.filter((pro) => pro.status === "draft");
  return TRADES.map((trade) => ({
    trade,
    pros: drafts.filter((pro) => pro.trades.includes(trade)).map((pro) => ({ id: pro.id, name: pro.name, needsYou: proGaps(pro) })),
  })).filter((group) => group.pros.length > 0);
}

/**
 * Why Activate is refused, in plain words; empty when it can go. The property and its calendars are
 * the hub's; the host's "there is no booking calendar" is Fixer Core's own, in fixer.json.
 */
export function activateProblems(hub: Hub, file: FixerFile): string[] {
  const out: string[] = [];
  const place = hub.property();
  if (!place.address || !place.timeZone) out.push("Save the property's address and time zone first.");
  if (hub.calendars().length === 0 && !hub.google() && !hub.calendarsDone() && !file.setup.noCalendar) out.push("Save a booking calendar first, or say there is none.");
  return out;
}

const TRADE_LABELS: Record<Trade, string> = {
  plumbing: "Plumber",
  hvac: "HVAC",
  electrical: "Electrician",
  handyman: "Handyman",
  gutters: "Gutters",
  "pest-control": "Pest control",
  appliance: "Appliance repair",
  locksmith: "Locksmith",
};

/** The pros, in two cards: Grok's choice card shows only a few options, so each has at most five. */
const PROS_QUESTIONS: AskQuestion[] = [
  {
    field: "pros",
    ask: "which of these trades the host already has someone they call for",
    required: true,
    options: [...(["plumbing", "hvac", "electrical", "handyman"] as const).map((trade) => ({ value: trade, label: TRADE_LABELS[trade] })), { value: "none", label: "None of these" }],
    multiple: true,
    example: "Joe's Plumbing, 201-555-0142",
    how:
      "Ask two choice cards, one card per message, where the host picks all that apply: this one, then the next. Never ask trade by trade, and never ask about a trade they didn't pick. Then, for each trade they picked on either card, ask for that pro's name and phone, one per message. If you can read their contacts, receipts and emails, draft pros from them first with save_pro and draft: true, and confirm each drafted pro with the host, one per message: name the pro and their trade, with Yes, Change it and Remove as a choice card. Confirm with save_pro { confirm: [ids] }. For each trade, put the pros in the order to call them with preferredFor ranks. When the list is final (none is fine), call save_fixer_settings with prosDone: true.",
  },
  {
    field: "pros-more",
    ask: "which of these other trades the host already has someone they call for",
    required: true,
    options: [...(["gutters", "pest-control", "appliance", "locksmith"] as const).map((trade) => ({ value: trade, label: TRADE_LABELS[trade] })), { value: "none", label: "None of these" }],
    multiple: true,
  },
];

const UPKEEP_QUESTION: AskQuestion = {
  field: "upkeep",
  ask: "whether they want reminders for regular upkeep",
  required: false,
  how:
    "Suggest gutters in spring and fall, HVAC filters every 3 months, and smoke detectors twice a year. For each one: the trade, what it is, the schedule (every so many days, a day of the month, or another rule; call preview_schedule and read the next 3 dates back before saving), and optionally a pro. Save it with save_upkeep. Not by bookings. When that's all (none is fine), call save_fixer_settings with upkeepDone: true.",
};

const ALERTS_QUESTION: AskQuestion = {
  field: "alerts",
  ask: "Want me to tell you the moment a pro texts or calls back? I'll set up an alert for this chat. You'll copy two values into secure cards.",
  required: true,
  options: [
    { value: "yes", label: "Yes" },
    { value: "not-now", label: "Not now" },
  ],
  how:
    "On Yes: create the Property Core Alerts routine from property-core-template/routines/property-core-alerts.md. Only the host can see its webhook address and key. Right after you create it, send the host a link that opens its Webhook URL field directly and one that opens its Webhook key field directly, with one secure card for each, the address first. Never send a link to the Routines page. Then call save_repair_alerts to get a one-time upload link, and POST JSON {\"url\": \"<webhook address>\", \"token\": \"<webhook key>\"} to it from your own cloud computer. Never put them in chat. On Not now: save_fixer_settings with alertsSkipped: true.",
};

/**
 * The next setup question. `cleaningOn` and `supplyOn` say whether the cleaner and Supply Core run on the property;
 * `alertsWanted` whether this chat can be woken and no alerts routine reaches it yet.
 */
export function fixerSetupAsk(file: FixerFile, hub: Hub, cleaningOn: boolean, supplyOn: boolean, alertsWanted = false): FixerAsk | undefined {
  if (file.settings.activatedAt) return undefined;
  if (!file.setup.prosDone) {
    const drafts = draftsByTrade(file);
    return { step: "pros", tool: "save_pro", questions: PROS_QUESTIONS, ...(drafts.length > 0 ? { drafts } : {}) };
  }
  if (cleaningOn && !file.setup.cleanerAsked) {
    return {
      step: "ask-cleaner",
      tool: "save_fixer_settings",
      questions: [
        {
          field: "askCleaner",
          ask: cleanerAskQuestion(supplyOn),
          required: true,
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
          how: "Yes saves askCleaner: true; no saves askCleaner: false.",
        },
      ],
    };
  }
  if (!file.setup.upkeepDone) return { step: "upkeep", tool: "save_upkeep", questions: [UPKEEP_QUESTION] };
  if (alertsWanted && !file.setup.alertsDone && !file.setup.alertsSkipped) return { step: "alerts", tool: "save_repair_alerts", questions: [ALERTS_QUESTION] };
  const blockers = activateProblems(hub, file);
  return {
    step: "review",
    tool: "activate_fixer",
    questions: [{ field: "activate", ask: "whether to start: summarize the pros, hours and upkeep in your own words", required: true, options: [{ value: "activate", label: "Activate" }] }],
    ...(blockers.length > 0 ? { blockers } : {}),
  };
}
