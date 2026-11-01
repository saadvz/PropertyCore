import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleaningUpdateEvent } from "../alerts/operatorEvents";
import { parsePhone } from "../core/phone";
import { tenantFolder, type Tenant, type TenantService } from "../cleaner-core/hosted/registry";
import { tenantContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { isMedicalEmergency, isPlainLanguageStop, keywordOf } from "../intent/ruleBased";
import { isInjuryReport } from "../cleaner-core/injury";
import { normalize } from "../intent/normalize";
import { PropertyWorkspace } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { touringSinkFor } from "./touringAlerts";

/**
 * Rules that hold for a number whatever service it runs. A phone that texted STOP stays opted out of
 * both services until it texts START; each service still handles the STOP itself. A phone the
 * inactive service knows (its host, cleaner, or past visitors) gets no reply from the active one, and
 * the host is told once.
 */

/** STOP, as both services read it, except a bare "cancel": on touring that cancels a tour. */
export function isStopText(text: string): boolean {
  if (normalize(text) === "cancel") return false;
  return keywordOf(text) === "stop" || isPlainLanguageStop(text);
}

/** START, and YES, which Twilio also takes as an opt-in. Each service still decides what a YES means to it. */
export function isStartText(text: string): boolean {
  return keywordOf(text) === "start" || normalize(text) === "yes";
}

/** Each tenant's opted-out phones, as E.164, in its folder. */
export class TenantOptOuts {
  constructor(private readonly dataRoot: string) {}

  private file(tenantId: string): string {
    return join(tenantFolder(this.dataRoot, tenantId), "opt-outs.json");
  }

  private read(tenantId: string): string[] {
    const file = this.file(tenantId);
    if (!existsSync(file)) return [];
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { phones?: string[] };
      return Array.isArray(doc.phones) ? doc.phones : [];
    } catch {
      return [];
    }
  }

  stop(tenantId: string, raw: string): void {
    const phone = parsePhone(raw);
    if (!phone) return;
    const phones = this.read(tenantId);
    if (!phones.includes(phone)) writeJsonAtomic(this.file(tenantId), { phones: [...phones, phone] });
  }

  start(tenantId: string, raw: string): void {
    const phone = parsePhone(raw);
    if (!phone) return;
    const phones = this.read(tenantId);
    if (phones.includes(phone)) writeJsonAtomic(this.file(tenantId), { phones: phones.filter((p) => p !== phone) });
  }

  stopped(tenantId: string, raw: string): boolean {
    const phone = parsePhone(raw);
    return !!phone && this.read(tenantId).includes(phone);
  }
}

/** The host, cleaner, observer, and contacts the tenant's cleaning setup saved. */
function knownToCleaning(h: HostedCleaner, tenant: Tenant, phone: string): Promise<boolean> {
  const ctx = tenantContext(h, tenant);
  if (!existsSync(ctx.root)) return Promise.resolve(false);
  return liveDeskFor(ctx.root, ctx.env, () => h.now()).knownPhones().then((phones) => phones.includes(phone));
}

/** Visitors in the tenant's touring records. Read from its folder: its process doesn't run while touring is off. */
function knownToTouring(h: HostedCleaner, tenant: Tenant, phone: string): boolean {
  const root = join(tenantFolder(h.dataRoot, tenant.id), "tour-core");
  if (!existsSync(root)) return false;
  try {
    const ws = new PropertyWorkspace(root);
    return ws.list().some(({ config }) => ws.listTours(config.property.id).some((tour) => parsePhone(tour.visitorPhone ?? "") === phone));
  } catch {
    return false;
  }
}

const NOTICE = (inactive: TenantService, active: TenantService) => `Someone from your ${inactive} setup texted this number, which is set up for ${active} now. They didn't get a reply.`;

/** Notes for a touring tenant's host that the shared service keeps and adds to touring's get_state. */
export class ServiceNotices {
  constructor(private readonly dataRoot: string) {}

  private file(tenantId: string): string {
    return join(tenantFolder(this.dataRoot, tenantId), "service-notices.json");
  }

  private read(tenantId: string): { notices: string[]; told: string[] } {
    const file = this.file(tenantId);
    if (!existsSync(file)) return { notices: [], told: [] };
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { notices?: string[]; told?: string[] };
      return { notices: doc.notices ?? [], told: doc.told ?? [] };
    } catch {
      return { notices: [], told: [] };
    }
  }

  /** True the first time `key` is told; false after. */
  tellOnce(tenantId: string, key: string, notice?: string): boolean {
    const doc = this.read(tenantId);
    if (doc.told.includes(key)) return false;
    writeJsonAtomic(this.file(tenantId), { notices: notice ? [...doc.notices, notice] : doc.notices, told: [...doc.told, key] });
    return true;
  }

  /** The notes not shown yet. Taking them clears them. */
  take(tenantId: string): string[] {
    const doc = this.read(tenantId);
    if (doc.notices.length === 0) return [];
    writeJsonAtomic(this.file(tenantId), { notices: [], told: doc.told });
    return doc.notices;
  }
}

/**
 * Decides whether a text for this tenant goes to its active service. Call it only after the Twilio
 * signature was checked. Delivery callbacks always go through.
 */
export async function screenText(h: HostedCleaner, tenant: Tenant, fields: Record<string, string>): Promise<"route" | "drop"> {
  const active = tenant.service;
  const from = parsePhone(fields.From ?? "");
  const isMessage = typeof fields.Body === "string" && !fields.MessageStatus;
  if (!active || !from || !isMessage) return "route";
  const optOuts = new TenantOptOuts(h.dataRoot);
  const body = fields.Body ?? "";
  // HELP and anything that sounds like an injury always reach the service, whoever sends them:
  // each service answers those itself, including the 911 path.
  if (keywordOf(body) === "help" || isInjuryReport(body) || isMedicalEmergency(body)) return "route";
  if (isStopText(body)) {
    optOuts.stop(tenant.id, from);
    return "route";
  }
  if (isStartText(body)) {
    optOuts.start(tenant.id, from);
    return "route";
  }
  if (optOuts.stopped(tenant.id, from)) {
    h.log(`A text reached ${tenant.id} from a phone that opted out. Nothing was sent.`);
    return "drop";
  }
  const inactive: TenantService = active === "touring" ? "cleaning" : "touring";
  const known = inactive === "cleaning" ? await knownToCleaning(h, tenant, from) : knownToTouring(h, tenant, from);
  if (!known) return "route";
  h.log(`A text reached ${tenant.id} from someone in its ${inactive} setup. Nothing was sent.`);
  await tellHost(h, tenant, inactive, active, from);
  return "drop";
}

/** One note per phone for each time the number's service was set. */
async function tellHost(h: HostedCleaner, tenant: Tenant, inactive: TenantService, active: TenantService, phone: string): Promise<void> {
  const key = createHash("sha256").update(`${tenant.serviceChangedAt ?? ""}|${phone}`).digest("hex").slice(0, 24);
  const notice = NOTICE(inactive, active);
  if (active === "cleaning") {
    const ctx = tenantContext(h, tenant);
    if (!new ServiceNotices(h.dataRoot).tellOnce(tenant.id, key)) return;
    await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteForHost(`service:${key}`, notice);
    return;
  }
  if (!new ServiceNotices(h.dataRoot).tellOnce(tenant.id, key, notice)) return;
  // The wake carries no words; the host's chat reads the note from get_state.
  await touringSinkFor(h, tenant)
    .deliver(cleaningUpdateEvent(h.now()))
    .catch(() => undefined);
}
