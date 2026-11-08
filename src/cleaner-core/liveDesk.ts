import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ChatGptTaskSink, ClaudeRoutineFireSink, cleaningUpdateEvent, GrokRoutineWebhookSink, testEvent } from "../alerts/operatorEvents";
import { ASSISTANT_PROFILES, CHATGPT_CHECK_GAP_MS, CHATGPT_DESK_WORDING, CHATGPT_TASK, CHATGPT_TASK_CONNECTED, chatGptAsk, CLAUDE_DESK_WORDING, CLAUDE_FIRE_URL, CLAUDE_IMAGE_TYPES, CLAUDE_MAX_IMAGE_BYTES, CLAUDE_MAX_IMAGES, CLAUDE_TASK, claudeAsk, claudeAskNext, cleanerAssistant, GROK_HELPER, MUSE_DESK_WORDING, MUSE_TASK, MUSE_TASK_CONNECTED, museAsk, runsSupplies, taskWarning, type CleanerAssistant, type DeskWording } from "./assistant";
import { currentCaller, withCaller, type CleanerCaller } from "./callerContext";
import { OperatorEventOutbox } from "../alerts/outbox";
import { parsePhone } from "../core/phone";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { ConfirmationBook } from "../operator/confirmations";
import { supplyAskOn } from "../supply-core/store";
import { messagingKeyword, normalize } from "../intent";
import { spokenTimes } from "../core/spokenTime";
import { formatWhen, zonedInstant } from "../hub/calendar";
import { dollarsText, MAX_PAY_REMINDERS, nextReminderAt, payCents, venmoPayLink, venmoProfileLink, venmoUsername, type PaymentSettings, type PayRecord } from "./payments";
import { joinSplitDigits } from "../hub/digits";
import { sameHash, uploadHash } from "../hub/uploadCode";
import { isDeparture, openCleanerCore, redactDigitRuns, SAFETY, storedConsent, type CleanerCore, type CleanerText, type JobStatus, type MessageHandled, type ReceiveResult, type TextKind } from "./core";
import { cleanerMultiTenant, groupChatEnabled } from "./flag";
import { GROUP_RECIPIENT, draftStatus, earlierThan, replyStateAt, type ReplyState, type StoredDraft } from "./replies";
import { publicBaseUrl } from "../messaging/publicUrl";
import { CLEANER_PHOTO_PREFIX, cleanerPhotoFetch, downloadPhotos, dropPhotos, MESSAGE_PHOTO_KEEP_MS, messagePhotoId, photoCount, photoKey, photoLinks, prunePhotos, servePhoto, storePhotos, type InboundMedia } from "./photos";
import { calendarUrlAllowed, type CalendarFetch } from "../hub/fetchLimits";
import { setCalendarFetch } from "../hub/calendarFetch";
import { forgetHub, hubFor, resetHubs, type Hub, type HubSave, type UploadResult } from "../hub/hub";
import type { HubProperty } from "../hub/store";
import { DOOR_CODE_IN_CHAT, LEGACY_CALENDAR, MAX_CALENDARS, maskedLink, setAsideLine, type StoredCalendar } from "../hub/calendars";
import { allTimesAsk, askNext, DOOR_CODE_STEP, DRAFT_CONFIRM, DRAFT_FILL, DRAFT_NEXT, moreSourcesAsk, PAYMENTS_STEP, peopleAsk, PREFERENCES_STEP, propertyAsk, SCHEDULE_STEP, sourcesAsk, START_ASK, SUPPLIES_STEP, type SetupAsk, type SetupDraft } from "./setupAsk";
import { cleanerOptOutHold, hostStartReply, hostStopReply, isPrivateCodeLine, jobHoldLine, optedOutCodeLine, resumeNote } from "./cleanerTexts";
import { isInjuryReport } from "./injury";
import { GroupNotConfirmed } from "./groupThread";
import { cleanerPinStatusUrl, deleteLiveGroup, landlordConfirmed, liveSmsOn, mayText, sendLiveGroup, sendLiveSms, verifiedLandlordPhone } from "./liveSms";
import { DOOR_CODE_SHAPE_REFUSED, LOCK_LOCATION_REFUSED, PIN_KEY_MISSING, serverPinKey, UPLOAD_LINK_OFF, type AccessRefusal, type DoorAccess } from "../hub/doorAccess";
import { DOOR_WINDOW_OVER, type AccessRefusedLines, type DoorAccessPort } from "./doorPort";
import { accountOf, peopleFor, resetPeople, streetOf, type MoveSource, type People, type PersonChange, type Role } from "../hub/people";
import { containsCodeToken, redactPhone } from "./redact";
import { isScratchTestNumber } from "./scratch";
import { guestyLiteSource, icalSource, type BookingSource, type GoogleEventList } from "../hub/sources";
import {
  SCRATCH_NUMBER_REFUSAL,
  SCRATCH_PROPERTY_REFUSAL,
  SCRATCH_GROUP_KEPT,
  SCRATCH_RESET_LINE,
  SCRATCH_STATUS_NEEDED,
  SCRATCH_TEST_WENT_THROUGH,
  SCRATCH_TEXT_MISSING,
  SCRATCH_TEXT_NEEDED,
  SCRATCH_WHICH_NEEDED,
  inboxLine,
  isDeliveryReport,
  isScratchPropertyAddress,
  outboxLabel,
  outboxLine,
  scratchToolsOn,
  whoTheyAre,
  type DeliveryReport,
} from "./scratchQa";

export const FIRST_QUESTION =
  "What do you want help with? 1) Letting renters tour a unit on their own, or 2) Scheduling cleaners between guest stays.";

const TOUR_PICK = "That's Tour Core. It lets renters tour a unit on their own.";
const CLEANER_PICK = "That's Cleaner Core. It schedules cleaners between guest stays.";
const ROUTINE_ASK =
  "Create the Cleaner Core Check and Cleaner Core Alerts routines. Only the host can see the Alerts routine's webhook address and key. Right after you create it, without waiting to be asked, send the host a link that opens the Alerts routine's Webhook URL field directly and one that opens its Webhook key field directly, with one secure card for each, the address first. Never send a link to the Routines page, and never tell the host to open Routines and pick the routine: opening the routine from there doesn't show its Webhook URL. Keep it to three short steps: open the link, copy the value, paste it in the card. Then call save_alert_routine with no arguments to get a one-time upload link, and send both values to that link from your own computer. Never put them in chat.";
const REVIEW_ASK = "Summarize this setup for the host in your own words, then ask them to reply Activate.";
const PICK_FIRST = "Tell me which job you want help with first.";

/** "a, b, and c" */
function listText(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const UPDATE_HELD = "Times saved. I'll send the cleaner the new time in about a minute. If the time changes again before then, they get only the last one.";
const PIN_SENT_GROUP = "I posted the door code in the cleaning group for the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const PIN_REENTER = "Please enter the door code again in the private box. Don't text it here.";
export { DOOR_CODE_IN_CHAT };
const DIRECT_TEXT_REPLY = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
const ROUTINE_SAVED = "Alerts are connected. I queued a test alert for the routine.";
/** Activate's refusal while the routine's test wake-up hasn't gone through. The reason and the fix follow. */
const ACTIVATE_WAITS_FOR_WAKE = "Nothing was texted: Activate waits until Cleaner Core's test wake-up reaches the alert routine.";
/** A test wake-up that is saved but hasn't been tried yet. */
const WAKE_NOT_TRIED = "The test wake-up hasn't gone through yet.";
const ROUTINE_SAVED_IN_SETUP = `${ROUTINE_SAVED} Then call get_state for the review.`;
const NOT_ACTIVE_YET = "Cleaner Core isn't active yet. Post nothing.";
const ROUTINE_NEEDED =
  "Send the routine's https address and its key. If your secure card can't pass them to a tool, call save_alert_routine with no arguments to get a one-time upload link.";
/** Where Grok's own computer posts the routine's address and key. The rest of the path is the one-time code. */
export const ALERT_UPLOAD_PREFIX = "/cleaner-core/alert-routine/";
const CALENDAR_UPLOAD_NEXT =
  'From your own cloud computer, POST JSON {"url": "<calendar link>"} to uploadUrl with Content-Type: application/json, using the link from your secure card. Never put it in chat or in a tool argument. Then call get_state to confirm.';
const DOOR_CODE_UPLOAD_NEXT =
  'From your own cloud computer, POST JSON {"code": "<door code>"} to uploadUrl with Content-Type: application/json, using the code from your secure card. Never put it in chat. Then call get_state to confirm.';
/** A tool got a secure card's placeholder instead of the door code. */
const MASKED_CODE =
  "That door code came through masked, so I didn't save it. Call save_door_code with no code to get a one-time upload link, and post the code to it from your own computer.";
/** A tool got a secure card's placeholder instead of the link. */
const MASKED_LINK =
  'That link came through masked, so I didn\'t save it. A secure card can\'t pass a value to a tool. Call save_sources with uploadLink: { name: "Guesty Lite" } (or the calendar\'s name) and post the link to the upload link from your own computer.';
const UPLOAD_MINUTES = 10;
const UPLOAD_NEXT =
  'From your own cloud computer, POST JSON {"url": "<webhook address>", "token": "<webhook key>"} to uploadUrl with Content-Type: application/json, using the webhook address and key you already hold. Never put them in chat or in a tool argument. Then call get_state to confirm.';
/** A Grok deployment's wording. Claude, ChatGPT, and Muse deployments use their own DeskWording. */
const GROK_DESK_WORDING: DeskWording = {
  helper: GROK_HELPER,
  pinFailed: PIN_FAILED,
  directTextReply: DIRECT_TEXT_REPLY,
  routineAsk: ROUTINE_ASK,
  routineNeeded: ROUTINE_NEEDED,
  calendarUploadNext: CALENDAR_UPLOAD_NEXT,
  doorCodeUploadNext: DOOR_CODE_UPLOAD_NEXT,
  alertUploadNext: UPLOAD_NEXT,
  maskedCode: MASKED_CODE,
  maskedLink: MASKED_LINK,
};
/** Each deployment's wording, by its chat. */
const DESK_WORDING: Record<CleanerAssistant, DeskWording> = { grok: GROK_DESK_WORDING, claude: CLAUDE_DESK_WORDING, chatgpt: CHATGPT_DESK_WORDING, muse: MUSE_DESK_WORDING };
const UPLOAD_CONNECTED = "Alerts are connected.";
const UPLOAD_REFUSED = "Send the routine's https webhook address as url and its key as token.";
const UPLOAD_GONE = "This upload link isn't valid anymore. Call save_alert_routine with no arguments for a new one.";
const GOOGLE_UNREAD = "I couldn't read those Google Calendar events. Read Google Calendar again and pass its events.";
const NO_OPEN_CLEANING = "There's no open cleaning to save an arrival time for.";
const TIMES_NEEDED = "Send the checkout time and the next check-in time the host stated, as 24-hour HH:MM, like 10:30 and 15:00.";
const DEPARTURE_NEEDED = "Ask the host whether the guests have left. Call again with confirmed true only after the host says yes. I won't guess from the calendar.";
const NO_DEPARTURE_JOB = "There's no confirmed cleaning waiting for the door code right now.";
const RETRY_NEEDED = "Ask the host whether to send it again. Call again with confirmed true only after the host says yes.";
const RETRY_SENT = "Sent it to the cleaner once more.";
const RETRY_NOTHING = "Nothing is waiting to be sent again.";
const ARRIVAL_NEEDED = "Send the arrival time as 24-hour HH:MM, like 11:30 or 14:00.";
const ARRIVAL_SAVED = "Saved the cleaner's arrival time.";
const NO_PHOTO_JOB = "There's no cleaning with that day to get photos for.";
const PHOTO_LINKS_OFF = "I can't make photo links until the server's public address is saved.";
/** A kept message's text for an MMS photo. */
const PHOTO_MARK = "[photo]";
/** A host message is 1 to 600 characters, and at most 10 go out in any hour. */
const MAX_HOST_MESSAGE = 600;
const HOST_MESSAGES_PER_HOUR = 10;
const HOUR_MS = 60 * 60_000;
/**
 * Twilio hands one group reply to both the group's webhook and the cleaning number's SMS webhook,
 * each with its own sid. The same words from the same person on the other path this soon after
 * are that second copy.
 */
const SECOND_COPY_MS = 5 * 60_000;
/** The approval action for a host message. Its target is the recipient, its fingerprint the recipient and the exact text. */
const SEND_ACTION = "cleaner-message";
const MESSAGE_NEEDED = `Write the message in 1 to ${MAX_HOST_MESSAGE} characters.`;
export const DRAFT_UNKNOWN = "I don't have that message. Call check_now and use a message id it returned.";
export const DRAFT_GONE = "That draft was sent, dropped, or already answered. Call check_now for the drafts still waiting.";
export const ALREADY_ANSWERED = "The host already answered that message. Drop the draft and tell the host nothing more about it.";
export const ANSWER_NEEDED = "Tell me the topic and the answer, in the host's words.";
export const ANSWER_TOO_LONG = `Keep the answer to ${MAX_HOST_MESSAGE} characters.`;
export const TOPIC_TOO_LONG = "Keep the topic to a few words.";
export const NO_SUCH_ANSWER = "There's no saved answer for that topic.";
const MAX_TOPIC = 60;
const SAVE_ANSWER_ACTION = "cleaner-saved-answer";

/** An answer the host saved for next time. */
interface SavedAnswer {
  topic: string;
  answer: string;
}

export const DRAFT_RECIPIENT_CHANGED = "The person this draft was for has changed. Drop it, and draft again from the newest messages.";
export const DRAFT_NOT_IN_GROUP = "That came to Cleaner Core one-to-one from someone outside the group, and with a group, replies go only to the group. Tell the host to answer them directly.";
export const CODE_IN_SAVED_ANSWER = (topic?: string): string =>
  topic
    ? `Those digits are in the saved answer for "${topic}". Change or forget that answer with save_answer, then save the door code again.`
    : "Those digits are in a saved answer. Change or forget it with save_answer, then save the door code again.";
export const CODE_IN_DRAFT = "Those digits are in a reply draft waiting to be sent. Send it or drop it with save_draft, then save the door code again.";
/** Setup saves in any order, so the cleaner's notes can be saved before the door code. */
export const CODE_IN_PREFERENCES = "Those digits are in the saved checklist or the note for the cleaner. Change them with save_preferences, then save the door code again.";
export const CODE_IN_SAVED_SETUP = "Those digits are in a name or a setting saved for this setup. Change it, then save the door code again.";
export const DRAFT_NEW_SINCE = "Something new came in since this draft. Read it with check_now, then save a new draft or drop this one.";
const RECIPIENT_NEEDED = "Say who to text: the cleaner, the group, or a saved contact's name.";
const NO_GROUP = "There's no group chat for this property.";
const GROUP_ONLY = "Messages go to the group. Send it with to: group.";
/** Nobody on the account is texted until the saved host is the landlord's confirmed phone (saadvz/PropertyCore#164). */
const HOST_UNCONFIRMED = "I can text only after the host's phone is confirmed. Save the phone you confirmed when you signed in as the host's number.";
const CLEANER_IS_LINE = "The cleaner's number is one of this service's own lines. Save the cleaner's own phone.";
const DOOR_CODE_QUESTION = "You added other people to the group. Should the door code go to the whole group, or only privately to the cleaner?";
const TOO_MANY = "That's a lot of messages this hour. Try again later.";
/** The approval action for a property reset. It is bound to this property's group, so a changed group voids it. */
const RESET_ACTION = "cleaner-reset-property";
const PAYMENTS_ACTION = "cleaner-payments";
const RATE_HELP = "Tell me the pay per cleaning, from $1 to $1,000.";
const CODE_IN_USERNAME = "That username has the door code in it, so I can't save it. Ask the host to pay the cleaner in Venmo themselves.";
const NOT_OWED = "That cleaning isn't waiting on pay.";
const PAID_NEEDS_YES = "Ask the host first. Call mark_paid with confirmed true only after they say it's paid.";
const VENMO_HELP = "Tell me the cleaner's Venmo username, like @maria-cleans. A phone number or email won't work.";
const HOLD_ACTION = "cleaner-hold";
const RESUME_ACTION = "cleaner-resume";
const CLEANING_TARGET = "cleaning";
const STAND_DOWN_ACTION = "cleaner-stand-down";
const UNDER_WAY = "A cleaning is under way. Stand down after it's done.";
const NOTHING_LIVE = "Nothing is live on cleaning, so there's nothing to stand down. You can switch now.";
const STOOD_DOWN = "Cleaning is stood down. Nothing is live, so you can switch now.";
const LIVE_WORDS: Partial<Record<JobStatus, string>> = {
  offered: "offered",
  confirmed: "confirmed",
  awaiting_departure: "waiting for the guests to leave",
  cleared: "cleared for the cleaner",
  in_progress: "under way",
};
const ALREADY_HELD = "The cleaning is already on hold. Resume it with resume_job when the host says so.";
const RESET_TARGET = "property";
const RESET_GROUP_KEPT = "I couldn't remove the group text on Twilio, so nothing was reset. Try again in a few minutes.";
const RESET_NOT_DONE = "I couldn't reset Cleaner Core just now, so nothing else was changed. Try again in a few minutes.";
const RESET_UNFINISHED = "I couldn't finish resetting Cleaner Core. Try reset_property again.";
const ROUTINE_SECRETS = ["CLEANER_CORE_ROUTINE_URL", "CLEANER_CORE_ROUTINE_KEY"] as const;
const APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";
/** Messages kept for Grok, newest last. */
const MAX_MESSAGES = 200;
const MAX_MESSAGE_TEXT = 300;
/** The receive reasons that mean the engine did not take the text at all, so no message is kept. */
const UNREAD_REASONS = new Set<ReceiveResult["reason"]>(["disabled", "duplicate", "scratch-only", "wrong-tenant"]);
const MAX_CONTACTS = 4;
const MAX_NAME = 40;
const MAX_CHECKLIST = 12;
const MAX_CHECKLIST_ITEM = 80;
const MAX_INSTRUCTIONS = 300;
const MIN_SCHEDULE_DAYS = 1;
const MAX_SCHEDULE_DAYS = 14;
/** A timed first cleaning text goes at this local time on its day. */
const FIRST_TEXT_TIME = "09:00";
const FIRST_TEXTS = ["when-confirmed", "days-after-check-in", "days-before-checkout"] as const;
const REMINDERS = ["morning-of", "days-before-checkout"] as const;
/**
 * The saved reminder's trigger id. It stays the same when its kind changes, so a reminder already
 * sent is not sent again. A reminder sent under the engine's default id counts too.
 */
const SCHEDULED_REMINDER = "scheduled";
const DEFAULT_REMINDER = "morning-of";
const DEFAULT_SCHEDULE: Schedule = { firstText: "days-before-checkout", firstTextDays: 1, reminder: "morning-of", reminderTime: "08:00" };
const CONTACT_ROLES = ["co-host", "assistant", "observer"] as const;
const GROUP_CHOICES = ["cleaner-only", "cleaner-and-host", "everyone"] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number];
export type GroupChoice = (typeof GROUP_CHOICES)[number];

interface Contact {
  name: string;
  role: ContactRole;
  phone: string;
}

/** The messaging schedule. Times are "HH:MM". */
interface Schedule {
  firstText: (typeof FIRST_TEXTS)[number];
  /** Days after check-in, or days before checkout, for the timed first texts. */
  firstTextDays?: number;
  reminder: (typeof REMINDERS)[number];
  /** Days before checkout, for days-before-checkout. */
  reminderDays?: number;
  reminderTime: string;
  quietFrom?: string;
  quietUntil?: string;
  /** Who should hear about problems. Recorded for the review; problems still go to the host. */
  escalateTo?: string;
}

interface Preferences {
  checklist: string[];
  photosRequired: boolean;
  supplyNotes: boolean;
  instructions?: string;
}

/**
 * An inbound text from the cleaner, the host in the group, or a saved contact, for Grok to read.
 * A message the host approved and Cleaner Core sent is kept too, from host with handled sent.
 */
interface Message {
  /** Letters only, so an id can never hold a run of digits like a door code. */
  id: string;
  from: "cleaner" | "host" | "contact";
  name: string;
  /** Who a sent host message went to, like Ana or the group. */
  to?: string;
  /** Who a sent host message reached, for reply tracking: "group", "cleaner", or "contact:<name>". Not shown. */
  target?: string;
  /** Trimmed to 300 characters, with every run of 4 or more digits redacted. */
  text: string;
  /** Local time at the property, like "Wednesday, Oct 14, 11:00 AM". */
  at: string;
  handled: MessageHandled;
  /** Set when the text came in the group. */
  channel?: "group";
  /** How many of its photos were kept, for check_now's links. Never returned as is. */
  photos?: number;
  /** When its photos were kept, so they are deleted 7 days later. */
  photosAt?: string;
}

/** An inbound text or MMS. */
interface Inbound {
  id: string;
  from: string;
  text: string;
  channel?: "group";
  media?: InboundMedia[];
}

interface PinSend {
  sid: string;
  outcome: "accepted" | "undelivered" | "settled";
  notePending: boolean;
  delivered?: boolean;
}

interface PropertyInput {
  address?: string;
  business?: string;
  timeZone?: string;
  nickname?: string;
  propertyType?: string;
  checkoutTime?: string;
  checkInTime?: string;
}

interface PeopleInput {
  host?: string;
  /** What the group calls the host. Unset reads as the business name. */
  hostName?: string;
  cleaner?: string;
  observer?: string;
  cleanerName?: string;
  contacts?: { name?: string; role?: string; phone?: string }[];
  groupChat?: string;
  /** Who gets the door code once others are in the group. */
  doorCodeTo?: string;
  /** The host confirmed a person already on another property (saadvz/PropertyCore#190). The hosted layer reads it; the desk ignores it. */
  shared?: boolean;
}

interface SourcesInput {
  calendars?: { name?: string; url?: string }[];
  google?: boolean;
  dropJobs?: boolean;
  /** Makes a one-time upload link for a calendar link that is on Grok's secure card. */
  uploadLink?: { name?: string };
  /** The host has no more booking calendars to add. */
  done?: boolean;
}

interface ScheduleInput {
  firstText?: (typeof FIRST_TEXTS)[number];
  firstTextDays?: number;
  reminder?: "morning-of" | "days-before-checkout";
  reminderDays?: number;
  reminderTime?: string;
  quietFrom?: string;
  quietUntil?: string;
  escalateTo?: string;
}

export interface ToolOk {
  ok: true;
  result: Record<string, unknown>;
}

export interface ToolNo {
  ok: false;
  error: string;
  /** Details for Grok beside the refusal, such as the cleanings a save would call off. */
  result?: Record<string, unknown>;
}

export type ToolReply = ToolOk | ToolNo;

/** Saves the alert routine's address and key to the secret store. */
type SaveRoutine = (values: { CLEANER_CORE_ROUTINE_URL: string; CLEANER_CORE_ROUTINE_KEY: string }) => void;
/** Saves a new photo link key to the secret store. */
type SavePhotoKey = (values: { CLEANER_CORE_PHOTO_KEY: string }) => void;
/** A one-time upload link's answer. */
type UploadReply = { status: 200 | 400 | 404; body: { ok: boolean; message?: string; error?: string } };

/**
 * Cleaner Core's own record for one property. The property's details (nickname, address, type, time
 * zone, usual times) and its booking calendars live in the property hub (src/hub), shared with Supply
 * Core; this file no longer holds them.
 */
interface LiveFile {
  choice?: "tours" | "cleaners";
  business?: string;
  propertyId?: string;
  host?: string;
  /** What the group calls the host. Unset reads as the business name. */
  hostName?: string;
  cleaner?: string;
  cleanerName?: string;
  /** The legacy single observer from save_people. It reads as one contact named Observer. */
  observer?: string;
  contacts?: Contact[];
  /** Unset keeps every saved contact in the group, as before the choice existed. */
  groupChat?: GroupChoice;
  /** The landlord's door-code choice when contacts share the group. */
  doorCodeTo?: "group" | "cleaner";
  /** Set once the host saved a messaging schedule, or kept the defaults. */
  schedule?: Schedule;
  /** Set once the host saved cleaning preferences or said there are none. */
  preferences?: Preferences;
  /** Set once the host answered the Payments step, or turned payments on later. */
  payments?: PaymentSettings;
  /** Set once the host answered whether to set up Supply Core, or turned it on. */
  suppliesAsked?: boolean;
  /** When the agent showed the host the setup draft and saved their changes (get_state drafted: true). */
  drafted?: string;
  /** Each finished cleaning's pay, by job id, once it became owed. */
  pay?: Record<string, PayRecord>;
  /**
   * Set when this setup connected the alert routine. An address left in the secret store or the
   * environment by an earlier setup doesn't count, so the routine step is asked again.
   */
  routineConnected?: boolean;
  /** On a multi-tenant service, the connections (grant ids) that connected their own routine. */
  routineConnections?: string[];
  /** When check_now or the checks last ran. A ChatGPT deployment warns when its hourly task stops. */
  lastCheckAt?: string;
  /** The pending alert upload link: the sha256 of its code and when it expires. Never the code. */
  alertUpload?: { hash: string; expiresAt: string; by?: CleanerCaller };
  pinSend?: PinSend;
  texting?: boolean;
  /**
   * Phones that texted STOP to the account's shared line before they were saved here. Nothing is sent
   * to them until they text START or YES.
   */
  lineOptOuts?: string[];
  checked?: boolean;
  /** Ids of the host notes `check_now` has already returned, or that the host saw before it. */
  alertsShown?: string[];
  /** Ids of the host notes that already woke the cleaning routine. */
  alertsQueued?: string[];
  /** The failed wake-up check_now already told the host about, so each problem is told once. */
  wakeProblemShown?: string;
  /** The last 200 inbound messages, oldest first. */
  messages?: Message[];
  /** Ids of the messages `check_now` has already returned. */
  messagesShown?: string[];
  /** Reply drafts waiting for the host's Send. They send nothing by themselves and never expire. */
  drafts?: StoredDraft[];
  /** The host's own answers, saved on their yes, for the next draft to use word for word. */
  savedAnswers?: SavedAnswer[];
  /** Ids of the finished cleanings `check_now` has already returned as completed. */
  completedShown?: string[];
  released?: boolean;
  /** Ids of the jobs the host gave both times for through confirm_times. */
  timedJobs?: string[];
  cleanerOut?: boolean;
  hostOut?: boolean;
  seenInbound?: string[];
  conversationSid?: string;
  deliveries?: { id: string; status: DeliveryReport }[];
  localSends?: { id: string; to: string; kind: TextKind; status: DeliveryReport; body?: string }[];
}

interface CalendarRead {
  /** The legacy Guesty Lite link did not read. */
  guestyFailed: boolean;
  /** Why the first failed link did not read. Never the URL. */
  reason?: string;
  googleUnread: boolean;
  /** Names of the calendar links that were not applied. Never a URL. */
  unread: string[];
  /** Set when nothing was applied because calendars are set aside and the saved list would call off this many cleanings. */
  held?: number;
}

interface OutboxRow {
  id: string;
  kind: TextKind;
  local: boolean;
  label: string;
  line: string;
  status: string;
  body: string;
}

/** Tests stub the calendar read. Unset uses the platform fetch. */
export function setCleanerCalendarFetch(fetchImpl: CalendarFetch | undefined): void {
  setCalendarFetch(fetchImpl);
}

type AlertFetch = NonNullable<NonNullable<ConstructorParameters<typeof GrokRoutineWebhookSink>[1]>["fetch"]>;

let alertFetch: AlertFetch | undefined;

/** Tests stub the routine webhook. Unset uses the platform fetch. */
export function setCleanerAlertFetch(fetchImpl: AlertFetch | undefined): void {
  alertFetch = fetchImpl;
}

/**
 * How long a checkout change after the offer waits before the cleaner's update goes. A quick second
 * change then sends one text, and a change back sends none.
 */
const UPDATE_SETTLE_MS = 60_000;
let updateSettle: number | undefined;

/** Tests set the hold. Unset is one minute. */
export function setCleanerUpdateSettle(ms: number | undefined): void {
  updateSettle = ms;
}

const desks = new Map<string, LiveDesk>();

/**
 * One desk per state folder. The first caller's env getter is kept, so the server passes a live
 * one (`() => installation.env()`) and a secret saved later is seen at once.
 */
export function liveDeskFor(root: string, env: () => NodeJS.ProcessEnv, now: () => Date): LiveDesk {
  const existing = desks.get(root);
  if (existing) return existing;
  const desk = new LiveDesk(root, env, now);
  desks.set(root, desk);
  return desk;
}

/** Delivers the cleaning routine's pending wake-ups. The server's retry timer calls this. */
export async function drainCleanerAlerts(root: string, env: () => NodeJS.ProcessEnv, now: () => Date): Promise<void> {
  await liveDeskFor(root, env, now).drainAlerts();
}

/**
 * Tells every other open desk on the account about a person's YES, STOP or START. A desk that isn't open
 * applies the account's state when its engine next opens.
 */
async function relayToOpenDesks(accountRoot: string, change: PersonChange): Promise<void> {
  for (const propertyId of change.properties) {
    if (propertyId === change.from) continue;
    const desk = desks.get(join(accountRoot, "properties", propertyId));
    if (!desk) continue;
    // One desk that can't apply it doesn't stop the others. It applies the account's state when its engine next opens.
    try {
      if (change.kind === "opted-in") await desk.accountOptIn(change.phone);
      else if (change.kind === "stopped") await desk.accountStop(change.phone);
      else await desk.accountStart(change.phone);
    } catch {
      continue;
    }
  }
}

export function resetLiveDesks(): void {
  desks.clear();
  resetHubs();
  resetPeople();
}

/** Drops one state folder's desk, so nothing keeps working on a folder that is being removed. */
export function forgetLiveDesk(root: string): void {
  desks.delete(root);
  forgetHub(root);
}

function statedClock(text: string): boolean {
  return Boolean(spokenTimes(normalize(text))[0]?.meridiem);
}

/** Characters a secure card shows in place of a value it hides. */
const MASK_MARK = /[*\u2022\u25cf\u00b7]/;

/** True when a key is a masked placeholder: mask characters, or one character repeated. */
function maskedValue(token: string): boolean {
  return MASK_MARK.test(token) || /^(.)\1*$/su.test(token) || /^[xX]+$/.test(token);
}

/** What check_now and run_checks say while set-aside calendars hold the saved list back. */
function calendarsHeld(count: number): string {
  const cleanings = `${count} upcoming ${count === 1 ? "cleaning" : "cleanings"}`;
  return `Calendars are set aside for this property, and its saved calendar list would call off ${cleanings}. Ask the host: to add a set-aside calendar, send its link again with save_sources uploadLink; to keep the list as it is, call save_sources with done: true and dropJobs: true.`;
}

/** Stamps a read with the hash of the link it came from. */
function fromLink(source: BookingSource, origin: string): BookingSource {
  return { kind: source.kind, read: async () => ({ ...(await source.read()), origin }) };
}

/** A 24-hour "HH:MM" from a tool argument, or undefined. Grok turns the host's words into this; nothing here reads words. */
function hourMinute(text: string | undefined): string | undefined {
  const value = text?.trim() ?? "";
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined;
}

/** "HH:MM" as minutes after midnight. */
function minutesOfDay(hm: string): number {
  const [hour = 0, minute = 0] = hm.split(":").map(Number);
  return hour * 60 + minute;
}

/** "HH:MM" as "10:30 AM". */
function clockText(hm: string): string {
  const [hour = 0, minute = 0] = hm.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** A setup question as this chat shows it. Grok's is shown as it is. */
function askFor(assistant: CleanerAssistant, ask: SetupAsk): SetupAsk {
  return assistant === "muse" ? museAsk(ask) : assistant === "chatgpt" ? chatGptAsk(ask) : assistant === "claude" ? claudeAsk(ask) : ask;
}

/** The saved extra contacts. A legacy observer reads as one contact named Observer and comes first. */
function contactsOf(file: LiveFile): Contact[] {
  return [...(file.observer ? [{ name: "Observer", role: "observer" as const, phone: file.observer }] : []), ...(file.contacts ?? [])];
}

/** A message id of 16 random lowercase letters. It never holds a digit. */
function messageId(): string {
  return `m-${[...randomBytes(16)].map((byte) => String.fromCharCode(97 + (byte % 26))).join("")}`;
}

function propertyIdFor(business: string): string {
  const slug = business.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "property";
  return `live-${slug}`;
}

type JobView = ReturnType<CleanerCore["jobs"]>[number];

/** A job has its times when it has a checkout time, and a next check-in time if a next stay is booked. */
function hasTimes(job: JobView): boolean {
  return Boolean(job.checkoutTime && (job.nextCheckInTime || !job.nextCheckInDate));
}

/** A job that is called off, declined, started, or done: never timed again. */
const CLOSED_STATUSES = new Set(["canceled", "declined", "in_progress", "done"]);

/**
 * The job confirm_times would time: the first one that is not called off, declined, started, or done.
 * A finished cleaning is never timed again, so a later booking is the one asked about.
 */
function timesTarget(engine: CleanerCore): JobView | undefined {
  return engine.jobs().find((job) => !CLOSED_STATUSES.has(job.status));
}

export class LiveDesk {
  private file: LiveFile = {};
  private readonly hub: Hub;
  /** The hub's property revision the engine was opened with. */
  private engineRevision = 0;
  /** The door-code key from the call that made the calendar upload link, so the upload can check the link. */
  private calendarUploadKey: Buffer | undefined;
  private pin: string | undefined;
  /** Why the hub refused door access during this call, for mark_guests_left's reply. */
  private accessRefusal: AccessRefusal | undefined;
  private engine: CleanerCore | undefined;
  /** The account this property belongs to, when its folder is an account's property folder (saadvz/PropertyCore#190). */
  private readonly account: { accountRoot: string; propertyId: string } | undefined;
  /** The account's people: their one YES and their own STOP, for every property they're on. */
  private readonly people: People | undefined;
  /** The engine the account's opt-in and STOP were last applied to. */
  private appliedTo: CleanerCore | undefined;
  /** A setup save changed what the engine reads when it opens. The next serial step reopens it. */
  private stale = false;
  private checking = false;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private held = false;
  private readonly path: string;
  private readonly alerts: OperatorEventOutbox;
  /** Approvals for host messages, payments and other changes. Kept in the folder, so a restart keeps them. */
  private readonly approvals: ConfirmationBook;
  /** Approvals for saved drafts. They never expire and are tagged with the draft's id, so they leave with it. */
  private readonly draftApprovals: ConfirmationBook;
  /** The door-code key of the call that made the pending upload link. Only in memory. */
  private uploadKey: Buffer | undefined;

  constructor(
    private readonly root: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly now: () => Date,
  ) {
    this.path = join(root, "cleaner-live.json");
    // The hub moves any old fields out of cleaner-live.json before this desk reads it, so the desk
    // never holds them in memory to write back.
    this.hub = hubFor(root, { now });
    this.account = accountOf(root);
    this.people = this.account ? peopleFor(this.account.accountRoot, { now }) : undefined;
    const accountRoot = this.account?.accountRoot;
    if (accountRoot) this.people?.onChange((change) => relayToOpenDesks(accountRoot, change));
    this.approvals = new ConfirmationBook(10 * 60_000, () => this.now().getTime(), { file: join(root, "cleaner-approvals.json") });
    this.draftApprovals = new ConfirmationBook(Number.POSITIVE_INFINITY, () => this.now().getTime(), { file: join(root, "cleaner-draft-approvals.json") });
    this.load();
    // With the server's key, a saved code opens at load, so a redeploy doesn't ask for it again.
    this.openSeal();
    // The hub's checks on a calendar posted to its upload link, from either flow. The door code is
    // checked whenever this desk exists; cleanings are guarded only while Cleaner Core is on for the
    // property (the shared service sets CLEANER_CORE_ENABLED to 0 for a property with cleaning off).
    this.hub.useGuards(() => ({
      carriesCode: (text) => {
        this.openSeal(this.calendarUploadKey);
        return this.carriesCode(text) || this.leaks(text);
      },
      leaks: (text) => this.leaks(text),
      codeRefused: (code, lockLocation) => this.codeRefused(code, lockLocation),
      wouldCancel: (claims) =>
        this.env().CLEANER_CORE_ENABLED?.trim() === "0"
          ? Promise.resolve([])
          : this.serial(async () => {
              this.resume();
              return (this.engine?.wouldCancel(claims) ?? []).map((job) => job.checkoutDate);
            }),
    }));
    // The routine's address and key are read from the env on every delivery, never saved here.
    this.alerts = new OperatorEventOutbox(
      new FileRuntimeStore(join(root, "cleaner-alerts")),
      () => {
        // Only a routine this setup connected gets wake-ups. Until then they wait.
        const settings = {
          url: () => (this.file.routineConnected ? this.env().CLEANER_CORE_ROUTINE_URL?.trim() || undefined : undefined),
          key: () => (this.file.routineConnected ? this.env().CLEANER_CORE_ROUTINE_KEY?.trim() || undefined : undefined),
        };
        const options = alertFetch ? { fetch: alertFetch } : {};
        // A Claude deployment's routine is a scheduled task's API trigger, which takes { text }.
        if (this.primaryAssistant() === "claude") return new ClaudeRoutineFireSink(settings, options);
        // A ChatGPT or Muse task can't be woken. Its hourly run reads everything with check_now.
        if (this.polledTask(this.primaryAssistant())) return new ChatGptTaskSink(() => this.routineReady());
        return new GrokRoutineWebhookSink(settings, options);
      },
      { now: () => this.now().getTime() },
    );
  }

  /**
   * Saves the cleaning routine's webhook address and token through `save` (the secret store) and
   * queues a test wake-up. Neither value is kept in this desk's file or repeated in the reply.
   * The door-code key is never accepted as the token.
   */
  saveAlertRoutine(
    input: { url?: string; token?: string },
    save: SaveRoutine,
    pinKey?: Buffer,
  ): Promise<ToolReply> {
    return this.serial(async () => this.saveAlertRoutineNow(input, save, pinKey));
  }

  private saveAlertRoutineNow(
    input: { url?: string; token?: string },
    save: SaveRoutine,
    pinKey: Buffer | undefined,
  ): ToolReply {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    const token = typeof input.token === "string" ? input.token.trim() : "";
    // A ChatGPT or Muse task has no address or key: the chat made it, and no values connects it.
    if (this.polledTask(this.assistant())) return url || token ? this.fail(this.words().routineNeeded) : this.connectTask();
    // A Grok Bot's secure card can't fill a tool argument, so no values means: make an upload link.
    if (!url && !token) return this.issueUpload(pinKey);
    if (this.routineRefused(url, token, pinKey)) return this.fail(this.words().routineNeeded);
    this.connectRoutine(url, token, save);
    return this.reply({ next: this.cleaningState().next === REVIEW_ASK ? ROUTINE_SAVED_IN_SETUP : ROUTINE_SAVED });
  }

  /** Connects a ChatGPT or Muse deployment's hourly task. There is no test wake-up: nothing can wake it. */
  private connectTask(): ToolReply {
    this.file.routineConnected = true;
    this.noteRoutineConnection();
    this.persist();
    const inSetup = this.cleaningState().next === REVIEW_ASK;
    const connected = this.assistant() === "muse" ? MUSE_TASK_CONNECTED : CHATGPT_TASK_CONNECTED;
    return this.reply({ next: inSetup ? `${connected} Then call get_state for the review.` : connected });
  }

  /**
   * True when the address isn't a safe https one, either value is a masked placeholder, the key is
   * short, or the key holds the door code or is a door-code key.
   */
  private routineRefused(url: string, token: string, pinKey: Buffer | undefined): boolean {
    if (!calendarUrlAllowed(url) || MASK_MARK.test(url)) return true;
    // A Claude deployment wakes only a scheduled task's Fire URL, the one shape its sink speaks.
    if (this.claude() && !CLAUDE_FIRE_URL.test(url)) return true;
    if (token.length < 8 || maskedValue(token)) return true;
    if (pinKey && (token === pinKey.toString("base64") || token === pinKey.toString("base64url"))) return true;
    if (this.isServerKey(token) || this.leaks(token)) return true;
    return this.opensSavedCode(token);
  }

  /** True when `token`, read as a base64 or base64url key, opens the sealed door code. */
  private opensSavedCode(token: string): boolean {
    if (!this.door().saved()) return false;
    for (const encoding of ["base64", "base64url"] as const) {
      const key = Buffer.from(token, encoding);
      if (key.length === 32 && this.door().opensWith(key)) return true;
    }
    return false;
  }

  /** Saves the routine through the secret store, ends any upload link, and queues the test wake-up. */
  private connectRoutine(url: string, token: string, save: SaveRoutine): void {
    save({ CLEANER_CORE_ROUTINE_URL: url, CLEANER_CORE_ROUTINE_KEY: token });
    this.uploadKey = undefined;
    delete this.file.alertUpload;
    this.file.routineConnected = true;
    this.noteRoutineConnection();
    this.persist();
    this.alerts.enqueue(testEvent(this.now()));
    this.startDrain();
  }

  /**
   * Makes a one-time upload link for the routine's address and key. Only the code's sha256 and its
   * expiry are kept, and a new link replaces the last one.
   */
  private issueUpload(pinKey: Buffer | undefined): ToolReply {
    const base = publicBaseUrl(this.env());
    if (!base) return this.fail(UPLOAD_LINK_OFF);
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomBytes(32).toString("base64url");
      const uploadUrl = `${base}${ALERT_UPLOAD_PREFIX}${code}`;
      // A link that happens to hold the door code would be refused as a reply, so make another.
      if (this.leaks(uploadUrl)) continue;
      const by = currentCaller();
      this.file.alertUpload = { hash: uploadHash(code), expiresAt: new Date(this.now().getTime() + UPLOAD_MINUTES * 60_000).toISOString(), ...(by ? { by } : {}) };
      this.uploadKey = pinKey;
      this.persist();
      return this.reply({ uploadUrl, expiresInMinutes: UPLOAD_MINUTES, next: this.words().alertUploadNext });
    }
    return this.fail("That didn't work. Try again.");
  }

  /**
   * Saves the routine's address and key posted to an upload link, with the same checks as
   * `save_alert_routine`. Only a save uses the link up. Nothing posted is repeated or logged.
   */
  uploadAlertRoutine(
    code: string,
    body: Record<string, unknown>,
    save: SaveRoutine,
  ): Promise<UploadReply> {
    return this.serial(async () => {
      const pending = this.file.alertUpload;
      if (!pending || !sameHash(uploadHash(code), pending.hash)) return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
      if (this.now().getTime() >= Date.parse(pending.expiresAt)) {
        delete this.file.alertUpload;
        this.uploadKey = undefined;
        this.persist();
        return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
      }
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const given = typeof body.token === "string" ? body.token : typeof body.key === "string" ? body.key : "";
      const token = given.trim();
      const finish = () => {
        if (this.routineRefused(url, token, this.uploadKey ?? serverPinKey(this.env()))) return { status: 400 as const, body: { ok: false, error: UPLOAD_REFUSED } };
        this.connectRoutine(url, token, save);
        return { status: 200 as const, body: { ok: true, message: UPLOAD_CONNECTED } };
      };
      // The link's maker is the connection whose routine this is.
      return pending.by ? withCaller(pending.by, finish) : finish();
    });
  }

  /** Delivers every pending wake-up that is due. A routine that is down or not saved leaves them pending. */
  async drainAlerts(): Promise<void> {
    await this.alerts.drain();
  }

  private startDrain(): void {
    void this.drainAlerts().catch(() => undefined);
  }

  /**
   * The newest wake-up that didn't reach the alert routine, unless a later one got through. A
   * ChatGPT or Muse task can't be woken, so it never has one. The error is plain words, never the
   * address or key.
   */
  private wakeProblem(): { eventId: string; error: string } | undefined {
    if (this.polledTask(this.primaryAssistant())) return undefined;
    const records = this.alerts.records();
    const lastDelivered = records
      .map((record) => (record.status === "delivered" ? record.deliveredAt : undefined))
      .filter((at): at is string => Boolean(at))
      .sort()
      .at(-1);
    const missed = records
      .filter((record) => record.status === "failed" || (record.status === "pending" && record.attempts > 0))
      .filter((record) => !lastDelivered || (record.lastAttemptAt ?? "") > lastDelivered)
      .sort((a, b) => (a.lastAttemptAt ?? "").localeCompare(b.lastAttemptAt ?? ""))
      .at(-1);
    if (!missed) return undefined;
    return { eventId: missed.event.eventId, error: missed.lastError ?? "The last wake-up didn't go through." };
  }

  /**
   * Activate's check: undefined once a test wake-up reached the routine and none failed since, else
   * why not and how to fix it. Tries any wake-up that is due first. A setup with no test saved gets one.
   */
  private async wakeTestRefusal(): Promise<string | undefined> {
    if (this.polledTask(this.primaryAssistant())) return undefined;
    const tests = () => this.alerts.records().filter((record) => record.event.eventType === "installation.test");
    if (tests().length === 0) this.alerts.enqueue(testEvent(this.now()));
    await this.alerts.drain().catch(() => undefined);
    const problem = this.wakeProblem();
    if (!problem && tests().some((record) => record.status === "delivered")) return undefined;
    return `${ACTIVATE_WAITS_FOR_WAKE} ${problem?.error ?? WAKE_NOT_TRIED} ${this.words().routineNeeded}`;
  }

  /**
   * The admin page's word on this tenant's wake-ups: "failing: <why>", "working" once one got
   * through, or "—" before any was tried. Never the address or key.
   */
  wakeHealth(): string {
    const problem = this.wakeProblem();
    if (problem) return `failing: ${problem.error}`;
    return this.alerts.records().some((record) => record.status === "delivered") ? "working" : "—";
  }

  /** get_state's warning for the assistant while wake-ups aren't getting through, with the fix. */
  private wakeWarning(): string | undefined {
    if (!this.file.routineConnected) return undefined;
    const problem = this.wakeProblem();
    if (!problem) return undefined;
    return `Cleaner Core couldn't wake the alert routine. ${problem.error} Until it's fixed, a text from the cleaner shows up only at the next scheduled check. ${this.words().routineNeeded}`;
  }

  /**
   * check_now's one line for the host about a wake-up that didn't get through, the first time
   * check_now sees that problem. The scheduled run reads it, so it names the chat, not a tool. The caller persists.
   */
  private wakeAlert(): string | undefined {
    const problem = this.file.routineConnected ? this.wakeProblem() : undefined;
    if (!problem) {
      delete this.file.wakeProblemShown;
      return undefined;
    }
    if (this.file.wakeProblemShown === problem.eventId) return undefined;
    this.file.wakeProblemShown = problem.eventId;
    return `Cleaner Core couldn't wake your alerts, so a text from the cleaner waits for the next scheduled check. ${problem.error} Ask ${this.hostWords().helper} to reconnect Cleaner Core's alerts.`;
  }

  /** Ids of the host notes visible now. Taken before a path Grok doesn't see, so only that path's notes wake the routine. */
  private visibleNoteIds(): Set<string> {
    this.resume();
    return new Set(this.engine ? this.visibleNotes(this.engine).map((note) => note.id) : []);
  }

  /**
   * Wakes the cleaning routine once when a host note became visible since `before` and the host
   * has not seen it yet, or when a new message was kept. The event carries no content: Grok reads
   * the notes and the messages with `check_now`.
   */
  private queueNewAlerts(before: Set<string>, newMessage = false): void {
    const engine = this.engine;
    const queued = new Set(this.file.alertsQueued ?? []);
    const shown = new Set(this.file.alertsShown ?? []);
    const fresh = engine ? this.visibleNotes(engine).filter((note) => !before.has(note.id) && !queued.has(note.id) && !shown.has(note.id)) : [];
    if (fresh.length === 0 && !newMessage) return;
    // One waiting wake-up is enough: check_now returns every note and message that is new by then.
    // Without a routine saved, a wake-up each would arrive later as a backlog of identical wake-ups.
    const waiting = this.alerts.records().some((record) => record.event.eventType === "cleaning.update" && record.status === "pending");
    if (!waiting) this.alerts.enqueue(cleaningUpdateEvent(this.now()));
    if (fresh.length > 0) this.file.alertsQueued = [...queued, ...fresh.map((note) => note.id)];
    this.persist();
    this.startDrain();
  }

  /** True when `text` contains the saved door code, or the server's door-code key. */
  leaks(text: string): boolean {
    return Boolean(this.pin && text.includes(this.pin)) || this.isServerKey(text, true);
  }

  /** True when `text` is (or, with `inside`, holds) the server's door-code key. */
  private isServerKey(text: string, inside = false): boolean {
    const key = this.env().CLEANER_CORE_PIN_KEY?.trim();
    if (!key) return false;
    return inside ? text.includes(key) : text.trim() === key;
  }

  /** The request's key, or else the server's own key. Undefined when neither is there. */
  private keyFor(pinKey: Buffer | undefined): Buffer | undefined {
    return pinKey ?? serverPinKey(this.env());
  }

  /**
   * Opens a sealed code that isn't open yet, with the request's key or else the server's key. A seal
   * made with another key stays shut.
   */
  private openSeal(pinKey?: Buffer): void {
    if (this.pin) return;
    const code = this.door().codeForChecks(pinKey);
    if (!code) return;
    this.pin = code;
  }

  /**
   * The engine's door access: the hub's request. With no key of its own, the hub opens the code with
   * the key that last saved or opened it, else the server's key. The refusal is kept for mark_guests_left.
   */
  private doorPort(): DoorAccessPort {
    return {
      request: async (input) => {
        const grant = this.door().request({ person: input.person, window: input.window, purpose: input.purpose });
        this.accessRefusal = grant.ok ? undefined : grant.reason;
        return grant;
      },
      codeForChecks: () => this.pin,
    };
  }

  private accessRefusedLines(): AccessRefusedLines {
    return { "no-code": "Save the door code first.", "no-key": PIN_KEY_MISSING, sealed: PIN_REENTER, "window-over": DOOR_WINDOW_OVER };
  }

  /** The property's door access in its hub: the sealed code, the lock location, and the upload link. */
  private door(): DoorAccess {
    return this.hub.doorAccess(this.env);
  }

  /**
   * Cleaner Core's checks on a door code being saved, run by the hub for save_door_code and for its
   * upload link: the lock location may not carry it, and its digits may not already sit in a saved
   * answer or a waiting draft. The refusal says where, never the digits.
   */
  private codeRefused(code: string, lockLocation?: string): string | undefined {
    if (lockLocation && this.carriesCode(lockLocation, code)) return LOCK_LOCATION_REFUSED;
    const inAnswer = (this.file.savedAnswers ?? []).find((item) => containsCodeToken(item.topic, code) || containsCodeToken(item.answer, code));
    if (inAnswer) return CODE_IN_SAVED_ANSWER(containsCodeToken(inAnswer.topic, code) ? undefined : inAnswer.topic);
    if ((this.file.drafts ?? []).some((draft) => containsCodeToken(draft.text, code))) return CODE_IN_DRAFT;
    // Setup saves in any order (#166), so text the cleaner gets may be saved before the code.
    const preferences = this.file.preferences;
    if (preferences && [...preferences.checklist, preferences.instructions ?? ""].some((text) => text && containsCodeToken(joinSplitDigits(text), code))) return CODE_IN_PREFERENCES;
    const saved = [this.file.business, this.file.cleanerName, this.file.hostName, this.file.schedule?.escalateTo, this.file.payments?.venmo, ...contactsOf(this.file).map((contact) => contact.name), ...this.hub.calendars().map((calendar) => calendar.name)];
    if (saved.some((text) => text && containsCodeToken(joinSplitDigits(text), code))) return CODE_IN_SAVED_SETUP;
    return undefined;
  }

  /**
   * The one door-code check for host free text that is saved or sent: a message, checklist items,
   * instructions, the lock location, who hears about problems, and contact, cleaner, and calendar
   * names and links. It catches the saved code and `saving` (a code being saved now), also split by
   * spaces, dots, or dashes, and the chat checks. While the code is sealed and this desk can't open
   * it, any run of 4 or more digits might be it, so that is refused too.
   */
  private carriesCode(text: string, saving?: string): boolean {
    const joined = joinSplitDigits(text);
    if (saving && joined.includes(saving)) return true;
    if (this.chatCarriesDoorCode(text) || this.chatCarriesDoorCode(joined)) return true;
    return !this.pin && this.door().saved() && /\d{4,}/.test(joined);
  }

  /** True when a door code is saved, open in memory or only sealed. */
  private codeSaved(): boolean {
    return Boolean(this.pin || this.door().saved());
  }

  chatCarriesDoorCode(text: string): boolean {
    if (this.pin && text.includes(this.pin)) return true;
    const trimmed = text.trim();
    if (/^\d{4,8}$/.test(trimmed)) return true;
    return /\bdoor code\b/i.test(text) && /\b\d{4,8}\b/.test(text);
  }

  /**
   * The number already runs cleaning (the host picked it on the shared address or its Allow page, or
   * connected at the cleaning address), so setup never asks touring or cleaning again.
   */
  chooseCleaning(): Promise<void> {
    return this.serial(async () => {
      if (this.file.choice) return;
      this.file.choice = "cleaners";
      this.persist();
    });
  }

  /** drafted: true says the host saw the setup draft and their changes are saved, so setup asks what's still missing. */
  getState(choice?: "tours" | "cleaners", drafted?: boolean): Promise<ToolReply> {
    return this.serial(async () => this.getStateNow(choice, drafted));
  }

  private getStateNow(choice: "tours" | "cleaners" | undefined, drafted?: boolean): ToolReply {
    if (this.file.choice === "cleaners") this.resume();
    const failure = this.engine?.pullPinFailure() ? this.words().pinFailed : undefined;
    if (!this.file.choice) {
      const pick = choice === "tours" || choice === "cleaners" ? choice : undefined;
      if (!pick) return this.reply({ done: [], next: FIRST_QUESTION, ask: START_ASK });
      this.file.choice = pick;
      this.noteDrafted(drafted);
      this.persist();
      if (pick === "tours") return this.reply({ done: [], next: TOUR_PICK });
      const first = this.cleaningState();
      return this.reply({ ...first, done: ["You chose cleaning."], next: `${CLEANER_PICK} ${String(first.next)}` });
    }
    if (this.file.choice === "tours") return this.withFailure(this.reply({ done: ["You chose touring."], next: "What's the property you want renters to tour?" }), failure);
    if (this.noteDrafted(drafted)) this.persist();
    return this.withFailure(this.reply(this.cleaningState()), failure);
  }

  /** Records the host's look at the setup draft, once. True when it changed the file; the caller persists. */
  private noteDrafted(drafted: boolean | undefined): boolean {
    if (drafted !== true || this.file.choice !== "cleaners" || this.file.drafted) return false;
    this.file.drafted = this.now().toISOString();
    return true;
  }

  saveProperty(input: PropertyInput, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.savePropertyNow(input, pinKey));
  }

  private savePropertyNow(input: PropertyInput, pinKey: Buffer | undefined): ToolReply {
    if (this.file.choice !== "cleaners") return this.fail(PICK_FIRST);
    const address = input.address?.trim() ?? "";
    const business = input.business?.trim() ?? "";
    const timeZone = input.timeZone?.trim() ?? "";
    if (!address || !business || !timeZone.includes("/")) {
      return this.fail("I need the business name, the property address, and the time zone.");
    }
    const nickname = input.nickname?.trim() ?? "";
    const propertyType = input.propertyType?.trim() ?? "";
    if (nickname.length > MAX_NAME || propertyType.length > MAX_NAME) return this.fail(`Keep the nickname and the property type under ${MAX_NAME} characters.`);
    // The business name goes into the cleaner's opt-in text. The address is left out: it holds house numbers and ZIP codes.
    this.openSeal(pinKey);
    if ([business, nickname, propertyType].some((text) => text && this.carriesCode(text))) return this.fail(DOOR_CODE_IN_CHAT);
    const checkoutText = input.checkoutTime?.trim() ?? "";
    const checkInText = input.checkInTime?.trim() ?? "";
    const checkoutTime = hourMinute(checkoutText);
    const checkInTime = hourMinute(checkInText);
    if ((checkoutText && !checkoutTime) || (checkInText && !checkInTime)) {
      return this.fail("Send the usual checkout and check-in times as 24-hour HH:MM, like 11:00 and 15:00.");
    }
    // The details are the property's, in its hub: Supply Core reads the same ones.
    const saved = this.hub.saveProperty(
      { address, timeZone, nickname: nickname || undefined, propertyType: propertyType || undefined, checkoutTime, checkInTime },
      [...(nickname ? [] : ["nickname" as const]), ...(propertyType ? [] : ["propertyType" as const])],
    );
    if (!saved.ok) return this.fail(saved.error);
    // This desk's own save takes effect at the next run_checks, as before; only another flow's save
    // reopens the engine on the next step.
    this.engineRevision = this.hub.propertyRevision();
    this.file.business = business;
    this.file.propertyId = propertyIdFor(business);
    this.persist();
    // The engine reads the usual times when it opens.
    this.stale = true;
    return this.setupReply();
  }

  /**
   * Saves the host, the cleaner (with an optional name), up to four extra contacts, and the
   * group-chat choice. Each save replaces the saved people. The legacy observer counts as a contact.
   */
  savePeople(input: PeopleInput, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.savePeopleNow(input, pinKey));
  }

  private savePeopleNow(input: PeopleInput, pinKey: Buffer | undefined): ToolReply {
    // Setup saves in any order (#166): the people don't wait for the property.
    if (this.file.choice !== "cleaners") return this.fail(PICK_FIRST);
    this.openSeal(pinKey);
    const host = parsePhone(input.host ?? "");
    const cleaner = parsePhone(input.cleaner ?? "");
    const observerText = input.observer?.trim() ?? "";
    const observer = observerText ? parsePhone(observerText) : undefined;
    if (!host || !cleaner || host === cleaner) {
      return this.fail("I need two different phone numbers: the host and the cleaner. An observer is optional.");
    }
    // The host is the landlord, whose phone was confirmed with a code at sign-up.
    const landlord = verifiedLandlordPhone(this.env());
    if (landlord && host !== landlord) return this.fail("The host's number has to be the phone you confirmed when you signed in.");
    if (observerText && !observer) return this.fail("Send the observer as a phone number, or leave that number out.");
    if (observer && (observer === host || observer === cleaner)) {
      return this.fail("The observer has to be a different phone number from the host and the cleaner.");
    }
    const cleanerName = input.cleanerName?.trim() ?? "";
    if (cleanerName.length > MAX_NAME) return this.fail(`Keep the cleaner's name under ${MAX_NAME} characters.`);
    const hostName = input.hostName?.trim() ?? "";
    if (hostName.length > MAX_NAME) return this.fail(`Keep the host's name under ${MAX_NAME} characters.`);
    const groupChat = input.groupChat?.trim() ?? "";
    if (groupChat && !(GROUP_CHOICES as readonly string[]).includes(groupChat)) {
      return this.fail("Choose who gets the texts: cleaner-only, cleaner-and-host, or everyone.");
    }
    const doorCodeTo = input.doorCodeTo?.trim() ?? "";
    if (doorCodeTo && doorCodeTo !== "group" && doorCodeTo !== "cleaner") return this.fail(DOOR_CODE_QUESTION);
    const contacts: Contact[] = [];
    const used = new Set([host, cleaner, ...(observer ? [observer] : [])]);
    for (const contact of input.contacts ?? []) {
      const name = contact.name?.trim() ?? "";
      const role = contact.role?.trim() ?? "";
      const phone = parsePhone(contact.phone ?? "");
      if (!name || name.length > MAX_NAME) return this.fail(`Give each contact a name under ${MAX_NAME} characters.`);
      if (!(CONTACT_ROLES as readonly string[]).includes(role)) return this.fail("Each contact is a co-host, an assistant, or an observer.");
      if (!phone) return this.fail(`Send ${name}'s phone number.`);
      if (used.has(phone)) return this.fail("Each person needs a different phone number.");
      if (this.carriesCode(name)) return this.fail(DOOR_CODE_IN_CHAT);
      used.add(phone);
      contacts.push({ name, role: role as ContactRole, phone });
    }
    if (contacts.length + (observer ? 1 : 0) > MAX_CONTACTS) return this.fail(`I can keep up to ${MAX_CONTACTS} extra contacts.`);
    if (this.carriesCode(cleanerName) || this.carriesCode(hostName)) return this.fail(DOOR_CODE_IN_CHAT);
    // The legacy observer reads as one contact. Only "everyone" or an unset choice puts contacts in the group.
    const othersInGroup = contacts.length + (observer ? 1 : 0) > 0 && (groupChat === "" || groupChat === "everyone") && groupChatEnabled(this.env());
    if (othersInGroup && !doorCodeTo) return this.fail(DOOR_CODE_QUESTION);
    this.file.host = host;
    this.file.cleaner = cleaner;
    if (observer) this.file.observer = observer;
    else delete this.file.observer;
    this.keep("cleanerName", cleanerName || undefined);
    this.keep("hostName", hostName || undefined);
    this.keep("contacts", contacts.length > 0 ? contacts : undefined);
    this.keep("groupChat", (groupChat || undefined) as GroupChoice | undefined);
    this.keep("doorCodeTo", othersInGroup && doorCodeTo ? (doorCodeTo as "group" | "cleaner") : undefined);
    this.persist();
    this.stale = true;
    return this.setupReply();
  }

  /**
   * Saves the messaging schedule: when the first cleaning text goes, when the reminder goes, quiet
   * hours, and who should hear about problems. A field left out keeps what was saved, and `{}` the
   * first time keeps the defaults. Days run 1 to 14 and times are clock times like 8:00 AM. Empty
   * quiet hours clear them. The schedule can only hold a text back. The first cleaning text still
   * waits for the host's confirmed times, and the door code still waits for "guests have left".
   */
  saveSchedule(input: ScheduleInput, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.saveScheduleNow(input, pinKey));
  }

  private saveScheduleNow(input: ScheduleInput, pinKey: Buffer | undefined): ToolReply {
    if (this.file.choice !== "cleaners") return this.fail(PICK_FIRST);
    this.openSeal(pinKey);
    const saved = this.file.schedule ?? DEFAULT_SCHEDULE;
    const firstText = input.firstText ?? saved.firstText;
    const reminder = input.reminder ?? saved.reminder;
    if (!(FIRST_TEXTS as readonly string[]).includes(firstText)) return this.fail("Send the first cleaning text when the times are confirmed, a number of days after check-in, or a number of days before checkout.");
    if (!(REMINDERS as readonly string[]).includes(reminder)) return this.fail("Send the reminder the morning of checkout, or a number of days before checkout.");
    const days = (value: number | undefined) => (value !== undefined && Number.isInteger(value) && value >= MIN_SCHEDULE_DAYS && value <= MAX_SCHEDULE_DAYS ? value : undefined);
    const dayRange = `${MIN_SCHEDULE_DAYS} to ${MAX_SCHEDULE_DAYS} days`;
    const timedFirstText = firstText === "days-after-check-in" || firstText === "days-before-checkout";
    // Saved days carry over only while the kind stays the same.
    const firstTextDays = timedFirstText ? days(input.firstTextDays ?? (firstText === saved.firstText ? saved.firstTextDays : undefined)) : undefined;
    if (timedFirstText && firstTextDays === undefined) {
      const side = firstText === "days-after-check-in" ? "after check-in" : "before checkout";
      return this.fail(`Say how many days ${side} the first text goes, ${dayRange}.`);
    }
    const reminderDays = reminder === "days-before-checkout" ? days(input.reminderDays ?? saved.reminderDays) : undefined;
    if (reminder === "days-before-checkout" && reminderDays === undefined) return this.fail(`Say how many days before checkout the reminder goes, ${dayRange}.`);
    const reminderText = input.reminderTime?.trim();
    const reminderTime = reminderText === undefined ? saved.reminderTime : hourMinute(reminderText);
    if (!reminderTime) return this.fail("Send the reminder time as 24-hour HH:MM, like 08:00.");
    let quiet = saved.quietFrom && saved.quietUntil ? { from: saved.quietFrom, until: saved.quietUntil } : undefined;
    if (input.quietFrom !== undefined || input.quietUntil !== undefined) {
      const fromText = input.quietFrom?.trim() ?? "";
      const untilText = input.quietUntil?.trim() ?? "";
      const from = hourMinute(fromText);
      const until = hourMinute(untilText);
      if (!fromText && !untilText) quiet = undefined;
      else if (!from || !until || from === until) return this.fail("Send both quiet-hours times as 24-hour HH:MM, like 21:00 and 08:00.");
      else quiet = { from, until };
    }
    const escalateTo = input.escalateTo === undefined ? saved.escalateTo : input.escalateTo.trim() || undefined;
    if (escalateTo && escalateTo.length > MAX_NAME) return this.fail(`Keep who hears about problems under ${MAX_NAME} characters.`);
    if (escalateTo && this.carriesCode(escalateTo)) return this.fail(DOOR_CODE_IN_CHAT);
    this.file.schedule = {
      firstText,
      ...(firstTextDays !== undefined ? { firstTextDays } : {}),
      reminder,
      ...(reminderDays !== undefined ? { reminderDays } : {}),
      reminderTime,
      ...(quiet ? { quietFrom: quiet.from, quietUntil: quiet.until } : {}),
      ...(escalateTo ? { escalateTo } : {}),
    };
    this.persist();
    // The engine reads the schedule when it opens.
    this.stale = true;
    return this.setupReply();
  }

  saveCalendarLink(input: { url?: string; google?: boolean }, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.saveCalendarLinkNow(input, pinKey));
  }

  private saveCalendarLinkNow(input: { url?: string; google?: boolean }, pinKey: Buffer | undefined): ToolReply {
    if (!this.place.address) return this.fail("Save the property first.");
    const url = input.url?.trim() ?? "";
    if (!url && !input.google) return this.fail("Send the Guesty Lite link, or say you use Google Calendar.");
    if (url && maskedLink(url)) return this.fail(this.words().maskedLink);
    if (url && !url.startsWith("https://")) return this.fail("Send a public https calendar link.");
    this.openSeal(pinKey);
    if (url && this.carriesCode(url)) return this.fail(DOOR_CODE_IN_CHAT);
    // Replaces only the Guesty Lite link. Every other saved calendar stays.
    const stored = this.hub.stored();
    const at = stored.findIndex((calendar) => calendar.legacy);
    const calendars = at >= 0 ? stored.map((calendar, i) => (i === at ? { ...calendar, url } : calendar)) : [{ name: LEGACY_CALENDAR, url, legacy: true as const }, ...stored];
    const saved = this.hub.setCalendars({ ...(url ? { calendars } : {}), ...(input.google ? { google: true } : {}) });
    if (!saved.ok) return this.fail(this.hubRefusal(saved));
    return this.setupReply();
  }

  /**
   * Saves the booking sources: the calendar links in the order given, and whether Google Calendar is
   * used. A calendars list replaces every saved link, the legacy one too. Leaving calendars or google
   * out keeps what was saved. A link that is not public https is refused, and the reply never repeats
   * a link. When the change would call off an upcoming cleaning that only a dropped source lists, it
   * is refused with `wouldCancel` until Grok asks the host and passes dropJobs.
   */
  saveSources(input: SourcesInput, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.saveSourcesNow(input, pinKey));
  }

  private saveSourcesNow(input: SourcesInput, pinKey: Buffer | undefined): ToolReply {
    if (!this.place.address) return this.fail("Save the property first.");
    this.openSeal(pinKey);
    if (input.uploadLink) return this.issueCalendarUpload(input.uploadLink.name?.trim() || LEGACY_CALENDAR, input.google, pinKey);
    let calendars: StoredCalendar[] = this.hub.stored();
    if (input.calendars !== undefined) {
      calendars = input.calendars.map((calendar) => ({ name: calendar.name?.trim() ?? "", url: calendar.url?.trim() ?? "" }));
      if (calendars.length > MAX_CALENDARS) return this.fail(`I can keep up to ${MAX_CALENDARS} calendar links.`);
      for (const calendar of calendars) {
        if (!calendar.name) return this.fail("Give each calendar link a name, like Airbnb or Vrbo.");
        if (this.carriesCode(calendar.name) || this.carriesCode(calendar.url)) return this.fail(DOOR_CODE_IN_CHAT);
        if (maskedLink(calendar.url)) return this.fail(this.words().maskedLink);
        if (!calendarUrlAllowed(calendar.url)) {
          return this.fail(`I can't use the ${calendar.name} link. It has to be a public https address, and not a private network.`);
        }
      }
    }
    const google = input.google ?? this.hub.google();
    if (calendars.length === 0 && !google) return this.fail("Send at least one calendar link, or say you use Google Calendar.");
    if (input.dropJobs !== true) {
      this.resume();
      const lost = this.engine?.wouldCancel(this.hub.claims(calendars, google)) ?? [];
      if (lost.length > 0) {
        const count = `${lost.length} upcoming ${lost.length === 1 ? "cleaning" : "cleanings"}`;
        return this.failWith(`Removing that calendar would call off ${count}. Ask the host, then save again with dropJobs: true.`, { wouldCancel: lost });
      }
    }
    // The calendars are the property's, in its hub: Supply Core reads the same ones. The hub
    // doesn't ask wouldCancel here; it was asked above.
    const saved = this.hub.setCalendars({
      ...(input.calendars !== undefined ? { calendars } : {}),
      ...(input.google !== undefined ? { google: input.google } : {}),
      ...(input.done === true ? { done: true } : {}),
    });
    if (!saved.ok) return this.fail(this.hubRefusal(saved));
    return this.setupReply();
  }

  /** A hub refusal in this deployment's words. */
  private hubRefusal(saved: Extract<HubSave, { ok: false }>): string {
    return saved.reason === "masked" ? this.words().maskedLink : saved.error;
  }

  /**
   * Makes a one-time upload link for one calendar link, saved under `name`. Only the code's sha256,
   * its expiry, and the name are kept. A new link replaces the last one. google: true is saved now.
   */
  private issueCalendarUpload(name: string, google: boolean | undefined, pinKey: Buffer | undefined): ToolReply {
    const base = publicBaseUrl(this.env());
    if (!base) return this.fail(UPLOAD_LINK_OFF);
    const by = currentCaller();
    const made = this.hub.issueCalendarUpload({ name, base, ...(google !== undefined ? { google } : {}), ...(by ? { by } : {}) });
    if ("error" in made) return this.fail(made.error);
    // The upload opens the sealed code with this key, for the door-code check on the posted link.
    this.calendarUploadKey = pinKey;
    return this.reply({ uploadUrl: made.uploadUrl, expiresInMinutes: made.expiresInMinutes, next: this.words().calendarUploadNext });
  }

  /**
   * Saves a calendar link posted to its upload link, through the property's hub, with the same checks
   * as save_sources: this desk's door-code check, and a 409 when it would call off a cleaning. A link
   * with the same name is replaced, and every other saved calendar stays. The link is never repeated.
   */
  uploadCalendarLink(code: string, body: Record<string, unknown>): Promise<UploadResult> {
    // Not in this desk's queue: the hub asks wouldCancel, which takes the queue itself.
    return this.hub.uploadCalendarLink(code, body);
  }

  /**
   * Seals the door code. lockLocation names where the lock is, for the private code text. Leaving it
   * out keeps the saved one, and an empty one clears it. It may not carry a run of 4 or more digits.
   */
  saveDoorCode(input: { code?: string; lockLocation?: string }, pinKey: Buffer | undefined): Promise<ToolReply> {
    return this.serial(async () => this.saveDoorCodeNow(input, pinKey));
  }

  private saveDoorCodeNow(input: { code?: string; lockLocation?: string }, pinKey: Buffer | undefined): ToolReply {
    const before = this.doorCodeBefore();
    if (before) return this.fail(before);
    const code = input.code?.trim() ?? "";
    // A Grok Bot's secure card can't fill a tool argument, so no code means: make an upload link.
    if (!code) return this.issueDoorCodeUpload(input.lockLocation?.trim(), pinKey);
    if (!/^\d{4,8}$/.test(code)) return this.fail(/\d/.test(code) || code.length > 12 ? DOOR_CODE_SHAPE_REFUSED : this.words().maskedCode);
    this.openSeal(pinKey);
    const previousLock = this.door().lockLocation();
    const previousCode = this.pin;
    // The hub seals it in door-access.json, after this desk's checks (codeRefused) and its own.
    const saved = this.door().save(code, input.lockLocation, pinKey);
    if (!saved.ok) return this.fail(saved.error);
    this.pin = code;
    // The engine names the lock in the door code text and guards its texts and files with the code,
    // so it reopens with a new location or a new code.
    if (this.door().lockLocation() !== previousLock || code !== previousCode) this.stale = true;
    return this.reply({ next: this.doorCodeSavedLine() });
  }

  /**
   * Why the door code can't be saved yet, or undefined. Setup saves in any order (#166), so only the
   * property comes first: the code is that property's. It still goes only to the approved cleaner,
   * and only after the host says the guests have left.
   */
  private doorCodeBefore(): string | undefined {
    if (this.file.choice !== "cleaners") return PICK_FIRST;
    if (!this.file.propertyId || !this.place.address) return "Save the property first.";
    return undefined;
  }

  private doorCodeSavedLine(): string {
    return `Saved the door code. It goes only to the cleaner, ${this.codeGoesToGroup() ? "in the cleaning group" : "in a private text"}, after you say the guests have left.`;
  }

  /**
   * Makes the hub's one-time upload link for the door code. Only the link code's sha256, its expiry,
   * and the lock location are kept. A new link replaces the last one.
   */
  private issueDoorCodeUpload(lockLocation: string | undefined, pinKey: Buffer | undefined): ToolReply {
    this.openSeal(pinKey);
    if (lockLocation && this.carriesCode(lockLocation)) return this.fail(LOCK_LOCATION_REFUSED);
    const caller = currentCaller();
    const issued = this.door().issueUpload(lockLocation, pinKey, publicBaseUrl(this.env()), caller);
    if (!issued.ok) return this.fail(issued.error);
    return this.reply({ uploadUrl: issued.uploadUrl, expiresInMinutes: issued.expiresInMinutes, next: this.words().doorCodeUploadNext });
  }

  /**
   * Seals a door code posted to its upload link, with the same checks as save_door_code. Only a save
   * uses the link up. The code is never repeated or logged, and the reply never holds it.
   */
  uploadDoorCode(code: string, body: Record<string, unknown>): Promise<UploadReply> {
    return this.serial(async () => {
      const door = this.door();
      const before = door.uploadLinkOpen(code).open ? this.doorCodeBefore() : undefined;
      // A refused code keeps the link, so Grok can post again.
      if (before) return { status: 400, body: { ok: false, error: before } };
      this.openSeal();
      const previousLock = door.lockLocation();
      const previousCode = this.pin;
      const result = door.upload(code, body);
      if (result.status !== 200) return result;
      this.pin = door.codeForChecks();
      if (door.lockLocation() !== previousLock || this.pin !== previousCode) this.stale = true;
      return { status: 200, body: { ok: true, message: this.doorCodeSavedLine() } };
    });
  }

  /**
   * Saves whether to help pay the cleaner, the pay per cleaning, and the cleaner's Venmo username.
   * Turning it on needs the host's approval, bound to that exact username and amount. Never moves money.
   */
  savePayments(input: { on?: boolean; rate?: number; venmo?: string; confirmation?: string }): Promise<ToolReply> {
    return this.serial(async () => this.savePaymentsNow(input));
  }

  private savePaymentsNow(input: { on?: boolean; rate?: number; venmo?: string; confirmation?: string }): ToolReply {
    const now = this.now().toISOString();
    if (input.on === false) {
      this.file.payments = { on: false, savedAt: now };
      this.persist();
      return this.setupReply({ saved: "Payments are off." });
    }
    const cents = typeof input.rate === "number" ? payCents(input.rate) : undefined;
    if (cents === undefined) return this.fail(RATE_HELP);
    const venmo = typeof input.venmo === "string" ? venmoUsername(input.venmo) : undefined;
    if (!venmo) return this.fail(VENMO_HELP);
    if (this.leaks(venmoProfileLink(venmo))) return this.fail(CODE_IN_USERNAME);
    const fingerprint = createHash("sha256").update(`${venmo}|${cents}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const question = `Save ${dollarsText(cents)} per cleaning to @${venmo}?`;
      return this.reply({ profile: venmoProfileLink(venmo), question, confirmation: this.approvals.issue(PAYMENTS_ACTION, "payments", fingerprint, question) });
    }
    if (!this.redeemed(this.approvals, code, PAYMENTS_ACTION, "payments", fingerprint)) return this.fail(APPROVAL_STALE);
    const saved = this.file.payments;
    const onSince = saved?.on && saved.onSince ? saved.onSince : now;
    this.file.payments = { on: true, rateCents: cents, venmo, onSince, savedAt: now };
    this.persist();
    return this.setupReply({ saved: `Saved. After each cleaning I'll offer a Venmo link for ${dollarsText(cents)}.` });
  }

  /**
   * Saves the cleaning preferences. A field left out keeps what was saved, and `{}` the first time
   * means there are none, which still moves setup on to the review.
   */
  savePreferences(input: { checklist?: string[]; photosRequired?: boolean; supplyNotes?: boolean; instructions?: string }, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.savePreferencesNow(input, pinKey));
  }

  private savePreferencesNow(input: { checklist?: string[]; photosRequired?: boolean; supplyNotes?: boolean; instructions?: string }, pinKey: Buffer | undefined): ToolReply {
    // Setup saves in any order (#166). A door code saved later is checked against these (codeRefused).
    if (this.file.choice !== "cleaners") return this.fail(PICK_FIRST);
    // The checklist and the instructions go to the cleaner, so the code is checked open when it can be.
    this.openSeal(pinKey);
    const saved = this.file.preferences ?? { checklist: [], photosRequired: false, supplyNotes: false };
    const checklist = input.checklist === undefined ? saved.checklist : input.checklist.map((item) => item.trim()).filter((item) => item.length > 0);
    if (checklist.length > MAX_CHECKLIST) return this.fail(`I can keep up to ${MAX_CHECKLIST} checklist items.`);
    if (checklist.some((item) => item.length > MAX_CHECKLIST_ITEM)) return this.fail(`Keep each checklist item under ${MAX_CHECKLIST_ITEM} characters.`);
    const instructions = input.instructions === undefined ? saved.instructions : input.instructions.trim() || undefined;
    if (instructions && instructions.length > MAX_INSTRUCTIONS) return this.fail(`Keep the other instructions under ${MAX_INSTRUCTIONS} characters.`);
    if ([...checklist, instructions ?? ""].some((text) => text && this.carriesCode(text))) return this.fail(DOOR_CODE_IN_CHAT);
    this.file.preferences = {
      checklist,
      photosRequired: input.photosRequired ?? saved.photosRequired,
      supplyNotes: input.supplyNotes ?? saved.supplyNotes,
      ...(instructions ? { instructions } : {}),
    };
    this.persist();
    // The engine reads the checklist, the photo rule, supply notes, and the offer note when it opens.
    this.stale = true;
    return this.setupReply();
  }

  setUpTexting(): Promise<ToolReply> {
    return this.serial(async () => this.setUpTextingNow());
  }

  private setUpTextingNow(): ToolReply {
    // Setup saves in any order (#166), so a saved code no longer means the cleaner and a calendar are saved.
    const missing = this.textingMissing();
    if (missing.length > 0) return this.failWith(`Before texting, save ${listText(missing)}.`, { missing });
    this.file.texting = true;
    this.persist();
    return this.reply({
      next: "Texting is saved. The cleaner gets one text asking them to reply YES, and only after you confirm the checkout and the next check-in.",
    });
  }

  /** Review & Activate: saves texting, then runs the checks. Takes the same input as run_checks. */
  activate(input: { googleEvents?: GoogleEventList } = {}): Promise<ToolReply> {
    return this.serial(async () => {
      // Setup saves in any order (#166), so Activate checks every step it needs.
      const missing = this.activateMissing();
      if (missing.length > 0) return this.failWith(`Before Activate, save ${listText(missing)}.`, { missing });
      // Nothing texts before the alert routine is connected, so no reply from the cleaner goes unheard.
      if (!this.routineReady()) {
        const task = this.task();
        return task ? this.failWith(this.words().routineAsk, { routine: task }) : this.fail(ROUTINE_ASK);
      }
      // A routine that refuses its wake-ups would leave the cleaner's replies unheard, so its test has to get through first.
      const unwoken = await this.wakeTestRefusal();
      if (unwoken) {
        const task = this.task();
        return task ? this.failWith(unwoken, { routine: task }) : this.fail(unwoken);
      }
      // Already inside the serial queue, so the inner steps, never runChecks.
      const texting = this.setUpTextingNow();
      if (!texting.ok) return texting;
      return this.runChecksNow(input);
    });
  }

  /**
   * Runs `work` after every earlier serial job has settled, so a check never overlaps a text or a
   * tool step that is still sending. Work already inside the queue calls the inner steps, never a
   * serial entry point, or it would wait on itself. With nothing in flight, `work` starts at once.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const now = (): Promise<T> => {
      try {
        this.beginStep();
        return this.thenApplyAccount(work());
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const idle = this.inFlight === 0;
    this.inFlight += 1;
    const run = idle ? now() : this.queue.then(now, now);
    this.queue = run.then(
      () => {
        this.inFlight -= 1;
      },
      () => {
        this.inFlight -= 1;
      },
    );
    return run;
  }

  /**
   * After a step that opened a new engine, the account's opt-in and STOP are applied to it before the
   * step ends, so a property that was closed when the person said YES or STOP elsewhere still follows.
   */
  private thenApplyAccount<T>(run: Promise<T>): Promise<T> {
    if (!this.people) return run;
    return run.then(async (value) => {
      await this.applyAccount();
      return value;
    });
  }

  private async applyAccount(): Promise<void> {
    const engine = this.engine;
    const people = this.people;
    if (!engine || !people || engine === this.appliedTo) return;
    this.appliedTo = engine;
    for (const phone of this.personPhones()) {
      try {
        if (people.stopped(phone)) await engine.accountStop(phone);
        else {
          // A START this desk didn't hear while it was closed: only a STOP leaves a phone "out".
          if (engine.consentOf(phone) === "out") await engine.accountStart(phone);
          if (people.optedIn(phone)) await engine.accountOptIn(phone);
        }
      } catch {
        // A send that fails here is the engine's to retry; the step's own result stands.
      }
    }
  }

  /** The cleaner and contacts saved here, as E.164. Never the host. */
  private personPhones(): string[] {
    const host = this.file.host ? parsePhone(this.file.host) : undefined;
    const raw = [this.file.cleaner, ...contactsOf(this.file).map((contact) => contact.phone)];
    return [...new Set(raw.map((phone) => (phone ? parsePhone(phone) : undefined)).filter((phone): phone is string => !!phone && phone !== host))];
  }

  /** Tells the account about this engine's YES or STOP, and the account tells every other property. */
  private reportConsent(phone: string, consent: "in" | "out"): void {
    const people = this.people;
    const id = this.account?.propertyId;
    if (!people || !id) return;
    const change = consent === "in" ? people.optIn(phone, id) : people.stop(phone);
    void people.relay(change ? { ...change, from: id } : undefined).catch(() => undefined);
  }

  /** True when this property is waiting on a reply from this phone. It may open the engine, as any step does. */
  waitingOn(phone: string): Promise<boolean> {
    return this.serial(async () => {
      this.resume();
      return this.engine?.waitingOn(phone) ?? false;
    });
  }

  /** The person said YES on another property of the account. */
  accountOptIn(phone: string): Promise<void> {
    return this.serial(async () => {
      this.resume();
      if (this.engine) await this.engine.accountOptIn(phone);
    });
  }

  /** The person's STOP on the account. Before an engine exists, the cleaner's STOP holds the setup, as a text STOP does. */
  accountStop(phone: string): Promise<void> {
    return this.serial(async () => {
      this.resume();
      if (this.engine) return this.engine.accountStop(phone);
      if (parsePhone(this.file.cleaner ?? "") === parsePhone(phone)) {
        this.held = true;
        this.file.cleanerOut = true;
        this.persist();
      }
    });
  }

  /** The person's START on the account. */
  accountStart(phone: string): Promise<void> {
    return this.serial(async () => {
      this.resume();
      if (this.engine) return this.engine.accountStart(phone);
      if (parsePhone(this.file.cleaner ?? "") === parsePhone(phone) && this.file.cleanerOut) {
        this.held = false;
        this.file.cleanerOut = false;
        this.persist();
      }
    });
  }

  /** This desk's people and consent from the older files, for the account's one-time move. */
  moveSource(): Promise<MoveSource> {
    return this.serial(async () => {
      this.resume();
      const host = this.file.host ? parsePhone(this.file.host) : undefined;
      const people: MoveSource["people"] = [];
      const cleaner = this.file.cleaner ? parsePhone(this.file.cleaner) : undefined;
      if (cleaner && cleaner !== host) people.push({ phone: cleaner, role: "cleaner", ...(this.file.cleanerName ? { name: this.file.cleanerName } : {}) });
      for (const contact of contactsOf(this.file)) {
        const phone = parsePhone(contact.phone);
        if (!phone || phone === host || people.some((p) => p.phone === phone)) continue;
        people.push({ phone, role: contact.role as Role, ...(contact.name && contact.name !== "Observer" ? { name: contact.name } : {}) });
      }
      // An engine that can't open now still has its saved consent in its store.
      const stored = this.engine || !this.file.propertyId ? undefined : storedConsent(join(this.root, "cleaner-job"), this.file.propertyId);
      const consent = (phone: string) =>
        this.engine ? this.engine.consentOf(phone) : phone === cleaner ? stored?.cleaner : stored?.participants.find((p) => parsePhone(p.phone) === phone)?.consent;
      return {
        propertyId: this.account?.propertyId ?? "",
        ...(host ? { host } : {}),
        people,
        stopped: [...(this.file.lineOptOuts ?? [])],
        optedIn: people.filter((p) => consent(p.phone) === "in").map((p) => p.phone),
        optedOut: people.filter((p) => consent(p.phone) === "out" || (p.role === "cleaner" && this.file.cleanerOut)).map((p) => p.phone),
      };
    });
  }

  /**
   * The start of every serial step: a setup save since the last step reopens the engine now, never
   * while another step still holds it, and a sealed code opens with the server's key.
   */
  private beginStep(): void {
    if (this.stale) {
      this.stale = false;
      this.engine = undefined;
    }
    this.openSeal();
  }

  runChecks(input: { googleEvents?: GoogleEventList } = {}): Promise<ToolReply> {
    return this.serial(() => this.runChecksNow(input));
  }

  /**
   * Re-reads the saved calendars, sends reminders that are due, and returns the host alerts
   * that are new since the last call. Google events are applied only when Grok passes them.
   */
  checkNow(input: { googleEvents?: GoogleEventList } = {}, save?: SavePhotoKey): Promise<ToolReply> {
    return this.serial(() => this.checkNowSerial(input, save));
  }

  private async checkNowSerial(input: { googleEvents?: GoogleEventList }, save?: SavePhotoKey): Promise<ToolReply> {
    this.resume();
    const engine = this.engine;
    // The routines are created before Activate, so the Check routine can wake first.
    if (!this.file.checked && !this.file.texting && this.routineReady()) return this.reply({ alerts: [], messages: [], next: NOT_ACTIVE_YET });
    if (!this.file.checked || !engine) return this.fail("Run the checks first.");
    const read = await this.readCalendars(input.googleEvents);
    await engine.runReminders();
    this.syncHold();
    this.nudgeCheckout(engine);
    const shown = new Set(this.file.alertsShown ?? []);
    const fresh = [...this.visibleNotes(engine), ...this.newBookingAlert(engine)].filter((note) => !shown.has(note.id));
    this.file.alertsShown = [...shown, ...fresh.map((note) => note.id)];
    const messages = this.file.messages ?? [];
    const seen = new Set(this.file.messagesShown ?? []);
    const newMessages = messages.filter((message) => !seen.has(message.id));
    const firstNew = messages.findIndex((message) => !seen.has(message.id));
    // Already-shown messages just before the new ones, so a reply can be read against its question.
    const earlier = firstNew > 0 ? earlierThan(messages, firstNew) : [];
    // Only ids still kept, so the list stays as short as the messages.
    this.file.messagesShown = messages.map((message) => message.id);
    const jobs = engine.jobs();
    const shownDone = new Set(this.file.completedShown ?? []);
    const finished = jobs.filter((job) => job.doneAt && !shownDone.has(job.id));
    this.file.completedShown = [...shownDone, ...finished.map((job) => job.id)];
    const payDue = this.payDueNow(jobs);
    const drafts = this.waitingDrafts();
    const savedAnswers = this.savedAnswersOut();
    const wake = this.wakeAlert();
    prunePhotos(this.root, jobs, this.now());
    this.pruneMessagePhotos();
    this.noteCheck();
    this.persist();
    return this.reply({
      alerts: [...fresh.map((note) => note.body), ...(wake ? [wake] : [])],
      messages: this.messagesOut(newMessages, save),
      ...(read.held ? { calendarsHeld: calendarsHeld(read.held) } : {}),
      ...this.setAsideReply(),
      ...(drafts.length > 0 ? { drafts } : {}),
      ...(savedAnswers.length > 0 ? { savedAnswers } : {}),
      ...(earlier.length > 0 ? { earlier: earlier.map(({ photos: _photos, photosAt: _photosAt, ...message }) => this.withReply(message)) } : {}),
      ...(finished.length > 0 ? { completed: finished.map((job) => this.completedFacts(job)) } : {}),
      ...(payDue.length > 0 ? { payDue } : {}),
      turns: this.turns(),
      ...(this.needsTimes(engine) ? { needsTimes: true as const } : {}),
      ...(read.unread.length > 0 ? { unread: read.unread } : {}),
      ...(read.googleUnread ? { googleUnread: true as const } : {}),
    });
  }

  private async runChecksNow(input: { googleEvents?: GoogleEventList }): Promise<ToolReply> {
    if (!this.file.texting || !this.hasSources() || !this.codeSaved()) return this.fail("Set up texting first.");
    if (!this.file.host || !this.file.cleaner || !this.hostConfirmed()) return this.fail(HOST_UNCONFIRMED);
    if (!mayText(this.env(), this.file.cleaner)) return this.fail(CLEANER_IS_LINE);
    if (this.hub.google() && !input.googleEvents) return this.fail("Read Google Calendar and pass its events.");
    const before = this.engine;
    const engine = this.openEngine();
    this.engine = engine;
    this.checking = true;
    let read: CalendarRead;
    try {
      read = await this.readCalendars(input.googleEvents, { allOrNothing: true });
    } catch (err) {
      this.engine = before;
      throw err;
    } finally {
      this.checking = false;
    }
    if (read.held) return this.fail(calendarsHeld(read.held));
    if (read.reason) {
      this.engine = before;
      if (read.guestyFailed) return this.fail(read.reason);
      return this.fail(`I couldn't read the calendar link for ${read.unread.join(", ")}. Each link has to be a public https address, and not a private network.`);
    }
    if (read.googleUnread) {
      this.engine = before;
      return this.fail(GOOGLE_UNREAD);
    }
    this.file.checked = true;
    // run_checks' own reply already asks for the times, so its new-booking alert counts as shown too.
    const seen = [...this.visibleNotes(engine), ...this.newBookingAlert(engine)].map((note) => note.id);
    this.file.alertsShown = [...new Set([...(this.file.alertsShown ?? []), ...seen])];
    this.persist();
    const turns = this.turns();
    this.noteCheck();
    this.persist();
    // Claude, ChatGPT, and Muse follow this reply, not get_state, so there the scheduled task comes first, as in get_state.
    const task = this.task();
    if (task && !this.routineReady()) return this.reply({ next: this.words().routineAsk, routine: task, turns });
    return this.reply({
      next:
        turns.length === 0
          ? "I read the calendar. There's no guest stay yet. I'll tell you when one shows up."
          : "I read the calendar. Tell me the checkout time and the next check-in time before I text the cleaner.",
      turns,
    });
  }

  /**
   * Reads every saved booking source into the engine as one read: the calendar links in saved order,
   * then Google. The engine saves each source's last snapshot, so after a restart a link that fails
   * keeps its snapshot and its jobs. A link that fails is not applied, and is named in `unread`.
   *
   * A saved source the engine holds no snapshot of (never read, or saved before snapshots were kept)
   * and that is not read now would make the others look like they removed its stays, so then nothing
   * is applied. With `allOrNothing` (run_checks), any failed link applies nothing.
   */
  private async readCalendars(googleEvents?: GoogleEventList, options: { allOrNothing?: boolean } = {}): Promise<CalendarRead> {
    const engine = this.engine;
    const tenantId = this.file.propertyId;
    if (!engine || !tenantId) throw new Error("Setup is incomplete.");
    // Calendars set aside when the data moved are waiting for the host. Until they decide, a saved
    // list that would call off cleanings (the set-aside ones listed them) changes nothing.
    if (this.hub.setAside().length > 0) {
      const lost = engine.wouldCancel(this.hub.claims());
      if (lost.length > 0) return { guestyFailed: false, googleUnread: false, unread: [], held: lost.length };
    }
    const held = new Set(engine.keepSources(this.hub.claims()));
    // A saved Google source with no events now and no held snapshot would make the others look like
    // they removed its stays, so nothing is read or applied.
    if (this.hub.google() && !googleEvents && !held.has("google-calendar")) return { guestyFailed: false, googleUnread: false, unread: [] };
    // The hub fetches every saved link (and keeps the checkout dates Supply Core counts); the engine
    // logic below decides what to apply. Google events count only when the host saved Google.
    const hubRead = await this.hub.readCalendars({ ...(googleEvents ? { googleEvents } : {}), tenantId });
    const google = hubRead.google;
    const googleUnread = hubRead.googleUnread;
    if (this.hub.google() && !google && !held.has("google-calendar")) return { guestyFailed: false, googleUnread, unread: [] };
    const reads = hubRead.links;
    const failed = reads.flatMap(({ calendar, read }) => (read.ok ? [] : [{ calendar, reason: read.reason }]));
    const result: CalendarRead = {
      guestyFailed: failed.some((item) => item.calendar.sourceId === "guesty-lite"),
      ...(failed[0] ? { reason: failed[0].reason } : {}),
      googleUnread,
      unread: failed.map((item) => item.calendar.name),
    };
    if (failed.length > 0 && (options.allOrNothing || failed.some((item) => !held.has(item.calendar.sourceId)))) return result;
    const sources: BookingSource[] = [];
    const applied: string[] = [];
    for (const { calendar, read } of reads) {
      if (!read.ok) continue;
      const source = calendar.sourceId === "guesty-lite" ? guestyLiteSource(read.body, tenantId) : icalSource(read.body, tenantId, calendar.sourceId);
      sources.push(fromLink(source, calendar.origin));
      applied.push(calendar.name);
    }
    if (google) sources.push({ kind: "google-calendar", read: async () => google });
    if (sources.length === 0) return result;
    const polled = (await engine.readSources(sources)).polled;
    if (!polled) {
      result.unread.push(...applied);
      if (google) result.googleUnread = true;
    }
    return result;
  }

  /**
   * With group chat on, the engine asks the host nothing about a new booking, because Grok collects
   * the times with confirm_times. This alert names the job confirm_times would time, so check_now
   * reports the booking once. It is not a host note, so get_state is unchanged. A job the host
   * already timed is left to needsTimes.
   */
  private newBookingAlert(engine: CleanerCore): { id: string; body: string }[] {
    if (!this.groupOn() || !this.place.address || !this.place.timeZone) return [];
    const job = timesTarget(engine);
    if (!job || job.status !== "discovered" || job.checkoutTime || (this.file.timedJobs ?? []).includes(job.id)) return [];
    const day = this.checkoutDay(job.checkoutDate);
    const body = engine.newBookingAsk(job.id) ?? `New booking at ${this.place.address}, checking out ${day}. What are the checkout time and the next check-in time?`;
    return [{ id: `new-booking:${job.id}`, body }];
  }

  /**
   * At a confirmed cleaning's checkout time, with no departure recorded yet, keeps one host note
   * asking whether the guests have left. It sends nothing: the door code still waits for the host.
   */
  private nudgeCheckout(engine: CleanerCore): void {
    // A cleaning on hold won't get the code, so the host is not asked.
    if (this.held) return;
    const now = this.now().getTime();
    const name = this.place.nickname ?? this.place.address ?? "the property";
    for (const job of engine.jobs()) {
      if (job.status !== "confirmed" && job.status !== "awaiting_departure") continue;
      if (!job.checkoutAt || Date.parse(job.checkoutAt) > now) continue;
      engine.keepHostNote(`nudge:${job.id}`, `Checkout time at ${name}. Have the guests left?`);
    }
  }

  /**
   * Adds an owed record for each cleaning finished while payments were on, and returns the ones
   * check_now shows now: new ones, and unpaid ones whose next 9:00 AM reminder is due.
   */
  private payDueNow(jobs: JobView[]): Record<string, unknown>[] {
    const now = this.now();
    const at = now.toISOString();
    const zone = this.place.timeZone ?? "UTC";
    const pay = (this.file.pay ??= {});
    const settings = this.file.payments;
    const due: Record<string, unknown>[] = [];
    for (const job of jobs) {
      const record = pay[job.id];
      if (!record) {
        if (!job.doneAt || !settings?.on || !settings.rateCents || !settings.venmo || !settings.onSince) continue;
        if (Date.parse(job.doneAt) < Date.parse(settings.onSince)) continue;
        pay[job.id] = { amountCents: settings.rateCents, venmo: settings.venmo, owedAt: at, lastShownAt: at, reminders: 0 };
        due.push(this.payItem(job, pay[job.id]!));
        continue;
      }
      if (record.paidAt || record.reminders >= MAX_PAY_REMINDERS) continue;
      if (now.getTime() < Date.parse(nextReminderAt(record.lastShownAt, zone))) continue;
      record.reminders += 1;
      record.lastShownAt = at;
      due.push(this.payItem(job, record));
    }
    return due;
  }

  /** One payDue item. A link that would hold the door code is left out, and the host pays in Venmo. */
  private payItem(job: JobView, record: PayRecord): Record<string, unknown> {
    const link = this.payLink(job, record);
    return {
      job: job.checkoutDate,
      cleaner: this.file.cleanerName ?? "the cleaner",
      amount: dollarsText(record.amountCents),
      ...(this.leaks(link) ? { payInVenmo: true } : { link }),
      reminder: record.reminders,
    };
  }

  private payLink(job: JobView, record: PayRecord): string {
    const day = this.checkoutDay(job.checkoutDate).split(", ").at(-1) ?? job.checkoutDate;
    const label = this.payLabel();
    return venmoPayLink({ username: record.venmo, cents: record.amountCents, label, day });
  }

  /** The pay note's name for the property: the nickname or business, never the address. */
  private payLabel(): string {
    const label = (this.place.nickname ?? this.file.business ?? "").trim();
    const address = (this.place.address ?? "").toLowerCase();
    const street = address.split(",")[0]?.trim() ?? "";
    const lower = label.toLowerCase();
    if (!label || (address && (address.includes(lower) || (street && lower.includes(street))))) return "Cleaning";
    return label;
  }

  /** The owed, unpaid cleaning `wanted` names (a checkout date, a day, or an id). */
  private owedJob(wanted: string | undefined): { job: JobView; record: PayRecord } | undefined {
    const engine = this.engine;
    if (!engine || !wanted?.trim()) return undefined;
    const job = this.findJob(engine.jobs(), wanted.trim().toLowerCase());
    const record = job ? this.file.pay?.[job.id] : undefined;
    return job && record ? { job, record } : undefined;
  }

  /** Records that the host paid for one cleaning. Only after the host's own words in chat. Never moves money. */
  markPaid(input: { job?: string; how?: "venmo" | "other"; confirmed?: boolean }): Promise<ToolReply> {
    return this.serial(async () => this.markPaidNow(input));
  }

  private markPaidNow(input: { job?: string; how?: "venmo" | "other"; confirmed?: boolean }): ToolReply {
    if (input.confirmed !== true) return this.fail(PAID_NEEDS_YES);
    this.resume();
    const owed = this.owedJob(input.job);
    if (!owed) return this.fail(NOT_OWED);
    if (owed.record.paidAt) return this.reply({ next: "That cleaning is already marked paid." });
    owed.record.paidAt = this.now().toISOString();
    owed.record.how = input.how === "other" ? "other" : "venmo";
    owed.record.confirmedBy = "landlord";
    this.persist();
    const day = this.checkoutDay(owed.job.checkoutDate).split(", ").at(-1);
    return this.reply({ next: `Marked ${this.file.cleanerName ? `${this.file.cleanerName}'s` : "the cleaner's"} ${day} cleaning paid.` });
  }

  /** A new pay link for an unpaid cleaning, with a new amount for that cleaning when given. */
  getPayLink(input: { job?: string; amount?: number }): Promise<ToolReply> {
    return this.serial(async () => this.getPayLinkNow(input));
  }

  private getPayLinkNow(input: { job?: string; amount?: number }): ToolReply {
    this.resume();
    const owed = this.owedJob(input.job);
    if (!owed || owed.record.paidAt) return this.fail(NOT_OWED);
    if (input.amount !== undefined) {
      const cents = payCents(input.amount);
      if (cents === undefined) return this.fail(RATE_HELP);
      owed.record.amountCents = cents;
      this.persist();
    }
    const item = this.payItem(owed.job, owed.record);
    return this.reply({ job: item.job, amount: item.amount, ...(item.link ? { link: item.link } : { payInVenmo: true }) });
  }

  /**
   * A finished cleaning's facts, for Grok to summarize in its own words. Times are local at the
   * property. Notes were redacted when they were kept, and the reply's leak check still runs.
   */
  private completedFacts(job: JobView): Record<string, unknown> {
    const zone = this.place.timeZone ?? "UTC";
    const local = (iso: string | undefined) => {
      if (!iso) return null;
      const when = formatWhen(iso, zone);
      return `${when.day}, ${when.time}`;
    };
    return {
      nickname: this.place.nickname ?? this.place.address ?? "the property",
      day: this.checkoutDay(job.checkoutDate),
      arrivalTime: job.arrivalTime ?? null,
      startedAt: local(job.startedAt),
      doneAt: local(job.doneAt),
      ...(job.checklistConfirmedAt ? { checklistConfirmed: local(job.checklistConfirmedAt) } : {}),
      checklist: job.checklist ?? [],
      photos: job.photos ?? 0,
      // Photos that came in but couldn't be downloaded, so get_job_photos can't show them.
      ...((job.photos ?? 0) > (job.photosSaved ?? 0) ? { photosMissing: (job.photos ?? 0) - (job.photosSaved ?? 0) } : {}),
      notes: job.notes ?? [],
    };
  }

  /**
   * Links to the cleaner's photos for one job, each good for one hour. `job` is a checkout date like
   * 2026-10-18 or the day check_now named, like Sunday, Oct 18. Without it, the latest job with
   * photos. The signing key is CLEANER_CORE_PHOTO_KEY, or one made once and saved through `save`.
   */
  getJobPhotos(input: { job?: string }, save?: SavePhotoKey): Promise<ToolReply> {
    return this.serial(async () => this.getJobPhotosNow(input, save));
  }

  private getJobPhotosNow(input: { job?: string }, save: SavePhotoKey | undefined): ToolReply {
    this.resume();
    const engine = this.engine;
    if (!this.file.checked || !engine) return this.fail("Run the checks first.");
    const wanted = input.job?.trim().toLowerCase() ?? "";
    const jobs = engine.jobs();
    const job = wanted ? this.findJob(jobs, wanted) : [...jobs].reverse().find((item) => photoCount(this.root, item.id) > 0);
    if (wanted && !job) return this.fail(NO_PHOTO_JOB);
    if (!job) return this.reply({ photos: [] });
    const base = publicBaseUrl(this.env());
    const key = base ? photoKey(this.env(), save) : undefined;
    if (!base || !key) return this.fail(PHOTO_LINKS_OFF);
    return this.reply({ photos: photoLinks(this.root, job.id, base, key, this.now()) });
  }

  /** The job a lowercase `wanted` names: its checkout date, its day like "sunday, oct 18", or its id. */
  private findJob(jobs: JobView[], wanted: string): JobView | undefined {
    const dayOf = (job: JobView) => this.checkoutDay(job.checkoutDate).toLowerCase();
    return jobs.find((item) => item.checkoutDate === wanted || dayOf(item) === wanted || item.id.toLowerCase() === wanted);
  }

  /** Supply Core is offered at setup only to an always-on agent (Grok Bot, Muse) on the shared service, where the add-on lives. */
  private offersSupplies(): boolean {
    return runsSupplies(this.assistant()) && cleanerMultiTenant(this.env());
  }

  /** The host answered the Supply Core question, or turned it on another way: setup doesn't ask again. */
  noteSuppliesChoice(): Promise<void> {
    return this.serial(async () => {
      if (this.file.suppliesAsked) return;
      this.file.suppliesAsked = true;
      this.persist();
    });
  }

  /** Supply Core turned on, off, or activated: the engine reopens before the next step and reads it. */
  refreshSupplyAsk(): void {
    this.stale = true;
  }

  getTurns(): Promise<ToolReply> {
    return this.serial(async () => this.getTurnsNow());
  }

  private getTurnsNow(): ToolReply {
    this.resume();
    return this.reply({ turns: this.turns(), ...(this.held ? { held: true } : {}) });
  }

  /**
   * Saves the cleaner's arrival time, which Grok read in their message, on the open job's checkout
   * day. The time needs AM or PM. The server never reads an arrival time from a text itself.
   */
  saveArrival(input: { time?: string }): Promise<ToolReply> {
    return this.serial(async () => this.saveArrivalNow(input));
  }

  private saveArrivalNow(input: { time?: string }): ToolReply {
    const hm = hourMinute(input.time);
    if (!hm) return this.fail(ARRIVAL_NEEDED);
    this.resume();
    if (!this.file.checked || !this.engine?.saveArrival(minutesOfDay(hm))) return this.fail(NO_OPEN_CLEANING);
    return this.reply({ next: ARRIVAL_SAVED, turns: this.turns() });
  }

  confirmTimes(input: { checkout?: string; checkIn?: string; all?: boolean }): Promise<ToolReply> {
    return this.serial(() => this.confirmTimesNow(input));
  }

  private async confirmTimesNow(input: { checkout?: string; checkIn?: string; all?: boolean }): Promise<ToolReply> {
    this.resume();
    if (!this.file.checked || !this.engine || !this.file.host) return this.fail("Run the checks first.");
    const checkout = hourMinute(input.checkout);
    const checkIn = hourMinute(input.checkIn);
    if (!checkout || !checkIn) return this.fail(TIMES_NEEDED);
    const engine = this.engine;
    const times = { checkout: minutesOfDay(checkout), checkIn: minutesOfDay(checkIn) };
    if (input.all === true) return this.confirmAllTimes(engine, times);
    const target = timesTarget(engine);
    const sentBefore = new Set(engine.outbox().filter((item) => item.status === "sent").map((item) => item.id));
    // A check-in the host already set stays, as the tool description says.
    await engine.setHostTimes({ ...times, keepCheckIn: true });
    const job = engine.jobs().find((item) => item.id === target?.id);
    if (!job || !hasTimes(job)) return this.fail(TIMES_NEEDED);
    this.file.released = true;
    this.file.timedJobs = [...new Set([...(this.file.timedJobs ?? []), ...engine.jobs().filter(hasTimes).map((item) => item.id)])];
    this.persist();
    await engine.releaseCleanerTexts();
    const sent = this.cleanerSent(engine, sentBefore);
    const held = this.armUpdate(engine);
    return this.reply({
      next:
        sent === "opt-in"
          ? "Times saved. The cleaner got one text asking them to reply YES. Nothing else goes to them until they do."
          : sent === "offer"
            ? "Times saved. I sent the cleaner the cleaning offer. They reply YES to take it."
            : sent === "corrected"
              ? "Times saved. I sent the cleaner the new time."
              : held
                ? UPDATE_HELD
                : "Times saved. Nothing was sent.",
      turns: this.turns(),
    });
  }

  /**
   * The text this call sent the cleaner, one-to-one or in the group. Only texts sent since `before`,
   * so an opt-in from an earlier job is not reported again.
   */
  private cleanerSent(engine: CleanerCore, before: Set<string>): "opt-in" | "offer" | "corrected" | undefined {
    const sentNow = engine.outbox().filter((item) => item.status === "sent" && !before.has(item.id) && item.to === this.file.cleaner);
    return (["opt-in", "offer", "corrected"] as const).find((kind) => sentNow.some((item) => item.kind === kind));
  }

  /**
   * Times every open turnover the host hasn't timed with the same checkout and check-in. Only a group
   * setup does this. The cleaner still gets one offer at a time, and replies YES to each.
   */
  private async confirmAllTimes(engine: CleanerCore, times: { checkout: number; checkIn: number }): Promise<ToolReply> {
    if (!this.groupOn()) return this.fail("I can only time one turnover at a time here. Tell me the first turnover's times.");
    const sentBefore = new Set(engine.outbox().filter((item) => item.status === "sent").map((item) => item.id));
    const { timed } = await engine.setOpenTimes(times);
    if (timed === 0) return this.fail("Every upcoming turnover already has times.");
    this.file.released = true;
    this.file.timedJobs = [...new Set([...(this.file.timedJobs ?? []), ...engine.jobs().filter(hasTimes).map((item) => item.id)])];
    this.persist();
    await engine.releaseCleanerTexts();
    // Says whether a text went out, so a texting setup that sends nothing shows up here.
    const saved = `Times saved for ${timed} ${timed === 1 ? "turnover" : "turnovers"}.`;
    const sent = this.cleanerSent(engine, sentBefore);
    return this.reply({
      next:
        sent === "opt-in"
          ? `${saved} The cleaner got one text asking them to reply YES. Offers start after they do, one at a time.`
          : sent === "offer"
            ? `${saved} I sent the cleaner the first cleaning offer. They reply YES to take it, and the next offer comes after.`
            : `${saved} Nothing was sent yet. The cleaner gets one cleaning offer at a time, starting with the first.`,
      turns: this.turns(),
    });
  }

  /**
   * Wakes the desk when a held checkout update is due. True while one is held. A restart loses the
   * timer, and the next check_now sends the update instead.
   */
  private armUpdate(engine: CleanerCore, onlyAhead = false): boolean {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    const due = engine.updateDueAt();
    if (!due) return false;
    const ahead = Date.parse(due) - this.now().getTime();
    // An update that is due but still can't go (a hold, an opt-out) waits for the next check_now.
    if (onlyAhead && ahead <= 0) return true;
    const wait = Math.max(0, ahead) + 1000;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      if (desks.get(this.root) !== this) return;
      void this.serial(async () => {
        this.resume();
        const current = this.engine;
        if (!current) return;
        await current.sendDueUpdates();
        this.persist();
        this.armUpdate(current, true);
      }).catch(() => undefined);
    }, wait);
    this.updateTimer.unref?.();
    return true;
  }

  markGuestsLeft(input: { confirmed?: boolean }, pinKey: Buffer | undefined): Promise<ToolReply> {
    return this.serial(() => this.markGuestsLeftNow(input, pinKey));
  }

  private async markGuestsLeftNow(input: { confirmed?: boolean }, pinKey: Buffer | undefined): Promise<ToolReply> {
    if (!this.file.host || !this.file.checked) return this.fail("Run the checks first.");
    if (input.confirmed !== true) return this.fail(DEPARTURE_NEEDED);
    const key = this.keyFor(pinKey);
    if (!key) return this.fail(PIN_KEY_MISSING);
    if (this.unlock(key) !== "ready") return this.fail(PIN_REENTER);
    this.resume();
    if (this.pin) this.engine?.rememberPin(this.pin);
    if (!this.engine) return this.fail("Run the checks first.");
    if (this.file.pinSend?.outcome === "settled") return this.reply({ next: PIN_REPEAT });
    if (this.engine.jobOnHold()) {
      const line = this.heldDepartureLine();
      if (line === optedOutCodeLine()) this.engine.keepHostNote(`host:pin-held:${line}`, line);
      return this.reply({ next: line });
    }
    if (this.engine.pinAccepted()) return this.reply({ next: PIN_REPEAT });
    this.accessRefusal = undefined;
    const result = await this.engine.hostDeparture(`left-${randomUUID()}`);
    if (result.reason !== "departure") return this.fail(NO_DEPARTURE_JOB);
    // The hub refused door access for this release: say why, as the engine's host note does.
    const refusal = this.accessRefusal as AccessRefusal | undefined;
    if (refusal) return this.fail(this.accessRefusedLines()[refusal] ?? PIN_REENTER);
    const heldLine = result.sent.find((text) => text.kind === "pin-held")?.body;
    const sentNow = result.sent.some((text) => text.kind === "pin");
    const privateNow = result.sent.some((text) => text.kind === "pin" && text.channel !== "group");
    if (this.groupOn() && this.engine.groupPinSettled() && !sentNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "", outcome: "settled", notePending: false };
      this.persist();
      return this.reply({ next: "A text failed to send. I saved it for your review and did not count it as delivered." });
    }
    if (sentNow && this.groupOn() && !privateNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "group", outcome: "accepted", notePending: false };
      this.persist();
    }
    if (heldLine) return this.reply({ next: heldLine });
    if (sentNow) return this.reply({ next: privateNow ? PIN_SENT : PIN_SENT_GROUP });
    return this.reply({ next: this.words().pinFailed });
  }

  /** Sends an offer or reminder that may not have gone out once more, after the host said to. */
  retrySend(input: { confirmed?: boolean }): Promise<ToolReply> {
    return this.serial(() => this.retrySendNow(input));
  }

  private async retrySendNow(input: { confirmed?: boolean }): Promise<ToolReply> {
    if (input.confirmed !== true) return this.fail(RETRY_NEEDED);
    this.resume();
    if (!this.file.host || !this.engine) return this.fail("Run the checks first.");
    const result = await this.engine.hostRetry(`retry-${randomUUID()}`);
    return this.reply({ next: result.sent.length > 0 ? RETRY_SENT : RETRY_NOTHING, turns: this.turns() });
  }

  /**
   * Pauses the cleaning, only on the host's yes. Without a confirmation it returns the question to ask
   * the host and an approval code. With the code, no offer, reminder, or door code goes out until the
   * host resumes it, and the cleaner gets one hold line.
   */
  holdJob(input: { confirmation?: string }): Promise<ToolReply> {
    return this.serial(() => this.holdJobNow(input));
  }

  private async holdJobNow(input: { confirmation?: string }): Promise<ToolReply> {
    this.resume();
    if (!this.place.address || !this.engine) return this.fail("Run the checks first.");
    if (this.engine.jobOnHold()) return this.reply({ next: ALREADY_HELD });
    const address = this.place.address;
    const fingerprint = createHash("sha256").update(`hold|${address}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const next = `Pause the cleaning at ${address}? No cleaning offer, reminder, or door code goes out until you resume it, and the cleaner gets one text saying it's on hold. Reply yes to pause.`;
      return this.reply({ next, confirmation: this.approvals.issue(HOLD_ACTION, CLEANING_TARGET, fingerprint, next) });
    }
    if (!this.redeemed(this.approvals, code, HOLD_ACTION, CLEANING_TARGET, fingerprint)) return this.fail(APPROVAL_STALE);
    await this.engine.hostHold(`hold-${randomUUID()}`);
    this.syncHold();
    this.persist();
    return this.reply({ next: jobHoldLine(address), turns: this.turns() });
  }

  /** Every phone this setup saved: host, cleaner, observer, and contacts. Sends nothing. */
  knownPhones(): Promise<string[]> {
    return this.serial(async () => this.savedPhones());
  }

  private savedPhones(): string[] {
    const raw = [this.file.host, this.file.cleaner, this.file.observer, ...(this.file.contacts ?? []).map((contact) => contact.phone)];
    return raw.map((phone) => (phone ? parsePhone(phone) : undefined)).filter((phone): phone is string => !!phone);
  }

  /** True when the saved host is the account's confirmed landlord, so this property's texts may go. */
  textsAllowed(): Promise<boolean> {
    return this.serial(async () => this.hostConfirmed());
  }

  /** The business name saved for this property. */
  businessName(): Promise<string | undefined> {
    return this.serial(async () => this.file.business);
  }

  /** A note for the host's agent chat from the shared line, such as a held text that was dropped. One wake-up. */
  noteDroppedText(note: string): Promise<boolean> {
    return this.noteForHost(`line-note:${randomUUID()}`, note);
  }

  /**
   * Records that the landlord's phone opted out of the shared line before this property saved it.
   * Nothing is sent to it, and nothing is sent by this call, until it texts START or YES.
   */
  markHostOptedOut(phone: string): Promise<void> {
    return this.serial(async () => {
      const e164 = parsePhone(phone);
      if (!e164) return;
      const out = this.file.lineOptOuts ?? [];
      if (out.includes(e164)) return;
      this.file.lineOptOuts = [...out, e164];
      this.persist();
    });
  }

  /**
   * A text the host sent the shared line one-to-one, kept for the host's chat because the account has
   * several properties and the text can't say which. Its digit runs are redacted. One wake-up.
   */
  noteUnusedHostText(text: string): Promise<boolean> {
    const words = this.messageText(text);
    return this.noteForHost(`unused-host:${randomUUID()}`, `The host texted the line: "${words}". It wasn't used, because this account has several properties. Ask them in chat which property.`);
  }

  /** Counts the account's alert routine, connected through another property, as connected here. */
  markRoutineConnected(connectionIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const ids = this.file.routineConnections ?? [];
      const fresh = connectionIds.filter((id) => !ids.includes(id));
      if (fresh.length === 0 && this.file.routineConnected) return;
      this.file.routineConnected = true;
      this.file.routineConnections = [...ids, ...fresh];
      this.persist();
    });
  }

  /** On a line shared by two or more properties, a text to the host, or in the group, names the property first. */
  private labeled(to: string, body: string, group: boolean): string {
    // A person on two or more of the account's properties: a one-to-one text names the property it's about, by its street.
    const street = this.place.address ? streetOf(this.place.address) : undefined;
    if (!group && street && to !== this.file.host && (this.people?.propertiesOf(to).length ?? 0) >= 2) {
      return body.startsWith(`${street}: `) ? body : `${street}: ${body}`;
    }
    const env = this.env();
    const label = env.CLEANER_CORE_PROPERTY_LABEL?.trim();
    if (!label || Number(env.CLEANER_CORE_PROPERTY_COUNT ?? "1") < 2) return body;
    if (!group && to !== this.file.host) return body;
    return body.startsWith(`${label}: `) ? body : `${label}: ${body}`;
  }

  /** True while the phone opted out of the shared line before it was saved here. */
  private lineOptedOut(phone: string): boolean {
    // On an account, a person's own STOP lives in the account's people list, for every property. The
    // landlord is never a person there: their line STOP stays in this desk's list. Until the account's
    // one-time move has run, the desk's list still counts for everyone.
    if (this.people?.stopped(phone)) return true;
    if (this.people?.moved() && phone !== parsePhone(this.file.host ?? "")) return false;
    return (this.file.lineOptOuts ?? []).includes(phone);
  }

  /** A note for the host from the shared service, shown by check_now, with one wake-up. Nothing is texted. */
  noteForHost(id: string, body: string): Promise<boolean> {
    return this.serial(async () => {
      this.resume();
      const engine = this.engine;
      if (!engine) return false;
      const before = new Set(this.visibleNotes(engine).map((note) => note.id));
      engine.keepHostNote(id, body);
      this.queueNewAlerts(before);
      return true;
    });
  }

  /**
   * What keeps this number on cleaning. Sends nothing. Only tests call it, to see what is live:
   * set_flows replaced the shared service's switch that used it.
   */
  liveWork(): Promise<{ live: string[]; inProgress: boolean }> {
    return this.serial(async () => {
      this.resume();
      const jobs = this.engine?.liveJobs() ?? [];
      return {
        live: jobs.map((job) => `The cleaning for checkout on ${job.checkoutDate} is ${LIVE_WORDS[job.status] ?? job.status}.`),
        inProgress: jobs.some((job) => job.status === "cleared" || job.status === "in_progress"),
      };
    });
  }

  /**
   * Calls off what's live so the number can switch services, keeping the setup. The first call
   * previews the exact texts and returns a code; the second, with the code after the host's yes,
   * does it. Never while a cleaning is under way.
   */
  standDown(input: { confirmation?: string }): Promise<ToolReply> {
    return this.serial(async () => {
      this.resume();
      const jobs = this.engine?.liveJobs() ?? [];
      if (jobs.some((job) => job.status === "cleared" || job.status === "in_progress")) return this.fail(UNDER_WAY);
      if (!this.engine || jobs.length === 0) return this.reply({ next: NOTHING_LIVE, texts: [] });
      const cleaner = this.file.cleanerName ?? "your cleaner";
      const texts = this.engine.standDownTexts().map((text) => ({ to: text.to === "cleaner" ? cleaner : "you", body: text.body }));
      const fingerprint = createHash("sha256").update(`stand-down|${jobs.map((job) => `${job.id}:${job.status}`).join(",")}|${texts.map((t) => t.body).join("|")}`).digest("hex");
      const code = input.confirmation?.trim() ?? "";
      if (!code) {
        const stops = jobs.map((job) => `- The cleaning for checkout on ${job.checkoutDate}.`).join("\n");
        const goes = texts.length ? `These texts go out:\n${texts.map((t) => `- To ${t.to}: "${t.body}"`).join("\n")}` : "No texts go out.";
        const next = `Stand down cleaning at ${this.place.address ?? "this property"}? This calls off:\n${stops}\n${goes}\nThe setup is kept. Reply yes to stand down.`;
        return this.reply({ next, texts, confirmation: this.approvals.issue(STAND_DOWN_ACTION, CLEANING_TARGET, fingerprint, next) });
      }
      if (!this.redeemed(this.approvals, code, STAND_DOWN_ACTION, CLEANING_TARGET, fingerprint)) return this.fail(APPROVAL_STALE);
      await this.engine.hostStandDown(`stand-down-${randomUUID()}`);
      this.syncHold();
      this.persist();
      return this.reply({ next: STOOD_DOWN, texts });
    });
  }

  /** Resumes a cleaning on hold, only on the host's yes, with the same preview and approval code as hold_job. */
  resumeCleaning(input: { confirmation?: string } = {}): Promise<ToolReply> {
    return this.serial(() => this.resumeCleaningNow(input));
  }

  private async resumeCleaningNow(input: { confirmation?: string }): Promise<ToolReply> {
    this.resume();
    if (!this.place.address || !this.engine) return this.fail("Run the checks first.");
    const address = this.place.address;
    const fingerprint = createHash("sha256").update(`resume|${address}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const next = `Resume the cleaning at ${address}? Cleaning texts and the door code can go out again under the usual rules. Reply yes to resume.`;
      return this.reply({ next, confirmation: this.approvals.issue(RESUME_ACTION, CLEANING_TARGET, fingerprint, next) });
    }
    if (!this.redeemed(this.approvals, code, RESUME_ACTION, CLEANING_TARGET, fingerprint)) return this.fail(APPROVAL_STALE);
    await this.engine.resumeJob();
    this.syncHold();
    this.persist();
    return this.reply({ next: resumeNote(this.place.address) });
  }

  /**
   * Saves one reply draft for a cleaner or contact message, by its id. It sends nothing, so a
   * routine may call it. The reply goes to the group when there is one, otherwise to the person
   * who wrote. A new draft for the same message replaces the old one; drop removes it.
   */
  saveDraft(input: { replyTo?: string; text?: string; drop?: boolean }, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.saveDraftNow(input, pinKey));
  }

  private saveDraftNow(input: { replyTo?: string; text?: string; drop?: boolean }, pinKey: Buffer | undefined): ToolReply {
    const replyTo = input.replyTo?.trim() ?? "";
    const kept = this.file.messages ?? [];
    const at = kept.findIndex((message) => message.id === replyTo);
    const message = kept[at];
    if (input.drop) {
      this.setDrafts((this.file.drafts ?? []).filter((draft) => draft.replyTo !== replyTo));
      this.persist();
      return this.reply({ dropped: true });
    }
    if (!message || message.from === "host") return this.fail(DRAFT_UNKNOWN);
    const text = input.text?.trim() ?? "";
    if (!text || text.length > MAX_HOST_MESSAGE) return this.fail(MESSAGE_NEEDED);
    this.openSeal(pinKey);
    if (this.carriesCode(text)) return this.fail(DOOR_CODE_IN_CHAT);
    const state = replyStateAt(kept, at);
    if (state?.reply === "answered") return this.failWith(ALREADY_ANSWERED, { alreadyAnswered: true, by: state.by });
    const to = this.draftRecipientKey(message);
    if ("error" in to) return this.fail(to.error);
    const members = to.key === "group" ? this.groupMembersNow() : undefined;
    const draft: StoredDraft = { id: messageId(), replyTo, to: to.key, text, base: kept.at(-1)!.id, ...(members !== undefined ? { members } : {}) };
    this.setDrafts([...(this.file.drafts ?? []).filter((item) => item.replyTo !== replyTo), draft]);
    this.persist();
    return this.reply({ draft: this.draftOut(draft, "ready") });
  }

  /**
   * Who a reply to this message goes to, by phone, so a contact who shares the cleaner's name, or a
   * cleaner replaced later, never gets someone else's reply. With a group, replies go only to the
   * group, so a contact who texted one-to-one from outside it can't get one.
   */
  private draftRecipientKey(message: Message): { key: string } | { error: string } {
    if (this.groupOn()) return message.from === "contact" && message.channel !== "group" ? { error: DRAFT_NOT_IN_GROUP } : { key: "group" };
    if (message.from === "cleaner") return this.file.cleaner ? { key: `cleaner:${this.file.cleaner}` } : { error: DRAFT_RECIPIENT_CHANGED };
    const contact = contactsOf(this.file).find((item) => item.name === message.name);
    return contact ? { key: `contact:${contact.phone}` } : { error: DRAFT_RECIPIENT_CHANGED };
  }

  /** The recipient a draft's key names now, or why it can't be sent. */
  private draftRecipient(key: string): { key: string; send: string; name: string } | { error: string } {
    if (key === "group") return this.recipientOf("group");
    if (this.groupOn()) return { error: GROUP_ONLY };
    if (key.startsWith("cleaner:")) {
      const phone = key.slice("cleaner:".length);
      if (!this.file.cleaner || phone !== this.file.cleaner) return { error: DRAFT_RECIPIENT_CHANGED };
      return { key, send: phone, name: this.file.cleanerName ?? "the cleaner" };
    }
    if (key.startsWith("contact:")) {
      const contact = contactsOf(this.file).find((item) => `contact:${item.phone}` === key);
      return contact ? { key, send: contact.phone, name: contact.name } : { error: DRAFT_RECIPIENT_CHANGED };
    }
    return { error: DRAFT_RECIPIENT_CHANGED };
  }

  /** A draft as check_now and save_draft show it: the recipient by name, never by phone. */
  private draftOut(draft: StoredDraft, status: "ready" | "stale"): Record<string, unknown> {
    const recipient = this.draftRecipient(draft.to);
    const to = draft.to === "group" ? GROUP_RECIPIENT : "error" in recipient ? "someone no longer saved" : recipient.name;
    return { id: draft.id, replyTo: draft.replyTo, to, text: draft.text, status };
  }

  /** The drafts still waiting, as check_now returns them. Answered and gone drafts are removed from the file. */
  private waitingDrafts(): Record<string, unknown>[] {
    const kept = this.file.messages ?? [];
    const waiting: { draft: StoredDraft; status: "ready" | "stale" }[] = [];
    const members = this.groupMembersNow();
    for (const draft of this.file.drafts ?? []) {
      const status = draftStatus(draft, kept, members);
      // A draft whose group changed is shown stale, so the assistant reads the thread and drafts again.
      if (status === "ready" || status === "stale" || status === "changed") waiting.push({ draft, status: status === "ready" ? "ready" : "stale" });
    }
    if (waiting.length !== (this.file.drafts ?? []).length) this.setDrafts(waiting.map((item) => item.draft));
    return waiting.map((item) => this.draftOut(item.draft, item.status));
  }

  /** Replaces the saved drafts. A draft that leaves takes its approval codes out of the book with it. */
  private setDrafts(next: StoredDraft[]): void {
    const keep = new Set(next.map((draft) => draft.id));
    for (const draft of this.file.drafts ?? []) {
      if (keep.has(draft.id)) continue;
      this.draftApprovals.dropTagged(draft.id);
    }
    if (next.length > 0) this.file.drafts = next;
    else delete this.file.drafts;
  }

  /** Who is in the group thread now, as sorted phones joined by commas, or undefined without one. */
  private groupMembersNow(): string | undefined {
    if (!this.groupOn()) return undefined;
    this.resume();
    const members = this.engine?.groupMembers();
    return members ? [...members].sort().join(",") : undefined;
  }

  /**
   * Saves, or with remove forgets, the host's own answer for a topic, on the host's yes. It sends
   * nothing. Saving a topic already saved (ignoring case) replaces its answer. There is no count limit.
   */
  saveAnswer(input: { topic?: string; answer?: string; remove?: boolean; confirmation?: string }, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(async () => this.saveAnswerNow(input, pinKey));
  }

  private saveAnswerNow(input: { topic?: string; answer?: string; remove?: boolean; confirmation?: string }, pinKey: Buffer | undefined): ToolReply {
    const topic = input.topic?.trim() ?? "";
    const answer = input.remove ? "" : (input.answer?.trim() ?? "");
    if (!topic || (!input.remove && !answer)) return this.fail(ANSWER_NEEDED);
    this.openSeal(pinKey);
    if (this.carriesCode(topic) || this.carriesCode(answer)) return this.fail(DOOR_CODE_IN_CHAT);
    if (topic.length > MAX_TOPIC) return this.fail(TOPIC_TOO_LONG);
    if (answer.length > MAX_HOST_MESSAGE) return this.fail(ANSWER_TOO_LONG);
    const key = topic.toLowerCase();
    const saved = this.file.savedAnswers ?? [];
    if (input.remove && !saved.some((item) => item.topic.toLowerCase() === key)) return this.fail(NO_SUCH_ANSWER);
    const fingerprint = createHash("sha256").update(`${key}|${answer}|${input.remove ? 1 : 0}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const question = input.remove ? `Forget the saved answer for ${topic}?` : `Save for next time, ${topic}: "${answer}"?`;
      return this.reply({ preview: input.remove ? { topic, remove: true } : { topic, answer }, confirmation: this.approvals.issue(SAVE_ANSWER_ACTION, "answers", fingerprint, question) });
    }
    if (!this.redeemed(this.approvals, code, SAVE_ANSWER_ACTION, "answers", fingerprint)) return this.fail(APPROVAL_STALE);
    const others = saved.filter((item) => item.topic.toLowerCase() !== key);
    const next = input.remove ? others : [...others, { topic, answer }];
    if (next.length > 0) this.file.savedAnswers = next;
    else delete this.file.savedAnswers;
    this.persist();
    return this.reply({ next: input.remove ? "Forgotten." : "Saved." });
  }

  /**
   * The host's saved answers, then the checklist and the cleaning note, as check_now returns them.
   * Unlike kept messages, these aren't digit-redacted: they are the host's own words, which a draft
   * sends word for word, so redacting would break the reply. The door code can't be in them: saving
   * checks for it, and while the code is sealed and can't be opened any run of 4 or more digits is
   * refused (carriesCode). A new door code whose digits are already in one won't seal (saveDoorCodeNow).
   */
  private savedAnswersOut(): SavedAnswer[] {
    const preferences = this.file.preferences;
    return [
      ...(this.file.savedAnswers ?? []),
      ...(preferences?.checklist?.length ? [{ topic: "Checklist", answer: preferences.checklist.join("; ") }] : []),
      ...(preferences?.instructions ? [{ topic: "Cleaning note", answer: preferences.instructions }] : []),
    ];
  }

  /**
   * Sends the host's own message to the cleaner, the group, or a saved contact. Without a
   * confirmation it only checks the message and returns the exact text with an approval code.
   * With the code it sends through the engine, and only when the recipient and the text are the
   * ones the host approved. The door code never goes out this way.
   */
  sendMessage(input: { to?: string; text?: string; draft?: string; confirmation?: string }, pinKey?: Buffer): Promise<ToolReply> {
    return this.serial(() => (input.draft !== undefined ? this.sendDraftNow(input.draft, input.confirmation, pinKey) : this.sendMessageNow(input, pinKey)));
  }

  /**
   * Sends a saved draft: its text, to its recipient, with the host's code. The code never expires,
   * and is bound to the draft, its text, and who is in the group. A draft that is stale, answered,
   * or gone is refused, both for the preview and for the send.
   */
  private async sendDraftNow(id: string, confirmation: string | undefined, pinKey: Buffer | undefined): Promise<ToolReply> {
    const draft = (this.file.drafts ?? []).find((item) => item.id === id.trim());
    if (!draft) return this.fail(DRAFT_GONE);
    const kept = this.file.messages ?? [];
    const status = draftStatus(draft, kept, this.groupMembersNow());
    if (status === "gone") return this.fail(DRAFT_GONE);
    if (status === "changed") return this.fail(DRAFT_RECIPIENT_CHANGED);
    if (status === "answered") {
      const state = replyStateAt(kept, kept.findIndex((message) => message.id === draft.replyTo));
      return this.failWith(ALREADY_ANSWERED, { alreadyAnswered: true, by: state?.reply === "answered" ? state.by : "group" });
    }
    if (status === "stale") return this.failWith(DRAFT_NEW_SINCE, { newSince: true });
    this.openSeal(pinKey);
    if (this.carriesCode(draft.text)) return this.fail(DOOR_CODE_IN_CHAT);
    const recipient = this.draftRecipient(draft.to);
    if ("error" in recipient) return this.fail(recipient.error);
    const cant = `I can't text ${recipient.name} right now.`;
    this.resume();
    const engine = this.engine;
    if (this.pin) engine?.rememberPin(this.pin);
    if (!this.file.checked || !engine || !this.reachable(recipient.send, engine)) return this.fail(cant);
    if (engine.hostMessagesSince(new Date(this.now().getTime() - HOUR_MS)) >= HOST_MESSAGES_PER_HOUR) return this.fail(TOO_MANY);
    const bound = recipient.send === "group" ? `group:${engine.groupMembers().join(",")}` : recipient.key;
    const fingerprint = createHash("sha256").update(`${bound}|draft:${draft.id}|${draft.text}`).digest("hex");
    const code = confirmation?.trim() ?? "";
    if (!code) {
      const question = `Send to ${recipient.name}: "${draft.text}"?`;
      const issued = this.draftApprovals.issue(SEND_ACTION, recipient.key, fingerprint, question, draft.id);
      return this.reply({ preview: { to: recipient.name, text: draft.text }, confirmation: issued });
    }
    if (!this.redeemed(this.draftApprovals, code, SEND_ACTION, recipient.key, fingerprint)) return this.fail(APPROVAL_STALE);
    let sent: CleanerText | null;
    try {
      sent = await engine.sendHostMessage({ to: recipient.send, body: draft.text });
    } catch {
      sent = null;
    }
    if (!sent) return this.fail(cant);
    this.setDrafts((this.file.drafts ?? []).filter((item) => item.id !== draft.id));
    this.keepSent(recipient.name, draft.text, sentTarget(recipient));
    return this.reply({ next: `Sent to ${recipient.name}.` });
  }

  private async sendMessageNow(input: { to?: string; text?: string; confirmation?: string }, pinKey: Buffer | undefined): Promise<ToolReply> {
    const text = input.text?.trim() ?? "";
    if (!text || text.length > MAX_HOST_MESSAGE) return this.fail(MESSAGE_NEEDED);
    this.openSeal(pinKey);
    if (this.carriesCode(text)) return this.fail(DOOR_CODE_IN_CHAT);
    const to = input.to?.trim() ?? "";
    if (!to) return this.fail(RECIPIENT_NEEDED);
    const recipient = this.recipientOf(to);
    if ("error" in recipient) return this.fail(recipient.error);
    const cant = `I can't text ${recipient.name} right now.`;
    this.resume();
    const engine = this.engine;
    if (this.pin) engine?.rememberPin(this.pin);
    if (!this.file.checked || !engine || !this.reachable(recipient.send, engine)) return this.fail(cant);
    // The engine's outbox counts them, so this desk saves no timestamp that could hold the door code's digits.
    if (engine.hostMessagesSince(new Date(this.now().getTime() - HOUR_MS)) >= HOST_MESSAGES_PER_HOUR) return this.fail(TOO_MANY);
    // A group approval also binds who is in the group, so a join or a leave before the yes voids it.
    const bound = recipient.send === "group" ? `group:${engine.groupMembers().join(",")}` : recipient.key;
    const fingerprint = createHash("sha256").update(`${bound}|${text}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const question = `Send to ${recipient.name}: "${text}"?`;
      return this.reply({ preview: { to: recipient.name, text }, confirmation: this.approvals.issue(SEND_ACTION, recipient.key, fingerprint, question) });
    }
    if (!this.redeemed(this.approvals, code, SEND_ACTION, recipient.key, fingerprint)) return this.fail(APPROVAL_STALE);
    let sent: CleanerText | null;
    try {
      sent = await engine.sendHostMessage({ to: recipient.send, body: text });
    } catch {
      sent = null;
    }
    if (!sent) return this.fail(cant);
    this.keepSent(recipient.name, text, sentTarget(recipient));
    return this.reply({ next: `Sent to ${recipient.name}.` });
  }

  /**
   * The saved person or thread a host message goes to: "cleaner" (or the cleaner's saved name),
   * "group", or a saved contact's name. `key` binds an approval to that exact person's phone.
   */
  private recipientOf(to: string): { key: string; send: string; name: string } | { error: string } {
    const wanted = to.toLowerCase();
    if (this.groupOn() && wanted !== "group") return { error: GROUP_ONLY };
    const cleanerName = this.file.cleanerName;
    if (wanted === "cleaner" || (cleanerName && wanted === cleanerName.toLowerCase())) {
      if (!this.file.cleaner) return { error: "I can't text the cleaner right now." };
      return { key: `cleaner:${this.file.cleaner}`, send: this.file.cleaner, name: cleanerName ?? "the cleaner" };
    }
    if (wanted === "group") {
      if (!this.groupOn()) return { error: NO_GROUP };
      return { key: "group", send: "group", name: "the group" };
    }
    const contact = contactsOf(this.file).find((item) => item.name.toLowerCase() === wanted);
    if (!contact) return { error: `I can't text ${to.slice(0, MAX_NAME)} right now.` };
    return { key: `contact:${contact.phone}`, send: contact.phone, name: contact.name };
  }

  /** The engine holds consent, STOP, and the group's members. Nothing goes until the host's phone is confirmed. */
  private reachable(send: string, engine: CleanerCore): boolean {
    if (!this.hostConfirmed()) return false;
    if (send === "group") return this.groupOn() && engine.canSendHostMessage("group");
    return mayText(this.env(), send) && engine.canSendHostMessage(send);
  }

  /**
   * True when the saved host is the account's landlord: the phone confirmed at sign-up, or on an
   * account with none, a phone the old operator allowlist approves (saadvz/PropertyCore#164).
   */
  private hostConfirmed(): boolean {
    return landlordConfirmed(this.env(), this.file.host);
  }

  /** Keeps a sent host message in the history. Grok sent it, so check_now doesn't return it as new. */
  private keepSent(to: string, text: string, target: string): void {
    const message: Message = { id: messageId(), from: "host", name: "Host", to, target, text: this.messageText(text), at: this.messageAt(), handled: "sent" };
    this.file.messages = [...(this.file.messages ?? []), message].slice(-MAX_MESSAGES);
    this.file.messagesShown = [...(this.file.messagesShown ?? []), message.id];
    this.persist();
  }

  /**
   * Wipes this property's Cleaner Core state, as if it was never set up, after the host confirms.
   * Without a confirmation it changes nothing and returns the exact words with an approval code.
   * With the code it removes the group on Twilio first; if Twilio won't, nothing else is touched.
   * Then the two alert routine secrets go through `deleteSecrets` (a failure stops here), then the desk's file, job folder and alert queue.
   * It never texts anyone.
   */
  resetProperty(input: { confirmation?: string }, deleteSecrets: (names: (typeof ROUTINE_SECRETS)[number][]) => void): Promise<ToolReply> {
    return this.serial(() => this.resetPropertyNow(input, deleteSecrets));
  }

  private async resetPropertyNow(input: { confirmation?: string }, deleteSecrets: (names: (typeof ROUTINE_SECRETS)[number][]) => void): Promise<ToolReply> {
    const address = this.place.address ?? "this property";
    const group = this.file.conversationSid;
    const fingerprint = createHash("sha256").update(`reset|${group ?? ""}|${this.place.address ?? ""}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const kept = this.suppliesShareHub() ? " The property's address and booking calendars stay, because Supply Core uses them." : "";
      const next = `This resets Cleaner Core for ${address}. It deletes the setup, jobs, messages, everyone's YES and STOP replies, the saved door code, the alert routine connection, and the group text on Twilio. Your Twilio settings and Grok logins stay.${kept} Reply yes to reset.`;
      return this.reply({ next, confirmation: this.approvals.issue(RESET_ACTION, RESET_TARGET, fingerprint, next) });
    }
    if (!this.redeemed(this.approvals, code, RESET_ACTION, RESET_TARGET, fingerprint)) return this.fail(APPROVAL_STALE);
    // Twilio first. A group that can't be removed stops everything, so the next try starts from the same state.
    if (group && !(await deleteLiveGroup(this.env(), group))) return this.fail(RESET_GROUP_KEPT);
    // Secrets before files: if the store can't delete them, nothing else is touched.
    try {
      deleteSecrets([...ROUTINE_SECRETS]);
    } catch {
      return this.fail(RESET_NOT_DONE);
    }
    // A drain still running would recreate the alert folder with a stale record. With the secrets gone it delivers nothing.
    await this.alerts.drain().catch(() => undefined);
    let wiped = true;
    try {
      rmSync(this.path, { force: true });
      rmSync(join(this.root, "cleaner-job"), { recursive: true, force: true });
      // The queued wake-ups belong to the old setup, so they can't deliver to a routine connected later.
      rmSync(join(this.root, "cleaner-alerts"), { recursive: true, force: true });
    } catch {
      wiped = false;
    } finally {
      // The secrets are already gone, so the desk forgets what it held either way. The door code goes
      // always: no other flow reads it. The property's details and calendars go too, unless Supply
      // Core keeps a record here and reads them.
      try {
        this.door().clear();
      } catch {
        wiped = false;
      }
      if (!this.suppliesShareHub()) {
        try {
          this.hub.clear();
        } catch {
          wiped = false;
        }
      }
      this.file = {};
      this.pin = undefined;
      this.accessRefusal = undefined;
      this.uploadKey = undefined;
      this.engine = undefined;
      this.stale = false;
      this.held = false;
      this.approvals.clear();
      this.draftApprovals.clear();
    }
    if (!wiped) return this.fail(RESET_UNFINISHED);
    return this.reply({ next: `Cleaner Core is reset for ${address}. Start setup again whenever you're ready.` });
  }

  resetScratch(): Promise<ToolReply> {
    return this.serial(async () => this.resetScratchNow());
  }

  private async resetScratchNow(): Promise<ToolReply> {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    // The group goes on Twilio first. Its sid is forgotten only once it is gone, so a group that
    // couldn't be removed is replaced by the next group text instead of holding the phones.
    const group = this.file.conversationSid;
    const groupGone = !group || (await deleteLiveGroup(this.env(), group));
    this.engine = undefined;
    rmSync(join(this.root, "cleaner-job"), { recursive: true, force: true });
    this.file.seenInbound = [];
    this.file.cleanerOut = false;
    this.file.released = false;
    delete this.file.pinSend;
    delete this.file.hostOut;
    if (groupGone) delete this.file.conversationSid;
    delete this.file.deliveries;
    delete this.file.localSends;
    delete this.file.alertsShown;
    delete this.file.alertsQueued;
    delete this.file.messages;
    delete this.file.messagesShown;
    delete this.file.drafts;
    delete this.file.savedAnswers;
    delete this.file.completedShown;
    delete this.file.timedJobs;
    this.approvals.clear();
    this.draftApprovals.clear();
    this.held = false;
    this.persist();
    return this.reply({ next: groupGone ? SCRATCH_RESET_LINE : `${SCRATCH_RESET_LINE} ${SCRATCH_GROUP_KEPT}` });
  }

  readInbox(): Promise<ToolReply> {
    return this.serial(async () => this.readInboxNow());
  }

  private readInboxNow(): ToolReply {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    this.resume();
    const lines = (this.engine?.transcript() ?? []).flatMap((line) => {
      const formatted = this.inboxFromTranscript(line);
      return formatted ? [formatted] : [];
    });
    return this.reply({ lines });
  }

  readOutbox(): Promise<ToolReply> {
    return this.serial(async () => this.readOutboxNow());
  }

  private readOutboxNow(): ToolReply {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    this.resume();
    const rows = this.outboxRows();
    return this.reply({
      lines: rows.map((row) => row.line),
      texts: rows.map((row) => ({ label: row.label, status: row.status, body: this.hideCode(row.body) })),
    });
  }

  sendTestText(input: { from?: string; text?: string }): Promise<ToolReply> {
    return this.serial(() => this.sendTestTextNow(input));
  }

  private async sendTestTextNow(input: { from?: string; text?: string }): Promise<ToolReply> {
    const guard = this.scratchGuard(input.from ?? "");
    if (guard) return this.fail(guard);
    const text = input.text?.trim() ?? "";
    if (!text) return this.fail(SCRATCH_TEXT_NEEDED);
    // Already inside the serial queue, so this calls the inner step, not `inbound`.
    await this.inboundSerial({ id: `scratch-${randomUUID()}`, from: input.from ?? "", text });
    return this.reply({ next: SCRATCH_TEST_WENT_THROUGH });
  }

  addTestTurn(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    return this.serial(() => this.addTestTurnNow(input));
  }

  private async addTestTurnNow(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    const guard = this.testTurnGuard();
    if (guard) return this.fail(guard);
    if (!this.file.texting || !this.codeSaved() || !this.file.host || !this.file.cleaner) return this.fail("Set up texting first.");
    if (!this.hostConfirmed()) return this.fail(HOST_UNCONFIRMED);
    if (!mayText(this.env(), this.file.cleaner)) return this.fail(CLEANER_IS_LINE);
    const checkout = input.checkout?.trim() ?? "";
    const checkIn = input.checkIn?.trim() ?? "";
    if (!statedClock(checkout) || !statedClock(checkIn)) {
      return this.fail("Tell me the checkout time and the next check-in time, like 10:30 AM and 3:00 PM.");
    }
    this.file.checked = true;
    this.file.released = true;
    this.persist();
    this.resume();
    if (!this.engine) return this.fail("Set up texting first.");
    if (this.pin) this.engine.rememberPin(this.pin);
    const created = await this.engine.addTestTurn({ checkout, checkIn });
    if (!created.created) {
      if (created.reason === "exists") return this.reply({ next: "That test turnover is already saved.", turns: this.turns() });
      if (created.reason === "refused") return this.fail(CLEANER_IS_LINE);
      return this.fail("Tell me the checkout time and the next check-in time, like 10:30 AM and 3:00 PM.");
    }
    const invited = this.engine.outbox().some((item) => item.kind === "opt-in" && item.status === "sent");
    return this.reply({
      next: invited ? "Test turnover saved. Anyone who has not replied YES got only the opt-in text." : "Test turnover saved. Nothing was sent.",
      turns: this.turns(),
    });
  }

  reportDelivery(input: { which?: string; status?: string }): Promise<ToolReply> {
    return this.serial(() => this.reportDeliveryNow(input));
  }

  private async reportDeliveryNow(input: { which?: string; status?: string }): Promise<ToolReply> {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    const status = input.status?.trim().toLowerCase() ?? "";
    if (!isDeliveryReport(status)) return this.fail(SCRATCH_STATUS_NEEDED);
    this.resume();
    const which = input.which?.trim().toLowerCase() ?? "";
    const rows = this.outboxRows();
    const exactLine = rows.filter((row) => row.line.toLowerCase() === which);
    const exactLabel = rows.filter((row) => row.label.toLowerCase() === which);
    const contains = rows.filter((row) => which.length > 0 && row.label.toLowerCase().includes(which));
    if (exactLine.length === 0 && exactLabel.length === 0 && contains.length > 1) return this.fail(SCRATCH_WHICH_NEEDED);
    const matches = exactLine.length > 0 ? exactLine : exactLabel.length > 0 ? exactLabel : contains;
    const row = matches[matches.length - 1];
    if (!row) return this.fail(SCRATCH_TEXT_MISSING);
    if (row.kind === "pin" && !row.local) await this.applyPinReport(row.id, status);
    else this.setDelivery(row, status);
    const updated = this.outboxRows().find((item) => item.id === row.id);
    return this.reply({ next: updated?.line ?? row.line });
  }

  /** Records a Twilio delivery status. Does not unseal the door code. A failure tells the host once. */
  notePinDelivery(input: { sid: string; status: string }): Promise<void> {
    return this.serial(async () => {
      const before = this.visibleNoteIds();
      await this.pinDeliveryNow(input);
      this.queueNewAlerts(before);
    });
  }

  private async pinDeliveryNow(input: { sid: string; status: string }): Promise<void> {
    const tracked = this.file.pinSend;
    if (!tracked || tracked.outcome === "settled" || tracked.sid !== input.sid) return;
    this.resume();
    const pinId = [...this.outboxRows()].reverse().find((item) => item.kind === "pin" && !item.local)?.id;
    if (!pinId) return;
    await this.applyPinReport(pinId, input.status.toLowerCase());
  }

  /**
   * A text from the host, the cleaner, or the group. Grok does not see it, so a new host note or a
   * new message wakes the routine. `media` is an MMS's attachments: during a cleaning, the cleaner's
   * photos are downloaded and kept under the job. A media URL is never saved or returned.
   */
  inbound(input: Inbound): Promise<{ sent: CleanerText[] }> {
    return this.serial(() => this.inboundSerial(input));
  }

  /**
   * A text in the group, from Twilio's conversation webhook. It is taken only from the saved group
   * conversation, and only from the host, the cleaner, or a contact in that group.
   */
  inboundGroup(input: { conversationSid: string; id: string; from: string; text: string; media?: InboundMedia[] }): Promise<{ sent: CleanerText[] }> {
    return this.serial(async () => {
      if (!this.groupOn() || !this.file.conversationSid || input.conversationSid !== this.file.conversationSid) return { sent: [] };
      const from = parsePhone(input.from);
      const members = [this.file.host, this.file.cleaner, ...this.groupExtras().map((contact) => contact.phone)];
      if (!from || !members.includes(from)) return { sent: [] };
      return this.inboundSerial({ id: input.id, from, text: input.text, channel: "group", ...(input.media && input.media.length > 0 ? { media: input.media } : {}) });
    });
  }

  /** The body of `inbound`, for a caller already inside the serial queue. */
  private async inboundSerial(input: Inbound): Promise<{ sent: CleanerText[] }> {
    const before = this.visibleNoteIds();
    const lastBefore = this.file.messages?.at(-1)?.id;
    const result = await this.inboundNow(input);
    this.queueNewAlerts(before, this.file.messages?.at(-1)?.id !== lastBefore);
    return result;
  }

  private async inboundNow(input: Inbound): Promise<{ sent: CleanerText[] }> {
    const from = parsePhone(input.from);
    // Only the people the host saved are read (saadvz/PropertyCore#164). A stranger's text, STOP or
    // "someone is hurt" never reaches the engine, changes nothing, and gets no reply with the address.
    if (!from || !mayText(this.env(), from) || !this.savedPhones().includes(from)) return { sent: [] };
    if (this.claiming.has(input.id)) return { sent: [] };
    if (this.file.seenInbound?.includes(input.id)) {
      this.resume();
      return { sent: [] };
    }
    if (this.secondCopy(from, input)) {
      this.noteSeen(input.id);
      this.persist();
      return { sent: [] };
    }
    // START or YES from a phone that opted out of the shared line before it was saved brings it back.
    if (this.lineOptedOut(from) && (messagingKeyword(input.text) === "start" || normalize(input.text) === "yes")) {
      if (this.people && this.account) {
        const change = this.people.start(from);
        void this.people.relay(change ? { ...change, from: this.account.propertyId } : undefined).catch(() => undefined);
      }
      if (this.file.lineOptOuts?.includes(from)) {
        this.file.lineOptOuts = this.file.lineOptOuts.filter((phone) => phone !== from);
        this.persist();
      }
    }
    this.claiming.add(input.id);
    try {
      // A photo from the cleaner or a contact is downloaded once: for the cleaning in progress, and for its message.
      const media = input.media ?? [];
      const downloads = media.length > 0 && this.keepsPhotos(from, input.channel) ? await downloadPhotos(media, cleanerPhotoFetch(), this.env()) : [];
      const routed = await this.routeInbound(input, from, downloads);
      if (routed.handled) this.keepMessage(from, input, routed.handled, downloads);
      return { sent: routed.sent };
    } finally {
      this.claiming.delete(input.id);
    }
  }

  /**
   * True when this text is the other webhook's copy of a group reply already taken. Only a group
   * copy and a one-to-one copy match each other, so a person who sends the same words twice in one
   * thread is still read twice.
   */
  private secondCopy(from: string, input: Inbound): boolean {
    if (!this.groupOn() || !this.file.conversationSid) return false;
    const members = [this.file.host, this.file.cleaner, ...this.groupExtras().map((contact) => contact.phone)];
    if (!members.includes(from)) return false;
    const at = this.now().getTime();
    const words = input.text.trim().replace(/\s+/g, " ");
    const media = input.media?.length ?? 0;
    const group = input.channel === "group";
    this.recentInbound = this.recentInbound.filter((item) => at - item.at < SECOND_COPY_MS);
    const index = this.recentInbound.findIndex((item) => item.from === from && item.words === words && item.media === media && item.group !== group);
    if (index >= 0) {
      // One copy matches one copy, so a third send of the same words is read again.
      this.recentInbound.splice(index, 1);
      return true;
    }
    this.recentInbound.push({ from, words, media, group, at });
    return false;
  }

  /** Handles one inbound text. `handled` is what Cleaner Core did, or undefined when the text was not taken. */
  private async routeInbound(input: Inbound, from: string, downloads: readonly { bytes: Buffer; ext: string }[]): Promise<{ sent: CleanerText[]; handled?: MessageHandled }> {
    if (from === this.file.host) return this.hostText(input.id, from, input.text, input.channel);
    this.resume();
    const keyword = messagingKeyword(input.text);
    // One engine for the whole text, so it is taken, counted, and seen by the engine that started it.
    const engine = this.engine;
    if (!engine) {
      const sent = await this.inboundBeforeJob(input.id, from, keyword);
      return { sent, handled: keyword === "stop" || keyword === "start" ? keyword : "none" };
    }
    const offered = new Set(engine.jobs().filter((job) => job.status === "offered").map((job) => job.id));
    const media = input.media ?? [];
    const photoJob = media.length > 0 ? engine.photoJobFor({ id: input.id, from }) : undefined;
    const photos = photoJob ? storePhotos(this.root, photoJob, downloads) : 0;
    const result = await engine.receive({
      id: input.id,
      from,
      text: input.text,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(media.length > 0 ? { media: media.length, photos } : {}),
    });
    this.noteCleanerYes(engine, offered);
    this.noteSeen(input.id);
    // Every setup save runs in the queue, so this is only a guard: reopen from the saved store.
    if (this.engine !== engine) {
      this.engine = undefined;
      this.resume();
    }
    this.syncHold();
    return { sent: result.sent, ...this.handledBy(result) };
  }

  /** The message label from the engine's result. A text the engine did not take is not kept. */
  private handledBy(result: ReceiveResult): { handled?: MessageHandled } {
    if (UNREAD_REASONS.has(result.reason)) return {};
    return { handled: result.outcome ?? "none" };
  }

  /**
   * Keeps a text from the cleaner or a saved contact, or from the host in the group, for Grok to
   * read. Every run of 4 or more digits is redacted, even split like "80-88", so the door code never
   * reaches a message even when this desk doesn't hold it in memory. The last 200 are kept.
   */
  private keepMessage(from: string, input: Inbound, handled: MessageHandled, downloads: readonly { bytes: Buffer; ext: string }[]): void {
    const who = this.speaker(from, input.channel);
    if (!who) return;
    const words = this.messageText(input.text);
    // An MMS shows as [photo], after its words when it has any. Its media URL is never kept.
    const text = (input.media?.length ?? 0) > 0 ? (words ? `${words} ${PHOTO_MARK}` : PHOTO_MARK).slice(0, MAX_MESSAGE_TEXT) : words;
    const message: Message = { id: messageId(), from: who.from, name: who.name, text, at: this.messageAt(), handled, ...(input.channel ? { channel: input.channel } : {}) };
    // Its photos are kept under the message, so check_now can link them even outside a cleaning.
    const kept = downloads.length > 0 && who.from !== "host" ? storePhotos(this.root, messagePhotoId(message.id), downloads) : 0;
    if (kept > 0) Object.assign(message, { photos: kept, photosAt: this.now().toISOString() });
    const all = [...(this.file.messages ?? []), message];
    // A message that falls off the list takes its photos with it.
    for (const dropped of all.slice(0, Math.max(0, all.length - MAX_MESSAGES))) if (dropped.photos) dropPhotos(this.root, messagePhotoId(dropped.id));
    this.file.messages = all.slice(-MAX_MESSAGES);
    this.pruneMessagePhotos();
    this.persist();
  }

  /** True when a text's photos are kept: from the cleaner or a saved contact. The host's own photos are not. */
  private keepsPhotos(from: string, channel: "group" | undefined): boolean {
    const who = this.speaker(from, channel);
    return who?.from === "cleaner" || who?.from === "contact";
  }

  /** Deletes a message's photos 7 days after they came in. Its text keeps the [photo] mark. The caller persists. */
  private pruneMessagePhotos(): void {
    const now = this.now().getTime();
    for (const message of this.file.messages ?? []) {
      if (!message.photosAt || now - Date.parse(message.photosAt) < MESSAGE_PHOTO_KEEP_MS) continue;
      dropPhotos(this.root, messagePhotoId(message.id));
      delete message.photos;
      delete message.photosAt;
    }
  }

  /**
   * Messages as check_now returns them. A message with kept photos gets a link to each, good for one
   * hour, like get_job_photos. Without a public address or a key, it keeps only its [photo] mark.
   */
  private messagesOut(messages: readonly Message[], save?: SavePhotoKey): Record<string, unknown>[] {
    const withPhotos = messages.some((message) => message.photos);
    const base = withPhotos ? publicBaseUrl(this.env()) : undefined;
    const key = base ? photoKey(this.env(), save) : undefined;
    return messages.map(({ photos, photosAt: _photosAt, ...kept }) => {
      const message = this.withReply(kept);
      if (!photos || !base || !key) return message;
      const links = photoLinks(this.root, messagePhotoId(message.id), base, key, this.now());
      return links.length > 0 ? { ...message, photos: links } : message;
    });
  }

  /** A cleaner or contact message with whether the host has answered it, read against every kept message. */
  private withReply<T extends Omit<Message, "photos" | "photosAt">>(kept: T): Omit<T, "target"> & Partial<ReplyState> {
    const { target: _target, ...message } = kept;
    const all = this.file.messages ?? [];
    const state = replyStateAt(all, all.findIndex((item) => item.id === message.id));
    return state ? { ...message, ...state } : message;
  }

  /** A kept message's text: every run of 4 or more digits redacted, split or not, trimmed to 300 characters. */
  private messageText(text: string): string {
    return redactDigitRuns(this.hideCode(text)).trim().slice(0, MAX_MESSAGE_TEXT);
  }

  /** Now, as local time at the property, like "Wednesday, Oct 14, 11:00 AM". */
  private messageAt(): string {
    const when = formatWhen(this.now().toISOString(), this.place.timeZone ?? "UTC");
    return `${when.day}, ${when.time}`;
  }

  /** Who sent a text Grok reads. The host counts only in the group thread. */
  private speaker(from: string, channel: "group" | undefined): { from: Message["from"]; name: string } | undefined {
    if (from === this.file.cleaner) return { from: "cleaner", name: this.file.cleanerName ?? "Cleaner" };
    if (from === this.file.host) return channel === "group" ? { from: "host", name: "Host" } : undefined;
    const contact = contactsOf(this.file).find((item) => item.phone === from);
    return contact ? { from: "contact", name: contact.name } : undefined;
  }

  private readonly claiming = new Set<string>();
  private updateTimer: NodeJS.Timeout | undefined;
  /** Recent texts from group members, kept in memory only, to drop a group reply's second copy. */
  private recentInbound: { from: string; words: string; media: number; group: boolean; at: number }[] = [];

  /** The engine tells the host nothing when the cleaner accepts. One note per job, the first time it is confirmed. */
  private noteCleanerYes(engine: CleanerCore, offered: Set<string>): void {
    for (const job of engine.jobs()) {
      if (!offered.has(job.id) || job.status !== "confirmed") continue;
      engine.keepHostNote(`cleaner-yes:${job.id}`, `The cleaner said YES to the turnover at ${this.place.address ?? "the property"}.`);
    }
  }

  private async inboundBeforeJob(id: string, from: string, keyword: ReturnType<typeof messagingKeyword>): Promise<CleanerText[]> {
    if (keyword !== "stop" && keyword !== "start") return [];
    if (keyword === "stop" && from === this.file.cleaner) {
      this.held = true;
      this.file.cleanerOut = true;
    }
    if (keyword === "start" && from === this.file.cleaner) {
      this.held = false;
      this.file.cleanerOut = false;
    }
    if (from === this.file.host && keyword === "stop") this.file.hostOut = true;
    if (from === this.file.host && keyword === "start") this.file.hostOut = false;
    // A saved contact's STOP goes on the desk's opt-out list, which the engine's sends check and a
    // START or YES clears. On an account the line already kept it in the account's people list.
    const contact = from !== this.file.host && from !== this.file.cleaner && contactsOf(this.file).some((item) => item.phone === from);
    if (contact && keyword === "stop" && !this.people && !this.lineOptedOut(from)) this.file.lineOptOuts = [...(this.file.lineOptOuts ?? []), from];
    this.noteSeen(id);
    // Kept on disk now, so a restart before the engine first opens keeps it.
    this.persist();
    const address = this.place.address ?? "the property";
    const host = from === this.file.host;
    const body = host
      ? keyword === "stop"
        ? hostStopReply(address, this.held)
        : hostStartReply(address, this.held, this.hostWords().helper)
      : keyword === "stop"
        ? `You're opted out of cleaning texts for ${address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`
        : "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out.";
    const labeled = this.labeled(from, body, false);
    // The STOP or START is kept above. The reply names the address, so it waits for a confirmed host like every other text.
    if (!this.hostConfirmed()) return [];
    if (this.scratchCapture()) {
      this.noteLocal(from, keyword, labeled);
      return [{ to: from, body: labeled, kind: keyword }];
    }
    if (!liveSmsOn(this.env())) return [];
    try {
      await sendLiveSms(this.env(), { to: from, body: labeled });
      return [{ to: from, body: labeled, kind: keyword }];
    } catch {
      return [];
    }
  }

  /**
   * The setup steps follow the diagram: property, sources, people, door code, preferences, then
   * review. At review the saved choices come back as `setup` for Grok to summarize in its own words.
   */
  private cleaningState(): Record<string, unknown> {
    const done: string[] = [];
    if (this.place.address) done.push("Property saved.");
    if (this.file.cleaner) done.push(this.peopleLine());
    if (this.file.schedule) done.push("Schedule saved.");
    const calendars = this.hub.calendars().length;
    if (calendars === 1) done.push("Calendar link saved.");
    if (calendars > 1) done.push(`${calendars} calendar links saved.`);
    if (this.hub.google()) done.push("Google Calendar saved.");
    if (this.codeSaved()) done.push("Door code saved.");
    const preferences = this.file.preferences;
    if (preferences) {
      const any = preferences.checklist.length > 0 || preferences.photosRequired || preferences.supplyNotes || Boolean(preferences.instructions);
      done.push(any ? "Preferences saved." : "No cleaning preferences.");
    }
    const payments = this.file.payments;
    if (payments) {
      done.push(payments.on && payments.rateCents && payments.venmo ? `Payments: ${dollarsText(payments.rateCents)} per cleaning to @${payments.venmo}.` : "Payments: off.");
    }
    const unpaid = Object.values(this.file.pay ?? {}).filter((record) => !record.paidAt);
    if (unpaid.length > 0) {
      const total = unpaid.reduce((sum, record) => sum + record.amountCents, 0);
      done.push(`${unpaid.length} ${unpaid.length === 1 ? "cleaning" : "cleanings"} unpaid (${dollarsText(total)}).`);
    }
    if (this.file.texting) done.push("Texting saved.");
    if (this.file.texting && this.groupOn()) done.push(this.groupLine());
    if (this.file.checked) done.push("Checks finished.");
    let next: string;
    let ask: SetupAsk | undefined;
    // A setup that is still being built asks for the usual times. One that already texts isn't held back.
    const timesMissing = !this.file.texting && (!this.place.checkoutTime || !this.place.checkInTime);
    if (!this.place.address || timesMissing) {
      ask = propertyAsk({ address: Boolean(this.place.address), checkoutTime: Boolean(this.place.checkoutTime), checkInTime: Boolean(this.place.checkInTime) });
    } else if (!this.hasSources()) ask = sourcesAsk(this.place.nickname ?? this.file.business ?? "the property");
    // A setup that already saved the cleaner was past this step, so it isn't asked again.
    else if (!this.hub.calendarsDone() && !this.file.cleaner) ask = moreSourcesAsk(this.sourceNames(), this.place.nickname ?? this.file.business ?? "the property");
    else if (!this.file.cleaner) ask = peopleAsk(this.file.business ?? "the host");
    // Setups that saved texting before the schedule step existed skip it.
    else if (!this.file.schedule && !this.file.texting) ask = SCHEDULE_STEP;
    else if (!this.codeSaved()) ask = DOOR_CODE_STEP;
    else if (!this.file.texting && !preferences) ask = PREFERENCES_STEP;
    else if (!this.file.texting && !this.file.payments) ask = PAYMENTS_STEP;
    else if (!this.file.texting && !this.file.suppliesAsked && this.offersSupplies()) ask = SUPPLIES_STEP;
    // Setup starts with a draft (#166): until the host has seen it, get_state asks for the draft
    // instead of the next step's questions. What's still missing after it is asked one at a time.
    const draft = ask && !this.file.texting && !this.file.drafted ? this.setupDraft() : undefined;
    if (draft) next = DRAFT_NEXT;
    else if (ask) next = askNext(ask.tool);
    // The routines come before the review, so the cleaner's first reply already wakes Grok.
    else if (!this.file.texting && !this.routineReady()) next = this.words().routineAsk;
    else if (!this.file.texting) next = REVIEW_ASK;
    else if (!this.file.checked) next = "Run the checks. I'll read the calendar and I won't text anyone while I do.";
    // A setup that went live before the routines were asked at setup still needs them.
    else if (!this.routineReady()) next = this.words().routineAsk;
    else {
      const untimed = this.untimedTurns();
      // Only a group times every turnover at once (confirmAllTimes), so only a group is offered it.
      if (untimed >= 2 && this.groupOn() && this.place.checkoutTime && this.place.checkInTime) {
        ask = allTimesAsk(clockText(this.place.checkoutTime), clockText(this.place.checkInTime), untimed);
        next = askNext(ask.tool);
      } else next = "Tell me the checkout time and the next check-in time before I text the cleaner.";
    }
    const review = next === REVIEW_ASK;
    const drafting = next === DRAFT_NEXT;
    if (this.held) next = this.holdLine();
    const notes = this.engine ? this.visibleNotes(this.engine).map((note) => note.body) : [];
    if (!this.held && this.privateCodeWaiting()) next = this.words().pinFailed;
    const asking = ask && next === askNext(ask.tool);
    const assistant = this.assistant();
    // Muse shows choice cards, as Grok does. Claude and ChatGPT show a short list.
    if (ask && asking && (assistant === "claude" || assistant === "chatgpt")) next = claudeAskNext(ask.tool);
    const task = this.task();
    const warning = this.taskWarning() ?? this.wakeWarning();
    return {
      done,
      next,
      ...(ask && asking ? { ask: askFor(assistant, ask) } : {}),
      ...(draft && drafting && next === DRAFT_NEXT ? { draft } : {}),
      ...(task && (next === this.words().routineAsk || warning) ? { routine: task } : {}),
      ...(warning ? { warning } : {}),
      ...(review && next === REVIEW_ASK ? { setup: this.reviewSetup() } : {}),
      ...(this.file.checked ? { turns: this.turns() } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      ...this.setAsideReply(),
    };
  }

  /** True when Supply Core keeps a record in this property's folder, so it reads the same hub. */
  private suppliesShareHub(): boolean {
    return existsSync(join(this.root, "supply.json"));
  }

  /** The set-aside calendars' line, while there are any. Never their links. */
  private setAsideReply(): { setAside?: string } {
    const line = setAsideLine(this.hub.setAside());
    return line ? { setAside: line } : {};
  }

  /** True when this setup connected the alert routine and its address is still saved. A ChatGPT or Muse task has no address. */
  private routineReady(): boolean {
    // On a multi-tenant service, only the primary connection's own routine counts.
    const primary = this.env().CLEANER_CORE_PRIMARY_CONNECTION?.trim();
    if (primary && !(this.file.routineConnections ?? []).includes(primary)) return false;
    if (this.polledTask(this.primaryAssistant())) return Boolean(this.file.routineConnected);
    return Boolean(this.file.routineConnected && this.env().CLEANER_CORE_ROUTINE_URL?.trim());
  }

  /** The scheduled task get_state hands Claude, ChatGPT, or Muse. A Grok Bot's routines are in its own guide. */
  private task(): typeof CLAUDE_TASK | typeof CHATGPT_TASK | typeof MUSE_TASK | undefined {
    return { grok: undefined, claude: CLAUDE_TASK, chatgpt: CHATGPT_TASK, muse: MUSE_TASK }[this.assistant()];
  }

  /** True for a chat whose one recurring task nothing outside it can wake: ChatGPT and Muse. */
  private polledTask(assistant: CleanerAssistant): boolean {
    return ASSISTANT_PROFILES[assistant].polledTask;
  }

  /** Notes when a check ran, on a ChatGPT or Muse deployment only. The caller persists. */
  private noteCheck(): void {
    if (this.polledTask(this.primaryAssistant())) this.file.lastCheckAt = this.now().toISOString();
  }

  /**
   * On a live ChatGPT or Muse deployment, the warning when no check has come in for longer than one missed
   * hourly run. The task can pause itself, and nothing else would tell the host.
   */
  private taskWarning(): string | undefined {
    if (!this.polledTask(this.primaryAssistant()) || !this.file.texting || !this.file.checked || !this.routineReady() || !this.file.lastCheckAt) return undefined;
    const last = Date.parse(this.file.lastCheckAt);
    if (!Number.isFinite(last) || this.now().getTime() - last <= CHATGPT_CHECK_GAP_MS) return undefined;
    const when = formatWhen(this.file.lastCheckAt, this.place.timeZone ?? "UTC");
    return taskWarning(this.primaryAssistant(), `${when.day} at ${when.time}`);
  }

  /** The saved booking sources by name, Google Calendar last. Never a link. */
  private sourceNames(): string[] {
    return [...this.hub.calendars().map((calendar) => calendar.name), ...(this.hub.google() ? ["Google Calendar"] : [])];
  }

  /** True once a calendar link or Google Calendar is saved for the property. */
  private hasSources(): boolean {
    return this.hub.calendars().length > 0 || this.hub.google();
  }

  /**
   * The setup draft (#166): where to look, what the host always confirms, and the questions of every
   * step still missing, in setup order but saved in any order. A step whose answer has a default
   * (the schedule, the preferences) is still listed, so the summary shows what the draft picked.
   */
  private setupDraft(): SetupDraft {
    const place = this.place;
    const name = place.nickname ?? this.file.business ?? "the property";
    const needsYou: SetupAsk[] = [];
    if (!place.address || !place.checkoutTime || !place.checkInTime) {
      needsYou.push(propertyAsk({ address: Boolean(place.address), checkoutTime: Boolean(place.checkoutTime), checkInTime: Boolean(place.checkInTime) }));
    }
    if (!this.hasSources()) needsYou.push(sourcesAsk(name));
    // Whether bookings come from anywhere else stays in the summary until the host says that's all.
    else if (!this.hub.calendarsDone()) needsYou.push(moreSourcesAsk(this.sourceNames(), name));
    if (!this.file.cleaner) needsYou.push(peopleAsk(this.file.business ?? "the host"));
    if (!this.file.schedule) needsYou.push(SCHEDULE_STEP);
    if (!this.codeSaved()) needsYou.push(DOOR_CODE_STEP);
    if (!this.file.preferences) needsYou.push(PREFERENCES_STEP);
    if (!this.file.payments) needsYou.push(PAYMENTS_STEP);
    if (!this.file.suppliesAsked && this.offersSupplies()) needsYou.push(SUPPLIES_STEP);
    const assistant = this.assistant();
    const shown = (step: SetupAsk) => askFor(assistant, step);
    // Only the steps still missing are drafted, so a saved step (a setup already under way) isn't saved over.
    const missingTools = new Set(needsYou.map((step) => step.tool));
    const fill = DRAFT_FILL.filter((part) => !part.tool || missingTools.has(part.tool));
    return { fill, confirm: DRAFT_CONFIRM, needsYou: needsYou.map(shown) };
  }

  /** What texting needs before it can be saved, in the host's words: what the old save order guaranteed. */
  private textingMissing(): string[] {
    const missing: string[] = [];
    if (!this.place.address) missing.push("the property");
    if (!this.hasSources() && !isScratchPropertyAddress(this.place.address)) missing.push("a booking calendar");
    if (!this.file.cleaner) missing.push("the host and the cleaner");
    if (!this.codeSaved()) missing.push("the door code");
    return missing;
  }

  /** What Activate still needs, in the host's words. Empty once setup can go live. */
  private activateMissing(): string[] {
    return [...this.textingMissing(), ...(this.file.preferences ? [] : ["the cleaning preferences (empty ones if there are none)"])];
  }

  /** The next setup step with its ask, for a save tool's reply. */
  private setupReply(extra: Record<string, unknown> = {}): ToolReply {
    const state = this.cleaningState();
    return this.reply({ ...extra, next: state.next, ...(state.ask ? { ask: state.ask } : {}) });
  }

  /** Open turnovers the host hasn't timed yet. */
  private untimedTurns(): number {
    if (!this.engine) return 0;
    return this.engine.jobs().filter((job) => !CLOSED_STATUSES.has(job.status) && !job.checkoutTime).length;
  }

  private peopleLine(): string {
    const contacts = contactsOf(this.file).length;
    if (contacts === 0) return "Cleaner saved.";
    if (this.file.observer && !this.file.contacts) return "Cleaner and observer saved.";
    return `Cleaner and ${contacts} extra ${contacts === 1 ? "contact" : "contacts"} saved.`;
  }

  private groupLine(): string {
    const extra = this.groupExtras();
    if (extra.length === 0) return "Group chat set up with you and the cleaner.";
    if (this.file.observer && extra.length === 1) return "Group chat set up with you, the cleaner, and the observer.";
    return "Group chat set up with you, the cleaner, and your contacts.";
  }

  /**
   * The saved choices, for Grok's review summary. Phones show their last 4 digits only. The door
   * code is never here, and access holds the lock location alone.
   */
  private reviewSetup(): Record<string, unknown> {
    const file = this.file;
    const place = this.place;
    const last4 = (phone: string | undefined) => {
      const four = phone?.replace(/\D/g, "").slice(-4) ?? "";
      return four && !this.leaks(four) ? { phoneLast4: four } : {};
    };
    return {
      property: {
        business: file.business,
        ...(place.nickname ? { nickname: place.nickname } : {}),
        address: place.address,
        ...(place.propertyType ? { propertyType: place.propertyType } : {}),
        timeZone: place.timeZone,
        ...(place.checkoutTime ? { checkoutTime: clockText(place.checkoutTime) } : {}),
        ...(place.checkInTime ? { checkInTime: clockText(place.checkInTime) } : {}),
      },
      sources: { calendars: this.hub.calendars().map((calendar) => calendar.name), google: this.hub.google() },
      people: {
        host: { ...(file.hostName ? { name: file.hostName } : {}), ...last4(file.host) },
        cleaner: { ...(file.cleanerName ? { name: file.cleanerName } : {}), ...last4(file.cleaner) },
        contacts: contactsOf(file).map((contact) => ({ name: contact.name, role: contact.role, ...last4(contact.phone) })),
        groupChat: file.groupChat ?? "everyone",
        groupThread: this.groupOn(),
      },
      ...(file.schedule ? { schedule: this.reviewSchedule(file.schedule) } : {}),
      access: this.door().lockLocation() ? { lockLocation: this.door().lockLocation() } : {},
      preferences: file.preferences,
      payments: this.reviewPayments(),
    };
  }

  /** Payments for the review (#166): on with the pay per cleaning and the Venmo username, off, or not answered. */
  private reviewPayments(): Record<string, unknown> {
    const payments = this.file.payments;
    if (!payments) return { on: false, asked: false };
    if (!payments.on || !payments.rateCents || !payments.venmo) return { on: false };
    return { on: true, perCleaning: dollarsText(payments.rateCents), venmo: `@${payments.venmo}` };
  }

  /** The saved schedule with clock times like 8:00 AM. Problems go to the host unless someone else was named. */
  private reviewSchedule(schedule: Schedule): Record<string, unknown> {
    return {
      firstText: schedule.firstText,
      ...(schedule.firstTextDays !== undefined ? { firstTextDays: schedule.firstTextDays } : {}),
      reminder: schedule.reminder,
      ...(schedule.reminderDays !== undefined ? { reminderDays: schedule.reminderDays } : {}),
      reminderTime: clockText(schedule.reminderTime),
      ...(schedule.quietFrom && schedule.quietUntil ? { quietFrom: clockText(schedule.quietFrom), quietUntil: clockText(schedule.quietUntil) } : {}),
      escalateTo: schedule.escalateTo ?? "host",
    };
  }

  /** The engine options for the saved schedule. Without one, the engine keeps its defaults. */
  private scheduleOptions(): Partial<Parameters<typeof openCleanerCore>[0]> {
    const schedule = this.file.schedule;
    if (!schedule) return {};
    const reminderDays = schedule.reminder === "days-before-checkout" ? schedule.reminderDays : undefined;
    return {
      offerTrigger:
        schedule.firstText !== "when-confirmed" && schedule.firstTextDays !== undefined
          ? { kind: schedule.firstText, days: schedule.firstTextDays, localTime: FIRST_TEXT_TIME }
          : { kind: "when-confirmed" },
      triggers: [
        {
          id: SCHEDULED_REMINDER,
          kind: schedule.reminder,
          localTime: schedule.reminderTime,
          replaces: [DEFAULT_REMINDER],
          ...(reminderDays !== undefined ? { days: reminderDays } : {}),
        },
      ],
      // The saved schedule is the only source of quiet hours, so clearing them takes effect.
      quietHours: schedule.quietFrom && schedule.quietUntil ? { from: schedule.quietFrom, until: schedule.quietUntil } : null,
    };
  }

  /** The engine options for the saved preferences. The cleaning note is set only when instructions are saved. */
  private preferenceOptions(): Partial<Parameters<typeof openCleanerCore>[0]> {
    // Supply Core on and active: the done text also asks what's running low.
    const supplies = supplyAskOn(this.root) ? { supplyAsk: true } : {};
    const preferences = this.file.preferences;
    if (!preferences) return supplies;
    return {
      ...supplies,
      ...(preferences.checklist.length > 0 ? { checklist: { name: this.place.nickname ?? this.place.address ?? "the property", items: [...preferences.checklist] } } : {}),
      ...(preferences.photosRequired ? { photosRequired: true } : {}),
      ...(preferences.supplyNotes ? { supplyNotes: true } : {}),
      ...(preferences.instructions ? { cleaningNote: preferences.instructions } : {}),
    };
  }

  /** True when the door code is set to go in the group: group texts are on and the host didn't keep it private. */
  private codeGoesToGroup(): boolean {
    return this.groupOn() && this.file.doorCodeTo !== "cleaner";
  }

  /** Group texts are on when the server allows them and the host didn't choose cleaner-only. */
  private groupOn(): boolean {
    return groupChatEnabled(this.env()) && this.file.groupChat !== "cleaner-only";
  }

  /** The contacts who join the group. cleaner-and-host leaves them all out. */
  private groupExtras(): { phone: string; name: string }[] {
    if (this.file.groupChat === "cleaner-and-host") return [];
    return contactsOf(this.file).map((contact) => ({ phone: contact.phone, name: contact.name }));
  }

  /** The property's details, from its hub. A getter, so a check narrows the next read. */
  private get place(): HubProperty {
    return this.hub.property();
  }

  /** A checkout date as the property's local day, like "Sunday, Oct 18". UTC when no time zone is saved. */
  private checkoutDay(date: string): string {
    const zone = this.place.timeZone ?? "UTC";
    return formatWhen(zonedInstant(date, "12:00", zone), zone).day;
  }

  /** Sets a saved field, or removes it when the value is undefined. */
  private keep<K extends keyof LiveFile>(key: K, value: LiveFile[K] | undefined): void {
    if (value === undefined) delete this.file[key];
    else this.file[key] = value;
  }

  /**
   * True when a job the host already timed has lost a time. With group chat on, a moved stay clears
   * the checkout time without a host note, so check_now flags it for Grok to ask. A job the host
   * never timed (the next stay on the calendar) is not asked about here.
   */
  private needsTimes(engine: CleanerCore): boolean {
    const timed = new Set(this.file.timedJobs ?? []);
    return engine.jobs().some((job) => timed.has(job.id) && job.status !== "canceled" && job.status !== "done" && !hasTimes(job));
  }

  /** The host notes the host may see now. A private-code line waits for delivery, and PIN_SENT for the accepted text. */
  private visibleNotes(engine: CleanerCore): { id: string; body: string }[] {
    const delivered = this.file.pinSend?.delivered === true && this.file.pinSend.outcome !== "undelivered";
    return engine
      .hostNoteEntries()
      .filter((note) => (delivered || !isPrivateCodeLine(note.body)) && (note.body !== PIN_SENT || engine.pinAccepted()));
  }

  private turns(): Record<string, unknown>[] {
    if (!this.engine) return [];
    return this.engine.jobs().map((job) => ({
      checkoutDate: job.checkoutDate,
      nextCheckInDate: job.nextCheckInDate,
      checkoutTime: job.checkoutTime,
      nextCheckInTime: job.nextCheckInTime,
      ...(job.arrivalTime ? { arrivalTime: job.arrivalTime } : {}),
      status: job.status,
      ...(this.held ? { held: true } : {}),
    }));
  }

  private resume(): void {
    this.openSeal();
    // Supply Core saved the shared property (address, time zone, usual times) since the engine
    // opened: reopen it from its files, so the next text uses the saved details.
    if (this.engine && this.engineRevision !== this.hub.propertyRevision()) this.engine = undefined;
    if (this.engine || !this.file.checked) return;
    if (!this.codeSaved()) return;
    this.engine = this.openEngine();
    this.syncHold();
  }

  /**
   * A saved contact's STOP kept before this engine opened, on a desk without an account, counts in
   * the engine as their STOP would have: before its first send, so no invite is marked sent. An
   * account's STOPs are applied by applyAccount.
   */
  private applyLineStops(engine: CleanerCore): void {
    if (this.people) return;
    const host = parsePhone(this.file.host ?? "");
    const cleaner = parsePhone(this.file.cleaner ?? "");
    for (const contact of contactsOf(this.file)) {
      const phone = parsePhone(contact.phone);
      if (!phone || phone === host || phone === cleaner || !this.lineOptedOut(phone)) continue;
      // A contact's accountStop only marks them out and saves: nothing is sent and nothing waits.
      void engine.accountStop(phone).catch(() => undefined);
    }
  }

  private noteSeen(id: string): void {
    const seen = this.file.seenInbound ?? [];
    if (seen.includes(id)) return;
    this.file.seenInbound = [...seen, id];
    this.persist();
  }

  private openEngine(): CleanerCore {
    this.engineRevision = this.hub.propertyRevision();
    const file = this.file;
    const place = this.place;
    if (!file.host || !file.cleaner || !place.address || !place.timeZone || !file.propertyId || !file.business) {
      throw new Error("Setup is incomplete.");
    }
    const env = () => this.env();
    const dataDir = join(this.root, "cleaner-job");
    const extra = this.groupExtras();
    mkdirSync(dataDir, { recursive: true });
    const engine = openCleanerCore({
      enabled: true,
      property: {
        id: file.propertyId,
        address: place.address,
        timeZone: place.timeZone,
        ...(place.checkoutTime ? { defaultCheckout: place.checkoutTime } : {}),
        ...(place.checkInTime ? { defaultCheckIn: place.checkInTime } : {}),
      },
      ...(place.checkoutTime && place.checkInTime ? { usualTimesName: place.nickname ?? place.address } : {}),
      ...this.scheduleOptions(),
      reminderAsksArrival: true,
      grokReadsMessages: true,
      updateSettleMs: updateSettle ?? UPDATE_SETTLE_MS,
      ...(this.primaryAssistant() !== "grok" ? { helperName: this.hostWords().helper } : {}),
      ...this.preferenceOptions(),
      ownerPhone: file.host,
      cleaner: { phone: file.cleaner, approved: true },
      access: this.doorPort(),
      accessRefused: this.accessRefusedLines(),
      hostName: file.business,
      consented: file.texting === true,
      // Consent is per account: the engine's own YES and STOP decide, and the service's own lines are
      // never texted. Until the host's phone is confirmed the engine reads no calendar and the host's
      // number doesn't pass, but texts in from the cleaner and contacts, such as a STOP, are still taken.
      allowlist: (phone: string) => mayText(env(), phone) && (phone !== parsePhone(this.file.host ?? "") || this.hostConfirmed()),
      // Nothing goes out until the host's phone is confirmed. Texts in from saved people, such as a
      // cleaner's STOP, are still taken, so consent is never lost while it waits.
      holdSends: () => this.checking || !this.hostConfirmed() || (!liveSmsOn(env()) && !this.scratchCapture()),
      deferCleanerTexts: this.file.released !== true,
      ...(this.file.cleanerOut ? { cleanerConsent: "out" as const } : {}),
      ...(this.people && this.account
        ? {
            // Claimed and recorded in one step, so two properties holding their invites can't both send them later.
            optInElsewhere: (phone: string) => !this.people!.claimInvite(phone, this.account!.propertyId),
            onConsent: (phone: string, consent: "in" | "out") => this.reportConsent(phone, consent),
          }
        : {}),
      ...(this.file.hostOut ? { ownerOptedOut: true } : {}),
      optInBody: `Hi, this is ${file.business} at ${place.address}. You're getting this because you clean between guest stays. Reply YES to get cleaning texts, or STOP to opt out.`,
      stopReply: `You're opted out of cleaning texts for ${place.address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
      noteHostOnStop: true,
      isolate: true,
      tenantId: file.propertyId,
      pinSentBody: PIN_SENT,
      pinFailedBody: this.hostWords().pinFailed,
      ...(this.groupOn()
        ? {
            groupChat: {
              hostName: file.hostName ?? file.business,
              // No saved name: address them by their role, never by a made-up name.
              cleanerName: file.cleanerName ?? "Cleaner",
              ...(extra.length > 0 ? { extra } : {}),
              ...(file.doorCodeTo ? { doorCodeTo: file.doorCodeTo } : {}),
            },
          }
        : {}),
      sink: {
        send: async (text) => {
          // A phone that opted out of the shared line gets nothing, group or not, until it texts START or YES.
          const audience = text.channel === "group" && text.audience ? text.audience : [text.to];
          // The reply to the person's own STOP still goes: the carrier's rules call for it.
          if (text.kind !== "stop" && audience.some((phone) => this.lineOptedOut(phone))) {
            if (text.kind === "pin") throw new Error("opted out of the line");
            return;
          }
          if (text.kind === "opt-in" && this.people && this.account && text.to !== file.host) this.people.markInvited(text.to, this.account.propertyId);
          const hostLine = text.to === file.host && text.channel !== "group";
          if (hostLine && text.kind !== "pin-notice" && text.kind !== "pin-failed") {
            this.engine?.keepHostNote(`host:${text.kind}:${text.body}`, text.body);
          }
          if (!liveSmsOn(env())) {
            if (text.kind === "pin") this.noteAccepted("scratch-pin");
            return;
          }
          const address = this.place.address;
          const holdSms = Boolean(address) && text.body === cleanerOptOutHold(address ?? "", this.hostWords().helper);
          const readySms = text.kind === "done";
          const inviteSms = text.kind === "opt-in";
          if (hostLine && text.kind !== "pin-failed" && !SAFETY.has(text.kind) && !holdSms && !readySms && !inviteSms) return;
          if (text.channel === "group" && text.audience && text.audience.length > 0) {
            try {
              const sent = await sendLiveGroup(env(), { audience: [...text.audience], body: this.labeled(text.to, text.body, true), conversationSid: this.file.conversationSid });
              if (sent?.conversationSid) this.file.conversationSid = sent.conversationSid;
              if (text.kind === "pin" && sent?.sid) this.noteAccepted(sent.sid);
            } catch (err) {
              if (err instanceof GroupNotConfirmed && err.conversationSid) this.file.conversationSid = err.conversationSid;
              if (err instanceof GroupNotConfirmed && err.refused) {
                const { phone, code, message } = err.refused;
                console.warn(`  Cleaner Core: Twilio refused ${redactPhone(phone)} for the group text${code !== undefined ? ` (error ${code}${message ? `: ${message}` : ""})` : ""}.`);
              }
              throw err;
            }
            return;
          }
          const statusCallback = text.kind === "pin" ? cleanerPinStatusUrl(env()) : undefined;
          const sid = await sendLiveSms(env(), { to: text.to, body: this.labeled(text.to, text.body, false), ...(statusCallback ? { statusCallback } : {}) });
          if (text.kind === "pin" && sid) this.noteAccepted(sid);
        },
      },
      now: this.now,
      dataDir,
    });
    this.applyLineStops(engine);
    return engine;
  }

  /** Scratch only. The host and cleaner saved with save_people are allowed even when they are not 555 numbers. */
  private testTurnGuard(): string | undefined {
    if (!scratchToolsOn(this.env())) return SCRATCH_PROPERTY_REFUSAL;
    if (!isScratchPropertyAddress(this.place.address)) return SCRATCH_PROPERTY_REFUSAL;
    return undefined;
  }

  private scratchGuard(from?: string): string | undefined {
    if (!scratchToolsOn(this.env())) return SCRATCH_PROPERTY_REFUSAL;
    if (from !== undefined && !isScratchTestNumber(from)) return SCRATCH_NUMBER_REFUSAL;
    if (!isScratchPropertyAddress(this.place.address)) return SCRATCH_PROPERTY_REFUSAL;
    const saved = [this.file.host, this.file.cleaner, ...contactsOf(this.file).map((contact) => contact.phone)].filter((phone): phone is string => Boolean(phone));
    if (saved.some((phone) => !isScratchTestNumber(phone))) return SCRATCH_NUMBER_REFUSAL;
    if (from !== undefined) {
      const parsed = parsePhone(from);
      if (!parsed || !saved.includes(parsed)) return SCRATCH_NUMBER_REFUSAL;
    }
    return undefined;
  }

  private scratchCapture(): boolean {
    return this.scratchGuard() === undefined;
  }

  private inboxFromTranscript(line: string): string | undefined {
    const match = /^(\+\d+): (.*)$/.exec(line);
    if (!match?.[1]) return undefined;
    return inboxLine(whoTheyAre(match[1], this.file), this.hideCode(match[2] ?? ""));
  }

  private hideCode(text: string): string {
    if (!this.pin || !text.includes(this.pin)) return text;
    return text.split(this.pin).join("[redacted]");
  }

  private outboxRows(): OutboxRow[] {
    const people = this.file;
    const engineRows = (this.engine?.outbox() ?? []).map((item) => {
      const shown = item.kind === "pin" ? this.engine?.pinShownStatus(item.id) : undefined;
      const saved = shown ? undefined : this.file.deliveries?.find((row) => row.id === item.id)?.status;
      const stored = item.status === "uncertain" ? "waiting" : item.status;
      const status = shown ?? saved ?? stored;
      const role = item.group ? "the group" : whoTheyAre(item.to, people);
      return { id: item.id, kind: item.kind, local: false, label: outboxLabel(item.kind, role), line: outboxLine(item.kind, role, status), status, body: item.body };
    });
    const localRows = (this.file.localSends ?? []).map((item) => {
      const role = whoTheyAre(item.to, people);
      return { id: item.id, kind: item.kind, local: true, label: outboxLabel(item.kind, role), line: outboxLine(item.kind, role, item.status), status: item.status, body: item.body ?? "" };
    });
    return [...engineRows, ...localRows];
  }

  private setDelivery(row: OutboxRow, status: DeliveryReport): void {
    if (row.local) {
      const item = this.file.localSends?.find((send) => send.id === row.id);
      if (item) item.status = status;
    } else {
      const deliveries = (this.file.deliveries ?? []).filter((item) => item.id !== row.id);
      deliveries.push({ id: row.id, status });
      this.file.deliveries = deliveries;
    }
    this.persist();
  }

  private noteLocal(to: string, kind: TextKind, body = ""): void {
    const sends = this.file.localSends ?? [];
    sends.push({ id: `local-${randomUUID()}`, to, kind, status: "sent", body });
    this.file.localSends = sends;
    this.persist();
  }

  /** The chat this reply goes to: the calling connection's, else the primary's. Only wording and delivery format change. */
  assistant(): CleanerAssistant {
    return currentCaller()?.assistant ?? this.primaryAssistant();
  }

  /** The chat texts, alerts and routines follow (CLEANER_CORE_ASSISTANT; on a multi-tenant service, the tenant's primary). */
  primaryAssistant(): CleanerAssistant {
    return cleanerAssistant(this.env());
  }

  /** On a multi-tenant service: the connections (grant ids) that connected their own routine, oldest first. */
  routineConnectionIds(): string[] {
    return [...(this.file.routineConnections ?? [])];
  }

  /** Records the calling connection as one that connected its own routine. The caller persists. */
  private noteRoutineConnection(): void {
    const id = currentCaller()?.connectionId;
    if (!id) return;
    const ids = this.file.routineConnections ?? [];
    if (!ids.includes(id)) this.file.routineConnections = [...ids, id];
  }

  /** True when this reply goes to Claude: the calling connection's chat, else the primary's. */
  claude(): boolean {
    return this.assistant() === "claude";
  }

  /** The replies that name the chat or its tools, for this deployment. */
  private words(): DeskWording {
    return DESK_WORDING[this.assistant()];
  }

  /** The words in texts to the host and cleaner, which always name the primary chat. */
  private hostWords(): DeskWording {
    return DESK_WORDING[this.primaryAssistant()];
  }

  /**
   * True while an upload link of `kind` with this one-time code is waiting and not expired. Reads
   * only; opening the private page never uses the link up.
   */
  uploadLinkOpen(kind: "door-code" | "calendar-link" | "alert-routine", code: string): Promise<{ open: boolean; name?: string; by?: CleanerCaller }> {
    // A calendar link is the property's, in its hub.
    if (kind === "calendar-link") return Promise.resolve(this.hub.uploadLinkOpen(code) as { open: boolean; name?: string; by?: CleanerCaller });
    // A door code link is the property's too, in its hub's door access.
    if (kind === "door-code") return this.serial(async () => this.door().uploadLinkOpen(code) as { open: boolean; by?: CleanerCaller });
    return this.serial(async () => {
      const pending = this.file.alertUpload;
      if (!pending || !sameHash(uploadHash(code), pending.hash)) return { open: false };
      if (this.now().getTime() >= Date.parse(pending.expiresAt)) return { open: false };
      return { open: true, ...(pending.by ? { by: pending.by } : {}) };
    });
  }

  /**
   * The photos behind get_job_photos' signed links, as MCP image content for a chat that can't open
   * a link. Only types Claude reads, at most CLAUDE_MAX_IMAGES and CLAUDE_MAX_IMAGE_BYTES in all.
   */
  photoImages(links: readonly { url: string }[]): { type: "image"; data: string; mimeType: string }[] {
    const key = photoKey(this.env());
    if (!key) return [];
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    let total = 0;
    for (const link of links) {
      if (images.length >= CLAUDE_MAX_IMAGES) break;
      const at = link.url.indexOf(CLEANER_PHOTO_PREFIX);
      if (at < 0) continue;
      const photo = servePhoto(this.root, link.url.slice(at + CLEANER_PHOTO_PREFIX.length), key, this.now());
      if (photo.status !== 200) continue;
      const mimeType = photo.headers["Content-Type"] ?? "";
      if (!CLAUDE_IMAGE_TYPES.has(mimeType) || total + photo.body.length > CLAUDE_MAX_IMAGE_BYTES) continue;
      total += photo.body.length;
      images.push({ type: "image", data: photo.body.toString("base64"), mimeType });
    }
    return images;
  }

  private reply(result: Record<string, unknown>): ToolReply {
    const json = JSON.stringify(result);
    if (this.leaks(json)) return { ok: false, error: "That didn't work. Try again." };
    return { ok: true, result };
  }

  private fail(error: string): ToolReply {
    if (this.leaks(error)) return { ok: false, error: "That didn't work. Try again." };
    return { ok: false, error };
  }

  /**
   * Redeems a host approval code. False when the code is wrong, used or expired, or when the book
   * couldn't save, so every caller answers with APPROVAL_STALE as before.
   */
  private redeemed(book: ConfirmationBook, code: string, action: string, target: string, fingerprint: string): boolean {
    try {
      book.redeem(code, action, target, fingerprint);
      return true;
    } catch {
      return false;
    }
  }

  private failWith(error: string, result: Record<string, unknown>): ToolReply {
    if (this.leaks(error) || this.leaks(JSON.stringify(result))) return { ok: false, error: "That didn't work. Try again." };
    return { ok: false, error, result };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LiveFile;
    this.file = parsed;
    if (parsed.cleanerOut) this.held = true;
  }

  private persist(): void {
    const json = `${JSON.stringify(this.file)}\n`;
    // The code as its own token. An id that only holds the digits (a SID, a UUID, a booking UID) is fine.
    if (this.pin && containsCodeToken(json, this.pin)) throw new Error("Could not seal the door code.");
    this.writeFile(json);
  }

  private writeFile(json: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.path, json);
  }

  /** Opens the hub's sealed code with exactly this key. A seal made with another key stays shut. */
  private unlock(pinKey: Buffer): "ready" | "closed" {
    if (!this.door().saved()) return this.pin ? "ready" : "closed";
    const opened = this.door().opensWith(pinKey);
    if (!opened) return "closed";
    this.pin = opened;
    return "ready";
  }

  private noteAccepted(sid: string): void {
    this.file.pinSend = { sid, outcome: "accepted", notePending: false };
    this.persist();
  }

  private privateCodeWaiting(): boolean {
    if (!this.groupOn() || !this.engine) return false;
    const tracked = this.file.pinSend;
    if (tracked?.delivered === true && tracked.outcome !== "undelivered") return false;
    if (tracked?.outcome === "undelivered") return true;
    if (tracked?.sid === "group" || tracked?.outcome === "settled" || tracked?.outcome === "accepted") return false;
    return this.engine.outbox().some((item) => item.kind === "pin" && (item.status === "failed" || item.status === "uncertain"));
  }

  private withFailure(reply: ToolReply, failure: string | undefined): ToolReply {
    if (!failure || !reply.ok) return reply;
    return this.reply({ ...reply.result, next: failure });
  }

  runReminders(): Promise<void> {
    return this.serial(async () => {
      this.resume();
      await this.engine?.runReminders();
    });
  }

  private holdLine(): string {
    const address = this.place.address ?? "the property";
    return this.engine?.holdNotice() ?? (this.engine?.cleanerHasOptedOut() || this.file.cleanerOut ? cleanerOptOutHold(address, this.words().helper) : jobHoldLine(address));
  }

  private heldDepartureLine(): string {
    if (this.engine?.cleanerHasOptedOut()) return optedOutCodeLine();
    return this.engine?.holdNotice() ?? jobHoldLine(this.place.address ?? "the property");
  }

  private syncHold(): void {
    this.held = this.file.cleanerOut === true || this.engine?.jobOnHold() === true || this.engine?.cleanerHasOptedOut() === true;
  }

  private async applyPinReport(id: string, status: string): Promise<void> {
    this.resume();
    const tracked = this.file.pinSend;
    const latest = [...this.outboxRows()].reverse().find((item) => item.kind === "pin" && !item.local)?.id;
    if (tracked && id === latest) {
      if (status === "sent" || status === "queued") return;
      if (status === "delivered") {
        if (tracked.outcome === "undelivered" || tracked.delivered) {
          await this.engine?.reportPin(id, status);
          return;
        }
        tracked.delivered = true;
        this.persist();
      } else if ((status === "failed" || status === "undelivered") && tracked.outcome !== "undelivered") {
        tracked.delivered = false;
        tracked.outcome = "undelivered";
        this.persist();
      }
    }
    await this.engine?.reportPin(id, status);
  }

  private async hostText(id: string, from: string, text: string, channel?: "group"): Promise<{ sent: CleanerText[]; handled?: MessageHandled }> {
    this.noteSeen(id);
    const keyword = messagingKeyword(text);
    if (keyword === "stop" || keyword === "start" || isInjuryReport(text)) {
      this.resume();
      if (!this.engine) {
        if (keyword === "stop" || keyword === "start") return { sent: await this.inboundBeforeJob(id, from, keyword), handled: keyword };
        return { sent: [], handled: "none" };
      }
      const result = await this.engine.receive({ id, from, text, ...(channel ? { channel } : {}) });
      this.syncHold();
      return { sent: result.sent, ...this.handledBy(result) };
    }
    if (!isDeparture(text)) {
      if (!this.groupOn()) return { sent: [], handled: "none" };
      this.resume();
      if (!this.engine) return { sent: [], handled: "none" };
      const result = await this.engine.receive({ id, from, text, ...(channel ? { channel } : {}) });
      this.syncHold();
      return { sent: result.sent, ...this.handledBy(result) };
    }
    this.resume();
    this.engine?.keepHostNote("host:direct-left", this.hostWords().directTextReply);
    if (this.scratchCapture()) this.noteLocal(from, "held");
    return { sent: [], handled: "none" };
  }
}

/** Who a send reached, as kept on the sent message: "group", "cleaner", or "contact:<name>". */
function sentTarget(recipient: { key: string; name: string }): string {
  if (recipient.key === "group") return "group";
  if (recipient.key.startsWith("cleaner:")) return "cleaner";
  return `contact:${recipient.name}`;
}
