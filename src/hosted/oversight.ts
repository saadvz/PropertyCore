import { camerasOn, remoteOversightOn } from "../cleaner-core/flag";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { hubFor } from "../hub/hub";
import { lockAdapter, smartLocksOn } from "../locks/registry";
import { doorDevices } from "../locks/settings";
import { redactDigitRuns } from "../visits/store";
import { oversightDeskFor, type OversightDesk } from "../oversight/desk";
import { handleOversightTool, OVERSIGHT_TOOL_NAMES, OVERSIGHT_TOOLS } from "../oversight/tools";
import type { FrontReply } from "./serviceTools";

/**
 * Remote oversight's expected visits (#240) on the shared service, behind REMOTE_OVERSIGHT=1, answered in this
 * process. It writes only the property's oversight.json, and texts nobody. It reads the property's visit log:
 * unlocks only on a property switched to connected locks (#180), camera sightings only with CAMERAS (#239).
 * The host-alert clock (src/hosted/hostAlerts.ts, #250) sends the same-day flag.
 */

export const OVERSIGHT_FRONT_NAMES: ReadonlySet<string> = OVERSIGHT_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The expected visit tools as tools/list shows them: while the flag is on and any property runs a flow. */
export function listedOversightFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!remoteOversightOn(h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...OVERSIGHT_TOOLS];
}

/** Answers one expected visit tool for the property it names. */
export function oversightCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!remoteOversightOn(h.baseEnv())) return { text: "Expected visits aren't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no expected visits.`, isError: true };
  return handleOversightTool(oversightDeskOf(h, tenant, property), name, args) ?? { text: "Expected visits couldn't answer that.", isError: true };
}

/** The property's expected-visit desk on the service, reading its visit log under the flags that are on. */
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
    locks: () => smartLocksOn(h.baseEnv()) && Boolean(lockAdapter()),
    lockedNow: () => safely(() => door().connected(), false),
    // As the visit log writes a device's name, so a door with digits in its name still matches.
    doors: () => safely(() => doorDevices(door().locks()).map((device) => redactDigitRuns(device.name).trim().slice(0, 80)), []),
    cameras: () => camerasOn(h.baseEnv()),
  });
}
