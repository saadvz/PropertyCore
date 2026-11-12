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

/** Where every account's line sends its calls. The `To` number picks the account. */
export const VOICE_PATH = "/webhooks/twilio/voice";
/** Where Twilio sends a voicemail's transcript. */
export const VOICE_TRANSCRIPT_PATH = "/webhooks/twilio/voice/transcript";

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
  const ids = new Set(tenant.properties.map((p) => p.id));
  return people.person(from)?.where.some((w) => ids.has(w.propertyId)) ? "person" : undefined;
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
  await new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id)).retry(h.baseEnv()).catch(() => undefined);
  const from = parsePhone(fields.From ?? "") ?? "";
  const who = knownCaller(tenant, await accountPeople(h, tenant), from);
  h.registry.touch(tenant.id);
  if (who === "landlord") return r.send(200, "text/xml", twiml([say(LANDLORD_CALL), "<Hangup/>"]));
  const origin = h.origin();
  if (!who || !origin || !new VoiceCalls(tenantFolder(h.dataRoot, tenant.id), () => h.now()).allow(from)) return r.send(200, "text/xml", noCallsTwiml());
  const record = `<Record maxLength="120" timeout="5" playBeep="true" transcribe="true" transcribeCallback="${escape(`${origin}${VOICE_TRANSCRIPT_PATH}`)}"/>`;
  r.send(200, "text/xml", twiml([say(GREETING), record, "<Hangup/>"]));
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
  if ((await note(property, `voicemail:${mail.recordingSid}`, text)) === false) h.log(`A voicemail reached ${tenant.id} for a property without Cleaner Core.`);
}

/** Twilio's transcript of a voicemail. Always answered 200 once signed, so Twilio doesn't retry it. */
export async function handleVoiceTranscript(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rawBody: Buffer, signedUrl: string | undefined): Promise<void> {
  const fields = formParams(rawBody);
  if (!signedCall(h, r, fields, signedUrl)) return r.send(403, "text/plain", "Forbidden");
  const from = parsePhone(fields.From ?? "") ?? "";
  const recordingSid = fields.RecordingSid ?? "";
  if (from && /^RE[0-9a-zA-Z]{2,64}$/.test(recordingSid)) {
    const seconds = Number(fields.RecordingDuration);
    await routeVoicemail(h, tenant, {
      recordingSid,
      from,
      text: fields.TranscriptionText ?? "",
      status: fields.TranscriptionStatus === "failed" ? "failed" : "completed",
      ...(Number.isFinite(seconds) && fields.RecordingDuration !== undefined ? { seconds } : {}),
    }).catch(() => h.log(`A voicemail for ${tenant.id} couldn't be taken.`));
  }
  // The audio goes once the transcript is in, whatever it said: only the words are kept.
  if (/^RE[0-9a-zA-Z]{2,64}$/.test(recordingSid)) {
    const deletes = new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id));
    await deletes.retry(h.baseEnv()).catch(() => undefined);
    await deletes.remove(h.baseEnv(), recordingSid).catch(() => h.log(`A voicemail recording for ${tenant.id} wasn't deleted yet.`));
  }
  r.send(200, "text/xml", twiml([]));
}

/** At startup: tries again each account's voicemail recordings Twilio didn't delete yet. */
export async function retryVoiceDeletes(h: HostedCleaner): Promise<void> {
  for (const tenant of h.registry.list()) await new VoiceDeletes(tenantFolder(h.dataRoot, tenant.id)).retry(h.baseEnv()).catch(() => undefined);
}
