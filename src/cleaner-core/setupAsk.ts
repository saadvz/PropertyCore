/**
 * What each setup step still needs, for Grok to ask in its own words. Cleaner Core names the fields,
 * the allowed answers, and the defaults. Setup starts with a draft: Grok fills in what it already
 * knows, shows the host one summary with the gaps marked "needs you", and the host corrects it once.
 * Whatever is still missing after that is asked one short question at a time, with options as a
 * choice card. Nothing here is sent to anyone.
 */

import { askNext, type AskOption, type AskQuestion } from "../hub/ask";

export { askNext, type AskOption, type AskQuestion };

export interface SetupAsk {
  step: "start" | "property" | "sources" | "people" | "schedule" | "door-code" | "preferences" | "payments" | "supplies" | "times";
  tool: string;
  questions: AskQuestion[];
}

export const START_ASK: SetupAsk = {
  step: "start",
  tool: "get_state",
  questions: [
    {
      field: "choice",
      ask: "what the host wants help with",
      required: true,
      options: [
        { value: "tours", label: "Letting renters tour a unit on their own" },
        { value: "cleaners", label: "Scheduling cleaners between guest stays" },
      ],
      how: "Call get_state again with choice set to the option's value.",
    },
  ],
};

/** The property step. Once the address is saved, only the missing usual times are asked. */
export function propertyAsk(saved: { address: boolean; checkoutTime: boolean; checkInTime: boolean }): SetupAsk {
  const questions: AskQuestion[] = [];
  if (!saved.address) {
    questions.push(
      { field: "address", ask: "the property's street address", required: true },
      { field: "business", ask: "what to call the business in texts", required: true },
      { field: "timeZone", ask: "the property's time zone", required: true, how: "Work it out from the address. Ask only if it's unclear." },
    );
  }
  // save_property takes the whole property, so a later save passes the saved fields again.
  const how = saved.address ? "Call save_property with the saved business, address, and time zone, plus the times." : undefined;
  if (!saved.checkoutTime) questions.push({ field: "checkoutTime", ask: "the usual checkout time", required: true, example: "10:00 AM", ...(how ? { how } : {}) });
  if (!saved.checkInTime) questions.push({ field: "checkInTime", ask: "the usual check-in time", required: true, example: "4:00 PM", ...(how ? { how } : {}) });
  return { step: "property", tool: "save_property", questions };
}

export function sourcesAsk(property: string): SetupAsk {
  return {
    step: "sources",
    tool: "save_sources",
    questions: [
      {
        field: "source",
        ask: "where the bookings come from",
        required: true,
        multiple: true,
        options: [
          { value: "guesty", label: "Guesty Lite" },
          { value: "google", label: "Google Calendar" },
          { value: "other", label: "Another calendar link (Airbnb, Vrbo, or other)" },
        ],
      },
      {
        field: "calendars",
        ask: "the calendar's export link",
        required: true,
        when: "source is guesty or other",
        how: 'Collect the link on your secure card. A secure card can\'t pass a value to a tool, so call save_sources with uploadLink: { name: "Guesty Lite" } (or the calendar\'s name) and post the link to the upload link from your own computer.',
      },
      {
        field: "google",
        ask: "which Google calendar holds the bookings",
        required: true,
        when: "source is google",
        example: `${property} bookings`,
        how: "Read only that calendar with your own connector, never the main one unless the bookings are there. Save with google: true.",
      },
    ],
  };
}

/** After the first calendar is saved: asks for every other place bookings come from, one at a time. */
export function moreSourcesAsk(saved: string[], property: string): SetupAsk {
  return {
    step: "sources",
    tool: "save_sources",
    questions: [
      {
        field: "more",
        ask: `whether ${property}'s bookings come from anywhere besides ${saved.join(", ")}`,
        required: true,
        options: [
          { value: "add", label: "Add another booking calendar" },
          { value: "done", label: `That's all, just ${saved.join(" and ")}` },
        ],
        how: "For each other calendar (Airbnb, Vrbo, Booking.com, a direct-booking calendar, or Google Calendar), save it the same way as the first, one at a time; every saved calendar stays. Guesty Lite already includes the Airbnb and Vrbo stays it manages, so add those only when they are booked outside Guesty. Ask again until the host says that's all, then call save_sources with done: true.",
      },
    ],
  };
}

export function peopleAsk(business: string): SetupAsk {
  return {
    step: "people",
    tool: "save_people",
    questions: [
      { field: "cleanerName", ask: "the cleaner's name", required: true },
      { field: "cleaner", ask: "the cleaner's phone number", required: true },
      { field: "host", ask: "the host's phone number", required: true },
      {
        field: "hostName",
        ask: "the host's own first name, for the group text",
        required: true,
        how: `The group intro greets the host by this name and calls you their cleaning assistant. Ask for a person's name, not the business name ("${business}").`,
      },
      {
        field: "groupChat",
        ask: "who is in the cleaning texts",
        required: true,
        default: "cleaner-and-host",
        options: [
          { value: "cleaner-and-host", label: "A group text with me and the cleaner" },
          { value: "everyone", label: "A group text with me, the cleaner, and extra contacts" },
          { value: "cleaner-only", label: "Texts to the cleaner alone" },
        ],
      },
      { field: "contacts", ask: "each extra contact's name, role, and phone number", required: true, when: "groupChat is everyone" },
      {
        field: "doorCodeTo",
        ask: "who gets the door code",
        required: true,
        when: "groupChat is everyone and there are contacts",
        options: [
          { value: "group", label: "The whole group" },
          { value: "cleaner", label: "Only the cleaner, privately" },
        ],
      },
    ],
  };
}

export const SCHEDULE_STEP: SetupAsk = {
  step: "schedule",
  tool: "save_schedule",
  questions: [
    {
      field: "firstText",
      ask: "how far ahead the cleaner is offered each cleaning",
      required: true,
      default: "1",
      options: [
        { value: "1", label: "1 day before checkout" },
        { value: "3", label: "3 days before checkout" },
        { value: "7", label: "A week before checkout" },
        { value: "custom", label: "Another number of days before checkout" },
        { value: "when-confirmed", label: "As soon as I confirm the times" },
      ],
      how: "For a number of days, pass firstText days-before-checkout with firstTextDays set to it. Each offer goes at 9:00 AM that day. For as soon as the times are confirmed, pass firstText when-confirmed, and tell the host that with many bookings ahead the cleaner is offered them one after another, however far out.",
    },
    { field: "firstTextDays", ask: "how many days before checkout, 1 to 14", required: true, when: "firstText is custom" },
    {
      field: "timing",
      ask: "when the reminder goes, and any quiet hours",
      required: true,
      default: "defaults",
      options: [
        { value: "defaults", label: "Keep the defaults" },
        { value: "custom", label: "Set them myself" },
      ],
      how: "The defaults: a reminder at 8:00 AM on checkout morning, no quiet hours, and problems go to the host. Save them with only the first-text fields.",
    },
  ],
};

export const DOOR_CODE_STEP: SetupAsk = {
  step: "door-code",
  tool: "save_door_code",
  questions: [
    {
      field: "lockLocation",
      ask: "how many locks the cleaner goes through and where each one is",
      required: true,
      example: "front door keypad and back gate lockbox",
      how: "Always ask this, before the code. Save every lock in lockLocation, under 80 characters and with no numbers. Cleaner Core keeps one door code, sent with this text, so when the locks use different codes, tell the host that only one code can be saved for now.",
    },
    {
      field: "code",
      ask: "the door code",
      required: true,
      how: 'Only on your secure card. Never in chat. Call save_door_code with no code and with lockLocation to get a one-time upload link, then post {"code": "<door code>"} to it from your own computer.',
    },
  ],
};

export const PREFERENCES_STEP: SetupAsk = {
  step: "preferences",
  tool: "save_preferences",
  questions: [
    {
      field: "any",
      ask: "whether the host has cleaning preferences",
      required: true,
      options: [
        { value: "none", label: "No preferences" },
        { value: "some", label: "Add preferences" },
      ],
      how: "No preferences saves save_preferences {}.",
    },
    {
      field: "supplyNotes",
      ask: "whether the cleaner should report supplies running low",
      required: false,
      when: "any is some",
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    },
    {
      field: "photosRequired",
      ask: "whether the cleaner must send photos when done",
      required: false,
      when: "any is some",
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    },
    { field: "checklist", ask: "checklist items", required: false, when: "any is some" },
    { field: "instructions", ask: "a note for the cleaner, sent with the door code", required: false, when: "any is some" },
  ],
};

/** Optional: help paying the cleaner after each cleaning, with a Venmo link the host taps. */
export const PAYMENTS_STEP: SetupAsk = {
  step: "payments",
  tool: "save_payments",
  questions: [
    {
      field: "on",
      ask: "whether you'd like help paying the cleaner after each cleaning",
      required: true,
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "Not now" },
      ],
      how: "Not now saves save_payments { on: false }.",
    },
    { field: "rate", ask: "how much the host pays the cleaner per cleaning, in dollars", required: false, when: "on is yes", example: "85" },
    {
      field: "venmo",
      ask: "the cleaner's Venmo username",
      required: false,
      when: "on is yes",
      example: "@maria-cleans",
      how: "Call save_payments without confirmation, show the host the profile link and the question, and call again with the code only after the host says yes.",
    },
  ],
};

/** Optional, Grok on the shared service only: Supply Core as an add-on, set up now or later. */
export const SUPPLIES_STEP: SetupAsk = {
  step: "supplies",
  tool: "choose_supplies",
  questions: [
    {
      field: "on",
      ask: "whether the host wants Supply Core to keep the property stocked",
      required: true,
      options: [
        { value: "yes", label: "Yes, set it up" },
        { value: "no", label: "Not now" },
      ],
      how:
        'Explain it in two or three short sentences, in your own words: Supply Core reorders the supplies the property always needs, like paper towels and coffee pods, on a schedule, from stores that deliver to the door. After each cleaning, the cleaner is asked "Anything running low?", and what they name gets ordered. You stop for the host\'s yes before checkout unless they choose hands-off, and their cards stay in their Vault. Tell them they can set it up later by asking you. Then call choose_supplies with on true or false.',
    },
  ],
};

/** Offers the usual times for every turnover that has none yet. */
export function allTimesAsk(checkout: string, checkIn: string, untimed: number): SetupAsk {
  return {
    step: "times",
    tool: "confirm_times",
    questions: [
      {
        field: "all",
        ask: `whether to use the usual times for all ${untimed} upcoming turnovers`,
        required: true,
        default: "all",
        options: [
          { value: "all", label: `Use ${checkout} checkout and ${checkIn} check-in for all ${untimed}` },
          { value: "one", label: "Set the times one turnover at a time" },
        ],
        how: `For all, call confirm_times with checkout ${checkout}, checkIn ${checkIn}, and all: true. For one at a time, ask for the first turnover's times and call confirm_times without all.`,
      },
    ],
  };
}

/** Where the agent looks for each part of the draft, and the tool that saves it. */
export interface DraftFill {
  fill: string;
  from: string;
  tool?: string;
  how?: string;
}

/**
 * The draft that starts setup (saadvz/TourCore#166). `needsYou` holds the questions of every step
 * that is still missing, whatever its order; `confirm` holds what the host always confirms.
 */
export interface SetupDraft {
  fill: DraftFill[];
  confirm: string[];
  needsYou: SetupAsk[];
}

export const DRAFT_NEXT =
  'Draft this setup before you ask the host anything. draft.fill says where to look and which tool saves each part. Save what you find, in any order except that the calendars wait for the property, but do not save again a step that done already lists unless the host changes it. Never draft the door code. Then show the host one summary for this property: what you filled in, every step in draft.needsYou marked "needs you", and each item in draft.confirm called out for their yes. Let the host correct it in one reply. Save their changes, then call get_state with drafted: true.';

export const DRAFT_FILL: DraftFill[] = [
  {
    fill: "the business name, the address, the time zone, and the usual checkout and check-in times",
    from: "the listing and the booking confirmation emails",
    tool: "save_property",
  },
  {
    fill: "where the bookings come from",
    from: "the booking emails and the host's calendars (Guesty Lite, Airbnb, Vrbo, Google Calendar)",
    tool: "save_sources",
    how: "A calendar link still goes through the upload link, never in chat. Once the host's reply confirms the list, save_sources with done: true.",
  },
  {
    fill: "the cleaner's name and phone number, the host's name and phone number, and anyone else in the cleaning texts",
    from: "the host's contacts and past texts with the cleaner. The host's own phone is the one they confirmed when they signed in",
    tool: "save_people",
  },
  { fill: "the schedule", from: "the defaults, unless past texts show the host does it another way", tool: "save_schedule" },
  { fill: "the checklist and the cleaner's notes", from: "past texts with the cleaner", tool: "save_preferences" },
  {
    fill: "supplies the property reorders",
    from: "past supply orders",
    how: "Name them in the summary as a suggestion for Supply Core. Nothing is ordered or saved from the draft.",
  },
  {
    fill: "pros the host has used, like a plumber or a handyman",
    from: "past emails and texts",
    how: "Name them in the summary for later. Nothing saves them yet, and nobody is texted.",
  },
];

export const DRAFT_CONFIRM: string[] = [
  "The door code, always through its secure upload: call save_door_code with no code for the link. Never take it from an email, a text, or the chat.",
  "Who gets the door code: the group choice and, with contacts in the group, doorCodeTo.",
  "Any spending: payments to the cleaner and Supply Core. Payments still take their own yes with save_payments.",
  "Anyone new who will be texted: the cleaner and each contact, by name. When someone is already on another of the host's properties, say so in the summary and save with shared: true only after the host's yes. Someone who already said YES there gets no new invite.",
];
