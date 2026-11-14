import { createHash } from "node:crypto";
import { normalizeListing, parseAirbnbEmail, redactBookingEmail, type BookingEmailInput, type ParsedBookingEmail, type ParseRefusal } from "../hub/airbnbEmail";
import {
  appendBookingEmail,
  bodyHash,
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
  /** Reads the calendars into the engine, as check_now does. False when it can't read them now. */
  readCalendars(): Promise<boolean>;
  cleanerName(): string;
  issueApproval(target: string, fingerprint: string, next: string): { code: string; question: string; expiresInMinutes?: number };
  redeem(code: string, target: string, fingerprint: string): boolean;
}

export interface EmailInput {
  email: BookingEmailInput;
  /** The host said the email's listing is this property's. */
  thisListing?: boolean;
  /** The host's yes to calling off a cancelled stay the calendar still shows. */
  confirmation?: string;
}

export type EmailReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const MAX_BODY = 50_000;
const REFUSAL_NEXT: Record<ParseRefusal, string> = {
  "not-airbnb": "That email isn't from Airbnb, so nothing changed. Pass only Airbnb's own reservation emails, never a forward.",
  "not-a-reservation": "That isn't an Airbnb reservation confirmation, change or cancellation, so nothing changed.",
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
  const base = { at: now.toISOString(), receivedAt, ...seen, bodyHash: hash };
  const keep = (outcome: BookingEmailOutcome, extra: Partial<BookingEmailRecord> = {}): void => appendBookingEmail(desk.root, { ...base, body, ...extra, outcome });

  // The host's yes to a call-off comes with the same email again, so it isn't a duplicate.
  const confirming = typeof input.confirmation === "string" && input.confirmation.trim() !== "";
  const listingYes = input.thisListing === true && lastOutcome(records, seen, hash) === "mismatch";
  if (!confirming && !listingYes && isDuplicate(records, { ...seen, body }, body)) {
    keep("duplicate");
    return done({ outcome: "duplicate", next: "I already read that email. Nothing changed." });
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
  const match = listingMatch(desk, parsed, body) || (!parsed.listing && rebuildBookings(records).has(parsed.confirmationCode));
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

  // Airbnb already sent a later email about this booking: that one stands.
  if (parsed.kind !== "cancelled" && superseded(records, parsed.confirmationCode, receivedAt, (record) => sameEmail(record, seen, hash))) {
    keep("superseded", { parsed });
    return done({ outcome: "superseded", confirmationCode: parsed.confirmationCode, next: "Airbnb sent a later email about that booking, so this older one changed nothing." });
  }

  if (!engine) {
    if (parsed.kind === "cancelled") {
      keep("applied", { parsed });
      return done({ outcome: "applied", next: "Cleaner Core isn't running checks yet, so there's no cleaning to call off. The calendar decides once the checks run." });
    }
    keep("pending", { parsed });
    return done({ outcome: "pending", next: "Cleaner Core isn't running checks yet. I kept the email, and its times go on the cleanings once the checks run." });
  }

  if (parsed.kind === "cancelled") return cancellation(desk, engine, parsed, records, input, keep);

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
    if (superseded(readBookingEmails(desk.root), parsed.confirmationCode, record.receivedAt, (item) => emailKey(item) === emailKey(record))) {
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
      `booking-email:missing:${parsed.confirmationCode}`,
      `Airbnb says ${parsed.confirmationCode} is ${shortDay(parsed.checkIn!.date)} to ${shortDay(parsed.checkout!.date)}, but the calendar doesn't show it. Check the booking, then run the checks again.`,
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
function superseded(records: readonly BookingEmailRecord[], code: string, receivedAt: string, self: (record: BookingEmailRecord) => boolean): boolean {
  const sent = Date.parse(receivedAt);
  return records.some((record) => record.parsed?.confirmationCode === code && COUNTED.has(record.outcome) && Date.parse(record.receivedAt) > sent && !self(record));
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
      `booking-email:dates:${parsed.confirmationCode}:${checkIn.date}:${checkout.date}`,
      `Airbnb says ${parsed.confirmationCode} is ${shortDay(checkIn.date)} to ${shortDay(checkout.date)}, but the calendar shows ${shortDay(near.checkInDate ?? checkIn.date)} to ${shortDay(near.checkoutDate)}. Check the booking, then run the checks again.`,
    );
    return { outcome: "disagrees" };
  }
  const before = jobs.find((job) => job.nextCheckInDate === checkIn.date && job.id !== own.id);
  if (checkout.time) await timeOne(desk, engine, own, "checkout", checkout.time);
  if (checkIn.time && before) await timeOne(desk, engine, before, "checkin", checkIn.time);
  return { outcome: "applied" };
}

async function timeOne(desk: EmailDesk, engine: CleanerCore, job: JobView, side: "checkout" | "checkin", hm: string): Promise<void> {
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
      engine.keepHostNote(`booking-email:after-code:${job.id}:${side}:${minutes}`, `Airbnb changed ${what} to ${said} after the door code went out. I left that cleaning as it was.`);
    }
    return;
  }
  if (saved !== undefined && saved !== minutes) {
    const body =
      side === "checkout"
        ? `Airbnb says checkout on ${day} is ${said}, not ${clock(saved)}. I'm using ${said}.`
        : `Airbnb says the next guest checks in on ${day} at ${said}, not ${clock(saved)}. I'm using ${said}.`;
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
): Promise<EmailReply> {
  // The dates Airbnb's earlier emails gave this booking come first; a cancellation's own wording is a sentence to read.
  const known = rebuildBookings(records).get(parsed.confirmationCode);
  const checkIn = known?.checkIn ?? parsed.checkIn?.date;
  const checkout = known?.checkout ?? parsed.checkout?.date;
  if (!checkIn || !checkout) {
    keep("disagrees", { parsed });
    engine.keepHostNote(`booking-email:cancel-unknown:${parsed.confirmationCode}`, `Airbnb says ${parsed.confirmationCode} was cancelled, but I don't know its dates. Check the calendar, and call off the cleaning if it's still on.`);
    return done({ outcome: "disagrees", next: "I can't tell which stay that cancellation is for, so nothing changed. Tell the host what check_now's alert says." });
  }
  const find = () => engine.jobs().find((job) => job.checkoutDate === checkout && (job.checkInDate ?? checkIn) === checkIn);
  // The calendar decides: read it first, and when it already dropped the stay, the existing rules called the cleaning off.
  if (!input.confirmation) await desk.readCalendars();
  const job = find();
  if (!job) {
    keep("disagrees", { parsed });
    engine.keepHostNote(
      `booking-email:cancel-missing:${parsed.confirmationCode}`,
      `Airbnb says ${parsed.confirmationCode} (${shortDay(checkIn)} to ${shortDay(checkout)}) was cancelled, but I can't find that stay on the calendar. Nothing was called off.`,
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
    engine.keepHostNote(`booking-email:cancel-under-way:${job.id}`, `Airbnb says the stay checking out ${longDay(desk, checkout)} was cancelled, but ${why}. Nothing was called off.`);
    return done({ outcome: "disagrees", next: `${why[0]!.toUpperCase()}${why.slice(1)}, so nothing was called off. Tell the host what check_now's alert says.` });
  }
  const cleaner = desk.cleanerName();
  const texts = engine
    .standDownTexts()
    .filter((text) => text.jobId === job.id)
    .map((text) => ({ to: text.to === "cleaner" ? cleaner : "you", body: text.body }));
  const fingerprint = createHash("sha256").update(`booking-cancel|${job.id}|${job.status}|${texts.map((t) => t.body).join("|")}`).digest("hex");
  const code = input.confirmation?.trim() ?? "";
  if (!code) {
    const day = longDay(desk, checkout);
    const goes = texts.length ? ` These texts go out: ${texts.map((t) => `to ${t.to}, "${t.body}"`).join("; ")}.` : " No texts go out.";
    const next = `Airbnb says ${parsed.confirmationCode} (${shortDay(checkIn)} to ${shortDay(checkout)}) was cancelled, but the calendar still shows it. Call off the cleaning on ${day}?${goes} Reply yes to call it off.`;
    keep("asked", { parsed });
    engine.keepHostNote(`booking-email:cancel:${job.id}`, `Airbnb says the stay checking out ${day} was cancelled, but the calendar still shows it. Should I call off that cleaning?`);
    return done({ outcome: "asked", next, texts, confirmation: desk.issueApproval(job.id, fingerprint, next) });
  }
  if (!desk.redeem(code, job.id, fingerprint)) return { ok: false, error: "That approval is stale. Ask the host again with the new preview." };
  const off = await engine.callOffJob(job.id);
  if (!off.calledOff) {
    keep("disagrees", { parsed });
    return done({ outcome: "disagrees", next: "That cleaning can't be called off now (it's under way, done, or its door code went out), so nothing changed. Tell the host." });
  }
  keep("called-off", { parsed });
  await stayCodeHook().stayCancelled({ jobId: job.id });
  return done({ outcome: "called-off", texts: off.sent.length > 0 ? texts : [], next: "The cleaning is called off." });
}

function done(result: Record<string, unknown>): EmailReply {
  return { ok: true, result };
}

function minutesOf(hm: string): number {
  const [hour = 0, minute = 0] = hm.split(":").map(Number);
  return hour * 60 + minute;
}

/** "11:00 AM" as minutes after midnight. */
function clockMinutes(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(text.trim());
  if (!match) return undefined;
  return ((Number(match[1]) % 12) + (match[3]!.toUpperCase() === "P" ? 12 : 0)) * 60 + Number(match[2]);
}

function clock(minutes: number): string {
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
