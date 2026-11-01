import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../../core/phone";
import { hashSecret } from "../../mcp/oauth/store";
import { writeJsonAtomic } from "../../storage/atomicWrite";
import type { CleanerAssistant } from "../assistant";

/**
 * The hosts a multi-tenant Cleaner Core serves. One small JSON file, read on every call so the
 * admin page and the request path never disagree. Invite codes are kept only as hashes.
 */

export interface TenantConnection {
  grantId: string;
  assistant: CleanerAssistant;
  connectedAt: string;
}

export interface TenantInvite {
  hash: string;
  expiresAt: string;
  usedAt?: string;
}

/** Which service a tenant's number answers for. Unset until the host's chat chooses one. */
export type TenantService = "cleaning" | "touring";

export interface Tenant {
  id: string;
  label: string;
  twilioNumber: string;
  primaryGrantId?: string;
  connections: TenantConnection[];
  invites: TenantInvite[];
  disabled?: boolean;
  service?: TenantService;
  serviceChangedAt?: string;
  createdAt: string;
  lastActivityAt?: string;
}

export type InviteRefusal = "invalid" | "expired" | "used" | "disabled";

export class RegistryError extends Error {
  constructor(readonly reason: "bad-label" | "bad-number" | "number-taken" | "unknown-tenant") {
    super(reason);
    this.name = "RegistryError";
  }
}

interface Doc {
  schemaVersion: 2;
  tenants: Tenant[];
}

const INVITE_MS = 7 * 24 * 60 * 60_000;
const TOUCH_MS = 5 * 60_000;
/** Crockford base32: no I, L, O or U, so a code reads back the same out loud. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const TENANT_ID = /^tnt_[a-z0-9]{10}$/;

export function isTenantId(value: string): boolean {
  return TENANT_ID.test(value);
}

export function tenantFolder(dataRoot: string, id: string): string {
  if (!isTenantId(id)) throw new RegistryError("unknown-tenant");
  return join(dataRoot, "tenants", id);
}

function pick(alphabet: string, length: number): string {
  // 256 is a multiple of 32 and 36 isn't, so reject bytes past the last whole run.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/** Uppercase, spaces and dashes removed. */
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

function newInviteCode(): string {
  const raw = pick(CROCKFORD, 12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export class TenantRegistry {
  private readonly file: string;

  constructor(
    private readonly dataRoot: string,
    private readonly now: () => Date,
  ) {
    this.file = join(dataRoot, "tenants.json");
  }

  private read(): Doc {
    if (!existsSync(this.file)) return { schemaVersion: 2, tenants: [] };
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as { schemaVersion?: number; tenants?: Tenant[] };
    const doc: Doc = { schemaVersion: 2, tenants: Array.isArray(raw.tenants) ? raw.tenants : [] };
    // Version 1 had only Cleaner Core, so every tenant in it is a cleaning tenant. Written back once.
    if (raw.schemaVersion !== 2) {
      for (const tenant of doc.tenants) tenant.service ??= "cleaning";
      this.write(doc);
    }
    return doc;
  }

  private write(doc: Doc): void {
    writeJsonAtomic(this.file, doc);
  }

  /** Reads, changes one tenant, writes. Throws unknown-tenant when it isn't there. */
  private update<T>(id: string, change: (tenant: Tenant) => T): T {
    const doc = this.read();
    const tenant = doc.tenants.find((t) => t.id === id);
    if (!tenant) throw new RegistryError("unknown-tenant");
    const result = change(tenant);
    this.write(doc);
    return result;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private newInvite(tenant: Tenant): string {
    const code = newInviteCode();
    tenant.invites.push({ hash: hashSecret(normalizeCode(code)), expiresAt: new Date(this.now().getTime() + INVITE_MS).toISOString() });
    return code;
  }

  list(): Tenant[] {
    return this.read().tenants;
  }

  get(id: string): Tenant | undefined {
    if (!isTenantId(id)) return undefined;
    return this.read().tenants.find((t) => t.id === id);
  }

  byNumber(raw: string): Tenant | undefined {
    const number = parsePhone(raw);
    if (!number) return undefined;
    return this.read().tenants.find((t) => t.twilioNumber === number);
  }

  create(input: { label: string; twilioNumber: string }): { tenant: Tenant; inviteCode: string } {
    const label = input.label.trim();
    if (!label) throw new RegistryError("bad-label");
    const number = parsePhone(input.twilioNumber);
    if (!number) throw new RegistryError("bad-number");
    const doc = this.read();
    if (doc.tenants.some((t) => t.twilioNumber === number)) throw new RegistryError("number-taken");
    let id = `tnt_${pick(ID_CHARS, 10)}`;
    while (doc.tenants.some((t) => t.id === id)) id = `tnt_${pick(ID_CHARS, 10)}`;
    const tenant: Tenant = { id, label, twilioNumber: number, connections: [], invites: [], createdAt: this.stamp() };
    const inviteCode = this.newInvite(tenant);
    doc.tenants.push(tenant);
    this.write(doc);
    return { tenant, inviteCode };
  }

  invite(id: string): string {
    return this.update(id, (tenant) => this.newInvite(tenant));
  }

  /** Uses the invite up when it is good. Each refusal says why. */
  claimInvite(code: string): { tenantId: string } | { refused: InviteRefusal } {
    const normalized = normalizeCode(code);
    if (!normalized) return { refused: "invalid" };
    const hash = hashSecret(normalized);
    const doc = this.read();
    for (const tenant of doc.tenants) {
      const invite = tenant.invites.find((i) => i.hash === hash);
      if (!invite) continue;
      if (invite.usedAt) return { refused: "used" };
      if (Date.parse(invite.expiresAt) <= this.now().getTime()) return { refused: "expired" };
      if (tenant.disabled) return { refused: "disabled" };
      invite.usedAt = this.stamp();
      this.write(doc);
      return { tenantId: tenant.id };
    }
    return { refused: "invalid" };
  }

  connect(tenantId: string, connection: TenantConnection): void {
    this.update(tenantId, (tenant) => {
      tenant.connections = [...tenant.connections.filter((c) => c.grantId !== connection.grantId), connection];
      tenant.primaryGrantId ??= connection.grantId;
    });
  }

  disconnect(tenantId: string, grantId: string): void {
    this.update(tenantId, (tenant) => {
      tenant.connections = tenant.connections.filter((c) => c.grantId !== grantId);
      if (tenant.primaryGrantId === grantId) {
        const next = oldest(tenant.connections);
        if (next) tenant.primaryGrantId = next.grantId;
        else delete tenant.primaryGrantId;
      }
    });
  }

  setPrimary(tenantId: string, grantId: string): void {
    this.update(tenantId, (tenant) => {
      if (!tenant.connections.some((c) => c.grantId === grantId)) throw new RegistryError("unknown-tenant");
      tenant.primaryGrantId = grantId;
    });
  }

  /** The primary connection, or the oldest live one when the primary's grant is gone. */
  primary(tenantId: string, isLive: (grantId: string) => boolean): TenantConnection | undefined {
    const tenant = this.get(tenantId);
    if (!tenant) return undefined;
    const chosen = tenant.connections.find((c) => c.grantId === tenant.primaryGrantId);
    if (chosen && isLive(chosen.grantId)) return chosen;
    return oldest(tenant.connections.filter((c) => isLive(c.grantId)));
  }

  setService(id: string, service: TenantService): void {
    this.update(id, (tenant) => {
      tenant.service = service;
      tenant.serviceChangedAt = this.stamp();
    });
  }

  setDisabled(id: string, disabled: boolean): void {
    this.update(id, (tenant) => {
      if (disabled) tenant.disabled = true;
      else delete tenant.disabled;
    });
  }

  remove(id: string): Tenant | undefined {
    const doc = this.read();
    const tenant = doc.tenants.find((t) => t.id === id);
    if (!tenant) return undefined;
    doc.tenants = doc.tenants.filter((t) => t.id !== id);
    this.write(doc);
    return tenant;
  }

  /** Last activity, written at most every 5 minutes. */
  touch(id: string): void {
    const tenant = this.get(id);
    if (!tenant) return;
    const last = tenant.lastActivityAt ? Date.parse(tenant.lastActivityAt) : 0;
    if (this.now().getTime() - last < TOUCH_MS) return;
    this.update(id, (t) => void (t.lastActivityAt = this.stamp()));
  }
}

function oldest(connections: TenantConnection[]): TenantConnection | undefined {
  return [...connections].sort((a, b) => Date.parse(a.connectedAt) - Date.parse(b.connectedAt))[0];
}
