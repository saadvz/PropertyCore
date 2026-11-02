import { SETUP_HELP_ENDING } from "./setupHelp";

/**
 * Grok-only, for an error while an alert address is already saved.
 * The secure page replaces that address and key, so the existing ones must be entered again.
 */
export const RECONNECT_EXISTING =
  "The secure page overwrites the saved address and key with no history, so re-enter the existing routine's address and key there. Never create a new routine or use a new routine's address or key. Do not ask for an address or a key in chat.";

export const RECONNECT_INSTRUCTIONS = `For you, not out loud: send the secure setup page this step names. ${RECONNECT_EXISTING}`;

/**
 * Wording shared by every playbook. Profiles add only their own differences.
 * Lines under "ask" are what the agent may say to the landlord.
 * An empty ask means there is no fixed line to say out loud.
 */

export const SHARED_VOICE = [
  "Talk to the landlord like a person. Short sentences. One question at a time.",
  'Say a time as a clock time on a day, for example "3:15 PM on Monday".',
  "Never say a tool name, a company name, an id, or a raw error out loud.",
  "Never say Main Home. If a house has no nickname, use the street or say the house.",
  "If a step fails, tell them what happened in plain words. Do not go quiet.",
  "When you give them the setup help link, say it as one plain link they can open. Do not dump a long web address. Never put that link in a text to a visitor.",
].join(" ");

export const SHARED_IRREVERSIBLE = [
  "Before you cancel a tour, remove a property, or restore a backup, say in plain words what will happen and wait for a clear yes.",
  "Cancel a tour: the doors for that visit stop, and the visitor is told. This cannot be undone.",
  "Remove a property: it leaves their list. A place that was never published is deleted for good. A published place keeps its records, and anyone booked is told the visit is off.",
  "Restore a backup: the records on this Tour Core are replaced by the copy. Logins are not in the copy. This cannot be undone.",
  "If they say no, or they change their mind, stop. Nothing happens until a clear yes.",
].join(" ");

/** Agent-only. Not a second question for the landlord. */
export const SHARED_AFTER_PUBLISH =
  "For you, not out loud: if they set up a portable copy and this is the first time this place is published, make that one copy before you ask anything. If they skipped copies, don't. Then ask the one question below.";

export const SHARED_FLAGGED_RULES = [
  "A visitor question with no saved answer is already flagged. They already got the usual short holding reply, unless the question was held for the team, in which case they already got: Good question for the {team}. I've passed it along, and they'll text you back here. Do not send them anything else until the landlord gives a clear yes.",
  'A draft, if one is written, stays casual and short. Call the team by the same name the visitor\'s texts already used ("the {team}", which is "the property team" unless the stored name ends in "team"). Do not name a product, a tool, or a company. Promise nothing that is not already in the listing or in an earlier answer the landlord approved.',
  "If the question is fair-housing sensitive, including who is allowed to live there, do not draft an answer. Leave it with the landlord. Do not invent a special reply.",
  "Before the yes, read the landlord the full text the visitor will get, including any closing line. The confirmation has that exact text. It matches what is sent, word for word. The first call does not send.",
  `If the send fails, tell the landlord the visitor did not get it. You try again only after they say yes again. ${SETUP_HELP_ENDING}`,
].join(" ");

export interface StepCopy {
  /** The one thing to ask or do, in words that can be said out loud. */
  ask: string;
  done: string;
  ifItFails: string;
}

export const SHARED_STEPS = {
  connect: {
    ask: "I need you to approve the connection. You'll see a code. If it matches, allow it.",
    done: "You are connected, and the next step has moved on.",
    ifItFails: `Tell them the connection didn't go through, and that they can allow it again. You help with the next try. ${SETUP_HELP_ENDING}`,
  },
  starting: {
    ask: "I'm getting things set up. I won't ask you to do anything yet.",
    done: "The next step has moved on.",
    ifItFails: `Tell them it isn't up yet and that you'll try again. ${SETUP_HELP_ENDING}`,
  },
  "texting-choose": {
    ask: "How should people text you about a tour?",
    done: "They picked one, and that choice is saved.",
    ifItFails: `Tell them that choice didn't stick, and ask them to pick again. You help. If there is nothing to pick from, say so. ${SETUP_HELP_ENDING}`,
  },
  "texting-keys": {
    ask: "I need the texting login. I'll collect it privately so it never shows in this chat.",
    done: "The login is saved, and you have not repeated it.",
    ifItFails: `Tell them the login didn't save, and that you'll ask again in private. You help. If the private link won't open, try that link again. ${SETUP_HELP_ENDING}`,
  },
  "texting-line": {
    ask: "Which of these numbers should people text?",
    done: "They picked one number from the list, and it is saved.",
    ifItFails: `Tell them that number isn't one you can use, and ask them to pick from the list again. You help. If the list is empty, say so. ${SETUP_HELP_ENDING}`,
  },
  "texting-test": {
    ask: "I'm checking that texting works. I won't text anyone.",
    done: "Texting works.",
    ifItFails: `Tell them texting isn't working right now, in plain words, with no error code. You try again. ${SETUP_HELP_ENDING}`,
  },
  backups: {
    ask: "I can keep a private copy of your records in a folder you own, or we can skip that. Skipping is fine. Which do you want?",
    done: "They said yes and the folder is confirmed, or they said skip and that choice is saved.",
    ifItFails: `Tell them the copy wasn't set up, and that skipping is still fine. You help. If a folder they already use can't be reached, they approve it again. ${SETUP_HELP_ENDING}`,
  },
  "property-address": {
    ask: "What's the street address?",
    done: "You have a street, city, state, and ZIP.",
    ifItFails: `Tell them you don't have a usable address yet and ask again. You help. ${SETUP_HELP_ENDING}`,
  },
  "property-confirm": {
    ask: "Did I get that right: {address}?",
    done: "They said the address is right.",
    ifItFails: `Tell them you'll correct it, and ask for the part that's wrong. You help. ${SETUP_HELP_ENDING}`,
  },
  "property-type": {
    ask: "Is this a single-family home, a multifamily home, or one apartment or condo?",
    done: "They named the kind of place, and you did not guess it.",
    ifItFails: `Tell them you still need the kind of place, and ask again. You help. Do not invent one. ${SETUP_HELP_ENDING}`,
  },
  "units-which": {
    ask: "What are the units called? For example, Unit A and Unit B.",
    done: "Each place they named is saved.",
    ifItFails: `Tell them you still need the places people can tour. You help. ${SETUP_HELP_ENDING}`,
  },
  "units-home": {
    ask: "People will tour the whole home. What should I call it? The street is fine if you don't have a nickname.",
    done: "The home has the name they gave, or the street.",
    ifItFails: `Tell them you'll use the street, and ask once more if they want a different name. You help. ${SETUP_HELP_ENDING}`,
  },
  "units-details": {
    ask: "",
    done: "That detail is saved in their words, or they said not to list it.",
    ifItFails: `Tell them that detail didn't save, and ask it once more. You help. ${SETUP_HELP_ENDING}`,
  },
  "units-route": {
    ask: "How does someone walk in, from the front door to the door they tour?",
    done: "Each place has its own door and a way through, and you read that path back.",
    ifItFails: `Tell them which place is still missing a door or a way through. You fix it with them. ${SETUP_HELP_ENDING}`,
  },
  hours: {
    ask: "What days and times can people tour? Weekdays from 9:00 AM to 5:00 PM are already saved. You can keep that.",
    done: "They answered, including keeping what's already saved, and that answer is saved.",
    ifItFails: `Tell them the hours didn't save, and ask once more. You help. ${SETUP_HELP_ENDING}`,
  },
  "hours-help": {
    ask: "What number can stuck visitors call? Someone should answer it during touring hours. You can skip this.",
    done: "A number is saved, or they skipped it, and this step is no longer next.",
    ifItFails: `Tell them the number didn't save, and that they can skip it. You help. ${SETUP_HELP_ENDING}`,
  },
  facts: {
    ask: "How do people apply?",
    done: "They answered or skipped each facts question, and each answer is saved word for word.",
    ifItFails: `Tell them that answer didn't save, and that they can skip it. You help. ${SETUP_HELP_ENDING}`,
  },
  alerts: {
    ask: "Want me to tell you when someone books, starts, or finishes a tour, and when something needs you?",
    done: "They said yes and a test note arrived, or they said no and that is saved.",
    ifItFails: `Tell them the updates didn't connect, and that you'll try the private link again. You help. They can also skip updates. ${SETUP_HELP_ENDING}`,
  },
  "alerts-degraded": {
    ask: "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through.",
    done: "A test update got through, and tour updates are working again.",
    ifItFails: `Tell them the test didn't get through. You help. ${SETUP_HELP_ENDING}`,
  },
  "alerts-error": {
    ask: "Tour updates aren't reaching you. I'll send you a secure link to reconnect them. Nothing you type there shows in chat.",
    done: "The saved connection is back, and a test update got through.",
    ifItFails: `Tell them the updates still aren't reaching them. You help. ${SETUP_HELP_ENDING}`,
  },
  readiness: {
    ask: "I'm checking that a tour can run. Nobody is texted, and no real door opens.",
    done: "The check passed.",
    ifItFails: `Tell them what still needs a fix, in plain words, with no codes. You fix it with them, then check again. ${SETUP_HELP_ENDING}`,
  },
  practice: {
    ask: "I'm running a practice tour. Nobody is texted, and no real door opens.",
    done: "The practice tour passed.",
    ifItFails: `Tell them the practice tour didn't pass, in plain words. You fix it with them and try again. ${SETUP_HELP_ENDING}`,
  },
  publish: {
    ask: "Everything passed. Want me to publish this for a demo?",
    done: "They said yes, and it is published.",
    ifItFails: `Tell them it isn't published, and that nothing went live. You help. ${SETUP_HELP_ENDING}`,
  },
  another: {
    ask: "Want to set up another place? The one that's already published stays published.",
    done: "They said no, or they gave you a new street address.",
    ifItFails: `Tell them the new place didn't start, and the published one is untouched. You try again with the street address. ${SETUP_HELP_ENDING}`,
  },
  operate: {
    ask: "You're all set. Ask me anytime to see a tour or something that needs you.",
    done: "They don't owe you a setup answer.",
    ifItFails: `If a later request fails, tell them what happened and that you will try again. ${SETUP_HELP_ENDING}`,
  },
} as const satisfies Record<string, StepCopy>;

export type StepId = keyof typeof SHARED_STEPS;

/** Agent-only line for a step that has no fixed question to say out loud. */
export function stepAside(step: StepId): string | undefined {
  if (step !== "units-details") return undefined;
  return "For you, not out loud: ask the one detail that's still missing, in plain words.";
}

export const STEP_TITLES: Record<StepId, string> = {
  connect: "Connection",
  starting: "Getting set up",
  "texting-choose": "Texting",
  "texting-keys": "Texting login",
  "texting-line": "Texting number",
  "texting-test": "Texting check",
  backups: "Backups",
  "property-address": "Property",
  "property-confirm": "Property",
  "property-type": "Property",
  "units-which": "Units, doors, and routes",
  "units-home": "Units, doors, and routes",
  "units-details": "Units, doors, and routes",
  "units-route": "Units, doors, and routes",
  hours: "Hours",
  "hours-help": "Hours",
  facts: "Property facts",
  alerts: "Tour updates",
  "alerts-degraded": "Tour updates",
  "alerts-error": "Tour updates",
  readiness: "Practice tour",
  practice: "Practice tour",
  publish: "Publish",
  another: "Another place",
  operate: "All set",
};
