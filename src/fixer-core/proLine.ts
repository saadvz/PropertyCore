import type { Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { People } from "../hub/people";

/**
 * Pros on the shared text line. A pro's text never approves, books or changes anything but their own
 * job's done and price; the desk's `proInbound` does the work, this file only picks who it is for.
 */

/**
 * The properties with Fixer Core on where `from` is a pro, or undefined. A person who holds any other
 * role on any of the account's properties (cleaner, co-host, assistant, observer, or the host) stays
 * with Cleaner Core, and Fixer Core reaches them by the visit page only.
 */
export function proRoute(tenant: Pick<Tenant, "properties">, people: Pick<People, "rolesOn" | "hostOf">, from: string): Property[] | undefined {
  if (!from) return undefined;
  const other = tenant.properties.some((p) => people.hostOf(p.id) === from || people.rolesOn(from, p.id).some((role) => role !== "pro"));
  if (other) return undefined;
  const mine = tenant.properties.filter((p) => p.flows.fixer.on && people.rolesOn(from, p.id).includes("pro"));
  return mine.length > 0 ? mine : undefined;
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*dollars?\b/gi;

/** The one price in a text ($420, $420.50, 420 dollars), in cents. Undefined for no price or for two. */
export function priceCents(text: string): number | undefined {
  const found = [...text.matchAll(MONEY)];
  if (found.length !== 1) return undefined;
  const m = found[0]!;
  const whole = (m[1] ?? m[3])!.replace(/,/g, "");
  const frac = (m[2] ?? m[4] ?? "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac || "0");
  return Number.isSafeInteger(cents) ? cents : undefined;
}
