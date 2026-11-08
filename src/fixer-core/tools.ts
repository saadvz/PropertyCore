import { z } from "zod";
import { refuseCards } from "../hub/cards";
import { CARD_REFUSAL, type FixerDesk, type FixerReply } from "./desk";
import { TRADES } from "./store";

/**
 * Fixer Core's MCP tools: names, descriptions, and strict inputs, one desk method each. Every call is
 * checked for card-like text before it reaches the desk, then parsed, then run. No tool takes or
 * returns a door code, and none maps to the visit page's reveal.
 */

export interface FixerTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
}

const Id = z.string().max(40);
const Cents = z.number().int();
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Instant = z.string().max(40);
const Trade = z.enum(TRADES);
const Confirmation = z.string().max(40).optional();
const Reach = z.object({ phone: z.string().max(20).optional(), email: z.string().max(120).optional(), website: z.string().max(300).optional(), bookingUrl: z.string().max(300).optional() }).strict();
/** Upkeep runs every so many days, on a day of the month, or on another rule; never by bookings. */
const Schedule = z.union([
  z.object({ kind: z.literal("every"), days: z.number().int() }).strict(),
  z.object({ kind: z.literal("every"), monthlyOn: z.number().int() }).strict(),
  z.object({ kind: z.literal("custom"), rrule: z.string().max(300), said: z.string().max(200) }).strict(),
]);
const GoogleEvents = z.object({ timeZone: z.string().max(80).optional(), items: z.array(z.unknown()).max(2000) }).strict();
const Candidate = z
  .object({
    name: z.string().max(80),
    trade: Trade.optional(),
    source: z.string().max(60).optional(),
    rating: z.number().optional(),
    reviewCount: z.number().int().optional(),
    licensed: z.enum(["yes", "no", "unknown"]).optional(),
    backgroundChecked: z.enum(["yes", "no", "unknown"]).optional(),
    costRange: z.object({ lowCents: Cents, highCents: Cents }).strict().optional(),
    priceText: z.string().max(60).optional(),
    earliestAt: Instant.optional(),
    reach: Reach.extend({ networkRef: z.string().max(120).optional() }).strict().optional(),
  })
  .strict();

export const NO_CARDS = "Never pass a card number or any payment detail: Fixer Core never pays anyone.";
const TWO_CALL = "Call without confirmation to get the question and a code, ask the host, and call again with the code only after their yes.";
const AFTER_ACTIVATE = `After Activate it takes the host's yes: ${TWO_CALL}`;

export const FIXER_TOOLS: FixerTool[] = [
  {
    name: "get_fixer_state",
    title: "Fixer Core: what's next",
    description: "Fixer Core's setup step to ask next, or once it's active, the pros by trade, upkeep, open jobs and the cost log. Call first, and follow its ask one question at a time.",
    input: z.object({}).strict(),
  },
  {
    name: "save_fixer_property",
    title: "Save the property for repairs",
    description:
      `Saves the property's street address, the time zone you work out from it, and an optional name that defaults to the street address. They're the property's, shared with Cleaner Core and Supply Core. Activate needs them. ${AFTER_ACTIVATE}`,
    input: z.object({ address: z.string().max(200), timeZone: z.string().max(80), name: z.string().max(80).optional(), confirmation: Confirmation }).strict(),
  },
  {
    name: "save_fixer_sources",
    title: "Save booking calendars",
    description:
      "Saves the property's booking calendars, shared with Cleaner Core and Supply Core, so pros only come between stays. Skip it when the property already has its calendars. uploadLink { name } gives a one-time link: from your own cloud computer, POST JSON {\"url\": \"<calendar link>\"} to it. Never put the link in chat or in a tool argument. google: true when the bookings are in Google Calendar; then pass that calendar's events as googleEvents to check_fixes and approve_booking. done: true when that's all, or when the host has no booking calendar.",
    input: z.object({ uploadLink: z.object({ name: z.string().max(40) }).strict().optional(), google: z.literal(true).optional(), done: z.literal(true).optional() }).strict(),
  },
  {
    name: "save_fixer_settings",
    title: "Save repair settings",
    description: `Saves any of: costLineCents (a repair over it needs the host's yes; null for no line), checkInBufferMinutes (how long before check-in a pro must be gone), cleaningMinutes (how long a cleaning takes), askCleaner (ask the cleaner "Anything broken?" after each cleaning), prosDone (the pro list is final), upkeepDone (no more upkeep to add). ${AFTER_ACTIVATE} ${NO_CARDS}`,
    input: z
      .object({
        costLineCents: Cents.nullable().optional(),
        checkInBufferMinutes: z.number().int().optional(),
        cleaningMinutes: z.number().int().optional(),
        askCleaner: z.boolean().optional(),
        prosDone: z.literal(true).optional(),
        upkeepDone: z.literal(true).optional(),
        confirmation: Confirmation,
      })
      .strict(),
  },
  {
    name: "save_pro",
    title: "Save a pro",
    description: `Saves one pro the host calls for repairs, or changes one with its id: name, trades, preferredFor (the order to call them in for each trade, rank 1 first), reach (phone in +1 form, email, website, bookingUrl), and prefersText. draft: true for a pro you drafted from the host's contacts or receipts; confirm: [ids] once the host confirms drafts. jobId saves the pro from a finished job. A phone already on another of the host's properties needs the host's yes, then shared: true. ${AFTER_ACTIVATE}`,
    input: z
      .object({
        id: Id.optional(),
        name: z.string().max(80).optional(),
        trades: z.array(Trade).max(8).optional(),
        preferredFor: z.array(z.object({ trade: Trade, rank: z.number().int() }).strict()).max(8).optional(),
        reach: Reach.optional(),
        prefersText: z.boolean().optional(),
        draft: z.literal(true).optional(),
        confirm: z.array(Id).max(60).optional(),
        jobId: Id.optional(),
        shared: z.literal(true).optional(),
        confirmation: Confirmation,
      })
      .strict(),
  },
  {
    name: "remove_pro",
    title: "Remove a pro",
    description: `Removes a pro from the list. ${AFTER_ACTIVATE}`,
    input: z.object({ id: Id, confirmation: Confirmation }).strict(),
  },
  {
    name: "save_upkeep",
    title: "Save an upkeep item",
    description: `Saves a regular upkeep item, or changes one with its id: the trade, what it is (under 120 characters), the schedule (every so many days, a day of the month, or another rule; call preview_schedule and read the next 3 dates back first), leadDays (how many days ahead to start, default 14), and an optional proId. ${AFTER_ACTIVATE}`,
    input: z.object({ id: Id.optional(), trade: Trade, what: z.string().max(200), schedule: Schedule, leadDays: z.number().int().optional(), proId: Id.optional(), confirmation: Confirmation }).strict(),
  },
  {
    name: "remove_upkeep",
    title: "Remove an upkeep item",
    description: `Removes an upkeep item. ${AFTER_ACTIVATE}`,
    input: z.object({ id: Id, confirmation: Confirmation }).strict(),
  },
  {
    name: "activate_fixer",
    title: "Activate Fixer Core",
    description: "Starts Fixer Core after the host's Activate. Needs the property's address and time zone, and its booking calendars (or the host's word that there are none).",
    input: z.object({}).strict(),
  },
  {
    name: "check_fixes",
    title: "What repairs need",
    description:
      "The repair pass: jobs waiting for the host's go, upkeep due, the preferred pro to contact, the times a pro can come for each job, contacts with no outcome, follow-ups due, holds, delays, and questions for the host. Call it on every routine run and act on what it returns. Pass googleEvents when the bookings are in Google Calendar.",
    input: z.object({ googleEvents: GoogleEvents.optional() }).strict(),
  },
  {
    name: "open_job",
    title: "Open a repair job",
    description:
      'Opens a repair: trade, what needs fixing (under 300 characters, in the reporter\'s words), urgency (now, soon, by-date with byDate, or flexible), and source (host, cleaner, or upkeep with the upkeep id as sourceRef). For a cleaner\'s report, pass the message\'s photo ids as photoMessageIds and the cleaner\'s name. doorLock: true when the lock itself is broken. A host\'s job starts at once; a cleaner\'s or upkeep job waits for the host\'s go with approve_job.',
    input: z
      .object({
        trade: Trade,
        what: z.string().max(400),
        urgency: z.enum(["now", "soon", "by-date", "flexible"]),
        byDate: Ymd.optional(),
        source: z.enum(["host", "cleaner", "upkeep"]),
        sourceRef: z.string().max(80).optional(),
        photoMessageIds: z.array(z.string().max(120)).max(10).optional(),
        cleanerName: z.string().max(80).optional(),
        doorLock: z.literal(true).optional(),
      })
      .strict(),
  },
  {
    name: "approve_job",
    title: "The host's go for a job",
    description: `For a job from the cleaner or upkeep: ${TWO_CALL} no: true when the host says no, which cancels the job.`,
    input: z.object({ jobId: Id, no: z.literal(true).optional(), confirmation: Confirmation }).strict(),
  },
  {
    name: "add_candidates",
    title: "Add pros you found",
    description: "Records the pros you found for a job, up to 8: name, trade, where you found them, rating and review count, licensed, background checked, a cost range or price text, the earliest time they can come, and how to reach them. options: true when the host asks for more choices while someone is already being contacted.",
    input: z.object({ jobId: Id, candidates: z.array(Candidate).min(1).max(8), options: z.literal(true).optional() }).strict(),
  },
  {
    name: "pick_pros",
    title: "The host's pick",
    description: `The pros the host picked to call, in order, by candidate or pro id. ${TWO_CALL}`,
    input: z.object({ jobId: Id, ids: z.array(Id).min(1).max(8), confirmation: Confirmation }).strict(),
  },
  {
    name: "contact_pro",
    title: "Contact a pro",
    description: "Before you call, email, text, fill in a form or booking page, or message a network: gives a contactToken for a pro the host approved, or a refusal to pass to the host. how is call, email, form, booking-page, text, or network.",
    input: z.object({ jobId: Id, to: Id, how: z.enum(["call", "email", "form", "booking-page", "text", "network"]) }).strict(),
  },
  {
    name: "record_contact",
    title: "Record what a pro said",
    description: "The outcome of a contact, with its contactToken: booked (with from and until as ISO times, and estimateCents when they gave one), quoted (quoteCents), no-answer, declined, or waiting (followUpAt when they said when). A booking runs Fixer Core's checks and gives the host's question.",
    input: z
      .object({
        contactToken: z.string().max(80),
        outcome: z.enum(["booked", "quoted", "no-answer", "declined", "waiting"]),
        from: Instant.optional(),
        until: Instant.optional(),
        estimateCents: Cents.optional(),
        quoteCents: Cents.optional(),
        note: z.string().max(400).optional(),
        followUpAt: Instant.optional(),
      })
      .strict(),
  },
  {
    name: "approve_booking",
    title: "The host's yes to a booking",
    description: `The host's yes to a pro's time and how they get in, together. ${TWO_CALL} access is code (the pro gets the door code for the visit) or host (the host lets them in). cleaningOrder is before or after when the visit shares a day with a cleaning. proId picks another pro's held offer on the job. revised: true for a raised price the pro gave after booking. Pass googleEvents when the bookings are in Google Calendar.`,
    input: z
      .object({
        jobId: Id,
        access: z.enum(["code", "host"]).optional(),
        cleaningOrder: z.enum(["before", "after"]).optional(),
        revised: z.literal(true).optional(),
        proId: Id.optional(),
        googleEvents: GoogleEvents.optional(),
        confirmation: Confirmation,
      })
      .strict(),
  },
  {
    name: "visit_link",
    title: "The visit link",
    description: "The private visit page link for a booked job, after the host's yes. It is shown once: send it only to the pro's own phone or email, never to a group.",
    input: z.object({ jobId: Id }).strict(),
  },
  {
    name: "revoke_visit",
    title: "End a visit link",
    description: "Ends a job's visit link on the host's word. Only a new time or more time gives a new one.",
    input: z.object({ jobId: Id }).strict(),
  },
  {
    name: "extend_visit",
    title: "More time for a visit",
    description: `More time for a visit, until an ISO time. ${TWO_CALL}`,
    input: z.object({ jobId: Id, until: Instant, confirmation: Confirmation }).strict(),
  },
  {
    name: "guests_left",
    title: "The guests have left",
    description: "The host says today's guests have left, so a repair visit today can go ahead. Ask the host first, then call with confirmed: true.",
    input: z.object({ confirmed: z.literal(true).optional() }).strict(),
  },
  {
    name: "record_done",
    title: "Record a job done",
    description: "Your or the host's word that the pro finished, with by (agent or host), an optional note, and the amount in cents when known.",
    input: z.object({ jobId: Id, note: z.string().max(400).optional(), by: z.enum(["agent", "host"]).optional(), cents: Cents.optional() }).strict(),
  },
  {
    name: "record_cost",
    title: "Record what a job cost",
    description: `What the job cost in cents, and who said it: pro, agent, or host. ${NO_CARDS}`,
    input: z.object({ jobId: Id, cents: Cents, by: z.enum(["pro", "agent", "host"]).optional(), note: z.string().max(400).optional() }).strict(),
  },
  {
    name: "cancel_job",
    title: "Cancel a job",
    description: `Cancels a job, with an optional reason. A booked job takes the host's yes: ${TWO_CALL} Then tell the pro, and ask the host any question the reply gives.`,
    input: z.object({ jobId: Id, reason: z.string().max(200).optional(), confirmation: Confirmation }).strict(),
  },
  {
    name: "reschedule_job",
    title: "Move a visit to a new time",
    description: `Moves a booked visit to a new time: the old time and its visit link end, and you contact the pro for a new one. ${TWO_CALL}`,
    input: z.object({ jobId: Id, reason: z.string().max(200).optional(), confirmation: Confirmation }).strict(),
  },
  {
    name: "skip_question",
    title: "The host says no to a question",
    description: "The host says no to the question after a visit: preferred (add the pro to the preferred list) or rotate (change the door code).",
    input: z.object({ jobId: Id, question: z.enum(["preferred", "rotate"]) }).strict(),
  },
  {
    name: "change_door_code",
    title: "Change the door code",
    description: "The host's yes to changing the door code after a visit: gives a one-time link for the host alone. They set the new code on the lock first, then save it through the link. Never ask for the code in chat.",
    input: z.object({ jobId: Id }).strict(),
  },
];

export const FIXER_TOOL_NAMES: ReadonlySet<string> = new Set(FIXER_TOOLS.map((tool) => tool.name));

/** The tools as tools/list shows them. */
export function listedFixerTools(names: readonly string[]): Record<string, unknown>[] {
  return FIXER_TOOLS.filter((tool) => names.includes(tool.name)).map((tool) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { name: tool.name, title: tool.title, description: tool.description, inputSchema };
  });
}

/** Tools whose googleEvents are read for their dates only and never saved, so they skip the card check. */
const WITH_EVENTS = new Set(["check_fixes", "approve_booking"]);

/** Answers a Fixer Core tool. Undefined when the name isn't one. */
export async function handleFixerTool(desk: FixerDesk, name: string, args: unknown): Promise<FixerReply | undefined> {
  const tool = FIXER_TOOLS.find((item) => item.name === name);
  if (!tool) return undefined;
  const checked = WITH_EVENTS.has(name) && args && typeof args === "object" ? { ...(args as Record<string, unknown>), googleEvents: undefined } : args;
  if (refuseCards(checked)) return { text: CARD_REFUSAL, isError: true };
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return { text: `That was missing something I need, or had something I don't take: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}.`, isError: true };
  const input = parsed.data as never;
  switch (name) {
    case "get_fixer_state":
      return desk.state();
    case "save_fixer_property":
      return desk.saveProperty(input);
    case "save_fixer_sources":
      return desk.saveSources(input);
    case "save_fixer_settings":
      return desk.saveSettings(input);
    case "save_pro":
      return desk.savePro(input);
    case "remove_pro":
      return desk.removePro(input);
    case "save_upkeep":
      return desk.saveUpkeep(input);
    case "remove_upkeep":
      return desk.removeUpkeep(input);
    case "activate_fixer":
      return desk.activate();
    case "check_fixes":
      return desk.checkFixes(input);
    case "open_job":
      return desk.openJob(input);
    case "approve_job":
      return desk.approveJob(input);
    case "add_candidates":
      return desk.addCandidates(input);
    case "pick_pros":
      return desk.pickPros(input);
    case "contact_pro":
      return desk.contactPro(input);
    case "record_contact":
      return desk.recordContact(input);
    case "approve_booking":
      return desk.approveBooking(input);
    case "visit_link":
      return desk.visitLink(input);
    case "revoke_visit":
      return desk.revokeVisit(input);
    case "extend_visit":
      return desk.extendVisit(input);
    case "guests_left":
      return desk.guestsLeft(input);
    case "record_done":
      return desk.recordDone(input);
    case "record_cost":
      return desk.recordCost(input);
    case "cancel_job":
      return desk.cancelJob(input);
    case "reschedule_job":
      return desk.rescheduleJob(input);
    case "skip_question":
      return desk.skipQuestion(input);
    case "change_door_code":
      return desk.changeDoorCode(input);
  }
  return undefined;
}
