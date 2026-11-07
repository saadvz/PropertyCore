import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../core/phone";
import type { Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { peopleFor, type MoveSource, type People } from "../hub/people";
import { TenantOptOuts } from "./crossService";
import { sharedRefusal } from "./sharedRoute";

/**
 * The hosted side of an account's people (saadvz/TourCore#190): the one-time move from the older files,
 * the host's shared: true when a saved phone is already on another property, and the account list
 * kept in step with each property's saved people. Desks tell each other about a YES or STOP themselves.
 */

/** The account's people list, moved from the older files first if it hasn't been yet. */
export async function accountPeople(h: HostedCleaner, tenant: Tenant): Promise<People> {
  const people = peopleFor(tenantFolder(h.dataRoot, tenant.id), { now: () => h.now() });
  if (!people.moved()) await movePeople(h, tenant, people);
  return people;
}

/** Builds people.json from each property's saved people and consent, and the line's older STOP list. */
export async function movePeople(h: HostedCleaner, tenant: Tenant, people = peopleFor(tenantFolder(h.dataRoot, tenant.id), { now: () => h.now() })): Promise<void> {
  if (people.moved()) return;
  const sources: MoveSource[] = [];
  for (const property of tenant.properties) {
    const ctx = propertyContext(h, tenant, property);
    if (!existsSync(join(ctx.root, "cleaner-live.json"))) continue;
    sources.push({ ...(await liveDeskFor(ctx.root, ctx.env, () => h.now()).moveSource()), propertyId: property.id });
  }
  sources.push({ propertyId: "", people: [], stopped: new TenantOptOuts(h.dataRoot).phones(tenant.id), optedIn: [], optedOut: [] });
  people.move(sources);
}

const phoneOf = (raw: unknown) => (typeof raw === "string" ? parsePhone(raw) : undefined);

/** The landlord's phone as a person, or a person's phone as the host: refused even with shared: true. */
const hostIsPerson = (label: string) => `That number is the host's on ${label}. The host's phone can't also be a cleaner or contact.`;
const personIsHost = (label: string, role: string) => `That number is already on ${label} as the ${role}. A cleaner's or contact's phone can't be the host.`;

/**
 * Before save_people: a phone already on another of the account's properties needs the host's
 * shared: true. The refusal goes to the agent only. Nobody is texted.
 */
export async function peopleRefusal(h: HostedCleaner, tenant: Tenant, property: Property, args: Record<string, unknown>): Promise<string | undefined> {
  const people = await accountPeople(h, tenant);
  const contacts = Array.isArray(args.contacts) ? (args.contacts as { phone?: unknown }[]).map((c) => phoneOf(c?.phone)) : [];
  const saved = [...new Set([phoneOf(args.cleaner), phoneOf(args.observer), ...contacts].filter((p): p is string => !!p))];
  const host = phoneOf(args.host);
  const others = tenant.properties.filter((p) => p.id !== property.id);
  const label = (id: string) => others.find((p) => p.id === id)?.label;
  for (const other of others) {
    const otherHost = people.hostOf(other.id);
    if (otherHost && saved.includes(otherHost)) return hostIsPerson(other.label);
  }
  if (host) {
    for (const id of people.propertiesOf(host)) {
      const name = label(id);
      if (name) return personIsHost(name, people.roleOn(host, id) ?? "cleaner");
    }
  }
  if (args.shared === true) return undefined;
  const places = saved.flatMap((phone) =>
    people.propertiesOf(phone).flatMap((id) => {
      const name = label(id);
      return name ? [{ label: name, role: people.roleOn(phone, id) ?? "cleaner" }] : [];
    }),
  );
  return places.length > 0 ? sharedRefusal(places) : undefined;
}

/**
 * After save_people: the account list takes this property's people and host. Anyone who already said
 * YES or STOP on the account has it applied here too. A phone on the line's older STOP list stays stopped.
 */
export async function afterPeopleSaved(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void> {
  const people = await accountPeople(h, tenant);
  const ctx = propertyContext(h, tenant, property);
  const desk = liveDeskFor(ctx.root, ctx.env, () => h.now());
  const source = await desk.moveSource();
  people.savePropertyPeople(property.id, source.host, source.people);
  const older = new TenantOptOuts(h.dataRoot);
  // The landlord's line STOP holds on a property that saves them later, as before.
  if (source.host && older.stopped(tenant.id, source.host)) await desk.markHostOptedOut(source.host);
  for (const person of source.people) {
    if (older.stopped(tenant.id, person.phone)) people.stop(person.phone);
    if (people.stopped(person.phone)) await desk.accountStop(person.phone);
    else if (people.optedIn(person.phone)) await desk.accountOptIn(person.phone);
  }
}
