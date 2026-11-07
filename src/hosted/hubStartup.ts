import { propertyFolder } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { forgetHub, hubFor } from "../hub/hub";

/**
 * Moves every property's details and calendars into its hub.json at startup, before any desk opens,
 * each with its own cleaning switch: when both flows saved calendars, the one in use wins.
 */
export function migrateHubs(dataRoot: string, accounts: readonly Tenant[], now: () => Date, log: (line: string) => void = () => undefined): void {
  for (const account of accounts) {
    for (const property of account.properties) {
      // One unreadable folder doesn't stop the service: that property fails as before when it opens.
      try {
        hubFor(propertyFolder(dataRoot, account.id, property), { now, migrate: { cleaningInUse: property.flows.cleaning.on } });
      } catch {
        forgetHub(propertyFolder(dataRoot, account.id, property));
        log(`Couldn't move ${account.id}/${property.id} into its hub; it will try again when it opens.`);
      }
    }
  }
}
