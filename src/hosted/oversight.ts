import { featureOn } from "../features/features";
import { propertyBasePath, propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { hubFor } from "../hub/hub";
import { lockAdapter } from "../locks/registry";
import { peopleFor } from "../hub/people";
import { tenantFolder } from "../cleaner-core/hosted/registry";
import { optedInOnProperty, visitCodeDesk, visitCodesAvailable } from "./locks";
import { doorDevices } from "../locks/settings";
import { redactDigitRuns } from "../visits/store";
import { oversightDeskFor, type OversightDesk } from "../oversight/desk";
import { handleOversightTool, OVERSIGHT_TOOL_NAMES, OVERSIGHT_TOOLS } from "../oversight/tools";
import type { FrontReply } from "./serviceTools";

/**
 * Remote oversight's expected visits (#240) on the shared service, behind the account's "oversight" switch, answered in this
 * process. It writes only the property's oversight.json, and texts nobody. It reads the property's visit log:
 * unlocks only on a property switched to connected locks (#180), camera sightings only with the account's cameras on (#239).
 * The host-alert clock (src/hosted/hostAlerts.ts, #250) sends the same-day flag.
 */

export const OVERSIGHT_FRONT_NAMES: ReadonlySet<string> = OVERSIGHT_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The expected visit tools as tools/list shows them: while the account's switch is on and any property runs a flow. */
export function listedOversightFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!featureOn(tenant, "oversight", h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...OVERSIGHT_TOOLS];
}

/** Answers one expected visit tool for the property it names. */
export function oversightCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!featureOn(tenant, "oversight", h.baseEnv())) return { text: "Expected visits aren't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no expected visits.`, isError: true };
  return handleOversightTool(oversightDeskOf(h, tenant, property), name, args) ?? { text: "Expected visits couldn't answer that.", isError: true };
}

/** The property's expected-visit desk on the service, reading its visit log under the account's switches. */
export function oversightDeskOf(h: HostedCleaner, tenant: Tenant, property: Property, now: () => Date = () => h.now()): OversightDesk {
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const door = () => {
    const ctx = propertyContext(h, tenant, property);
    return hubFor(ctx.root, { now: () => h.now() }).doorAccess(ctx.env);
  };
  const safely = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  return oversightDeskFor(root, {
    now,
    locks: () => featureOn(h.registry.get(tenant.id), "locks", h.baseEnv()) && Boolean(lockAdapter()),
    lockedNow: () => safely(() => door().connected(), false),
    // As the visit log writes a device's name, so a door with digits in its name still matches.
    doors: () => safely(() => doorDevices(door().locks()).map((device) => redactDigitRuns(device.name).trim().slice(0, 80)), []),
    cameras: () => featureOn(h.registry.get(tenant.id), "cameras", h.baseEnv()),
    // Visit codes (#280 17): with the account's locks on and the property on connected locks.
    codes: () => visitCodesAvailable(h, h.registry.get(tenant.id) ?? tenant) && safely(() => door().connected(), false),
    hostPhone: () => safely(() => peopleFor(tenantFolder(h.dataRoot, tenant.id), { now: () => h.now() }).hostOf(property.id), undefined),
    stopped: (phone) => safely(() => peopleFor(tenantFolder(h.dataRoot, tenant.id), { now: () => h.now() }).stopped(phone), true),
    optedInHere: (phone) => safely(() => optedInOnProperty(h, h.registry.get(tenant.id) ?? tenant, property, phone), false),
    codeStatus: (visit) => safely(() => visitCodeDesk(h, h.registry.get(tenant.id) ?? tenant, property).codeStatus(visit), undefined),
    // The host's visit code page lives under this property's path (25 Nov).
    publicBase: () => {
      const origin = h.origin();
      return origin ? `${origin}${propertyBasePath(tenant.id, property)}` : undefined;
    },
  });
}
