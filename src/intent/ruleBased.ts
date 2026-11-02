import { isFairHousingQuestion, isTourPartyNote, suitabilityBlocksBooking } from "../core/fairHousing";
import { firstInboundMatch, isSchedulingMenuAnswer } from "../visitor/inboundTextPipeline";
import { isMoreTimeAsk } from "../core/overstayCopy";
import { dayReference, namesTourDay, spokenTimes, vagueTimeRequest, type SpokenTime } from "../core/spokenTime";
import { isGeneralTourHoursQuestion } from "./tourHoursAsk";
import type { IntentInterpretation, IntentInterpreter, IntentType, InterpretContext, StepAwaiting, StopRef, TourIntent } from "./model";
import { normalize, numberWord, ordinalWord, stripFiller } from "./normalize";
import { acceptsNextOpening, yesNo } from "./yesNo";

/**
 * Injury texts. Hyphenated compounds stay one word so "ambulance-chaser"
 * is not "ambulance". A 911 line on a normal text is noise, but a missed
 * injury is unsafe, so fell/hurt/injured/slipped/tripped need a person or a help word.
 * slipped and tripped are not acute phrases. A broken bone counts; a broken
 * lease, window, or nail does not. back counts only with his/her/my/their/your/our.
 */
const STREET_WORD =
  "main|st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|ter|terrace|cir|circle|hwy|highway|sq|square";
const INJURY = "(?:fell|hurt|injured|slipped|tripped)";
const BODY_PART =
  "(?:arms?|legs?|wrists?|ankles?|hands?|feet|foot|fingers?|toes?|ribs?|noses?|hips?|collarbones?|necks?|bones?|teeth|tooth|jaws?|elbows?|knees?|shoulders?|skulls?)";
const BROKE_BODY = `(?:broke|broken) (?:(?:his|her|my|their|your|our|a) )?${BODY_PART}`;
const BROKE_BACK = "(?:broke|broken) (?:his|her|my|their|your|our) back";
/** "my back is broken" is the same possessive back as "broke my back". "broke a back window" is not. */
const BACK_IS_BROKEN = "(?:his|her|my|their|your|our) back (?:is|was|got|gets) (?:broke|broken)";
const ACUTE =
  /\b(?:not breathing|stopped breathing|trouble breathing|cannot breathe|can not breathe|cannot get up|can not get up|choking|unconscious|unresponsive|passed out|fainted|collapsed|heart attack|(?:had|has|having) a stroke|seizure|overdos(?:e|ed|ing)|allergic reaction|chest pains?)\b/;

function medicalText(raw: string): string {
  const glued = raw.replace(/([A-Za-z0-9])-([A-Za-z0-9])/g, "$1$2");
  return stripFiller(normalize(glued));
}

function mentions911(text: string): boolean {
  const kept = text.replace(new RegExp(`\\b911\\s+(?:${STREET_WORD})\\b`, "g"), " ");
  if (/\b(?:call|dial)\s+911\b/.test(kept)) return true;
  return /^911$/.test(kept.trim());
}

/** Collocations that share an injury word and still are not an emergency. */
function stripNeverCounts(text: string): string {
  return text
    .replace(/\bfell in love\b/g, " ")
    .replace(/\bprice fell\b/g, " ")
    .replace(/\bwould it hurt\b/g, " ")
    .replace(/\bchoking hazard\b/g, " ")
    .replace(/\bseizure of\b/g, " ")
    .replace(/\bheart attack of\b/g, " ")
    .replace(/\bis a heart attack\b/g, " ")
    .replace(/\bpassed out (?:flyers|papers|pamphlets|candy)\b/g, " ")
    .replace(/\btripped the (?:breaker|alarm|switch)\b/g, " ")
    .replace(/\b(?:tour|showing|appointment|time|date|it)\s+slipped to\b/g, " ");
}

function injuryWithPersonOrHelp(text: string): boolean {
  if (!new RegExp(`\\b${INJURY}\\b`).test(text)) return false;
  if (/\bhelp\b/.test(text)) return true;
  if (new RegExp(`\\b(?:i|we|he|she|they|someone)\\b(?:\\s+\\w+){0,6}\\s+${INJURY}\\b`).test(text)) return true;
  if (new RegExp(`\\bmy\\s+(?:\\w+\\s+){1,6}${INJURY}\\b`).test(text)) return true;
  if (new RegExp(`\\b${INJURY}\\b(?:\\s+\\w+){0,4}\\s+(?:me|him|her|them|someone)\\b`).test(text)) return true;
  return new RegExp(`\\b(?!(?:it|that|this|there|what|which|price|the|a|an|would|to)\\b)\\w+\\s+(?:is|was|got|gets)\\s+(?:hurt|injured)\\b`).test(text);
}

/** True when this text should get the 911 help reply, in any conversation state. */
export function isMedicalEmergency(raw: string): boolean {
  const text = stripNeverCounts(medicalText(raw));
  if (!text.trim()) return false;
  if (ACUTE.test(text)) return true;
  if (new RegExp(`\\b(?:${BROKE_BODY}|${BROKE_BACK}|${BACK_IS_BROKEN})\\b`).test(text)) return true;
  if (/\bbleeding\b/.test(text) || /\bambulance\b/.test(text)) return true;
  if (mentions911(text)) return true;
  return injuryWithPersonOrHelp(text);
}

/**
 * Deterministic interpretation: menu numbers, YES/NO, messaging keywords and
 * the common ways people say "I'm here", "I'm at 101", "I'm done". No model
 * call, no network. Anything it can't place confidently comes back UNKNOWN
 * or low-confidence so Tour Core asks instead of acting.
 */

export type Keyword = "stop" | "start" | "help";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "opt out", "optout"]);
const START_WORDS = new Set(["start", "unstop", "subscribe"]);
const HELP_WORDS = new Set(["help", "info"]);

/** Messaging-service keywords. Only whole-message matches count ("stop" yes, "don't stop" no). */
export function keywordOf(text: string): Keyword | undefined {
  const t = normalize(text);
  if (STOP_WORDS.has(t)) return "stop";
  if (START_WORDS.has(t)) return "start";
  if (HELP_WORDS.has(t)) return "help";
  return undefined;
}

const NATURAL_STOP = /^(please )?(stop|quit) (texting|messaging|contacting) (me|us)( please)?$|^(please )?(stop|quit) (texting|messaging|contacting) my\b.*|^(please )?(do not|never) (text|message|contact) (me|us)( again| anymore)?$|^(unsubscribe|remove) me( from (this|your|the) list)?$/;

/** "stop texting me", "stop texting us", "stop texting my family", "please stop texting my ...". */
export function isPlainLanguageStop(text: string): boolean {
  return NATURAL_STOP.test(stripFiller(normalize(text)));
}

/**
 * Carrier keywords, plus a plain-language stop. The plain-language stop is
 * the keyword STOP: same opt-out, same acknowledgement, before any other check.
 */
export function messagingKeyword(text: string): Keyword | undefined {
  return keywordOf(text) ?? (isPlainLanguageStop(text) ? "stop" : undefined);
}

const MANIPULATION = new RegExp(
  [
    String.raw`\b(ignore|disregard|forget|override|bypass|circumvent|skip|disable)\b.{0,40}\b(rules?|instructions?|polic(y|ies)|restrictions?|checks?|security|verification|prompt|system|guidelines?|previous|above|limits?)\b`,
    String.raw`\b(system prompt|developer mode|dev mode|admin mode|god mode|jailbreak|you are now|act as|pretend (to be|you are|that)|new instructions?|as an? (admin|administrator|operator|manager|landlord|owner))\b`,
    String.raw`\b(i am|this is) (the |an? )?(admin|administrator|operator|property manager|landlord|owner|leasing agent|maintenance)\b`,
    String.raw`\b(open|unlock)\b.{0,20}\b(all|every|each|other|any|both)\b.{0,12}\b(doors?|units?|locks?|apartments?)\b`,
    String.raw`\b(master|override|admin) (code|key|access|password)\b`,
  ].join("|"),
);

const HELP: [RegExp, NonNullable<Extract<TourIntent, { type: "REQUEST_HELP" }>["problem"]>][] = [
  [
    /\b(will not|does not|did not|would not|is not|cannot|can not|not|never) (open|opening|unlock|unlocking|budge|work|working)\b|\b(still )?locked\b|\blocked out\b|\bcannot (get|go) (in|inside|through)\b|\bno access\b/,
    "DOOR_WONT_OPEN",
  ],
  [/\b(cannot|can not|could not|do not|did not) (find|see|locate)\b|\bwhere is (the |my )?(unit|apartment|apt|door|entrance|room|building)\b|\bwhich (door|way|entrance|building)\b/, "CANT_FIND_UNIT"],
  [/\b(lost|confused|trapped)\b|\bstuck\b(?! in traffic)|\bwhere (do|should|can) (i|we) go\b|\bwhere am i\b|\bwrong (door|way|turn|place|building|unit)\b|\bhow do (i|we) get (to|in|there|inside)\b/, "LOST"],
  [
    /^(i |we )?(really )?(need|want) (some )?help\b|\bhelp (me|us|please)\b|\bcan (you|someone|somebody|anyone) help\b|\b(need|want) (assistance|a hand)\b|\bemergency\b|\bsomething is wrong\b|\b(have|having|got|there is) (a |an |some )?(problem|issue|trouble)\b|^sos$/,
    "GENERAL",
  ],
  [/^(?:help)\b|\bhelp$/, "GENERAL"],
];

/**
 * Lost, stuck, or a door that will not open. The bare word help, or help
 * plus a clock, is not this. The catch-all pattern is the last HELP entry.
 */
export function isConcreteHelpProblem(raw: string): boolean {
  const t = stripFiller(normalize(raw));
  if (!t) return false;
  return HELP.slice(0, -1).some(([pattern]) => pattern.test(t));
}

/**
 * Presence at a stop during a running tour, confident enough to open the door.
 * A stuck or lost problem is help, not a door. A question that only mentions
 * the unit is not a door.
 */
export function isOnTourDoorAsk(raw: string, doors: StopRef[]): boolean {
  const t = stripFiller(normalize(raw));
  if (!t || !doors.length || isConcreteHelpProblem(raw)) return false;
  const asked = /\?\s*$/.test(raw.trim()) || QUESTION_START.test(t);
  const named = uniqueStops(doors.filter((door) => mentionsDoor(t, door)));
  const present = STRONG_PRESENCE.test(t) || PRESENCE.test(t);
  if (named.length === 1) {
    const bare = bareReference(t, named[0]!);
    if (asked && !OPEN.test(t) && !bare && !STRONG_PRESENCE.test(t)) return false;
    const confidence = bare ? 0.95 : present ? 0.9 : OPEN.test(t) ? 0.7 : 0.6;
    return confidence >= 0.85;
  }
  if (named.length > 1) return false;
  if (present && !asked && (GENERIC_UNIT.test(t) || GENERIC_DOOR.test(t))) return true;
  return PURE_HERE.test(t);
}

/** The door intent for a text isOnTourDoorAsk already accepted. */
export function onTourDoorIntent(raw: string, doors: StopRef[]): TourIntent | undefined {
  if (!isOnTourDoorAsk(raw, doors)) return undefined;
  const t = stripFiller(normalize(raw));
  const named = uniqueStops(doors.filter((door) => mentionsDoor(t, door)));
  if (named.length === 1) return stopIntent(named[0]!);
  if (GENERIC_UNIT.test(t) && !GENERIC_DOOR.test(t)) return { type: "AT_UNIT" };
  return { type: "AT_ROUTE_STOP" };
}

const QUESTION_START =
  /^(how|what|whats|is|are|does|do|did|can|could|would|will|where|when|which|who|why|any|anything|tell me|i was wondering|wondering|curious|i am curious|do you know|is there|are there|how about|what about)\b/;
const WANTS_TO_KNOW = /\b(want to know|like to know|wondering|curious|tell me about|info on|information (on|about)|details (on|about))\b/;
const TOPIC =
  /\b(parking|park|garage|laundry|washer|dryer|pets?|dogs?|cats?|gym|pool|rent|price|cost|deposit|utilities|wifi|internet|ac|heat|heating|bedrooms?|bathrooms?|beds?|baths?|sq ?ft|square feet|size|storage|elevator|floor|lease|available|availability|move in|amenities|appliances|dishwasher|balcony|view|furnished)\b/;

const PRESENCE = /\b(at|by|outside|in front of|infront of|near|next to|reached|made it|got to|arrived|standing|here|there|inside)\b/;
const STRONG_PRESENCE = /\b(i am|we are|i|we)\b.*\b(at|by|outside|in front of|near|next to|here|standing|reached|made it|got to|arrived)\b/;
const OPEN = /\b(open|unlock|let me in|let us in|buzz (me|us) in|access)\b/;
const GENERIC_UNIT = /\b(unit|apartment|apt|flat|condo|suite)\b/;
const GENERIC_DOOR = /\b(door|doors)\b/;
const ENTRANCE_WORDS = /\b(entrance|front door|main door|front entrance|main entrance|lobby door|building door|front gate|gate)\b/;

const PLACE = "(building|property|entrance|front|front door|main door|door|lobby|gate|complex|place|address|location|front entrance|main entrance|house|site)";
const VISIT = "(the|my|our) (tour|showing|appointment|viewing|visit)";
const ARRIVAL = new RegExp(
  `^(i think i am |i think we are |i am |we are |i have |we have |i |we )?(just |finally |now |already |also )*` +
    `(here|outside|out front|out here|downstairs|on site|onsite|arrived|got here|made it|made it here|pulled up|pulled in|showed up|parked|in the (lobby|parking lot|driveway)|` +
    `(outside|at|by|in front of|infront of|near) (the )?${PLACE}|here at the ${PLACE}|here for ${VISIT})` +
    `( here| now| already| outside| for ${VISIT})*$`,
);
/** "I'm here" with no place named: during a tour it means the next stop. */
const PURE_HERE = /^(i am |we are |i have |we have |i |we )?(just |finally |now )*(here|made it|made it here|arrived|got here)( now)?$/;
const NEAR_ARRIVAL =
  /\b(around (the )?(back|corner|side)|out back|in the back|at the back|at the side|nearby|close by|almost (there|here)|getting close|down the street|across the street|down the block|in the area|looking for parking|at the corner|pulling up|pulling in)\b/;
const EN_ROUTE = /\b(on (my|our|the) way|omw|running late|few (minutes|mins)|be there (soon|in)|heading (over|there)|in traffic|eta)\b/;

const FINISH = new RegExp(
  [
    String.raw`^(i am |we are |i think i am |i think we are |i think )?(all |pretty much |just )?(done|finished|through)( now| here| for (now|today))?( with (the |my |this |our )?(tour|showing|visit|viewing|it|everything|the place|the unit|the apartment))?$`,
    String.raw`^(finish|finish up|end|complete|wrap up|stop|done with)( the| my| this| our)? (tour|showing|visit)$`,
    String.raw`^(finish|finished|finish tour|end tour|that is it|that is all|that is everything|that is about it|leaving|i am leaving|we are leaving|heading out|i am heading out|we are heading out|all set|i am all set|we are all set|tour (is )?(done|over|finished|complete)|done touring|i have seen (it all|everything|enough)|seen everything|i have left|i left|i am out|im out|i am outside|done)$`,
  ].join("|"),
);
const WEAK_FINISH = /\b(done|finished|leaving|heading out|wrapping up|wrap up|all set)\b/;

const TOUR_NOUN = /\b(tour|showing|appointment|viewing|visit|booking|reservation)\b/;
const CANCEL_VERB = /\b(cancel|cancelling|canceled|cancelled|call off|called off)\b/;
const CANCEL_POLICY = /\b(cancellation policy|cancel(lation)? fees?)\b/;
const CANT_MAKE_IT =
  /\b(i |we )?(cannot|can not|will not|could not) make it\b|\b(i |we )?(cannot|can not|will not) (come|be there|attend)\b|\b(i |we )?(cannot|can not|will not) make (the |my |our )?(tour|showing|appointment|it)\b|\bwill not be able to make it\b/;
const WANT_CANCEL = /\b((i |we )?(need|have|want|would like) to cancel|please cancel)\b/;
const BARE_CANCEL = /^(please )?(cancel)( it)?( please)?$/;
/** "Actually cancel that" / "just call off this" — no tour noun required. */
const LOOSE_CANCEL = /^(actually |just )?(please )?(cancel|call off)( that| this| it| them)?( please)?$/;
const YES_CANCEL = /^(yes|yeah|yep|yup|sure|ok|okay) (please )?(cancel)( it)?$/;
/** "nevermind" / "actually never mind" — only when nothing is booked. Not a STOP keyword. */
const NEVERMIND = /^(actually |just )?(please )?(never mind|nevermind)( that| this| it)?( please)?$/;

/**
 * Natural-language cancel of a booked tour. Matches varied phrasing the way
 * YES/NO do — not one canned phrase. Cancellation-policy questions stay questions.
 */
export function isCancelTourAsk(raw: string): boolean {
  const t = stripFiller(normalize(raw));
  if (!t || CANCEL_POLICY.test(t) || /\b(do not|never) cancel\b/.test(t)) return false;
  if (BARE_CANCEL.test(t) || YES_CANCEL.test(t) || LOOSE_CANCEL.test(t)) return true;
  if (WANT_CANCEL.test(t) || CANT_MAKE_IT.test(t)) return true;
  return CANCEL_VERB.test(t) && TOUR_NOUN.test(t);
}

/**
 * Cancel phrasing while nothing is booked yet. Bare "cancel" stays the
 * carrier STOP keyword and is not this. Booked-tour cancel still uses
 * isCancelTourAsk only.
 */
export function isUnbookedCancelAsk(raw: string): boolean {
  if (keywordOf(raw) === "stop") return false;
  if (isCancelTourAsk(raw)) return true;
  return NEVERMIND.test(stripFiller(normalize(raw)));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mentionsUnit(t: string, unitName: string): boolean {
  const name = normalize(unitName);
  if (!name) return false;
  if (new RegExp(`\\b${esc(name)}\\b`).test(t)) return true;
  const digits = name.match(/\d+/)?.[0];
  // Short numbers ("1") are menu choices, so only longer ones stand in for a unit ("101").
  if (digits && digits.length >= 2 && new RegExp(`(^|[\\s#])${digits}\\b`).test(t)) return true;
  const suffix = name.replace(/^(unit|apt|apartment|suite)\s+/, "");
  if (suffix !== name && new RegExp(`\\b(unit|apt|apartment|suite|number|#)\\s*${esc(suffix)}\\b`).test(t)) return true;
  // "1A" and "Unit 1A" are the same label. A bare "1" stays a menu choice.
  const distinctive = /\d/.test(suffix) && (/[a-z]/.test(suffix) || suffix.length >= 2);
  return distinctive && suffix !== name && new RegExp(`\\b#?${esc(suffix)}\\b`).test(t);
}

function mentionsDoor(t: string, door: StopRef): boolean {
  if (door.unitName && mentionsUnit(t, door.unitName)) return true;
  const name = normalize(door.doorName);
  const short = name.replace(/\s+door$/, "");
  if (name && (new RegExp(`\\b${esc(name)}\\b`).test(t) || (short && new RegExp(`\\b${esc(short)}\\b`).test(t)))) return true;
  return door.kind === "ENTRANCE" && ENTRANCE_WORDS.test(t);
}

function uniqueStops(stops: StopRef[]): StopRef[] {
  const seen = new Set<string>();
  return stops.filter((s) => !seen.has(s.doorName) && seen.add(s.doorName));
}

const RESIDUAL_OK = new Set(
  (
    "i am we are at by the now just finally here outside in front of near next to standing right made it got reached arrived door unit apt apartment " +
    "suite number # please ok okay yeah so is this my our there sitting waiting to"
  ).split(" "),
);

/** True when, after removing the door reference, only "I'm at / by / outside" padding is left. */
function bareReference(t: string, stop: StopRef): boolean {
  let rest = t;
  for (const n of [stop.unitName, stop.doorName, stop.doorName.replace(/\s+door$/i, "")].filter(Boolean) as string[]) {
    rest = rest.replace(new RegExp(`\\b${esc(normalize(n))}\\b`, "g"), " ");
  }
  const digits = stop.unitName?.match(/\d+/)?.[0];
  if (digits) rest = rest.replace(new RegExp(`#?\\b${digits}\\b`, "g"), " ");
  if (stop.kind === "ENTRANCE") rest = rest.replace(new RegExp(ENTRANCE_WORDS.source, "g"), " ").replace(/\bentrance\b/g, " ");
  return rest.split(" ").every((w) => !w || RESIDUAL_OK.has(w));
}

const stopIntent = (s: StopRef): TourIntent => (s.unitName ? { type: "AT_UNIT", unitName: s.unitName } : { type: "AT_ROUTE_STOP", stopName: s.doorName });

/** Which menu option a reply points at: "2", "#2", "option two", "the first one", "2 works". */
function pickOption(t: string, count: number): { index: number; confidence: number } | undefined {
  const bare = t.match(/^(#|number |option |no |choice )?(\S+)$/);
  const n = bare ? numberWord(bare[2]!) : undefined;
  if (n !== undefined && n >= 1 && n <= count) return { index: n - 1, confidence: 1 };

  const ord = t.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last|latter|former|earlier|earliest|later|latest|sooner|soonest)\b/);
  if (ord) {
    const w = ord[1]!;
    const i = /^(last|latter|later|latest)$/.test(w) ? count - 1 : /^(former|earlier|earliest|sooner|soonest)$/.test(w) ? 0 : ordinalWord(w)! - 1;
    if (i >= 0 && i < count) return { index: i, confidence: 0.9 };
  }

  const words = t.split(" ");
  if (words.length > 6) return undefined;
  // "one" is usually a pronoun ("the blue one"); it's a number only after "unit", "option" and the like.
  const asNumber = (w: string, i: number) => (w === "one" && !/^(unit|option|number|choice|apt|apartment|#|no)$/.test(words[i - 1] ?? "") ? undefined : numberWord(w));
  const picks = [...new Set(words.map(asNumber).filter((x): x is number => x !== undefined))];
  if (picks.length === 1 && picks[0]! >= 1 && picks[0]! <= count) return { index: picks[0]! - 1, confidence: 0.9 };
  return undefined;
}

/** "2pm", "2:00", "3:30 pm", "at 2", "the 2 o'clock" -> an offered label ("2:00 PM"). */
function pickTimeLabel(t: string, labels: string[]): { label?: string; mentioned: boolean } {
  const re = /(\bat |\baround |\bfor )?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p|o'?clock|oclock)?\b/g;
  const found = new Set<string>();
  let mentioned = false;
  for (const m of t.matchAll(re)) {
    const [, lead, h, min, suffix] = m;
    if (!min && !suffix && !lead) continue;
    mentioned = true;
    const hour = Number(h);
    const minute = min ?? "00";
    const ampm = suffix && /^[ap]/.test(suffix) ? suffix[0] : undefined;
    for (const label of labels) {
      const lm = label.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
      if (!lm || Number(lm[1]) !== hour || lm[2] !== minute) continue;
      if (ampm && lm[3]!.toLowerCase()[0] !== ampm) continue;
      found.add(label);
    }
  }
  return { label: found.size === 1 ? [...found][0] : undefined, mentioned };
}

function clockIntent(spoken: SpokenTime): TourIntent {
  return {
    type: "REQUEST_CUSTOM_TIME",
    hour: spoken.hour,
    minute: spoken.minute,
    ...(spoken.meridiem ? { meridiem: spoken.meridiem } : {}),
    ...(spoken.day ? { day: spoken.day } : {}),
    ...(spoken.weekday ? { weekday: spoken.weekday } : {}),
    ...(spoken.nextWeek ? { nextWeek: true } : {}),
    ...(spoken.date ? { date: spoken.date } : {}),
  };
}

/**
 * A specific time the visitor asked for. A property question in the same
 * text stays a question and carries the clock aside, so the time isn't dropped
 * and isn't booked until they confirm it.
 */
function schedulingIntent(
  raw: string,
  t: string,
  allowBareClock: boolean,
  result: (intent: TourIntent, confidence: number, extra?: Partial<IntentInterpretation>) => IntentInterpretation,
  unknown: (extra?: Partial<IntentInterpretation>) => IntentInterpretation,
  today?: InterpretContext["today"],
): IntentInterpretation | undefined {
  const times = spokenTimes(t, today);
  if (times.length > 1) return unknown({ clarificationNeeded: true, clarificationQuestion: "Which time did you mean?" });
  const spoken = times[0];
  if (spoken && (TOPIC.test(t) || WANTS_TO_KNOW.test(t))) {
    return result({ type: "ASK_PROPERTY_QUESTION", question: raw.trim().slice(0, 300) }, 0.9, {
      mentionedTime: {
        hour: spoken.hour,
        minute: spoken.minute,
        ...(spoken.meridiem ? { meridiem: spoken.meridiem } : {}),
        ...(spoken.day ? { day: spoken.day } : {}),
        ...(spoken.weekday ? { weekday: spoken.weekday } : {}),
        ...(spoken.nextWeek ? { nextWeek: true } : {}),
        ...(spoken.date ? { date: spoken.date } : {}),
      },
    });
  }
  const asking = /\b(can i|could i|can we|could we|how about|what about|instead|move|change|reschedule|switch|come at|tour at|book|make it)\b/.test(t);
  if (spoken && (allowBareClock || asking)) return result(clockIntent(spoken), 0.9);
  if (!spoken && vagueTimeRequest(t)) return unknown({ clarificationNeeded: true, clarificationQuestion: "What time would you like?" });
  return undefined;
}

function dateIntent(
  raw: string,
  t: string,
  result: (intent: TourIntent, confidence: number, extra?: Partial<IntentInterpretation>) => IntentInterpretation,
  today?: InterpretContext["today"],
): IntentInterpretation | undefined {
  // "when can I tour?" names no day. Leave it as a property question so saved hours can answer it.
  if (isGeneralTourHoursQuestion(raw)) return undefined;
  const asked = dayReference(t, today);
  if (!asked) return undefined;
  // "available" names a day in a booking, not a missing property fact.
  const aside = t.replace(/\b(available|availability)\b/g, " ");
  if (asked !== "menu" && !asked.unclear && (TOPIC.test(aside) || WANTS_TO_KNOW.test(t))) {
    return result({ type: "ASK_PROPERTY_QUESTION", question: raw.trim().slice(0, 300) }, 0.9, { mentionedDate: asked });
  }
  if (asked === "menu") return result({ type: "SELECT_DATE" }, 0.9);
  return result(
    {
      type: "SELECT_DATE",
      ...(asked.weekday ? { weekday: asked.weekday } : {}),
      ...(asked.relative ? { relative: asked.relative } : {}),
      ...(asked.nextWeek ? { nextWeek: true } : {}),
      ...(asked.date ? { date: asked.date } : {}),
      ...(asked.unclear ? { unclear: true } : {}),
    },
    0.9,
  );
}

/** Longer names first so "monday" wins over "mon" and "thursday" wins over "thu". */
function dayMenuWeekday(): RegExp {
  return /\b(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|thurs|thur|tues|mon|tue|wed|thu|fri|sat|sun)\b/g;
}

/**
 * A weekday message is a day pick unless it is a question about something
 * else (parking, pets, a sale). Availability phrasing opens that day even
 * when the extra words are not a fixed list.
 */
const NON_SCHEDULING_TOPIC =
  /\b(parking|park|garage|laundry|washer|dryer|pets?|dogs?|cats?|gym|pool|rent|price|cost|deposit|utilities|wifi|internet|ac|heat|heating|bedrooms?|bathrooms?|beds?|baths?|sq ?ft|square feet|size|storage|elevator|floor|lease|move in|amenities|appliances|dishwasher|balcony|view|furnished|sale|nearby|busy)\b/;

const SCHEDULING_ASK =
  /\b(open|opens|opening|openings|free|available|availability|full|slots?|spots?|come|coming|tour|tours|visit|visits|showing|work|works|afternoon|morning|evening|possible|possibility|chance|doable|fit|option|options|happen|swing|hoping|trying|looking|window|good|book|booked)\b|\bget in\b|\ba go\b|\banything left\b/;

/** Words that can sit beside a day without turning it into another topic. */
const FUNCTION_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "at",
  "can",
  "could",
  "do",
  "for",
  "how",
  "i",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "ok",
  "okay",
  "please",
  "the",
  "this",
  "to",
  "we",
  "what",
  "would",
  "yeah",
  "yep",
  "yes",
  "you",
  "your",
  "yup",
  "just",
  "maybe",
  "uh",
  "um",
  "hmm",
  "next",
]);

const WEEKDAY_TOKEN: Record<string, "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT"> = {
  sunday: "SUN",
  sun: "SUN",
  monday: "MON",
  mon: "MON",
  tuesday: "TUE",
  tues: "TUE",
  tue: "TUE",
  wednesday: "WED",
  wed: "WED",
  thursday: "THU",
  thurs: "THU",
  thur: "THU",
  thu: "THU",
  friday: "FRI",
  fri: "FRI",
  saturday: "SAT",
  sat: "SAT",
};

/** A clock, month, ordinal, or number beside a weekday ("Friday at 2", "Fri 3:30", "Friday Oct 2", "the 2nd"). */
function stripScheduleTokens(t: string): string {
  const clock =
    /(?:^|\s)(?:(?:at|around|about|for|by)\s+)?(?<!\d)\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a m|p m|o'?clock|oclock))?(?!\d)(?=\s|$)/g;
  const month =
    /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/g;
  const ordinal = /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\b/g;
  return t.replace(dayMenuWeekday(), " ").replace(clock, " ").replace(month, " ").replace(ordinal, " ").replace(/\b\d{1,4}\b/g, " ");
}

function dayPickRest(t: string): string[] {
  return stripScheduleTokens(t).split(/\s+/).filter(Boolean);
}

/**
 * At the day menu, a weekday inside a non-scheduling question stays a
 * question. "Black Friday sale nearby?", "is Friday busy?", and "what about
 * Sunday parking?" are questions. Availability phrasing and a bare day are
 * still that day. A clock on the day ("Friday at 2") is handled before this.
 */
function questionInsteadOfDayPick(raw: string, t: string, today?: InterpretContext["today"]): boolean {
  const asked = dayReference(t, today);
  if (!asked || asked === "menu" || asked.unclear || asked.date || asked.relative || !asked.weekday) return false;
  if (NON_SCHEDULING_TOPIC.test(t)) return true;
  if (SCHEDULING_ASK.test(t) || /\b(can|could)\s+(i|we)\b/.test(t)) return false;
  if (dayPickRest(t).every((word) => FUNCTION_WORDS.has(word))) return false;
  const question = /\?\s*$/.test(raw.trim()) || QUESTION_START.test(t) || WANTS_TO_KNOW.test(t);
  if (question) return true;
  return false;
}

/** A weekday plus availability language that the short day parser did not already accept. */
/**
 * "What times do you have?", "any openings Tuesday?": the open tour times. Not a unit's availability to
 * move in, and not a change to a booked tour.
 */
export function isOpenTimesAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(move[- ]?in|lease|rent|change|move|reschedule|switch|push)\b/.test(t)) return false;
  if (/\bany\s+(openings?|availability)\b/.test(t)) return true;
  return /\b(times?|slots?|openings?)\b/.test(t) && /\b(what|which|any|available|open|free|have|got|left|other)\b/.test(t);
}

/**
 * A booked visitor asking to move their tour without naming a clock time: "can I change the time?",
 * "can we do Thursday instead?". A named time keeps going through the custom-time rules.
 */
export function isRescheduleAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b|\b\d{1,2}:\d{2}\b|\bnoon\b/.test(t)) return false;
  if (/\b(change|move|reschedule|switch|push|bump)\b/.test(t) && /\b(time|tour|appointment|booking|it|day|date|showing)\b/.test(t)) return true;
  if (/\b(different|another|other|new)\s+(time|day|date)\b/.test(t)) return true;
  return /\binstead\b/.test(t) && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|day|time)\b/.test(t);
}

/** "When is my tour?", "what time is my tour again?". */
export function isMyTourAsk(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(when|what time|what day)\b[^.?!]*\bmy (tour|appointment|showing|visit|booking)\b/.test(t) || /\bmy (tour|appointment) (time|details|info)\b/.test(t);
}

/** "Where is it?", "what's the address?", "how do I get there?". Not "where is unit 1A" on a tour. */
export function isDirectionsAsk(text: string): boolean {
  const t = text.toLowerCase().replace(/['\u2019]/g, "");
  return (
    /\bwhat(s| is) the (address|location)\b|\bwhere (is it|is the (property|place|house|building)|are you located|is this)\b|\b(directions|how do i get there|how to get there)\b/.test(t) ||
    /^\s*(address|location)\s*\??\s*$/.test(t)
  );
}

/** The weekday an open-times ask names, if any. */
function openTimesDay(t: string): { weekday?: "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" } {
  const named = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|thurs|thur|tues|mon|tue|wed|thu|fri|sat|sun)\b/.exec(t);
  const day = named ? WEEKDAY_TOKEN[named[1]!] : undefined;
  return day ? { weekday: day } : {};
}

function availabilityDayPick(t: string): TourIntent | undefined {
  if (NON_SCHEDULING_TOPIC.test(t)) return undefined;
  if (!SCHEDULING_ASK.test(t) && !/\b(can|could)\s+(i|we)\b/.test(t)) return undefined;
  const named = /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|thurs|thur|tues|mon|tue|wed|thu|fri|sat|sun)\b/.exec(t);
  if (!named) return undefined;
  const day = WEEKDAY_TOKEN[named[2]!];
  if (!day) return undefined;
  return { type: "SELECT_DATE", weekday: day, ...(named[1] ? { nextWeek: true } : {}) };
}

function answerScheduling(
  awaiting: Extract<StepAwaiting, { kind: "confirm-custom-time" | "confirm-alternative" }>,
  t: string,
  result: (intent: TourIntent, confidence: number, extra?: Partial<IntentInterpretation>) => IntentInterpretation,
  today?: InterpretContext["today"],
): IntentInterpretation | undefined {
  const namedClock = spokenTimes(t, today);
  const clock = namedClock.length === 1 ? namedClock[0] : undefined;
  if (awaiting.kind === "confirm-alternative") {
    const yn = yesNo(t);
    if (yn.answer === "yes" && yn.confidence >= 0.75) return result({ type: "ACCEPT_PROPOSED_TIME" }, yn.confidence);
    if (yn.answer === "no" && yn.confidence >= 0.75) return clock ? result(clockIntent(clock), yn.confidence) : result({ type: "DECLINE_PROPOSED_TIME" }, yn.confidence);
    return undefined;
  }
  const meridiemWord = /^(am|pm|a m|p m)$/.exec(t)?.[1];
  if (meridiemWord) return result(clockIntent({ hour: awaiting.hour, minute: awaiting.minute, meridiem: meridiemWord.startsWith("a") ? "AM" : "PM", ...(awaiting.day ? { day: awaiting.day } : {}) }), 0.95);
  const yn = yesNo(t);
  if (yn.answer === "no" && yn.confidence >= 0.75) {
    if (clock) return result(clockIntent(clock), 0.9);
    return result({ type: "UNKNOWN" }, 0, { clarificationNeeded: true, clarificationQuestion: "No problem." });
  }
  if (yn.answer === "yes" && yn.confidence >= 0.75 && awaiting.meridiem) return result(clockIntent(awaiting), yn.confidence);
  if (yn.answer === "yes" && !awaiting.meridiem) {
    const label = `${awaiting.hour}:${String(awaiting.minute).padStart(2, "0")}`;
    return result({ type: "UNKNOWN" }, 0, { clarificationNeeded: true, clarificationQuestion: `Did you mean ${label} AM or ${label} PM?` });
  }
  return undefined;
}

const BEDROOMS = /\b(studio)\b|\b(one|two|three|four|1|2|3|4)\s*(bed|beds|bedroom|bedrooms|br|bd)\b/;

function bedroomCount(text: string): number | undefined {
  const m = normalize(text).match(BEDROOMS);
  if (!m) return undefined;
  return m[1] ? 0 : numberWord(m[2]!);
}

/** Help, doors, cancel, and a menu answer win. A fair-housing question is only the leftover free text. */
const OPERATION_WINS = new Set<IntentType>([
  "REQUEST_HELP",
  "STOP_MESSAGES",
  "START_MESSAGES",
  "ARRIVAL",
  "AT_UNIT",
  "AT_ROUTE_STOP",
  "CONFIRM_CANCEL_TOUR",
  "KEEP_TOUR",
  "CANCEL_TOUR",
  "FINISH_TOUR",
  "ASK_MORE_TIME",
  "FOLLOW_UP_YES",
  "FOLLOW_UP_NO",
  "CONSENT_YES",
  "CONSENT_NO",
  "SELECT_UNIT",
  "ACCEPT_PROPOSED_TIME",
  "DECLINE_PROPOSED_TIME",
  "START_INQUIRY",
]);

function holdFairHousingLast(ctx: InterpretContext, found: IntentInterpretation): IntentInterpretation {
  const raw = ctx.message ?? "";
  if (!isFairHousingQuestion(raw)) return found;
  // Menus, help, injury, doors, stop, and cancel already won. Fair housing is only the leftover.
  const earlier = firstInboundMatch({
    text: raw,
    touring: ctx.step === "touring" || !!ctx.hasRunningTour,
    doors: ctx.step === "touring" ? ctx.doors : [],
    menuAnswer: isSchedulingMenuAnswer(ctx.step, found.intent.type),
  });
  if (earlier && earlier !== "fair-housing") return found;
  const type = found.intent.type;
  if (OPERATION_WINS.has(type)) return found;
  if ((type === "SELECT_DATE" || type === "SELECT_TIME" || type === "REQUEST_CUSTOM_TIME") && !suitabilityBlocksBooking(raw)) return found;
  if (type === "ASK_PROPERTY_QUESTION") return found;
  const question = raw.trim().slice(0, 300);
  if (!question) return found;
  return {
    intent: { type: "ASK_PROPERTY_QUESTION", question },
    confidence: 0.95,
    interpreter: "rules",
    clarificationNeeded: false,
  };
}

export function interpretByRules(ctx: InterpretContext): IntentInterpretation {
  return holdFairHousingLast(ctx, readByRules(ctx));
}

function readByRules(ctx: InterpretContext): IntentInterpretation {
  const raw = ctx.message ?? "";
  const full = normalize(raw);
  const t = stripFiller(full);
  const result = (intent: TourIntent, confidence: number, extra: Partial<IntentInterpretation> = {}): IntentInterpretation => ({
    intent,
    confidence,
    interpreter: "rules",
    clarificationNeeded: false,
    ...extra,
  });
  const unknown = (extra: Partial<IntentInterpretation> = {}) => result({ type: "UNKNOWN" }, 0, extra);
  if (!t) return unknown();

  const keyword = keywordOf(raw);
  // Bare "cancel" is a carrier opt-out keyword, but with a booked tour it means cancel the tour.
  if (keyword === "stop") {
    if ((ctx.hasCancelableTour || ctx.hasRunningTour) && isCancelTourAsk(raw) && normalize(raw) === "cancel") {
      return result({ type: "CANCEL_TOUR" }, 1);
    }
    return result({ type: "STOP_MESSAGES" }, 1);
  }
  if (keyword === "start") return result({ type: "START_MESSAGES" }, 1);
  if (keyword === "help") return result({ type: "REQUEST_HELP", problem: "GENERAL" }, 1);
  if (isPlainLanguageStop(raw)) return result({ type: "STOP_MESSAGES" }, 0.95);
  if (MANIPULATION.test(t)) return unknown({ manipulation: true, clarificationNeeded: true });
  if (isMedicalEmergency(raw)) return result({ type: "REQUEST_HELP", problem: "GENERAL" }, 0.95);

  if (ctx.awaiting?.kind === "confirm-cancel-tour") {
    // "yes cancel, family emergency": cancel is a negation, and emergency is a help word.
    if (/^(yes|yeah|yep|yup|sure|ok|okay)\b/.test(t) && /\bcancel\b/.test(t) && !/\b(?:do not|never)\b/.test(t)) {
      return result({ type: "CONFIRM_CANCEL_TOUR" }, 0.95);
    }
    const yn = yesNo(t);
    if (yn.answer === "no" && yn.confidence >= 0.75) return result({ type: "KEEP_TOUR" }, yn.confidence);
    if (yn.answer === "yes" && yn.confidence >= 0.75) return result({ type: "CONFIRM_CANCEL_TOUR" }, yn.confidence);
    if (isCancelTourAsk(raw)) return result({ type: "CONFIRM_CANCEL_TOUR" }, 0.95);
  }
  if ((ctx.hasCancelableTour || ctx.hasRunningTour) && isCancelTourAsk(raw)) return result({ type: "CANCEL_TOUR" }, 0.95);
  if (isMyTourAsk(t)) return result({ type: "ASK_MY_TOUR" }, 0.9);
  if (!ctx.hasRunningTour && isDirectionsAsk(t)) return result({ type: "ASK_DIRECTIONS" }, 0.9);
  if (ctx.hasCancelableTour && isRescheduleAsk(t)) return result({ type: "RESCHEDULE_TOUR", ...openTimesDay(t) }, 0.9);
  // On the day and time menus the day-pick rules already list times; a general hours ask keeps the saved-hours reply.
  if (ctx.step !== "choose-date" && ctx.step !== "choose-time" && !isGeneralTourHoursQuestion(raw) && isOpenTimesAsk(t)) {
    return result({ type: "ASK_OPEN_TIMES", ...openTimesDay(t) }, 0.9);
  }

  if (ctx.awaiting?.kind === "confirm-custom-time" || ctx.awaiting?.kind === "confirm-alternative") {
    const answered = answerScheduling(ctx.awaiting, t, result, ctx.today);
    if (answered) return answered;
  }

  const asked = /\?\s*$/.test(raw.trim()) || QUESTION_START.test(t);
  const question = (confidence: number) => result({ type: "ASK_PROPERTY_QUESTION", question: raw.trim().slice(0, 300) }, confidence);
  const help = (): IntentInterpretation | undefined => {
    for (const [re, problem] of HELP) if (re.test(t)) return result({ type: "REQUEST_HELP", problem }, 0.9);
    return undefined;
  };
  const informational = () => {
    if (isTourPartyNote(raw)) return unknown();
    return asked ? question(0.9) : WANTS_TO_KNOW.test(t) ? question(0.8) : t.split(" ").length <= 3 && TOPIC.test(t) ? question(0.7) : undefined;
  };
  // Asking about a detail ("How much is Unit 1A?", "Does 1A have laundry?") isn't choosing it.
  const detailQuestion = asked && (TOPIC.test(t) || /\bhow (much|many|big)\b/.test(t));

  switch (ctx.step) {
    case "choose-unit": {
      if (detailQuestion) return question(0.9);
      const named = ctx.units.filter((u) => mentionsUnit(t, u.name));
      if (named.length === 1) return result({ type: "SELECT_UNIT", unitName: named[0]!.name }, 0.95);
      if (named.length > 1) return unknown({ clarificationNeeded: true });
      const beds = bedroomCount(t);
      if (beds !== undefined) {
        const fits = ctx.units.filter((u) => u.summary && bedroomCount(u.summary) === beds);
        if (fits.length === 1) return result({ type: "SELECT_UNIT", unitName: fits[0]!.name }, 0.85);
      }
      const pick = pickOption(t, ctx.units.length);
      if (pick) return result({ type: "SELECT_UNIT", unitName: ctx.units[pick.index]!.name }, pick.confidence);
      const customUnit = schedulingIntent(raw, t, true, result, unknown, ctx.today);
      if (customUnit) return customUnit;
      const dateUnit = dateIntent(raw, t, result, ctx.today);
      if (dateUnit) return dateUnit;
      const h = help();
      if (h) return h;
      const info = informational();
      if (info) return info;
      // Same restart words as the day/time steps. "Tour" is not a unit name.
      if (wantsToStartBooking(full, t)) return result({ type: "START_INQUIRY" }, 0.9);
      if (GENERIC_UNIT.test(t) || /\b(any|either|whichever)\b/.test(t)) {
        return ctx.units.length === 1 ? result({ type: "SELECT_UNIT", unitName: ctx.units[0]!.name }, 0.9) : unknown({ clarificationNeeded: true });
      }
      return unknown();
    }

    case "choose-date": {
      if (ctx.awaiting?.kind === "accept-next-opening" && acceptsNextOpening(t) && !namesTourDay(t, ctx.today)) {
        return result({ type: "SELECT_DATE" }, 0.95);
      }
      const labels = ctx.timeChoices;
      const bare = t.match(/^(#|number |option |no |choice )?(\S+)$/);
      const bareN = bare ? numberWord(bare[2]!) : undefined;
      if (bareN !== undefined && bareN >= 1 && bareN <= Math.max(labels.length, 1) && labels.length) {
        return result({ type: "SELECT_DATE" }, 1, {});
      }
      const customDate = schedulingIntent(raw, t, true, result, unknown, ctx.today);
      if (customDate) return customDate;
      // A weekday inside a question, or in a message that is not a day pick, is not that day.
      if (questionInsteadOfDayPick(raw, t, ctx.today)) return isTourPartyNote(raw) ? unknown() : question(0.9);
      const picked = dateIntent(raw, t, result, ctx.today);
      if (picked) return picked;
      const availability = availabilityDayPick(t);
      if (availability) return result(availability, 0.9);
      const h = help();
      if (h) return h;
      const info = informational();
      if (info) return info;
      if (wantsToStartBooking(full, t)) return result({ type: "START_INQUIRY" }, 0.9);
      return unknown();
    }

    case "choose-time": {
      const labels = ctx.timeChoices;
      const bare = t.match(/^(#|number |option |no |choice )?(\S+)$/);
      const bareN = bare ? numberWord(bare[2]!) : undefined;
      if (bareN !== undefined && bareN >= 1 && bareN <= labels.length) return result({ type: "SELECT_TIME", timeLabel: labels[bareN - 1]! }, 1);
      const time = pickTimeLabel(t, labels);
      if (time.label) return result({ type: "SELECT_TIME", timeLabel: time.label }, 0.95);
      const customTime = schedulingIntent(raw, t, true, result, unknown, ctx.today);
      if (customTime) return customTime;
      const anotherDay = dateIntent(raw, t, result, ctx.today);
      if (anotherDay) return anotherDay;
      // "Does 1A have laundry?" names a unit, not 1 AM.
      if (asked && !time.label && (detailQuestion || ctx.units.some((u) => namesUnitLoosely(t, u.name)))) return question(0.9);
      if (time.mentioned) return unknown({ clarificationNeeded: true, clarificationQuestion: "That time isn't open." });
      const pick = pickOption(t, labels.length);
      if (pick) return result({ type: "SELECT_TIME", timeLabel: labels[pick.index]! }, pick.confidence);
      if (/\b(asap|as soon as possible|first available|earliest|soonest)\b/.test(t) && labels.length) return result({ type: "SELECT_TIME", timeLabel: labels[0]! }, 0.9);
      if (labels.length === 1 && yesNo(t).answer === "yes") return result({ type: "SELECT_TIME", timeLabel: labels[0]! }, 0.9);
      const h = help();
      if (h) return h;
      const info = informational();
      if (info) return info;
      if (wantsToStartBooking(full, t)) return result({ type: "START_INQUIRY" }, 0.9);
      return unknown(/\b(any|either|whichever|whenever|does not matter)\b/.test(t) ? { clarificationNeeded: true } : {});
    }

    case "consent": {
      const customConsent = schedulingIntent(raw, t, false, result, unknown, ctx.today);
      if (customConsent?.intent.type === "REQUEST_CUSTOM_TIME" || customConsent?.mentionedTime) return customConsent;
      const yn = yesNo(t);
      if (yn.answer === "yes") return result({ type: "CONSENT_YES" }, yn.confidence);
      // "I'm good" could mean "fine by me" or "no thanks"; saying no ends the booking, so it has to be clear.
      if (yn.answer === "no") return result({ type: "CONSENT_NO" }, yn.soft ? 0.5 : yn.confidence);
      return help() ?? informational() ?? unknown();
    }

    case "follow-up": {
      const customFollow = schedulingIntent(raw, t, false, result, unknown, ctx.today);
      if (customFollow) return customFollow;
      const yn = yesNo(t);
      if (yn.answer === "yes") return result({ type: "FOLLOW_UP_YES" }, yn.confidence);
      if (yn.answer === "no") return result({ type: "FOLLOW_UP_NO" }, yn.confidence);
      return help() ?? informational() ?? unknown();
    }

    case "identity": {
      // "Where's the form?" is about the identity form (Tour Core resends the link), not about the property.
      const customIdentity = schedulingIntent(raw, t, false, result, unknown, ctx.today);
      if (customIdentity) return customIdentity;
      if (FORM_WORDS.test(t)) return help() ?? unknown();
      return help() ?? clearQuestion() ?? unknown();
    }

    case "ready":
    case "touring":
      return interpretOnTour(ctx, t, asked, { result, unknown, question, help, informational });

    default: {
      const customOpen = schedulingIntent(raw, t, true, result, unknown, ctx.today);
      if (customOpen) return customOpen;
      const openDate = dateIntent(raw, t, result, ctx.today);
      if (openDate) return openDate;
      return help() ?? clearQuestion() ?? unknown();
    }
  }

  /** Where nothing else is expected, only an unmistakable question counts: a bare "anything" or "ok?" isn't one. */
  function clearQuestion(): IntentInterpretation | undefined {
    if (isTourPartyNote(raw)) return unknown();
    const words = t.split(" ").length;
    if ((asked && words >= 2) || WANTS_TO_KNOW.test(t) || (words <= 3 && TOPIC.test(t))) return question(0.85);
    return undefined;
  }
}

const START_BOOKING =
  /^(hi|hello|hey|hiya|howdy|yo|tour|book( a tour)?|start over|new tour|hi there|hello there|good (morning|afternoon|evening))$/;

function wantsToStartBooking(full: string, stripped: string): boolean {
  return START_BOOKING.test(full) || START_BOOKING.test(stripped);
}

const FORM_WORDS = /\b(form|link|verif\w*|identity|id check|my id)\b/;

/** A unit label written on its own ("1a", "2b", "101"), not just "unit 1A". Used only to tell a question from a time. */
function namesUnitLoosely(t: string, unitName: string): boolean {
  if (mentionsUnit(t, unitName)) return true;
  const label = normalize(unitName).replace(/^(unit|apt|apartment|suite)\s+/, "");
  return /\d/.test(label) && (/[a-z]/.test(label) || label.length >= 2) && new RegExp(`(^|\\s|#)${esc(label)}(\\s|$)`).test(t);
}

interface Helpers {
  result: (intent: TourIntent, confidence: number, extra?: Partial<IntentInterpretation>) => IntentInterpretation;
  unknown: (extra?: Partial<IntentInterpretation>) => IntentInterpretation;
  question: (confidence: number) => IntentInterpretation;
  help: () => IntentInterpretation | undefined;
  informational: () => IntentInterpretation | undefined;
}

function answerToAwaiting(awaiting: StepAwaiting, t: string, { result, unknown }: Helpers): IntentInterpretation | undefined {
  if (awaiting.kind === "t15-questions" || awaiting.kind === "t5-extension-offer" || awaiting.kind === "t5-no-offer") {
    return undefined;
  }
  if (awaiting.kind === "choose-stop") {
    const pick = pickOption(t, awaiting.stops.length);
    return pick ? result(stopIntent(awaiting.stops[pick.index]!), 0.95) : undefined;
  }
  const yn = yesNo(t);
  if (!yn.answer || yn.confidence < 0.75) return undefined;
  if (yn.answer === "no") {
    const followUp =
      awaiting.kind === "confirm-arrival" ? "No problem. Text me when you're at the property." : awaiting.kind === "confirm-stop" ? "No problem. Text me when you get there." : "No rush. Take your time.";
    return unknown({ clarificationNeeded: true, clarificationQuestion: followUp });
  }
  switch (awaiting.kind) {
    case "confirm-arrival":
      return result({ type: "ARRIVAL" }, 0.95);
    case "confirm-stop":
      return result(stopIntent(awaiting.stop), 0.95);
    case "confirm-finish":
      return result({ type: "FINISH_TOUR" }, 0.95);
  }
}

function interpretOnTour(ctx: InterpretContext, t: string, asked: boolean, h: Helpers): IntentInterpretation {
  const { result, unknown, question, help, informational } = h;
  const touring = ctx.step === "touring";
  // Already booked: "I'm here at 1:58" is arrival, not a new custom-time ask.
  if (ctx.step === "ready" && /^(i am |we are |i |we )?(just |finally |now )*here(\s+at\b|\s*$)/.test(t)) {
    return result({ type: "ARRIVAL" }, 0.95);
  }
  const custom = schedulingIntent(ctx.message, t, false, result, unknown, ctx.today);
  if (custom) return custom;

  if (ctx.awaiting) {
    const answered = answerToAwaiting(ctx.awaiting, t, h);
    if (answered) return answered;
  }

  const helpful = help();
  if (helpful) return helpful;

  if (touring && FINISH.test(t)) return result({ type: "FINISH_TOUR" }, 0.95);
  if (touring && isMoreTimeAsk(t)) return result({ type: "ASK_MORE_TIME" }, 0.95);

  const named = uniqueStops(ctx.doors.filter((d) => mentionsDoor(t, d)));
  const opening = OPEN.test(t);
  const present = STRONG_PRESENCE.test(t) || PRESENCE.test(t);
  if (named.length) {
    const bare = named.length === 1 && bareReference(t, named[0]!);
    if (asked && !opening && !bare && !STRONG_PRESENCE.test(t)) return isTourPartyNote(ctx.message) ? unknown() : question(0.9);
    if (named.length > 1) return result({ type: "AT_ROUTE_STOP" }, 0.4, { clarificationNeeded: true });
    const stop = named[0]!;
    // Being at a door is what opens it; asking for a door to open without saying you're there gets a check first.
    const confidence = bare ? 0.95 : present ? 0.9 : opening ? 0.7 : 0.6;
    return result(stopIntent(stop), confidence);
  }

  if (present && !asked && (GENERIC_UNIT.test(t) || GENERIC_DOOR.test(t))) {
    // Before the tour starts, "I'm at the apartment" means at the property: arrival always asks for the first stop, never a unit door.
    if (!touring) return result({ type: "ARRIVAL" }, 0.9);
    return result(GENERIC_UNIT.test(t) ? { type: "AT_UNIT" } : { type: "AT_ROUTE_STOP" }, 0.9);
  }

  if (ARRIVAL.test(t)) {
    if (touring && PURE_HERE.test(t)) return result({ type: "AT_ROUTE_STOP" }, 0.9);
    return result({ type: "ARRIVAL" }, 0.95);
  }

  if (touring && WEAK_FINISH.test(t) && !asked) return result({ type: "FINISH_TOUR" }, 0.6);

  const info = informational();
  if (info) return info;

  if (!touring) {
    if (EN_ROUTE.test(t)) return unknown({ clarificationNeeded: true, clarificationQuestion: "No rush! Text me when you're at the property." });
    if (NEAR_ARRIVAL.test(t) || opening) return result({ type: "ARRIVAL" }, 0.6);
  } else if (opening) {
    return result({ type: "AT_ROUTE_STOP" }, 0.6);
  }

  return unknown();
}

export class RuleBasedIntentInterpreter implements IntentInterpreter {
  readonly description = "rules";
  async interpret(context: InterpretContext): Promise<IntentInterpretation> {
    return interpretByRules(context);
  }
}
