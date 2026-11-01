import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { PER_TENANT_NAMES } from "../cleaner-core/hosted/tenantEnv";
import { isScratchTestNumber } from "../cleaner-core/scratch";
import { CLEANER_TWILIO_PATH } from "../cleaner-core/twilioHook";

/** Cleaner Core names a touring process still needs: the service-wide live switch, allowlist, and Scratch flag. */
const SHARED_CLEANER_NAMES = new Set(["CLEANER_CORE_LIVE_SMS", "CLEANER_CORE_SMS_ALLOWLIST", "CLEANER_CORE_SCRATCH_TOOLS"]);

/**
 * A touring process's environment: the service's environment with every Tour Core setting, every
 * Cleaner Core secret, and every per-tenant value taken out, then this tenant's folder, number,
 * links under /t/<id>, and key. The shared Twilio account goes in under Tour Core's names.
 */
export function buildTouringEnv(input: { base: NodeJS.ProcessEnv; tenant: Tenant; dataRoot: string; origin: string; key: string; scratch: boolean }): NodeJS.ProcessEnv {
  const { base, tenant } = input;
  const env: NodeJS.ProcessEnv = {};
  const dropped = new Set<string>(PER_TENANT_NAMES);
  for (const [name, value] of Object.entries(base)) {
    if (dropped.has(name) || name.startsWith("TOURCORE_")) continue;
    if (name.startsWith("CLEANER_CORE_") && !SHARED_CLEANER_NAMES.has(name)) continue;
    env[name] = value;
  }
  env.TOURCORE_DEPLOYMENT_MODE = "TENANT_WORKER";
  env.TOURCORE_HOME = `${tenantFolder(input.dataRoot, tenant.id)}/tour-core`;
  env.TOURCORE_WORKER_KEY = input.key;
  env.PUBLIC_BASE_URL = `${input.origin.replace(/\/+$/, "")}/t/${tenant.id}`;
  if (input.scratch) {
    // A Scratch tenant's texts stay in the local outbox. No Twilio account reaches it.
    env.TOURCORE_MESSAGING_PROVIDER = "local";
    env.TOURCORE_TOURING_SCRATCH = "1";
    env.TOURCORE_LOCAL_FROM_NUMBER = tenant.twilioNumber;
    return env;
  }
  env.TOURCORE_MESSAGING_PROVIDER = "twilio";
  env.TOURCORE_TWILIO_PHONE_NUMBER = tenant.twilioNumber;
  // The number's texts come to the shared service, which hands them on. Setup checks that address, never its own.
  env.TOURCORE_TWILIO_INCOMING_URL = `${input.origin.replace(/\/+$/, "")}${CLEANER_TWILIO_PATH}`;
  if (base.CLEANER_CORE_TWILIO_ACCOUNT_SID) env.TOURCORE_TWILIO_ACCOUNT_SID = base.CLEANER_CORE_TWILIO_ACCOUNT_SID;
  if (base.CLEANER_CORE_TWILIO_AUTH_TOKEN) env.TOURCORE_TWILIO_AUTH_TOKEN = base.CLEANER_CORE_TWILIO_AUTH_TOKEN;
  return env;
}

/** A tenant on a 555 number is Scratch: its touring texts stay in the local test outbox. */
export function touringScratch(tenant: Tenant): boolean {
  return isScratchTestNumber(tenant.twilioNumber);
}
