import { formatPhone } from "../core/phone";

/**
 * Every visitor-facing SMS lives here. Outbound prospect texts must match one
 * id before they are sent. `{slot}` is filled first. A channel prompt (yes/no,
 * a numbered menu, or a form link) may be appended after the body; those
 * prompts are listed too and are not a second message.
 *
 * Text supplied by the landlord or by a model may reach a visitor only as
 * `approved-answer` or `approved-answer-closing`, and only from
 * `resolve_issue`. A no-draft flag never
 * gets a draft. `approved-profile-fact` repeats a fact the landlord already
 * saved. It is not a new draft.
 */

/**
 * Visitor-facing team label. A stored name is used only when it already ends
 * in "team" (for example "leasing team"). A leading "the " is removed so the
 * template can add it once. A company name or a blank becomes "property team",
 * so the sentence stays grammatical.
 */
export function visitorTeamName(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim().replace(/^the\s+/i, "");
  return /\bteam$/i.test(trimmed) ? trimmed : "property team";
}

/**
 * The human-path reply when tours cannot run, including a draft property and a
 * published property with no time zone. `visitorContact` is the saved visitor
 * help number, the same field the paused and removed replies use.
 */
export function toursUnavailableText(name: string, team?: string, visitorContact?: string): string {
  if (visitorContact) {
    return `Thanks for reaching out to ${name}. Tours by text aren't available right now. You can call the ${visitorTeamName(team)} at ${formatPhone(visitorContact)}.`;
  }
  return `Thanks for reaching out to ${name}. Tours by text aren't available right now. Please check back soon.`;
}

export class UntemplatedVisitorSms extends Error {
  readonly body: string;
  constructor(body: string) {
    super(`Visitor text is not in the template registry: ${JSON.stringify(body)}`);
    this.name = "UntemplatedVisitorSms";
    this.body = body;
  }
}

export interface VisitorTemplate {
  id: string;
  /** Wording with `{slot}` or `{slot?}` (optional, may be empty). */
  text: string;
  /**
   * Not used by reverse matching. Callers must pass the id. Used for
   * landlord-approved prose and for saved profile facts, whose sentences
   * are not a fixed pattern.
   */
  explicitOnly?: boolean;
  /** Appended by the channel. Listed for review. Not a full message id. */
  suffix?: boolean;
  note?: string;
}

/** Bare cancel on a booked tour that has not started. One visitor text, and the opt-out. */
export const CANCEL_OPT_OUT =
  "Your tour is cancelled and you won't get any more texts from us. To come back or book again, reply START.";

const TEMPLATES: VisitorTemplate[] = [
  { id: "fair-housing-held", text: "Good question for the {team}. I've passed it along, and they'll text you back here.", note: "Sent only after the question is flagged no-draft. Never names the reason." },
  { id: "door-stuck-no-steps", text: "I can't open the doors for you right now. I've let the {team} know, and they'll text you here shortly.", note: "No step left, including a stale denial on a no-form property, and a failed forward of a held question." },
  { id: "finish-steps", text: "We're not quite ready to open doors yet. Finish the steps I sent earlier and you'll be all set." },
  { id: "tour-window-ended", text: "Your tour time ended at {time}, so the doors are locked now. Want to come back another time? Just reply with a day that works.", note: "{time} drops :00, for example 3 PM or 3:30 PM. No door opens." },
  { id: "all-doors-open", text: "Every door on your tour is already open for you. Text HELP if one isn't working." },

  { id: "unknown-answer", text: "I'll pass your question to the {team}, and they'll reply here as soon as they can." },
  { id: "unknown-answer-photo", text: "I can't open photos yet. I'll pass your question to the {team}, and they'll reply here as soon as they can." },
  { id: "unknown-answer-ended", text: "I'll pass your question to the {team}, and they'll reply here as soon as they can. If you'd like to tour again, just text HI." },
  { id: "unknown-answer-ended-photo", text: "I can't open photos yet. I'll pass your question to the {team}, and they'll reply here as soon as they can. If you'd like to tour again, just text HI." },
  { id: "tour-ended-reply", text: "This tour has ended. Text HI any time to start a new one." },
  { id: "open-times", text: "Here are the open tour times:\n{times}", note: "{times} is one line per day: the day, then its open times. Never the unit's move-in availability." },
  { id: "open-times-booked", text: "Here are the open tour times:\n{times}\nYour tour stays as it is. To move it, say which day and time you'd like.", note: "A booked visitor asked. Their booking is not changed." },
  { id: "open-times-other-day", text: "Nothing is open {day}. Here are the next open times:\n{times}", note: "The named weekday has no open times." },
  { id: "open-times-none", text: "Nothing is open for tours right now." },
  { id: "reschedule-offer", text: "Here are the open times:\n{options}\nReply with the number of the time you'd like. Your tour stays as it is until you pick.", note: "A booked visitor asked to move their tour. {options} is numbered lines like \"1) Tuesday, Sep 29 at 2:00 PM\"." },
  { id: "reschedule-none", text: "Nothing else is open right now, so your tour stays as it is." },
  { id: "my-tour", text: "Your tour is at {time} on {day}.\nDoors will work for you from {start} to {end}.\nThe address is {address}.", note: "A booked visitor asked when their tour is." },
  { id: "no-tour-booked", text: "You don't have a tour booked yet." },
  { id: "property-address", text: "The address is {address}." },
  { id: "reschedule-taken", text: "That time was just taken. Here are the open times now:\n{options}\nReply with the number of the time you'd like.", note: "The picked time was booked by someone else first. The visitor's tour is unchanged." },
  { id: "storage-unavailable", text: "I can't check that right now. Please try again in a little while." },
  { id: "shared-fact", text: "Here's what the {team} shared: {fact}" },
  { id: "tour-length", text: "Tours are about {minutes} minutes.{again?}", note: "From the tour length set at setup." },
  { id: "tour-id-form", text: "You'll fill out a short form with your name, email, and phone before your tour. No ID is needed at the door.{again?}", note: "ID question, identity form on." },
  { id: "tour-id-none", text: "No ID or form is needed for this tour.{again?}", note: "ID question, no identity form." },
  { id: "approved-profile-fact", text: "{answer}", explicitOnly: true, note: "A profile fact the landlord already saved. Not a draft." },
  { id: "approved-answer", text: "{answer}", explicitOnly: true, note: "Landlord reply from resolve_issue only. No-draft items never use this." },
  { id: "approved-answer-closing", text: "{answer} Let me know if you have any other questions.", explicitOnly: true, note: "Approved fact plus the closing line, from resolve_issue only." },

  { id: "cancel-done", text: "You're cancelled. Text me anytime if you want to book again." },
  {
    id: "cancel-opt-out",
    text: CANCEL_OPT_OUT,
    note: "Bare cancel when a tour is booked and has not started. Also the carrier opt-out. The stored keyword is STOP.",
  },
  { id: "nothing-booked-cancel", text: "No problem, nothing's booked yet, so I'll stop here. Text me anytime if you want to pick a time." },
  { id: "cancel-failed", text: "I can't cancel it from here. I've asked the {team} to call it off and get back to you." },
  { id: "cancel-confirm", text: "Cancel your {time} tour on {day}? Reply YES or NO." },
  { id: "cancel-kept", text: "Okay, your {time} tour on {day} stays booked." },
  { id: "later-cancel-confirm", text: "Cancel your later tour at {time} on {day}? Your tour right now isn't affected. Reply YES or NO." },
  { id: "later-cancel-done", text: "Done, I've cancelled your later tour at {time} on {day}. Your tour right now isn't affected." },
  { id: "later-cancel-kept", text: "Okay, your later tour at {time} on {day} stays booked." },
  { id: "cannot-cancel-running-later", text: "You can't cancel the tour you're on, but you're free to wrap up whenever you like.{note?} Your later tour at {time} on {day} is still booked. Want me to cancel that one instead? Reply YES or NO." },
  { id: "cannot-cancel-running", text: "You can't cancel the tour you're on, but you're free to wrap up whenever you like.{note?} Text me anytime if you want to book another tour." },

  { id: "at-door-phone", text: "Stay where you are. {who} reply as soon as they can, or call {phone}." },
  { id: "at-door", text: "Stay where you are and reply here. {who} reply as soon as they can." },
  { id: "remote-phone", text: "{who} reply here as soon as they can, or call {phone}." },
  { id: "remote", text: "{who} reply here as soon as they can." },
  { id: "operator-hold", text: "Your tour is on hold, and your tour time keeps running while the {team} sorts this out. {rest}" },
  { id: "called-off", text: "Your tour{when?} has been called off, so the doors won't open for it. {rest}" },
  { id: "too-early", text: "You're a little early! I can open the doors from {when}. {again}" },
  { id: "too-early-generic", text: "You're a little early! I can open the doors from your tour time. Text me again at your tour time." },
  { id: "follow-up-yes", text: "Great. Someone from the {team} will be in touch soon." },
  { id: "help-ack", text: "I've let the {team} know. {rest}" },
  { id: "help-repeat", text: "The {team} already knows and is on it. {rest}" },
  { id: "medical-help", text: "If someone is hurt, call 911 now. I've also let the {team} know, and they'll text you here as soon as they can.", note: "Injury help when the team alert went out. Plain help with no medical word keeps help-ack." },
  { id: "medical-help-call", text: "If someone is hurt, call 911 now. I couldn't reach the {team} just now, so please call them at {phone} too.", note: "Injury help when the team alert failed and a visitor help number is saved. Same help-number choice as property-not-ready-call. Never the snag line." },
  { id: "medical-help-unreached", text: "If someone is hurt, call 911 now. I couldn't reach the {team} just now.", note: "Injury help when the team alert failed and no visitor help number is saved. Never the snag line." },
  { id: "no-open-times", text: "There are no open tour times right now. The {team} will reach out." },
  { id: "doors-not-responding", text: "Sorry, the doors aren't responding right now. I've let the {team} know. {rest}" },
  { id: "follow-up-phone", text: "The {team} will follow up here, or call {phone}." },
  { id: "follow-up", text: "The {team} will follow up here." },
  { id: "failed-id-door", text: "I couldn't confirm your details, so I can't open doors for this tour. {rest}" },
  { id: "failed-id-booking", text: "Thanks for filling that out. {rest}" },
  { id: "failed-id-ended", text: "I couldn't confirm your details, so your tour has ended. Please head out the way you came in. {rest}" },
  { id: "stale-verification", text: "It's been a while since you filled out the identity form, so I'll need you to fill it out again before I can open doors." },
  { id: "missing-consent", text: "Before I can open doors, text me back and I'll finish setting up your tour." },
  { id: "wrong-route", text: "That door isn't part of your tour, so I can't open it. You're here to see {place}. I've let the {team} know in case you need a hand." },
  { id: "tour-completed-doors", text: "Your tour is finished, so the doors are locked again. Want to book another visit?" },
  { id: "tour-inactive", text: "This tour is no longer active, so I can't open doors. Reply if you'd like to book a new time." },

  { id: "booked-for", text: "Great, you're booked for {time} on {day}." },
  { id: "replaces-tour", text: "That replaces your {time} tour on {day}." },
  { id: "custom-time-asked", text: "I've asked the {team} about {newTime} on {newDay} instead. Your {time} tour on {day} stays booked unless they approve the change." },
  { id: "decline-request", text: "The {team} couldn't approve {newTime} on {newDay}. {rest}" },
  { id: "decline-still-confirmed", text: "The {team} couldn't approve {newTime} on {newDay}. Your {time} tour on {day} is still confirmed." },
  { id: "decline-still-booked", text: "The {team} couldn't approve {newTime} on {newDay}. You're still booked for {time} on {day}." },
  { id: "decline-no-booking", text: "The {team} couldn't approve {newTime} on {newDay}. If you'd like another time, just reply with a day." },
  { id: "request-expired", text: "The {team} couldn't get to your request for {newTime} on {newDay} in time. {rest}" },
  { id: "propose-one-off", text: "The {team} can do {time} on {day} as a one-off. {rest}" },
  { id: "propose-instead", text: "The {team} can't do {requestedTime} on {requestedDay}, but {proposedTime} on {proposedDay} works. {rest}" },
  { id: "decline-proposed-confirmed", text: "No problem. Your {time} tour on {day} is still confirmed." },
  { id: "decline-proposed-booked", text: "No problem. You're still booked for {time} on {day}." },
  { id: "decline-proposed-none", text: "No problem. If you'd like another time, just reply with a day." },
  { id: "pending-custom", text: "Your request for {time} on {day} is still with the {team}. I'll text you as soon as they respond.{rest?}" },
  { id: "taken-slot", text: "Sorry, {time} on {day} is already taken.{rest?}" },
  { id: "taken-other-day", text: "If you'd like another time, just reply with a day." },
  { id: "already-asked", text: "I've already asked the {team} about {time} on {day}." },
  { id: "time-passed", text: "That time has already passed. What later time works for you?" },
  { id: "time-passed-today", text: "That time today has already passed. Did you mean tomorrow?" },
  { id: "time-invalid", text: "That time doesn't work. What time would you like?" },
  { id: "consent-declined", text: "No problem, I won't text you again about this tour. Reach out anytime if you change your mind." },
  { id: "inquiry", text: "{greeting} Happy to set up a self-guided tour of {place}.{summary?}\n{next}" },
  { id: "tour-moved-window", text: "Your tour has moved to {when}.\nDoors will work for you from {start} to {end}." },
  { id: "tour-moved-same", text: "Your tour has moved to {when}. Everything else stays the same." },
  { id: "tour-moved-notice", text: "Your tour of {unit} has been moved to {time} on {day}.{extra?}" },
  { id: "operator-schedule-declined", text: "No problem. I cancelled that tour. Text me anytime to book another." },
  { id: "operator-schedule-expired", text: "I didn't hear back, so I released your {when} tour. Text me anytime to book another." },
  { id: "follow-up-no", text: "No problem. Thanks again for visiting!" },
  { id: "no-problem", text: "No problem." },
  { id: "mark-ready", text: "You're all set for your {time} tour on {day}!\nDoors will work for you from {start} to {end}.{entry?}" },
  { id: "tour-directions", text: "Here's how to get there: {url}" },
  { id: "door-open", text: "{door} is open for you now.{tail?}" },
  { id: "identity-form", text: "Thanks! One last step before your tour: please fill out this short form with your legal name, email and phone." },

  { id: "photo-alone", text: "I can't take photos yet. Text your question and I'll pass it along." },
  { id: "photo-with-text", text: "I can't take photos yet." },
  { id: "schedule-changed", text: "Tour times just changed. Here's what's open now:" },
  { id: "day-menu", text: "I have tours available. Which day works for you?" },
  { id: "no-weekend", text: "I don't have weekend tours, but weekdays are open. Which day works for you?" },
  { id: "sorry", text: "Sorry, I didn't catch that." },
  { id: "sorry-rest", text: "Sorry, I didn't catch that. {rest}" },
  { id: "sorry-ready", text: "Sorry, I didn't catch that. You can ask me a question about the property." },
  { id: "sorry-touring", text: "Sorry, I didn't catch that. You can ask me a question{hint?}, or text DONE when you're finished." },
  { id: "which-unit", text: "Which unit do you mean: {units}?" },
  { id: "which-unit-plain", text: "Which unit would you like to see?" },
  { id: "unit-two", text: "Sure — did you mean {a} or {b}?" },
  { id: "unit-many", text: "Sure — which unit did you mean?" },
  { id: "day-unclear", text: "I couldn't tell which day you meant. Which day works for you?" },
  { id: "confirm-arrival", text: "Are you at the property now?" },
  { id: "confirm-stop", text: "Are you at {stop} now?" },
  { id: "choose-stop", text: "Which door are you at: {stops}?" },
  { id: "confirm-finish", text: "Are you finished with your tour?" },
  { id: "identity-waiting", text: "Your identity form is in my earlier message. Once it's filled out, I'll confirm your tour." },
  { id: "follow-up-question", text: "Would you like someone from the {team} to follow up?" },
  { id: "follow-up-clarify", text: "Just to check: {question}" },
  { id: "tour-not-started", text: "Your tour hasn't started yet." },
  { id: "start-at-first", text: "Let's start at {stop}. Are you there now?" },
  { id: "arrival-all-set", text: "You're all set.{hint?}" },
  { id: "which-time", text: "Which time works for you?" },
  { id: "which-time-sure", text: "Sure — which time works for you?" },
  { id: "which-time-rule", text: "{lead} Which time works for you?" },
  { id: "manipulation", text: "I can only help with your own tour. Doors open only for the stops on it, during your tour time.{hint?}" },
  { id: "custom-time-which-unit", text: "{time} isn't one of the regular tour times. Which unit should I ask the {team} about?" },
  { id: "custom-time-yes", text: "If you'd like {time}, reply YES and I'll ask the {team}." },
  { id: "custom-time-ask", text: "{time} isn't one of the regular tour times, but I can ask the {team}. I'll let you know once they respond." },
  { id: "awaiting-team", text: "I'll check with the {team} and get back to you." },
  { id: "clarify-which-time", text: "Which time did you mean?" },
  { id: "clarify-what-time", text: "What time would you like?" },
  { id: "clarify-what-time-be", text: "What time should that be?" },
  { id: "clarify-am-pm", text: "Did you mean {label} AM or {label} PM?" },
  { id: "clarify-time-closed", text: "That time isn't open." },
  { id: "clarify-en-route", text: "No rush! Text me when you're at the property." },
  { id: "clarify-arrival-no", text: "No problem. Text me when you're at the property." },
  { id: "clarify-stop-no", text: "No problem. Text me when you get there." },
  { id: "clarify-finish-no", text: "No rush. Take your time." },

  { id: "welcome-unit", text: "Hi! Welcome to the self-guided tour for {place}. I can answer questions about the unit and help you book a tour.{next?}" },
  { id: "welcome-home", text: "Hi! Welcome to the self-guided tour for {place}. I can answer questions about the home and help you book a tour.{next?}" },
  { id: "welcome-building", text: "Hi! Welcome to the self-guided tours {where}. I can answer questions about the property and help you book a tour.{next?}" },
  { id: "time-menu", text: "I have these times available {day}:" },
  { id: "time-menu-empty", text: "I don't have any open times on {day}." },
  { id: "closed-weekday", text: "Tours don't run on {days}.{rest?}" },
  { id: "beyond-horizon", text: "I can't book that far ahead yet.{rest?}" },
  { id: "no-more-today", text: "There are no more tours today.{rest?}" },
  { id: "day-full", text: "{day} is fully booked.{rest?}" },
  { id: "day-passed", text: "That day has already passed. {rest}" },
  { id: "next-opening-follow", text: "Reply yes for {time} on {day}, or pick a day." },
  { id: "slot-grabbed", text: "Someone just grabbed that time. {rest}" },
  { id: "still-confirmed", text: "Your {time} tour on {day} is still confirmed." },
  { id: "still-booked", text: "You're still booked for {time} on {day}." },
  { id: "switch-keep", text: "Reply YES to switch, or NO to keep your {time} tour on {day}." },
  { id: "switch-keep-looking", text: "Reply YES to switch, or NO to keep looking." },
  { id: "which-day", text: "Which day works for you?" },
  { id: "tour-hours-which-day", text: "Tours run {days}, {hours}. Which day works for you? Just reply with a day, like {examples}." },
  { id: "next-opening-want", text: "The next {noun} is {when}. Want that, or another day?" },
  { id: "next-opening-menu", text: "The next {noun} is {when}. Reply yes to take it, or pick a day:" },
  { id: "heres-whats-left", text: "Here's what's left:" },
  { id: "tours-back-soon", text: "They'll text you when tours are back." },
  { id: "text-anytime-another", text: "Text me anytime to book another." },
  { id: "questions-call", text: "Questions? Call {phone}." },
  { id: "pending-regular", text: "If you'd rather pick one of the regular times instead, just reply with a day." },
  { id: "at-stop-hint", text: "Text me when you're at {stop}." },
  { id: "done-hint", text: "Text DONE when you're finished." },

  { id: "operator-scheduled", text: "Hi, this is the {team} at {address}. We set up a tour for you at {time} on {day}. Reply YES to confirm, NO to cancel, or STOP to opt out." },
  { id: "operator-schedule-nudge", text: "Reply YES to confirm, NO to cancel, or STOP to opt out." },
  { id: "opt-in-again", text: "You'll get messages from {place} again. Text HI any time to start a tour." },
  { id: "identity-resend", text: "Here's your identity form link again. The earlier link no longer works." },
  { id: "paused-property", text: "Tours at {address} are paused right now. The {team} will text you when they're back{call?}." },
  { id: "paused-unit", text: "{unit} isn't open for tours right now.{rest?}" },
  { id: "removed-property", text: "{address} isn't offering tours anymore.{rest?}" },
  { id: "called-off-lead", text: "Sorry, the {team} had to cancel your {time} tour on {day} at {address}. {rest}" },
  { id: "called-off-later", text: "Sorry, the {team} had to cancel your later tour at {time} on {day}. Your tour right now isn't affected. {rest}" },
  { id: "tours-are-back", text: "Tours at {address} are back. Text me anytime to book." },

  { id: "sms-disclosure", text: "{brand}: You're starting a text conversation about a self-guided property tour.\n\nMessage frequency varies. Message and data rates may apply.\n\nReply YES to continue, HELP for help, or STOP to opt out.\n\nPrivacy: {privacy}\nTerms: {terms}" },
  {
    id: "sms-disclosure-draft",
    text: "{brand}: You're starting a text conversation about a self-guided property tour.\n\nMessage frequency varies. Message and data rates may apply.\n\nTours by text aren't available right now. Please check back soon. Reply HELP for help or STOP to opt out.\n\nPrivacy: {privacy}\nTerms: {terms}",
    note: "START on a draft-only line when no visitor help number is saved. Same disclosure as sms-disclosure, with the YES line replaced.",
  },
  {
    id: "sms-disclosure-draft-call",
    text: "{brand}: You're starting a text conversation about a self-guided property tour.\n\nMessage frequency varies. Message and data rates may apply.\n\nTours by text aren't available right now. You can call the {team} at {phone}. Reply HELP for help or STOP to opt out.\n\nPrivacy: {privacy}\nTerms: {terms}",
    note: "START on a draft-only line when a visitor help number is saved. {team} and {phone} use the same help-number wording as the not-ready reply.",
  },
  { id: "sms-opt-in", text: "{brand}: You're opted in. I can answer questions about the property and help you schedule and complete a self-guided tour.\nI'll keep a record of your visit times and the doors you use.\n\nReply STOP at any time to opt out." },
  { id: "sms-gate", text: "Reply YES to continue, HELP for help, or STOP to opt out." },
  { id: "sms-keyword", text: "Text TOUR to ask questions or schedule a self-guided tour. Reply HELP for help or STOP to opt out." },
  { id: "sms-stop", text: "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.", note: "Shared with Cleaner Core. No product-brand prefix." },
  { id: "sms-help", text: "{brand}: {help} Message and data rates may apply. Reply STOP to opt out." },

  { id: "property-not-ready", text: "Thanks for reaching out to {name}. Tours by text aren't available right now. Please check back soon.", note: "Sent when tours cannot run and no visitor help number is saved, including a new visitor text to a property that is not published for demo (a draft, or a demo sent back to draft). A tour that was already booked on that property keeps going." },
  { id: "property-not-ready-call", text: "Thanks for reaching out to {name}. Tours by text aren't available right now. You can call the {team} at {phone}.", note: "The same reply when a visitor help number is saved. {phone} is that number, formatted the same way as the paused and removed replies." },
  { id: "storage-save-failed", text: "I couldn't save that, so nothing was booked or changed. Please try again in a little while." },
  { id: "handler-snag-alerted", text: "Sorry, I hit a snag with that. I've let the {team} know, and they'll reply here as soon as they can." },
  { id: "handler-snag-retry", text: "Sorry, I hit a snag with that. Could you text me again in a few minutes?" },
  { id: "restore-trouble", text: "I'm having trouble restoring your tour. I've alerted the {team}." },
  { id: "restore-trouble-restart", text: "I'm having trouble restoring your tour. I've alerted the {team}. Text HI to start a new tour." },
  { id: "portfolio-picker", text: "Which place are you touring?\n{choices}" },
  { id: "portfolio-miss-1", text: "I didn't catch that. Which place are you touring?" },
  { id: "portfolio-miss-2", text: "I didn't catch that. Reply 1 or 2 for which place." },
  { id: "portfolio-miss-3", text: "I didn't catch that. Reply 1, 2, or 3 for which place." },
  { id: "portfolio-street-miss", text: "I couldn't find that one. Reply 1, 2, or 3, or text the street name." },

  { id: "t15", text: "Hope you're enjoying {place}{name?}! You have about 15 minutes left. Any questions about the place? Just text them here." },
  { id: "t15-yes", text: "Sure, what's your question?" },
  { id: "t15-no", text: "Sounds good. Enjoy the rest of your tour!" },
  { id: "t5-offer", text: "Heads up{name?}, your tour of {place} ends in 5 minutes{when?}. Want 10 more minutes? Just reply and ask." },
  { id: "t5-no-offer", text: "Heads up{name?}, your tour of {place} ends in 5 minutes{when?}. Text DONE once you're outside." },
  { id: "t5-bare-yes", text: "Sounds good. Text DONE once you're outside." },
  { id: "extension-granted", text: "You've got 10 more minutes. Your tour now ends at {end}, and your doors will keep opening for you until then." },
  { id: "extension-granted-no-clock", text: "You've got 10 more minutes. Your doors will keep opening for you until then." },
  { id: "extension-unavailable", text: "Sorry, I can't add more time to this tour. It still ends at {end}. If you'd like another look, the {team} can set that up for you." },
  { id: "extension-unavailable-no-clock", text: "Sorry, I can't add more time to this tour. If you'd like another look, the {team} can set that up for you." },
  { id: "extension-used", text: "You've already used your extra 10 minutes{still?}." },
  { id: "extension-after-end", text: "Your tour time has ended, so I can't add more time now. Please head out the way you came in and text DONE once you're outside." },
  { id: "tour-ended-named", text: "Your tour of {place} just ended{name?}. I can't open any more doors for this tour, so please head out the way you came in and text DONE once you're outside." },
  { id: "door-after-end", text: "Your tour time has ended, so I can't open that door. Please head out the way you came in and text DONE once you're outside." },
  { id: "late-arrival", text: "Your tour time has ended, so I can't open doors anymore. Want me to find you another time?" },
  { id: "plus5", text: "Just checking in. Have you left {place}? Text DONE once you're outside." },
  { id: "plus15-phone", text: "Your tour of {place} is now closed. If you're still inside or need a hand, call {phone}." },
  { id: "plus15", text: "Your tour of {place} is now closed. If you're still inside or need a hand, reply here and I'll get someone to help." },
  { id: "after-close-phone", text: "Thanks, I've let the {team} know. If you're still inside or need a hand right away, call {phone}." },
  { id: "after-close", text: "Thanks, I've let the {team} know, and someone will reach out soon." },
  { id: "tour-finished", text: "Thanks for touring {place}{name?}!{recap?} The doors are locked again behind you.\nWould you like someone from the {team} to follow up?" },

  { id: "prompt-yes-no", text: "Reply YES or NO.", suffix: true },
  { id: "prompt-say", text: "Text {phrase} {purpose}.", suffix: true, note: "DONE is sent with no quotes: Text DONE when you're finished. Other phrases stay quoted, as in Text \"I'm here\" when you arrive." },
  { id: "prompt-choose", text: "{menu}", suffix: true, explicitOnly: true },
  { id: "prompt-form-link", text: "{link}", suffix: true, explicitOnly: true },
  { id: "prompt-form-pending", text: "The {team} will send you the form link shortly.", suffix: true },
  { id: "prompt-web-choose", text: "Pick {what} below.", suffix: true },
  { id: "prompt-web-form", text: "The form is just below.", suffix: true },
];

const byId = new Map(TEMPLATES.map((template) => [template.id, template]));

interface Compiled {
  template: VisitorTemplate;
  re: RegExp;
  literalScore: number;
  slots: number;
}

function compile(template: VisitorTemplate): Compiled {
  const parts = template.text.split(/\{[A-Za-z][A-Za-z0-9]*\??\}/);
  const slots = parts.length - 1;
  const literalScore = parts.reduce((n, part) => n + part.length, 0);
  const chunks = template.text.split(/(\{[A-Za-z][A-Za-z0-9]*\??\})/);
  const source = chunks
    .map((chunk) => {
      const slot = /^\{([A-Za-z][A-Za-z0-9]*)(\?)?\}$/.exec(chunk);
      if (!slot) return chunk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return slot[2] ? "([\\s\\S]*?)" : "([\\s\\S]+?)";
    })
    .join("");
  return { template, re: new RegExp(`^${source}$`), literalScore, slots };
}

const MATCHERS = TEMPLATES.filter((template) => !template.explicitOnly && !template.suffix)
  .map(compile)
  .sort((a, b) => b.literalScore - a.literalScore || a.slots - b.slots || a.template.id.localeCompare(b.template.id));

export function listVisitorTemplates(): readonly VisitorTemplate[] {
  return TEMPLATES;
}

export function visitorTemplate(id: string): VisitorTemplate {
  const found = byId.get(id);
  if (!found) throw new UntemplatedVisitorSms(id);
  return found;
}

/** Fill `{slot}` values. Optional slots that are omitted become empty. */
export function renderSms(id: string, slots: Record<string, string | number | undefined> = {}): { templateId: string; body: string } {
  const template = visitorTemplate(id);
  const body = template.text.replace(/\{([A-Za-z][A-Za-z0-9]*)(\?)?\}/g, (_all, name: string) => {
    const value = slots[name];
    return value === undefined || value === null ? "" : String(value);
  });
  if (/\{[A-Za-z][A-Za-z0-9]*\??\}/.test(body)) throw new UntemplatedVisitorSms(body);
  return { templateId: id, body };
}

function slotSpecs(text: string): Array<{ name: string; optional: boolean }> {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)(\?)?\}/g)].map((match) => ({
    name: match[1]!,
    optional: !!match[2],
  }));
}

/**
 * `{rest}` has to be another registered visitor template (its own `{rest}`
 * included). An optional empty rest is fine. Anything else is not a match.
 */
function restsCovered(matcher: Compiled, found: RegExpExecArray, stack: readonly string[]): boolean {
  const specs = slotSpecs(matcher.template.text);
  for (let i = 0; i < specs.length; i++) {
    if (specs[i]!.name !== "rest") continue;
    const value = (found[i + 1] ?? "").trim();
    if (!value) {
      if (!specs[i]!.optional) return false;
      continue;
    }
    if (stack.includes(value)) return false;
    if (!matchCompiled(value, [...stack, value])) return false;
  }
  return true;
}

function matchCompiled(body: string, stack: readonly string[]): Compiled | undefined {
  for (const matcher of MATCHERS) {
    const found = matcher.re.exec(body);
    if (!found) continue;
    if (restsCovered(matcher, found, stack)) return matcher;
  }
  return undefined;
}

/** The registry id for this exact visitor body, before any channel prompt. */
export function matchVisitorTemplate(body: string): string | undefined {
  return matchCompiled(body, [])?.template.id;
}

/**
 * Every prospect send calls this. `explicitId` is required for approved
 * answers and saved profile facts. Anything else must match the registry.
 */
export function claimVisitorSms(body: string, explicitId?: string): string {
  if (explicitId) {
    const template = byId.get(explicitId);
    if (!template) throw new UntemplatedVisitorSms(body);
    if (template.explicitOnly || template.suffix) return explicitId;
    if (matchVisitorTemplate(body) === explicitId || template.text === body) return explicitId;
    const compiled = compile(template);
    const found = compiled.re.exec(body);
    if (found && restsCovered(compiled, found, [])) return explicitId;
    throw new UntemplatedVisitorSms(body);
  }
  const id = matchVisitorTemplate(body);
  if (!id) throw new UntemplatedVisitorSms(body);
  return id;
}

function fence(text: string): string {
  return text.replaceAll("```", "` ` `");
}

/** Checked-in catalog for review. A test fails when this drifts from the registry. */
export function visitorTemplatesMarkdown(): string {
  const messages = TEMPLATES.filter((template) => !template.suffix);
  const suffixes = TEMPLATES.filter((template) => template.suffix);
  const block = (template: VisitorTemplate) => {
    const flags = [template.explicitOnly ? "Explicit id only. Not matched automatically." : "", template.note ?? ""].filter(Boolean);
    return [`### ${template.id}`, "", ...(flags.length ? [flags.join(" "), ""] : []), "```", fence(template.text), "```", ""].join("\n");
  };
  return [
    "# Visitor text templates",
    "",
    "Every outbound visitor text uses one of these ids. `{slot}` is filled before send. `{slot?}` may be empty. A channel prompt may be appended after the body. The stored template id is the body, not the prompt.",
    "",
    "Text from the landlord or from a model reaches a visitor only as `approved-answer` or `approved-answer-closing`, and only after they approve a flagged question (`resolve_issue`). A no-draft flag never gets a draft. `approved-profile-fact` repeats a fact they already saved.",
    "",
    `${messages.length} message templates. ${suffixes.length} channel prompts.`,
    "",
    "## Messages",
    "",
    ...messages.map(block),
    "## Channel prompts",
    "",
    "These are appended by the channel. They are not a second visitor message.",
    "",
    ...suffixes.map(block),
  ].join("\n");
}
