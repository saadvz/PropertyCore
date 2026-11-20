import { createHash } from "node:crypto";
import { normalizeListing, parseAirbnbEmail, redactBookingEmail, type BookingEmailInput, type ParsedBookingEmail, type ParseRefusal } from "../hub/airbnbEmail";
import { addressDomain, platformLabel, presetSender, senderAddress, sourceFor, type BookingSource } from "../hub/bookingSources";
import { authVerdict, type AuthVerdict } from "../hub/emailAuth";
import { checkOtherEmail } from "../hub/otherEmail";
import {
  appendBookingEmail,
  bodyHash,
  bookingKey,
  bySent,
  COUNTED,
  isDuplicate,
  readBookingEmails,
  rebuildBookings,
  recordBodyHash,
  sameEmail,
  type BookingEmailOutcome,
  type BookingEmailRecord,
} from "../hub/bookingEmails";
import { formatWhen, zonedInstant } from "../hub/calendar";
import type { HubSave } from "../hub/hub";
import type { HubProperty } from "../hub/store";
import type { CleanerCore, JobView } from "./core";
import { stayCodeHook } from "./stayCodeHook";

/**
 * Cleaner Core's side of Airbnb booking emails (#244): matches an email to this property and to a
 * stay on its calendar, puts the email's times on the cleanings through the engine's existing rules,
 * and asks the host whenever the email and the calendar disagree. The calendar decides which nights
 * are booked; an email never adds or removes one. See
 * docs/superpowers/specs/2026-11-14-airbnb-booking-emails-design.md.
 */

/** An email whose stay isn't on the calendar this long after it arrived is a question for the host. */
export const PENDING_MS = 3 * 60 * 60 * 1000;
export const CANCEL_ACTION = "cleaner-booking-cancel";
/** The host's yes to a booking from a platform without its own reader (#263). */
export const BOOKING_YES_ACTION = "cleaner-booking-yes";
const FAIL_WARNING = "This email didn't pass its sender check. Only say yes if you know this booking.";
const UNCHECKED_WARNING = "I couldn't check this email's sender. Only say yes if you know this booking.";

/** One line in every chat's instructions. The agent fetches the emails; Cleaner Core reads them. */
export const BOOKING_EMAIL_INSTRUCTION =
  "When the host's email is connected, pass each Airbnb reservation email (confirmed, changed or cancelled) to read_booking_email as it arrives: from, subject, the plain-text body, messageId and receivedAt, exactly as received. Never pass a guest message, a forward, or an email from anyone but Airbnb. When the host's email isn't connected, say once that connecting it lets Cleaner Core use each booking's exact times, and carry on with the usual times. Follow read_booking_email's next.";

export interface EmailDesk {
  root: string;
  now(): Date;
  engine(): CleanerCore | undefined;
  place(): HubProperty;
  listings(): string[];
  addListing(title: string): HubSave;
  /** The desk's door-code guard for free text. */
  carriesCode(text: string): boolean;
  /** True only when the text holds a code the desk guards: the saved door code, or a live per-visit code. */
  isCode(text: string): boolean;
  /** Reads the calendars into the engine, as check_now does. False when it can't read them now. */
  readCalendars(): Promise<boolean>;
  cleanerName(): string;
  issueApproval(target: string, fingerprint: string, next: string, action?: string): { code: string; question: string; expiresInMinutes?: number };
  redeem(code: string, target: string, fingerprint: string, action?: string): boolean;
  /** BOOKING_PLATFORMS is on (#263). Off, everything here behaves as before #263. */
  platformsOn(): boolean;
  /** The platforms the host takes bookings on (#263). */
  sources(): BookingSource[];
}

export interface EmailInput {
  email: BookingEmailInput;
  /** The host said the email's listing is this property's. */
  thisListing?: boolean;
  /** The host's yes to calling off a cancelled stay the calendar still shows, or to a booking on the Other path. */
  confirmation?: string;
  /** For an email from a platform without its own reader (#263): the fields the agent read in it. */
  extracted?: unknown;
}

export type EmailReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const MAX_BODY = 50_000;
const REFUSAL_NEXT: Record<ParseRefusal | "not-a-saved-sender" | "failed-authentication", string> = {
  "not-a-saved-sender": "That email isn't from a sender this property saved for its booking platforms, so nothing changed. Pass only the senders get_state's bookingEmails names, never a forward or a guest's message.",
  "failed-authentication": "That email failed its sender check, so it may not be from who it says. Nothing changed. Tell the host to check the booking on the platform itself.",
  "not-airbnb": "That email isn't from Airbnb, so nothing changed. Pass only Airbnb's own reservation emails, never a forward.",
  "not-a-reservation": "That isn't an Airbnb reservation confirmation, change or cancellation, so nothing changed. If it's a guest's message, pass it to read_guest_message instead, when that tool is listed.",
  "no-code": "I couldn't find the confirmation code in that email, so nothing changed.",
  "no-dates": "I couldn't read the check-in and checkout dates in that email, so nothing changed.",
};

export async function takeBookingEmail(desk: EmailDesk, input: EmailInput): Promise<EmailReply> {
  const email = input.email;
  if (!email || typeof email.from !== "string" || typeof email.subject !== "string" || typeof email.body !== "string") {
    return { ok: false, error: "Pass the email as from, subject and body (plain text)." };
  }
  if (email.body.length > MAX_BODY || email.subject.length > 1000 || email.from.length > 500) return { ok: false, error: "That email is too long to read." };
  const now = desk.now();
  const receivedAt = email.receivedAt && !Number.isNaN(Date.parse(email.receivedAt)) ? new Date(email.receivedAt).toISOString() : now.toISOString();
  const guard = (text: string) => desk.carriesCode(text);
  const body = redactBookingEmail(email.body, guard);
  const subject = redactBookingEmail(email.subject, guard);
  const from = redactBookingEmail(email.from, guard);
  const messageId = email.messageId ? redactBookingEmail(email.messageId.slice(0, 500), guard) : undefined;
  const hash = bodyHash(body);
  const records = readBookingEmails(desk.root);
  const seen = { from, subject, ...(messageId ? { messageId } : {}) };
  // With BOOKING_PLATFORMS on (#263): the platform the sender belongs to, and the email's sender check.
  const platforms = desk.platformsOn();
  const source = platforms ? sourceFor(desk.sources(), email.from) : undefined;
  const address = senderAddress(email.from);
  const auth: AuthVerdict | undefined = platforms && typeof email.authentication === "string" && address ? authVerdict(email.authentication, addressDomain(address)) : undefined;
  const base = { at: now.toISOString(), receivedAt, ...seen, bodyHash: hash, ...(auth ? { auth } : {}) };
  const keep = (outcome: BookingEmailOutcome, extra: Partial<BookingEmailRecord> = {}): void => appendBookingEmail(desk.root, { ...base, body, ...extra, outcome });

  // The host's yes to a call-off comes with the same email again, so it isn't a duplicate.
  const confirming = typeof input.confirmation === "string" && input.confirmation.trim() !== "";
  const last = lastOutcome(records, seen, hash);
  const listingYes = input.thisListing === true && last === "mismatch";
  // A booking still waiting on the host is asked again when its email comes back, so a new chat can get the yes.
  const awaitingAgain = last === "awaiting-host";
  if (!confirming && !listingYes && !awaitingAgain && isDuplicate(records, { ...seen, body }, body)) {
    keep("duplicate");
    return done({ outcome: "duplicate", next: "I already read that email. Nothing changed." });
  }
  if (platforms) {
    const refuse = (reason: "not-a-saved-sender" | "failed-authentication"): EmailReply => {
      // Anyone could have sent it: keep only that it came.
      appendBookingEmail(desk.root, { ...base, refused: reason, outcome: "refused" });
      return done({ outcome: "refused", reason, next: REFUSAL_NEXT[reason] });
    };
    if (!source) return refuse("not-a-saved-sender");
    // Airbnb's and the pre-filled platform senders are known; a failed check there is a spoof. A sender
    // the host named (their own site) may fail it honestly, so the host is warned and decides.
    if (auth === "fail" && (source.platform === "airbnb" || presetSender(source))) return refuse("failed-authentication");
    if (source.platform !== "airbnb") return otherPath(desk, input, source, auth, { subject, body, now, receivedAt, records, base, keep, self: (record) => sameEmail(record, seen, hash) });
  }
  const read = parseAirbnbEmail({ from: email.from, subject, body, receivedAt }, now);
  if (!read.ok) {
    // An email that isn't Airbnb's reservation notice could be anyone's: keep only that it came.
    appendBookingEmail(desk.root, { ...base, refused: read.reason, outcome: "refused" });
    return done({ outcome: "refused", reason: read.reason, next: REFUSAL_NEXT[read.reason] });
  }
  const parsed = read.parsed;
  const engine = desk.engine();

  // Matching the property.
  // An email about a booking this property already took (a change or cancellation that doesn't name its listing) is this property's.
  const match = listingMatch(desk, parsed, body) || (!parsed.listing && rebuildBookings(records).has(bookingKey(parsed)));
  if (!match) {
    if (input.thisListing === true && parsed.listing) {
      const saved = desk.addListing(parsed.listing);
      if (!saved.ok) return { ok: false, error: saved.error };
    } else {
      keep("mismatch", { parsed });
      const name = desk.place().nickname ?? desk.place().address ?? "this property";
      const shown = parsed.listing ? `‘${parsed.listing}’` : "a listing";
      engine?.keepHostNote(`booking-email:listing:${normalizeListing(parsed.listing ?? parsed.confirmationCode)}`, `An Airbnb email for ${shown} doesn't match ${name}. Is that listing this property?`);
      return done({
        outcome: "mismatch",
        ...(parsed.listing ? { listing: parsed.listing } : {}),
        next: parsed.listing
          ? `Ask the host whether the Airbnb listing "${parsed.listing}" is ${name}. If yes, call read_booking_email again with the same email and thisListing: true. If no, it's another property's email: nothing changed here.`
          : `That email doesn't name its listing, so I can't tell it's ${name}'s. Nothing changed.`,
      });
    }
  }

  return settle(desk, parsed, records, input, keep, receivedAt, (record) => sameEmail(record, seen, hash), false);
}

/**
 * A booking email that is this property's, read by its reader or confirmed by the host: its times go on
 * the cleanings, or its cancellation calls one off. `approved`: the host already said yes to this exact
 * booking and the texts its call-off sends (#263), so a cancellation isn't asked again.
 */
async function settle(
  desk: EmailDesk,
  parsed: ParsedBookingEmail,
  records: readonly BookingEmailRecord[],
  input: EmailInput,
  keep: (outcome: BookingEmailOutcome, extra?: Partial<BookingEmailRecord>) => void,
  receivedAt: string,
  self: (record: BookingEmailRecord) => boolean,
  approved: boolean,
): Promise<EmailReply> {
  const engine = desk.engine();
  const label = labelOf(parsed);
  // The platform already sent a later email about this booking: that one stands.
  if (parsed.kind !== "cancelled" && superseded(records, bookingKey(parsed), receivedAt, self)) {
    keep("superseded", { parsed });
    return done({ outcome: "superseded", confirmationCode: parsed.confirmationCode, next: `${label} sent a later email about that booking, so this older one changed nothing.` });
  }

  if (!engine) {
    if (parsed.kind === "cancelled") {
      keep("applied", { parsed });
      return done({ outcome: "applied", next: "Cleaner Core isn't running checks yet, so there's no cleaning to call off. The calendar decides once the checks run." });
    }
    keep("pending", { parsed });
    return done({ outcome: "pending", next: "Cleaner Core isn't running checks yet. I kept the email, and its times go on the cleanings once the checks run." });
  }

  if (parsed.kind === "cancelled") return cancellation(desk, engine, parsed, records, input, keep, approved);

  let applied = await applyTimes(desk, engine, parsed);
  if (applied.outcome === "pending" && (await desk.readCalendars())) applied = await applyTimes(desk, engine, parsed);
  keep(applied.outcome, { parsed });
  return done({
    outcome: applied.outcome,
    confirmationCode: parsed.confirmationCode,
    ...(parsed.guests ? { guests: parsed.guests.total } : {}),
    next:
      applied.outcome === "applied"
        ? "The email's times are on the cleanings. Tell the host only what check_now's alerts say."
        : applied.outcome === "pending"
          ? "That stay isn't on the calendar yet. I kept the email; its times go on the cleaning when the calendar shows it. Nothing to tell the host now."
          : "The email and the calendar disagree, so nothing changed. Tell the host what check_now's alert says.",
  });
}

/** Tries each email whose stay wasn't on the calendar yet. Call after every calendar read. */
export async function retryPendingEmails(desk: EmailDesk): Promise<void> {
  const engine = desk.engine();
  if (!engine) return;
  const records = readBookingEmails(desk.root);
  const now = desk.now();
  for (const record of waiting(records)) {
    const parsed = record.parsed!;
    if (parsed.kind === "cancelled") continue;
    if (superseded(readBookingEmails(desk.root), bookingKey(parsed), record.receivedAt, (item) => emailKey(item) === emailKey(record))) {
      appendBookingEmail(desk.root, { ...record, at: now.toISOString(), outcome: "superseded" });
      continue;
    }
    const applied = await applyTimes(desk, engine, parsed);
    if (applied.outcome === "applied" || applied.outcome === "disagrees") {
      appendBookingEmail(desk.root, { ...record, at: now.toISOString(), outcome: applied.outcome });
      continue;
    }
    if (now.getTime() - Date.parse(record.receivedAt) < PENDING_MS) continue;
    appendBookingEmail(desk.root, { ...record, at: now.toISOString(), outcome: "disagrees" });
    engine.keepHostNote(
      `booking-email:missing:${bookingKey(parsed)}`,
      `${labelOf(parsed)} says ${refOf(parsed)} is ${shortDay(parsed.checkIn!.date)} to ${shortDay(parsed.checkout!.date)}, but the calendar doesn't show it. Check the booking, then run the checks again.${missingCalendar(desk, parsed)}`,
    );
  }
}

/** Guests and confirmation code for each stay the emails gave them, by "checkIn|checkout". */
export function emailFacts(root: string): Map<string, { guests?: number; confirmationCode: string }> {
  const out = new Map<string, { guests?: number; confirmationCode: string }>();
  for (const booking of rebuildBookings(readBookingEmails(root)).values()) {
    if (booking.cancelled) continue;
    out.set(`${booking.checkIn}|${booking.checkout}`, { confirmationCode: booking.confirmationCode, ...(booking.guests !== undefined ? { guests: booking.guests } : {}) });
  }
  return out;
}

/** The latest record for each email still waiting on the calendar, in the order Airbnb sent them. */
function waiting(records: readonly BookingEmailRecord[]): BookingEmailRecord[] {
  const latest = new Map<string, BookingEmailRecord>();
  for (const record of records) {
    if (!record.parsed) continue;
    latest.set(emailKey(record), record);
  }
  return bySent([...latest.values()].filter((record) => record.outcome === "pending"));
}

/** True when the log has a later-sent email about the same booking that counted. */
function superseded(records: readonly BookingEmailRecord[], key: string, receivedAt: string, self: (record: BookingEmailRecord) => boolean): boolean {
  const sent = Date.parse(receivedAt);
  return records.some(
    (record) =>
      record.parsed !== undefined &&
      bookingKey(record.parsed) === key &&
      COUNTED.has(record.outcome) &&
      ((record.parsed.platform ?? "airbnb") === "airbnb" || record.hostConfirmed === true) &&
      Date.parse(record.receivedAt) > sent &&
      !self(record),
  );
}

function emailKey(record: Pick<BookingEmailRecord, "messageId" | "from" | "subject" | "body" | "bodyHash">): string {
  return record.messageId ?? createHash("sha256").update(`${record.from}\n${record.subject}\n${recordBodyHash(record)}`).digest("hex");
}

/** What came of this email last time: matched by its message id, or by its sender, subject and body. */
function lastOutcome(records: readonly BookingEmailRecord[], email: Pick<BookingEmailInput, "from" | "subject" | "messageId">, hash: string): BookingEmailOutcome | undefined {
  return records.filter((record) => sameEmail(record, email, hash) && record.outcome !== "duplicate").at(-1)?.outcome;
}

function listingMatch(desk: EmailDesk, parsed: ParsedBookingEmail, body: string): boolean {
  const saved = desk.listings().map(normalizeListing).filter(Boolean);
  const names = [...saved, ...(desk.place().nickname ? [normalizeListing(desk.place().nickname!)] : [])].filter(Boolean);
  if (names.length === 0) return false;
  if (parsed.listing) return names.includes(normalizeListing(parsed.listing));
  // An email that names no listing line still matches a listing title the host confirmed, written in its text.
  // A nickname is the host's own word and could be anywhere in an email, so it doesn't count here.
  const text = ` ${normalizeListing(body)} `;
  return saved.some((name) => text.includes(` ${name} `));
}

type Applied = { outcome: "applied" | "pending" | "disagrees" };

/** The stay's own cleaning takes the email's checkout time; the cleaning before it takes its check-in time. */
async function applyTimes(desk: EmailDesk, engine: CleanerCore, parsed: ParsedBookingEmail): Promise<Applied> {
  const checkIn = parsed.checkIn!;
  const checkout = parsed.checkout!;
  const jobs = engine.jobs().filter((job) => job.status !== "canceled");
  const own = jobs.find((job) => job.checkoutDate === checkout.date && (job.checkInDate ?? checkIn.date) === checkIn.date);
  if (!own) {
    const near = jobs.find((job) => job.checkoutDate === checkout.date || (job.checkInDate !== undefined && job.checkInDate === checkIn.date));
    if (!near) return { outcome: "pending" };
    engine.keepHostNote(
      `booking-email:dates:${bookingKey(parsed)}:${checkIn.date}:${checkout.date}`,
      `${labelOf(parsed)} says ${refOf(parsed)} is ${shortDay(checkIn.date)} to ${shortDay(checkout.date)}, but the calendar shows ${shortDay(near.checkInDate ?? checkIn.date)} to ${shortDay(near.checkoutDate)}. Check the booking, then run the checks again.`,
    );
    return { outcome: "disagrees" };
  }
  const before = jobs.find((job) => job.nextCheckInDate === checkIn.date && job.id !== own.id);
  if (checkout.time) await timeOne(desk, engine, own, "checkout", checkout.time, labelOf(parsed));
  if (checkIn.time && before) await timeOne(desk, engine, before, "checkin", checkIn.time, labelOf(parsed));
  return { outcome: "applied" };
}

async function timeOne(desk: EmailDesk, engine: CleanerCore, job: JobView, side: "checkout" | "checkin", hm: string, label = "Airbnb"): Promise<void> {
  const minutes = minutesOf(hm);
  const shown = side === "checkout" ? job.checkoutTime : job.nextCheckInTime;
  const usual = side === "checkout" ? desk.place().checkoutTime : desk.place().checkInTime;
  const saved = shown ? clockMinutes(shown) : usual ? minutesOf(usual) : undefined;
  const result = await engine.setJobTimes({ jobId: job.id, ...(side === "checkout" ? { checkout: minutes } : { checkIn: minutes }) });
  const day = longDay(desk, side === "checkout" ? job.checkoutDate : job.nextCheckInDate!);
  const said = clock(minutes);
  if (!result.applied) {
    if (result.reason === "code-sent" && saved !== minutes) {
      const what = side === "checkout" ? `checkout on ${day}` : `the next check-in on ${day}`;
      engine.keepHostNote(`booking-email:after-code:${job.id}:${side}:${minutes}`, `${label} changed ${what} to ${said} after the door code went out. I left that cleaning as it was.`);
    }
    return;
  }
  if (saved !== undefined && saved !== minutes) {
    const body =
      side === "checkout"
        ? `${label} says checkout on ${day} is ${said}, not ${clock(saved)}. I'm using ${said}.`
        : `${label} says the next guest checks in on ${day} at ${said}, not ${clock(saved)}. I'm using ${said}.`;
    engine.keepHostNote(`booking-email:time:${job.id}:${side}:${minutes}`, body);
  }
  const after = engine.jobs().find((item) => item.id === job.id);
  const moved = side === "checkout" ? shown !== after?.checkoutTime : shown !== after?.nextCheckInTime;
  if (moved && after?.checkoutAt) await stayCodeHook().windowMoved({ jobId: job.id, window: { start: after.checkoutAt, end: after.nextCheckInAt } });
}

async function cancellation(
  desk: EmailDesk,
  engine: CleanerCore,
  parsed: ParsedBookingEmail,
  records: readonly BookingEmailRecord[],
  input: EmailInput,
  keep: (outcome: BookingEmailOutcome, extra?: Partial<BookingEmailRecord>) => void,
  approved = false,
): Promise<EmailReply> {
  const label = labelOf(parsed);
  const ref = refOf(parsed);
  // The dates the platform's earlier emails gave this booking come first; a cancellation's own wording is a sentence to read.
  const known = rebuildBookings(records).get(bookingKey(parsed));
  const checkIn = known?.checkIn ?? parsed.checkIn?.date;
  const checkout = known?.checkout ?? parsed.checkout?.date;
  if (!checkIn || !checkout) {
    keep("disagrees", { parsed });
    engine.keepHostNote(`booking-email:cancel-unknown:${bookingKey(parsed)}`, `${label} says ${ref} was cancelled, but I don't know its dates. Check the calendar, and call off the cleaning if it's still on.`);
    return done({ outcome: "disagrees", next: "I can't tell which stay that cancellation is for, so nothing changed. Tell the host what check_now's alert says." });
  }
  const find = () => stayJob(engine, checkIn, checkout);
  // The calendar decides: read it first, and when it already dropped the stay, the existing rules called the cleaning off.
  if (!input.confirmation) await desk.readCalendars();
  const job = find();
  if (!job) {
    keep("disagrees", { parsed });
    engine.keepHostNote(
      `booking-email:cancel-missing:${bookingKey(parsed)}`,
      `${label} says ${ref} (${shortDay(checkIn)} to ${shortDay(checkout)}) was cancelled, but I can't find that stay on the calendar. Nothing was called off.`,
    );
    return done({ outcome: "disagrees", next: "I can't find that stay on the calendar, so nothing was called off. Tell the host what check_now's alert says." });
  }
  if (job.status === "canceled") {
    keep("applied", { parsed });
    await stayCodeHook().stayCancelled({ jobId: job.id });
    return done({ outcome: "applied", next: "The calendar already dropped that stay, so its cleaning is off. Nothing to ask the host." });
  }
  if (job.status === "cleared" || job.status === "in_progress" || job.status === "done" || job.status === "declined") {
    keep("disagrees", { parsed });
    const why = job.status === "declined" ? "the cleaner already turned that cleaning down" : "that cleaning is already under way";
    engine.keepHostNote(`booking-email:cancel-under-way:${job.id}`, `${label} says the stay checking out ${longDay(desk, checkout)} was cancelled, but ${why}. Nothing was called off.`);
    return done({ outcome: "disagrees", next: `${why[0]!.toUpperCase()}${why.slice(1)}, so nothing was called off. Tell the host what check_now's alert says.` });
  }
  const texts = cancelTexts(desk, engine, job.id);
  if (!approved) {
    const fingerprint = createHash("sha256").update(`booking-cancel|${job.id}|${job.status}|${texts.map((t) => t.body).join("|")}`).digest("hex");
    const code = input.confirmation?.trim() ?? "";
    if (!code) {
      const day = longDay(desk, checkout);
      const next = `${label} says ${ref} (${shortDay(checkIn)} to ${shortDay(checkout)}) was cancelled, but the calendar still shows it. Call off the cleaning on ${day}?${textsLine(texts)} Reply yes to call it off.`;
      keep("asked", { parsed });
      engine.keepHostNote(`booking-email:cancel:${job.id}`, `${label} says the stay checking out ${day} was cancelled, but the calendar still shows it. Should I call off that cleaning?`);
      return done({ outcome: "asked", next, texts, confirmation: desk.issueApproval(job.id, fingerprint, next) });
    }
    if (!desk.redeem(code, job.id, fingerprint)) return { ok: false, error: "That approval is stale. Ask the host again with the new preview." };
  }
  const off = await engine.callOffJob(job.id);
  if (!off.calledOff) {
    keep("disagrees", { parsed });
    return done({ outcome: "disagrees", next: "That cleaning can't be called off now (it's under way, done, or its door code went out), so nothing changed. Tell the host." });
  }
  keep("called-off", { parsed });
  await stayCodeHook().stayCancelled({ jobId: job.id });
  return done({ outcome: "called-off", texts: off.sent.length > 0 ? texts : [], next: "The cleaning is called off." });
}

/** The stay's own cleaning, still on: the one checking out on the stay's checkout date after its check-in. */
function stayJob(engine: CleanerCore, checkIn: string, checkout: string): JobView | undefined {
  const jobs = engine.jobs().filter((job) => job.checkoutDate === checkout && (job.checkInDate ?? checkIn) === checkIn);
  return jobs.find((job) => job.status !== "canceled") ?? jobs[0];
}

/** The texts calling off this cleaning would send, as the host sees them. */
function cancelTexts(desk: EmailDesk, engine: CleanerCore, jobId: string): { to: string; body: string }[] {
  const cleaner = desk.cleanerName();
  return engine
    .standDownTexts()
    .filter((text) => text.jobId === jobId)
    .map((text) => ({ to: text.to === "cleaner" ? cleaner : "you", body: text.body }));
}

function textsLine(texts: readonly { to: string; body: string }[]): string {
  return texts.length ? ` These texts go out: ${texts.map((t) => `to ${t.to}, "${t.body}"`).join("; ")}.` : " No texts go out.";
}

/** Who the email says it's from, at the start of a sentence: "Airbnb", "Vrbo", "Your booking site", or the Other platform's name. */
function labelOf(parsed: Pick<ParsedBookingEmail, "platform" | "platformName">): string {
  const label = platformLabel({ platform: parsed.platform ?? "airbnb", ...(parsed.platformName ? { name: parsed.platformName } : {}) });
  return `${label[0]!.toUpperCase()}${label.slice(1)}`;
}

/** The booking's reference, or a stand-in when an Other email gave none. */
function refOf(parsed: Pick<ParsedBookingEmail, "confirmationCode">): string {
  return parsed.confirmationCode || "the booking";
}

/** For a platform whose calendar may not be saved: ask the host to add it. The calendar decides which nights are booked. */
function missingCalendar(desk: EmailDesk, parsed: Pick<ParsedBookingEmail, "platform" | "platformName">): string {
  if ((parsed.platform ?? "airbnb") === "airbnb" || !desk.platformsOn()) return "";
  return ` If ${platformLabel({ platform: parsed.platform!, ...(parsed.platformName ? { name: parsed.platformName } : {}) })}'s calendar isn't saved here yet, send me its calendar link.`;
}

interface OtherContext {
  subject: string;
  body: string;
  now: Date;
  receivedAt: string;
  records: readonly BookingEmailRecord[];
  base: Omit<BookingEmailRecord, "outcome">;
  keep: (outcome: BookingEmailOutcome, extra?: Partial<BookingEmailRecord>) => void;
  self: (record: BookingEmailRecord) => boolean;
}

/**
 * The Other path (#263): a booking email from a platform without its own reader. The agent read the
 * fields; Property Core checks their shape, and nothing moves until the host says yes to this exact
 * email and these fields. With the yes, it goes the way an Airbnb email goes.
 */
async function otherPath(desk: EmailDesk, input: EmailInput, source: BookingSource, auth: AuthVerdict | undefined, ctx: OtherContext): Promise<EmailReply> {
  const check = checkOtherEmail({ subject: ctx.subject, body: ctx.body }, input.extracted, source, ctx.now, (text) => desk.carriesCode(text), (text) => desk.isCode(text));
  if (!check.ok) {
    // Fields that can't be used say nothing reliable about the email: keep only that it came.
    appendBookingEmail(desk.root, { ...ctx.base, refused: check.reason, outcome: "refused" });
    return done({ outcome: "refused", reason: check.reason, field: check.field, next: `${check.message} Nothing changed.` });
  }
  const parsed: ParsedBookingEmail = { ...check.parsed, ...(source.platform === "other" && source.name ? { platformName: source.name } : {}) };
  const engine = desk.engine();
  const label = labelOf(parsed);
  const key = bookingKey(parsed);
  const confirming = typeof input.confirmation === "string" && input.confirmation.trim() !== "";
  const warning = auth === "fail" ? FAIL_WARNING : source.platform === "booking" && auth !== "pass" ? UNCHECKED_WARNING : undefined;
  // A cancellation is one ask: the host's yes covers the texts calling the cleaning off sends.
  let texts: { to: string; body: string }[] = [];
  if (parsed.kind === "cancelled" && engine) {
    if (!confirming) await desk.readCalendars();
    const known = rebuildBookings(ctx.records).get(key);
    const job = stayJob(engine, known?.checkIn ?? parsed.checkIn!.date, known?.checkout ?? parsed.checkout!.date);
    if (job && job.status !== "canceled") texts = cancelTexts(desk, engine, job.id);
  }
  const fingerprint = createHash("sha256")
    .update(`booking-yes|${ctx.base.bodyHash}|${ctx.subject}|${JSON.stringify(parsed)}|${texts.map((t) => `${t.to}:${t.body}`).join("|")}`)
    .digest("hex");
  const summary = summaryOf(desk, parsed, label);
  if (!confirming) {
    ctx.keep("awaiting-host", { parsed });
    const question = parsed.kind === "cancelled" ? "Call off its cleaning?" : "Use these times for the cleaning?";
    engine?.keepHostNote(`booking-email:yes:${key}:${ctx.base.bodyHash}`, `${summary} I won't use it until you say yes in chat.`);
    const next = `Show the host this booking exactly: "${summary}"${warning ? ` ${warning}` : ""}${parsed.kind === "cancelled" ? textsLine(texts) : ""} Ask "${question}" with Yes and No. Only after their yes, call read_booking_email again with the same email, the same extracted and confirmation. Nothing changes until then.`;
    return done({
      outcome: "awaiting-host",
      platform: parsed.platform,
      summary,
      ...(warning ? { warning } : {}),
      ...(parsed.kind === "cancelled" ? { texts } : {}),
      next,
      confirmation: desk.issueApproval(key, fingerprint, next, BOOKING_YES_ACTION),
    });
  }
  if (!desk.redeem(input.confirmation!.trim(), key, fingerprint, BOOKING_YES_ACTION)) {
    return { ok: false, error: "That approval is stale: the email, its fields or what it would send changed. Call again without confirmation and show the host the new summary." };
  }
  const keepYes = (outcome: BookingEmailOutcome, extra: Partial<BookingEmailRecord> = {}) => ctx.keep(outcome, { ...extra, hostConfirmed: true });
  return settle(desk, parsed, ctx.records, input, keepYes, ctx.receivedAt, ctx.self, true);
}

/** One line for the host: the booking as the agent read it. */
function summaryOf(desk: EmailDesk, parsed: ParsedBookingEmail, label: string): string {
  const ref = parsed.confirmationCode ? ` ${parsed.confirmationCode}` : "";
  const range = `${shortDay(parsed.checkIn!.date)} to ${shortDay(parsed.checkout!.date)}`;
  if (parsed.kind === "cancelled") return `${label} says booking${ref} (${range}) was cancelled.`;
  const side = (date: string, time?: string) => `${longDay(desk, date)}${time ? ` at ${clock(minutesOf(time))}` : ""}`;
  const guests = parsed.guests ? `, ${parsed.guests.total} ${parsed.guests.total === 1 ? "guest" : "guests"}` : "";
  const what = parsed.kind === "changed" ? "changed booking" : "booking";
  return `${label} ${what}${ref}: ${side(parsed.checkIn!.date, parsed.checkIn!.time)} to ${side(parsed.checkout!.date, parsed.checkout!.time)}${guests}.`;
}

function done(result: Record<string, unknown>): EmailReply {
  return { ok: true, result };
}

export function minutesOf(hm: string): number {
  const [hour = 0, minute = 0] = hm.split(":").map(Number);
  return hour * 60 + minute;
}

/** "11:00 AM" as minutes after midnight. */
export function clockMinutes(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(text.trim());
  if (!match) return undefined;
  return ((Number(match[1]) % 12) + (match[3]!.toUpperCase() === "P" ? 12 : 0)) * 60 + Number(match[2]);
}

export function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function longDay(desk: EmailDesk, date: string): string {
  const zone = desk.place().timeZone ?? "UTC";
  return formatWhen(zonedInstant(date, "12:00", zone), zone).day;
}

function shortDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}
