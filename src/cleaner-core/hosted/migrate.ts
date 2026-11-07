import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../storage/atomicWrite";
import { migratedPropertyId, type Property } from "./properties";
import { tenantFolder } from "./registry";

/**
 * Moves a version 1 or 2 `tenants.json` to version 3, once, before the service answers anything.
 * Each cleaning or supplies tenant becomes an account with one property, and the property's files
 * move from the tenant's folder into `properties/<pid>/`. Every rename comes first and the registry
 * is written last, so a crash at any point leaves version 2, and the next start finishes the job.
 */

/** What belongs to one property. Everything else in a tenant's folder stays with the account. */
export const PROPERTY_FILES: readonly string[] = [
  "cleaner-live.json",
  "cleaner-job",
  "cleaner-alerts",
  "photos",
  "supply.json",
  "cleaner-approvals.json",
  "cleaner-draft-approvals.json",
  "supply-approvals.json",
  "supply-approvals-front.json",
  "flow-approvals.json",
  "hub.json",
];

export class MigrationError extends Error {
  constructor(
    readonly tenantId: string,
    readonly file: string,
    cause: unknown,
  ) {
    super(`Migration stopped at ${tenantId}/${file}.`, { cause });
    this.name = "MigrationError";
  }
}

type Rename = (from: string, to: string) => void;
let renameOverride: Rename | undefined;

/** Tests make a rename fail. Unset uses the real one. */
export function setMigrationRename(fn: Rename | undefined): void {
  renameOverride = fn;
}

interface OldTenant {
  id: string;
  label: string;
  service?: "cleaning" | "touring" | "supplies";
  supplies?: boolean;
  [key: string]: unknown;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The saved address, else Supply Core's property name, else the account's label. */
function labelOf(folder: string, fallback: string): string {
  const address = readJson(join(folder, "cleaner-live.json"))?.address;
  if (typeof address === "string" && address.trim()) return address.trim();
  const settings = readJson(join(folder, "supply.json"))?.settings as { property?: { name?: unknown } } | undefined;
  const name = settings?.property?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return fallback;
}

export function migrateRegistry(dataRoot: string, now: () => Date, rename: Rename = renameOverride ?? renameSync): { migrated: number } {
  const file = join(dataRoot, "tenants.json");
  if (!existsSync(file)) return { migrated: 0 };
  const raw = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: number; tenants?: OldTenant[] };
  if (raw.schemaVersion === 3) return { migrated: 0 };
  const old = Array.isArray(raw.tenants) ? raw.tenants : [];
  const stamp = now().toISOString();
  let migrated = 0;
  const tenants = old.map((tenant) => {
    // Version 1 had only Cleaner Core, so every tenant in it is a cleaning tenant.
    const service = raw.schemaVersion === 2 ? tenant.service : (tenant.service ?? "cleaning");
    const { supplies, service: _service, ...rest } = tenant;
    if (service === "touring") return { ...rest, service: "touring", properties: [] };
    if (service !== "cleaning" && service !== "supplies") return { ...rest, properties: [] };
    const folder = tenantFolder(dataRoot, tenant.id);
    const id = migratedPropertyId(tenant.id);
    const target = join(folder, "properties", id);
    const label = labelOf(existsSync(join(folder, "cleaner-live.json")) || existsSync(join(folder, "supply.json")) ? folder : target, tenant.label);
    mkdirSync(target, { recursive: true });
    for (const name of PROPERTY_FILES) {
      const from = join(folder, name);
      if (!existsSync(from) || existsSync(join(target, name))) continue;
      try {
        rename(from, join(target, name));
      } catch (err) {
        throw new MigrationError(tenant.id, name, err);
      }
    }
    const property: Property = {
      id,
      label,
      createdAt: stamp,
      legacyPaths: true,
      flows: { cleaning: { on: service === "cleaning" }, supplies: { on: service === "supplies" || supplies === true }, fixer: { on: false } },
    };
    migrated += 1;
    return { ...rest, properties: [property] };
  });
  writeJsonAtomic(file, { schemaVersion: 3, tenants });
  return { migrated };
}
