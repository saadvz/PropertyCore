import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { isScratchTestNumber } from "../cleaner-core/scratch";
import { SCRATCH_NUMBER_REFUSAL, SCRATCH_TEST_WENT_THROUGH, SCRATCH_TEXT_NEEDED } from "../cleaner-core/scratchQa";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { screenText } from "./crossService";
import { deliverText } from "./touringForward";

/**
 * Scratch QA for a touring tenant on a 555 number, with CLEANER_CORE_SCRATCH_TOOLS on, the same tools
 * Cleaner Core's Scratch property has: send a test visitor text down the real path, and read the texts
 * in and out. The touring process keeps its outbox in its folder; the service keeps the inbox.
 */

/** Where a Scratch touring process keeps its local outbox, inside its own folder. */
export const SCRATCH_OUTBOX_FILE = "scratch-outbox.json";

const inboxFile = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), "scratch-inbox.json");

/** Notes a test text the touring process took. */
export function recordScratchText(h: HostedCleaner, tenantId: string, from: string, text: string): void {
  const texts = readScratchInbox(h, tenantId);
  writeJsonAtomic(inboxFile(h, tenantId), { texts: [...texts, { from, text }] });
}

export function readScratchInbox(h: HostedCleaner, tenantId: string): { from: string; text: string }[] {
  const file = inboxFile(h, tenantId);
  if (!existsSync(file)) return [];
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { texts?: { from: string; text: string }[] }).texts ?? [];
  } catch {
    return [];
  }
}

export function readScratchOutbox(h: HostedCleaner, tenantId: string): { to: string; text: string }[] {
  const file = join(tenantFolder(h.dataRoot, tenantId), "tour-core", SCRATCH_OUTBOX_FILE);
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { bubbles?: { to: string; body: string; audience: string }[] };
    return (doc.bubbles ?? []).filter((bubble) => bubble.audience === "PROSPECT").map((bubble) => ({ to: bubble.to, text: bubble.body }));
  } catch {
    return [];
  }
}

/** A test visitor text, down the same path as a real one: the service's checks, then the touring process. */
export async function sendScratchText(h: HostedCleaner, tenant: Tenant, input: { from: string; text: string }): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  if (!isScratchTestNumber(input.from)) return { ok: false, text: SCRATCH_NUMBER_REFUSAL };
  const text = input.text.trim();
  if (!text) return { ok: false, text: SCRATCH_TEXT_NEEDED };
  const fields = { MessageSid: `SMscratch${randomUUID().replace(/-/g, "")}`, From: input.from, To: tenant.twilioNumber, Body: text };
  if ((await screenText(h, tenant, fields)) === "drop") return { ok: true, text: SCRATCH_TEST_WENT_THROUGH };
  const target = h.touring?.supervisor.target(tenant.id);
  const raw = Buffer.from(new URLSearchParams(fields).toString());
  if (!target || !(await deliverText(target, h.origin() ?? "", tenant.id, raw, h.touring?.authToken() ?? "", { scratch: true }))) {
    return { ok: false, text: "Touring isn't answering right now. Try again in a minute." };
  }
  recordScratchText(h, tenant.id, input.from, text);
  return { ok: true, text: SCRATCH_TEST_WENT_THROUGH };
}
