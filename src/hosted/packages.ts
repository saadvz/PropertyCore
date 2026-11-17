import { packageArrivalsOn } from "../cleaner-core/flag";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { packageDeskFor } from "../package-arrivals/desk";
import { handlePackageTool, PACKAGE_TOOL_NAMES, PACKAGE_TOOLS } from "../package-arrivals/tools";
import type { FrontReply } from "./serviceTools";

/**
 * Package arrivals (#241) on the shared service, behind PACKAGE_ARRIVALS=1, answered in this process, for a
 * property that runs Supply Core. It writes only the property's packages.json, and texts nobody.
 */

export const PACKAGE_FRONT_NAMES: ReadonlySet<string> = PACKAGE_TOOL_NAMES;

/** The package tools as tools/list shows them: while the flag is on and any property runs Supply Core. */
export function listedPackageFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!packageArrivalsOn(h.baseEnv()) || !tenant.properties.some((property) => property.flows.supplies.on)) return [];
  return [...PACKAGE_TOOLS];
}

/** Answers one package tool for the property it names. */
export function packageCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!packageArrivalsOn(h.baseEnv())) return { text: "Package arrivals isn't available yet.", isError: true };
  if (!property.flows.supplies.on) return { text: `Supply Core doesn't run at ${property.label}, so it has no expected packages.`, isError: true };
  const desk = packageDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now() });
  return handlePackageTool(desk, name, args) ?? { text: "Package arrivals couldn't answer that.", isError: true };
}
