/** True when a flag's value is "1" or "true", ignoring case and surrounding spaces. */
export function isOn(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** Off unless CLEANER_CORE_ENABLED is exactly "1" or "true". */
export function cleanerCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.CLEANER_CORE_ENABLED);
}

/** On unless CLEANER_CORE_GROUP_CHAT is exactly "0" or "false". */
export function groupChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_GROUP_CHAT?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** One service, many hosts. Off unless CLEANER_CORE_MULTI_TENANT is exactly "1" or "true". */
export function cleanerMultiTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.CLEANER_CORE_MULTI_TENANT);
}

/** Supply Core as a service choice on the multi-tenant service. Off unless SUPPLY_CORE is exactly "1" or "true". */
export function supplyCoreOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.SUPPLY_CORE);
}

/** Touring tenants on the multi-tenant service. Off unless TOUR_CORE_TENANTS is exactly "1" or "true". */
export function tourCoreTenants(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.TOUR_CORE_TENANTS);
}
