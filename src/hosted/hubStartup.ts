import { propertyFolder } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { hubFor } from "../hub/hub";

/**
 * Moves every property's details and calendars into its hub.json at startup, before any desk opens,
 * each with its own cleaning switch: when both flows saved calendars, the one in use wins.
 */
export function migrateHubs(dataRoot: string, accounts: readonly Tenant[], now: () => Date): void {
  for (const account of accounts) {
    for (const property of account.properties) {
      hubFor(propertyFolder(dataRoot, account.id, property), { now, migrate: { cleaningInUse: property.flows.cleaning.on } });
    }
  }
}
