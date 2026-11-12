import { VOICE_TRANSCRIPT_PATH } from "./voicePaths";
import { fixerCoreOn } from "../cleaner-core/flag";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner, HostedRequest } from "../cleaner-core/hosted/router";
import { parsePhone } from "../core/phone";
import { proRoute } from "../fixer-core/proLine";
import type { People } from "../hub/people";
import { formParams, verifyTwilioSignature } from "../messaging/twilio/signature";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { isLandlord } from "./lineRouter";
import { accountPeople } from "./sharedPeople";
import { VoiceDeletes } from "./voiceDeletes";
import { deleteRecording } from "../cleaner-core/hosted/twilioNumbers";
import { fixerProVoicemail } from "./fixer";
import { propertyContext } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import type { Property } from "../cleaner-core/hosted/properties";
import { redactDigits } from "../fixer-core/desk";
import { proVoicemailNews } from "../fixer-core/texts";
/**
 * Calls to an account's line: a known caller leaves a voicemail, Twilio transcribes it, and the
 * transcript becomes news for the host. Nobody else is recorded.
 */

export { VOICE_PATH, VOICE_TRANSCRIPT_PATH } from "./voicePaths";

export const GREETING = "Hi, you've reached the repairs and cleaning line. This call is recorded. Please leave your message after the tone, then hang up.";
export const NO_CALLS = "This number doesn't take calls. Please text it.";
export const LANDLORD_CALL = "This line is for your pros and cleaner. Talk to your assistant in chat.";
/** Recordings a caller may leave on an account's line in an hour. */
export const CALLS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A TwiML reply from fixed parts. No caller's text ever goes into it. */
export function twiml(parts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
}
const say = (text: string) => `<Say>${escape(text)}</Say>`;
/** What a caller hears when nothing is recorded. */
export const noCallsTwiml = () => twiml([say(NO_CALLS), "<Hangup/>"]);

/** Who is calling: a pro on the line, someone saved on one of the account's properties, the landlord, or nobody known. */
export function knownCaller(tenant: Pick<Tenant, "properties">, people: People, from: string): "pro" | "person" | "landlord" | undefined {
  if (!from) return undefined;
  if (isLandlord(tenant as Tenant, people, from)) return "landlord";
  if (proRoute(tenant, people, from)) return "pro";
  // Someone else is recorded only where their message can land: a property running Cleaner Core, in a role that isn't pro.
  const landing = new Set(tenant.properties.filter((p) => p.flows.cleaning.on).map((p) => p.id));
  return people.person(from)?.where.some((w) => w.role !== "pro" && landing.has(w.propertyId)) ? "person" : undefined;
}

/** Recordings per caller on one account in the last hour. Only a hash of the phone and the times are kept. */
export class VoiceCalls {
  private readonly file: string;
  constructor(dir: string, private readonly now: () => Date) {
    this.file = join(dir, "voice-calls.json");
  }

  /** True, and the call is counted, when the caller has fewer than CALLS_PER_HOUR in the last hour. */
  allow(from: string): boolean {
    const key = createHash("sha256").update(from).digest("hex");
    const at = this.now().getTime();
    const all: Record<string, string[]> = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string[]>) : {};
    for (const [phone, times] of Object.entries(all)) {
      const kept = times.filter((t) => at - Date.parse(t) < HOUR_MS);
      if (kept.length > 0) all[phone] = kept;
      else delete all[phone];
    }
    const mine = all[key] ?? [];
    const ok = mine.length < CALLS_PER_HOUR;
    if (ok) all[key] = [...mine, new Date(at).toISOString()];
    writeJsonAtomic(this.file, all);
    return ok;
  }
}

/** A forged request (a bad Twilio signature) is refused before anything is read or kept. */
export function signedCall(h: HostedCleaner, r: HostedRequest, fields: Record<string, string>, signedUrl: string | undefined): boolean {
  const signature = r.req.headers["x-twilio-signature"];
  return verifyTwilioSignature(h.baseEnv().CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim(), signedUrl, fields, Array.isArray(signature) ? signature[0] : signature).ok;
}

/** A call to the account's line: a known caller hears the greeting and leaves a voicemail; nobody else is recorded. */
export async function handleVoiceCall(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rawBody: Buffer, signedUrl: string | undefined): Promise<void> {
  const fields = formParams(rawBody);
  if (!signedCall(h, r, fields, signedUrl)) return r.send(403, "text/plain", "Forbidden");
  // Twilio's request after a recording ends: the call is over. Not a new call, so it isn't greeted or counted.
  if (fields.RecordingSid || fields.RecordingUrl) {
    // Only this request carries the recording's length: kept by its sid until the transcript comes.
    const seconds = Number(fields.RecordingDuration);
    if (/^RE[0-9a-zA-Z]{2,64}$/.test(fields.RecordingSid ?? "") && fields.RecordingDuration !== undefined && Number.isFinite(seconds)) new VoiceLengths(tenantFolder(h.dataRoot, tenant.id)).set(fields.RecordingSid!, seconds);
    return r.send(200, "text/xml", twiml(["<Hangup/>"]));
  }
  // Kept deletes are retried after the caller is answered, so a slow Twilio API never holds up the call.
  const retry = () => void new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id)).retry(h.baseEnv(), (line) => h.log(line)).catch(() => undefined);
  // Voicemail is part of Fixer Core: while FIXER_CORE is off, nobody is recorded.
  if (!fixerCoreOn(h.baseEnv())) {
    r.send(200, "text/xml", noCallsTwiml());
    return retry();
  }
  const from = parsePhone(fields.From ?? "") ?? "";
  const who = knownCaller(tenant, await accountPeople(h, tenant), from);
  h.registry.touch(tenant.id);
  const origin = h.origin();
  if (who === "landlord") r.send(200, "text/xml", twiml([say(LANDLORD_CALL), "<Hangup/>"]));
  else if (!who || !origin || !new VoiceCalls(tenantFolder(h.dataRoot, tenant.id), () => h.now()).allow(from)) r.send(200, "text/xml", noCallsTwiml());
  else {
    const record = `<Record maxLength="120" timeout="5" playBeep="true" transcribe="true" transcribeCallback="${escape(`${origin}${VOICE_TRANSCRIPT_PATH}`)}"/>`;
    r.send(200, "text/xml", twiml([say(GREETING), record, "<Hangup/>"]));
  }
  retry();
}

export interface Voicemail {
  recordingSid: string;
  from: string;
  text: string;
  status: "completed" | "failed";
  seconds?: number;
}

/** Leaves a note for the host through the property's Cleaner Core. False when Cleaner Core doesn't run there. */
export type CleanerNote = (property: Property, id: string, text: string) => Promise<boolean | void>;

const cleanerNote = (h: HostedCleaner, tenant: Tenant): CleanerNote => async (property, id, text) => {
  if (!property.flows.cleaning.on) return false;
  const ctx = propertyContext(h, tenant, property);
  return liveDeskFor(ctx.root, ctx.env, () => h.now()).noteForHost(id, text);
};

/**
 * Where a voicemail goes: a pro's to Fixer Core, as news on their job; someone else saved on a property
 * (cleaner, co-host) to that property's Cleaner Core, as a note for the host. Never anything else.
 */
export async function routeVoicemail(h: HostedCleaner, tenant: Tenant, mail: Voicemail, note: CleanerNote = cleanerNote(h, tenant)): Promise<void> {
  const people = await accountPeople(h, tenant);
  const pros = proRoute(tenant, people, mail.from);
  if (pros) {
    await fixerProVoicemail(h, tenant, pros, { id: mail.recordingSid, from: mail.from, text: mail.text, status: mail.status, ...(mail.seconds !== undefined ? { seconds: mail.seconds } : {}) });
    return;
  }
  const person = people.person(mail.from);
  const property = tenant.properties.find((p) => person?.where.some((w) => w.propertyId === p.id && w.role !== "pro"));
  if (!person || !property) return;
  const words = redactDigits(mail.text).trim().slice(0, 600);
  const short = mail.seconds !== undefined && mail.seconds < 2;
  const text = proVoicemailNews({ proName: person.name ?? "Someone", ...(mail.status === "failed" ? { failed: true } : {}), ...(words && !short ? { text: words } : {}) });
  if ((await note(property, `voicemail:${mail.recordingSid}`, text)) === false) h.log(`A voicemail for ${tenant.id} couldn't be noted: Cleaner Core isn't on or set up at that property.`);
}

/** Twilio's transcript of a voicemail. Always answered 200 once signed, so Twilio doesn't retry it. */
export async function handleVoiceTranscript(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rawBody: Buffer, signedUrl: string | undefined): Promise<void> {
  const fields = formParams(rawBody);
  if (!signedCall(h, r, fields, signedUrl)) return r.send(403, "text/plain", "Forbidden");
  const from = parsePhone(fields.From ?? "") ?? "";
  const recordingSid = fields.RecordingSid ?? "";
  if (from && /^RE[0-9a-zA-Z]{2,64}$/.test(recordingSid)) {
    const kept = new VoiceLengths(tenantFolder(h.dataRoot, tenant.id)).take(recordingSid);
    const seconds = fields.RecordingDuration !== undefined ? Number(fields.RecordingDuration) : (kept ?? Number.NaN);
    await routeVoicemail(h, tenant, {
      recordingSid,
      from,
      text: fields.TranscriptionText ?? "",
      status: fields.TranscriptionStatus === "failed" ? "failed" : "completed",
      ...(Number.isFinite(seconds) ? { seconds } : {}),
    }).catch(() => h.log(`A voicemail for ${tenant.id} couldn't be taken.`));
  }
  // The audio goes once the transcript is in, whatever it said: only the words are kept.
  if (/^RE[0-9a-zA-Z]{2,64}$/.test(recordingSid)) {
    const deletes = new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id));
    await deletes.retry(h.baseEnv(), (line) => h.log(line)).catch(() => undefined);
    await deletes.remove(h.baseEnv(), recordingSid).catch(() => h.log(`A voicemail recording for ${tenant.id} wasn't deleted yet.`));
  }
  r.send(200, "text/xml", twiml([]));
}

/** At startup: tries again each account's voicemail recordings Twilio didn't delete yet. */
export async function retryVoiceDeletes(h: HostedCleaner): Promise<void> {
  for (const tenant of h.registry.list()) await new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id)).retry(h.baseEnv(), (line) => h.log(line)).catch(() => undefined);
}

/**
 * A transcript for a line no live account holds (turned off, or gone, since the call): nothing is
 * routed, but a signed one's recording is still deleted.
 */
export async function dropTranscript(h: HostedCleaner, r: HostedRequest, tenant: Tenant | undefined, rawBody: Buffer, signedUrl: string | undefined): Promise<void> {
  const fields = formParams(rawBody);
  if (!signedCall(h, r, fields, signedUrl)) return r.send(403, "text/plain", "Forbidden");
  const recordingSid = fields.RecordingSid ?? "";
  if (/^RE[0-9a-zA-Z]{2,64}$/.test(recordingSid)) {
    if (tenant) await new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id)).remove(h.baseEnv(), recordingSid).catch(() => undefined);
    else await deleteRecording(h.baseEnv(), recordingSid).catch(() => undefined);
  }
  r.send(200, "text/xml", twiml([]));
}

/** Each recording's length in seconds, by its sid only, from the request Twilio makes when it ends. At most 200 are kept. */
export class VoiceLengths {
  private readonly file: string;
  constructor(dir: string) {
    this.file = join(dir, "voice-lengths.json");
  }

  private read(): Record<string, number> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, number>) : {};
  }

  set(sid: string, seconds: number): void {
    const all = this.read();
    all[sid] = seconds;
    writeJsonAtomic(this.file, Object.fromEntries(Object.entries(all).slice(-200)));
  }

  /** The length kept for the recording, and forgets it. */
  take(sid: string): number | undefined {
    const all = this.read();
    const seconds = all[sid];
    if (seconds === undefined) return undefined;
    delete all[sid];
    writeJsonAtomic(this.file, all);
    return seconds;
  }
}
