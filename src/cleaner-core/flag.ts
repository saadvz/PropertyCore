/** Off unless CLEANER_CORE_ENABLED is exactly "1" or "true". */
export function cleanerCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** On unless CLEANER_CORE_GROUP_CHAT is exactly "0" or "false". */
export function groupChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_GROUP_CHAT?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** One service, many hosts. Off unless CLEANER_CORE_MULTI_TENANT is exactly "1" or "true". */
export function cleanerMultiTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_MULTI_TENANT?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** Touring tenants on the multi-tenant service. Off unless TOUR_CORE_TENANTS is exactly "1" or "true". */
export function tourCoreTenants(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TOUR_CORE_TENANTS?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
