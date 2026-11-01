import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorEvent, OperatorEventType } from "../alerts/operatorEvents";
import { parsePhone } from "../core/phone";
import type { CleanerAssistant } from "../cleaner-core/assistant";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { tenantContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { sendLiveSms } from "../cleaner-core/liveSms";
import { isScratchTestNumber } from "../cleaner-core/scratch";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { TenantOptOuts } from "./crossService";
import { touringScratch } from "./touringEnv";

/**
 * Texts to a touring host's own phone, from the tenant's number, about the same events their chat
 * hears: urgent ones only, or everything. A text never names a visitor or carries their number, the
 * same as a routine's wake. A Scratch tenant's go to its test outbox instead of a phone.
 */

export type HostTextChoice = "urgent" | "all" | "off";

export interface HostTexts {
  phone?: string;
  which: HostTextChoice;
  /** Event ids already texted, newest last. */
  texted: string[];
  /** When the host's own text to the number last got its one reply. */
  repliedAt?: string;
}

export const HOST_TEXTS_QUESTION = "Want tour updates texted to your phone too?";
export const HOST_TEXT_CHOICES = [
  { label: "Urgent only", which: "urgent" },
  { label: "Everything", which: "all" },
  { label: "No texts", which: "off" },
] as const;

/** Why a text helps on a chat whose task can't be woken. */
const LIMIT: Partial<Record<CleanerAssistant, string>> = {
  chatgpt: "ChatGPT checks for updates at most once an hour, so a text gets you there sooner.",
  muse: "Muse checks for updates as often as you set its task, so a text gets you there sooner.",
};

/** The texts question for this chat, with its limit line and the suggested pick. */
export function hostTextsAsk(assistant: CleanerAssistant): { say: string; choices: typeof HOST_TEXT_CHOICES; suggested: HostTextChoice } {
  const limit = LIMIT[assistant];
  return { say: limit ? `${HOST_TEXTS_QUESTION} ${limit}` : HOST_TEXTS_QUESTION, choices: HOST_TEXT_CHOICES, suggested: limit ? "urgent" : "off" };
}

const URGENT_TIME = "Tour Core: a visitor asked for a tour time. Open your chat to answer.";
const URGENT_ISSUE = "Tour Core: something on a tour needs you. Open your chat.";
const ROUTINE: Partial<Record<OperatorEventType, string>> = {
  "tour.booked": "Tour Core: a tour was booked.",
  "tour.started": "Tour Core: a tour was started.",
  "tour.completed": "Tour Core: a tour was finished.",
  "tour.cancelled": "Tour Core: a tour was cancelled.",
};

/** The text for this event under this choice. Undefined when it isn't texted. */
export function hostTextBody(eventType: OperatorEventType, which: HostTextChoice): string | undefined {
  if (which === "off") return undefined;
  if (eventType === "tour.time_requested") return URGENT_TIME;
  if (eventType === "exception.created" || eventType === "access.problem" || eventType === "verification.problem") return URGENT_ISSUE;
  return which === "all" ? ROUTINE[eventType] : undefined;
}

const file = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), "host-texts.json");
const scratchFile = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), "scratch-host-texts.json");
const TEXTED_KEPT = 500;

export function readHostTexts(h: HostedCleaner, tenantId: string): HostTexts {
  const path = file(h, tenantId);
  if (!existsSync(path)) return { which: "off", texted: [] };
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<HostTexts>;
    return { which: doc.which ?? "off", texted: Array.isArray(doc.texted) ? doc.texted : [], ...(doc.phone ? { phone: doc.phone } : {}), ...(doc.repliedAt ? { repliedAt: doc.repliedAt } : {}) };
  } catch {
    return { which: "off", texted: [] };
  }
}

export function writeHostTexts(h: HostedCleaner, tenantId: string, texts: HostTexts): void {
  writeJsonAtomic(file(h, tenantId), { ...texts, texted: texts.texted.slice(-TEXTED_KEPT) });
}

const PHONE_NEEDED = "Send the host's phone number, like +1 555 555 0123.";

/** Saves the host's choice and phone. A Scratch tenant takes only 555 numbers; a live one never does. */
export function saveHostTexts(h: HostedCleaner, tenant: Tenant, input: { which: HostTextChoice; phone?: string }): { ok: true; text: string } | { ok: false; text: string } {
  const current = readHostTexts(h, tenant.id);
  if (input.which === "off" && !input.phone) {
    writeHostTexts(h, tenant.id, { ...current, which: "off" });
    return { ok: true, text: "No tour updates will be texted to the host." };
  }
  const phone = parsePhone(input.phone ?? "");
  if (!phone) return { ok: false, text: PHONE_NEEDED };
  if (phone === parsePhone(tenant.twilioNumber)) return { ok: false, text: "That's this Tour Core number. Send the host's own phone." };
  const scratch = touringScratch(tenant);
  if (scratch && !isScratchTestNumber(phone)) return { ok: false, text: "This is a test number, so it texts only 555 test numbers." };
  if (!scratch && isScratchTestNumber(phone)) return { ok: false, text: "That's a test number. Send the host's real phone." };
  const changed = phone !== current.phone;
  const { repliedAt: _replied, ...rest } = current;
  writeHostTexts(h, tenant.id, { ...(changed ? rest : current), phone, which: input.which });
  return { ok: true, text: input.which === "off" ? "No tour updates will be texted to the host." : input.which === "all" ? "Every tour update will be texted to the host too." : "Urgent tour updates will be texted to the host too." };
}

/** One text to the host, through the live gates, or into a Scratch tenant's test outbox. Never throws. */
export async function textHost(h: HostedCleaner, tenant: Tenant, to: string, body: string, options: { scratch?: boolean } = {}): Promise<void> {
  if (options.scratch ?? touringScratch(tenant)) {
    writeJsonAtomic(scratchFile(h, tenant.id), { texts: [...readScratchHostTexts(h, tenant.id), { to, text: body }] });
    return;
  }
  const env = tenantContext(h, tenant).env();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sendLiveSms(env, { to, body });
      return;
    } catch {
      // One retry, then it's left: a host text never holds up a tour.
    }
  }
  h.log(`${tenant.id}: a host text didn't go out.`);
}

/** Texts the host about this event when their choice covers it, once per event. Never throws. */
export async function sendHostText(h: HostedCleaner, tenant: Tenant, event: OperatorEvent, options: { scratch?: boolean } = {}): Promise<void> {
  const texts = readHostTexts(h, tenant.id);
  const body = hostTextBody(event.eventType, texts.which);
  if (!body || !texts.phone || texts.texted.includes(event.eventId)) return;
  if (new TenantOptOuts(h.dataRoot).stopped(tenant.id, texts.phone)) return;
  writeHostTexts(h, tenant.id, { ...texts, texted: [...texts.texted, event.eventId] });
  await textHost(h, tenant, texts.phone, body, options);
}

/** A Scratch tenant's host texts, for read_outbox. */
export function readScratchHostTexts(h: HostedCleaner, tenantId: string): { to: string; text: string }[] {
  const path = scratchFile(h, tenantId);
  if (!existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { texts?: { to: string; text: string }[] }).texts ?? [];
  } catch {
    return [];
  }
}
