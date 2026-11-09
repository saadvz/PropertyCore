import type { AskQuestion } from "../hub/ask";
import type { Hub } from "../hub/hub";
import { cleanerAskQuestion } from "./texts";
import { TRADES, type FixerFile, type Pro, type Trade } from "./store";

/**
 * Fixer Core's setup, one step at a time, in Supply Core's `ask` shape: Fixer Core names the fields and
 * choices, and the agent asks one short question per message in its own words.
 */

export type FixerStep = "pros" | "cost-line" | "ask-cleaner" | "upkeep" | "review";

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

const PROS_QUESTION: AskQuestion = {
  field: "pros",
  ask: "who the host already calls for repairs, trade by trade (plumbing, HVAC, electrical, handyman, gutters, pest control, appliance, locksmith)",
  required: true,
  example: "Joe's Plumbing, 201-555-0142",
  how:
    "Draft the list yourself from what you can read (their contacts, receipts and emails) and save each pro with save_pro and draft: true. Don't show a summary. Confirm each drafted pro with the host, one per message: name the pro and their trade, with Yes, Change it and Remove as a choice card. Then ask about each trade still missing, one per message. Confirm with save_pro { confirm: [ids] }. For each trade, put the pros in the order to call them with preferredFor ranks. When the list is final (none is fine), call save_fixer_settings with prosDone: true.",
};

const COST_QUESTION: AskQuestion = {
  field: "costLineCents",
  ask: "whether they want a cost line: any repair over it needs their yes, and so does a price raised on site",
  required: false,
  example: "50000 for $500",
  how: "No cost line saves costLineCents as null.",
};

const UPKEEP_QUESTION: AskQuestion = {
  field: "upkeep",
  ask: "whether they want reminders for regular upkeep",
  required: false,
  how:
    "Suggest gutters in spring and fall, HVAC filters every 3 months, and smoke detectors twice a year. For each one: the trade, what it is, the schedule (every so many days, a day of the month, or another rule; call preview_schedule and read the next 3 dates back before saving), and optionally a pro. Save it with save_upkeep. Not by bookings. When that's all (none is fine), call save_fixer_settings with upkeepDone: true.",
};

/** The next setup question. `cleaningOn` and `supplyOn` say whether the cleaner and Supply Core run on the property. */
export function fixerSetupAsk(file: FixerFile, hub: Hub, cleaningOn: boolean, supplyOn: boolean): FixerAsk | undefined {
  if (file.settings.activatedAt) return undefined;
  if (!file.setup.prosDone) {
    const drafts = draftsByTrade(file);
    return { step: "pros", tool: "save_pro", questions: [PROS_QUESTION], ...(drafts.length > 0 ? { drafts } : {}) };
  }
  if (!file.setup.costAsked) return { step: "cost-line", tool: "save_fixer_settings", questions: [COST_QUESTION] };
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
  const blockers = activateProblems(hub, file);
  return {
    step: "review",
    tool: "activate_fixer",
    questions: [{ field: "activate", ask: "whether to start: summarize the pros, cost line, hours and upkeep in your own words", required: true, options: [{ value: "activate", label: "Activate" }] }],
    ...(blockers.length > 0 ? { blockers } : {}),
  };
}
