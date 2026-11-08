import { randomInt } from "node:crypto";
import { join } from "node:path";
import { tenantFolder, type Tenant } from "./registry";

/**
 * An account's properties. Each one has its own folder, which is the root of an ordinary Cleaner Core
 * and Supply Core desk, and switches each flow on or off on its own.
 */

export type FlowName = "cleaning" | "supplies" | "fixer";

export interface Flow {
  on: boolean;
  changedAt?: string;
}

export interface Property {
  id: string;
  label: string;
  createdAt: string;
  flows: Record<FlowName, Flow>;
  /** The property migrated from a one-property tenant: its links stay under /t/<tenantId>/. */
  legacyPaths?: true;
}

const PROPERTY_ID = /^prp_[a-z0-9]{10}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function isPropertyId(value: string): boolean {
  return PROPERTY_ID.test(value);
}

export function newPropertyId(taken: (id: string) => boolean): string {
  let id: string;
  do id = `prp_${Array.from({ length: 10 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join("")}`;
  while (taken(id));
  return id;
}

/** The migrated property's id: the tenant id's ten characters, so an interrupted migration finds it again. */
export function migratedPropertyId(tenantId: string): string {
  return `prp_${tenantId.slice("tnt_".length)}`;
}

export function propertyFolder(dataRoot: string, tenantId: string, property: Property): string {
  if (!isPropertyId(property.id)) throw new Error("not a property id");
  return join(tenantFolder(dataRoot, tenantId), "properties", property.id);
}

/** Where the property's links live on the service: /t/<id> for the migrated property, else /t/<id>/p/<pid>. */
export function propertyBasePath(tenantId: string, property: Property): string {
  return property.legacyPaths ? `/t/${tenantId}` : `/t/${tenantId}/p/${property.id}`;
}

/** A property by its id, or by a label that matches exactly (any case) and only once on the account. */
export function findProperty(tenant: Tenant, ref: string): Property | undefined {
  const wanted = ref.trim();
  const byId = tenant.properties.find((p) => p.id === wanted);
  if (byId) return byId;
  const matches = tenant.properties.filter((p) => p.label.trim().toLowerCase() === wanted.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}
