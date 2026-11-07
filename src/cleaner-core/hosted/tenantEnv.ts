import { parsePhone } from "../../core/phone";
import { propertyBasePath, type Property } from "./properties";
import type { Tenant, TenantConnection } from "./registry";
import type { TenantSecrets } from "./tenantSecrets";

/**
 * Names that belong to one tenant. The process environment's values for these never reach a desk:
 * each desk gets its own from its tenant.
 */
export const PER_TENANT_NAMES = [
  "CLEANER_CORE_ROUTINE_URL",
  "CLEANER_CORE_ROUTINE_KEY",
  "CLEANER_CORE_PIN_KEY",
  "CLEANER_CORE_PHOTO_KEY",
  "CLEANER_CORE_TWILIO_PHONE_NUMBER",
  "CLEANER_CORE_SERVICE_LINES",
  "CLEANER_CORE_ASSISTANT",
  "CLEANER_CORE_PRIMARY_CONNECTION",
  "CLEANER_CORE_MCP_TOKEN",
  "TOURING_ROUTINE_URL",
  "TOURING_ROUTINE_KEY",
  "PUBLIC_BASE_URL",
  "CLEANER_CORE_PROPERTY_ID",
  "CLEANER_CORE_PROPERTY_LABEL",
  "CLEANER_CORE_PROPERTY_COUNT",
  "CLEANER_CORE_LANDLORD_PHONE",
] as const;

/** Saved per connection: each connected chat has its own alert routine. */
export const ROUTINE_NAMES = ["CLEANER_CORE_ROUTINE_URL", "CLEANER_CORE_ROUTINE_KEY"] as const;

/**
 * A desk's environment: the shared process values, this tenant's secrets and number, its links
 * under /t/<id>, and the primary connection's assistant and routine.
 */
export function buildTenantEnv(input: {
  base: NodeJS.ProcessEnv;
  tenant: Tenant;
  secrets: TenantSecrets;
  primary: TenantConnection | undefined;
  origin: string;
  /** Every tenant's number on this service. None of them is ever texted, even when any number is allowed. */
  serviceLines?: readonly string[];
  /** The property this desk serves. Its links, id and label. Unset only for account-wide work. */
  property?: Property;
  /** How many properties the account has, so texts to the landlord can name the property. */
  propertyCount?: number;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.base };
  for (const name of PER_TENANT_NAMES) delete env[name];
  const own = input.secrets.tenant(input.tenant.id);
  for (const name of ROUTINE_NAMES) delete own[name];
  Object.assign(env, own);
  env.CLEANER_CORE_TWILIO_PHONE_NUMBER = input.tenant.twilioNumber;
  if (input.serviceLines?.length) env.CLEANER_CORE_SERVICE_LINES = input.serviceLines.join(",");
  // Only the phone the landlord confirmed with a code counts, never a saved secret: the account's texts start from it.
  delete env.CLEANER_CORE_LANDLORD_PHONE;
  const owner = parsePhone(input.tenant.owner?.phoneVerifiedAt ? input.tenant.owner.phone : "");
  if (owner) env.CLEANER_CORE_LANDLORD_PHONE = owner;
  const base = input.property ? propertyBasePath(input.tenant.id, input.property) : `/t/${input.tenant.id}`;
  env.PUBLIC_BASE_URL = `${input.origin.replace(/\/+$/, "")}${base}`;
  if (input.property) {
    env.CLEANER_CORE_PROPERTY_ID = input.property.id;
    env.CLEANER_CORE_PROPERTY_LABEL = input.property.label;
    env.CLEANER_CORE_PROPERTY_COUNT = String(input.propertyCount ?? 1);
  }
  if (input.primary) {
    env.CLEANER_CORE_ASSISTANT = input.primary.assistant;
    env.CLEANER_CORE_PRIMARY_CONNECTION = input.primary.grantId;
    const routine = input.secrets.connection(input.tenant.id, input.primary.grantId);
    for (const name of ROUTINE_NAMES) if (routine[name]) env[name] = routine[name];
  }
  return env;
}
