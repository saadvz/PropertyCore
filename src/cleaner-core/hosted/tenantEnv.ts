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
  "CLEANER_CORE_ASSISTANT",
  "CLEANER_CORE_PRIMARY_CONNECTION",
  "CLEANER_CORE_MCP_TOKEN",
  "TOURING_ROUTINE_URL",
  "TOURING_ROUTINE_KEY",
  "PUBLIC_BASE_URL",
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
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.base };
  for (const name of PER_TENANT_NAMES) delete env[name];
  const own = input.secrets.tenant(input.tenant.id);
  for (const name of ROUTINE_NAMES) delete own[name];
  Object.assign(env, own);
  env.CLEANER_CORE_TWILIO_PHONE_NUMBER = input.tenant.twilioNumber;
  env.PUBLIC_BASE_URL = `${input.origin.replace(/\/+$/, "")}/t/${input.tenant.id}`;
  if (input.primary) {
    env.CLEANER_CORE_ASSISTANT = input.primary.assistant;
    env.CLEANER_CORE_PRIMARY_CONNECTION = input.primary.grantId;
    const routine = input.secrets.connection(input.tenant.id, input.primary.grantId);
    for (const name of ROUTINE_NAMES) if (routine[name]) env[name] = routine[name];
  }
  return env;
}
