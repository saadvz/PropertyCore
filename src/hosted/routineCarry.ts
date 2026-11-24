import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { Tenant, TenantConnection } from "../cleaner-core/hosted/registry";
import { ROUTINE_NAMES } from "../cleaner-core/hosted/tenantEnv";

/**
 * A chat that signs in again gets a new grant, and its alert routine was saved under the old one. When that old
 * grant has ended, the routine moves to the chat's newest live sign-in: same assistant, same address (job), and
 * connected no earlier than the old one. A grant that is still live never gives its routine away, so two chats the
 * host keeps on purpose stay apart. Only /admin's Disconnect deletes a routine without moving it.
 */

/** Where an ended grant's routine went: from the ended grant to its newest live sign-in. */
export interface Carried {
  from: string;
  to: string;
}

/** True when the connection has its own routine: a saved address and key, or a desk that counts it as connected. */
function hasRoutine(h: HostedCleaner, tenant: Tenant, grantId: string, listed: ReadonlySet<string>): boolean {
  if (listed.has(grantId)) return true;
  const saved = h.secrets.connection(tenant.id, grantId);
  return ROUTINE_NAMES.every((name) => Boolean(saved[name]?.trim()));
}

/** The newest live connection that signed in after `from` for the same chat, and has no routine of its own. */
function successor(h: HostedCleaner, tenant: Tenant, from: TenantConnection, live: (grantId: string) => boolean, listed: ReadonlySet<string>): TenantConnection | undefined {
  return tenant.connections
    .filter((c) => c.grantId !== from.grantId && c.assistant === from.assistant && c.job === from.job && live(c.grantId) && c.connectedAt >= from.connectedAt)
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))
    .find((c) => !hasRoutine(h, tenant, c.grantId, listed));
}

/**
 * Copies one connection's saved values to another: the routine address and key, and anything else it saved for
 * itself. Values the new connection already has stay. Makes the new one primary when the old one was.
 */
export function carryConnection(h: HostedCleaner, tenantId: string, from: string, to: string): void {
  const saved = h.secrets.connection(tenantId, from);
  const own = h.secrets.connection(tenantId, to);
  const missing = Object.fromEntries(Object.entries(saved).filter(([name]) => !own[name]?.trim()));
  if (Object.keys(missing).length > 0) h.secrets.setForConnection(tenantId, to, missing);
  const tenant = h.registry.get(tenantId);
  if (tenant?.primaryGrantId === from && tenant.connections.some((c) => c.grantId === to && !c.job)) h.registry.setPrimary(tenantId, to);
}

/**
 * Moves each ended grant's routine to that chat's newest live sign-in. `listed` is every connection a property's desk
 * counts as having connected its routine. Returns what moved, so the caller can tell the desks.
 */
export function carryEndedRoutines(h: HostedCleaner, tenant: Tenant, listed: ReadonlySet<string>): Carried[] {
  const liveIds = h.liveGrantIds?.();
  const live = (grantId: string) => (liveIds ? liveIds.has(grantId) : h.grantLive(grantId));
  const carried: Carried[] = [];
  // Newest ended grant first: its routine is the one the chat used last.
  const ended = tenant.connections.filter((c) => !live(c.grantId) && hasRoutine(h, tenant, c.grantId, listed)).sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  const taken = new Set<string>();
  for (const from of ended) {
    const to = successor(h, tenant, from, live, new Set([...listed, ...taken]));
    if (!to) continue;
    carryConnection(h, tenant.id, from.grantId, to.grantId);
    taken.add(to.grantId);
    carried.push({ from: from.grantId, to: to.grantId });
  }
  if (carried.length > 0) h.log(`Kept ${tenant.id}'s alert routine connected after its chat signed in again.`);
  return carried;
}
