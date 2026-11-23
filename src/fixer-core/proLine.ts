import type { Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { People } from "../hub/people";
import { liveBooking } from "./gate";
import type { FixerFile, Job } from "./store";

/**
 * Pros on the shared text line. A pro's text never approves, books or changes anything but their own
 * job's done and price; the desk's `proInbound` does the work, this file only picks who it is for.
 */

/** True when the phone is the host of any of the account's properties, or holds a role other than pro on any of them. */
export function holdsOtherRole(people: Pick<People, "person" | "isHost">, phone: string): boolean {
  return people.isHost(phone) || (people.person(phone)?.where.some((w) => w.role !== "pro") ?? false);
}

/**
 * The properties with Fixer Core on where `from` is a pro, or undefined. A person who holds any other
 * role on any of the account's properties (cleaner, co-host, assistant, observer, or the host) stays
 * with Cleaner Core, and Fixer Core reaches them by the visit page only.
 */
export function proRoute(tenant: Pick<Tenant, "properties">, people: Pick<People, "rolesOn" | "person" | "isHost">, from: string): Property[] | undefined {
  if (!from || holdsOtherRole(people, from)) return undefined;
  const mine = tenant.properties.filter((p) => p.flows.fixer.on && people.rolesOn(from, p.id).includes("pro"));
  return mine.length > 0 ? mine : undefined;
}

/**
 * The properties with Fixer Core on where `from` is a pro and also holds another role on the account (the cleaner
 * who is also the handyman), or undefined. Never the host. Their texts stay with Cleaner Core unless Fixer Core is
 * the one waiting on them (`proWaitingJob`); the line router decides.
 */
export function alsoProRoute(tenant: Pick<Tenant, "properties">, people: Pick<People, "rolesOn" | "person" | "isHost">, from: string): Property[] | undefined {
  if (!from || people.isHost(from) || !holdsOtherRole(people, from)) return undefined;
  const mine = tenant.properties.filter((p) => p.flows.fixer.on && people.rolesOn(from, p.id).includes("pro"));
  return mine.length > 0 ? mine : undefined;
}

/** How long after a visit's end a text from its pro is still taken as about it. */
const AFTER_VISIT_MS = 12 * 60 * 60_000;

/**
 * The visit Fixer Core is waiting on `phone` for, earliest first: a routine vendor's proposed or upcoming visit (a YES
 * or a new time), or a booked visit that has started and isn't more than 12 hours past its end (a DONE or a price).
 * Undefined when Fixer Core isn't waiting on them.
 */
export function proWaitingJob(file: FixerFile | undefined, phone: string, now: number): Job | undefined {
  const pro = file?.pros.find((entry) => entry.status === "saved" && entry.reach.phone === phone);
  if (!file || !pro || !file.settings.activatedAt || file.offAt) return undefined;
  return file.jobs
    .filter((job) => {
      const booking = job.booking;
      if (!booking || booking.proId !== pro.id || !booking.hostYes || !liveBooking(job) || job.done) return false;
      const end = Date.parse(booking.extendedUntil ?? booking.until);
      if (booking.vendor && now < end) return true;
      return (job.state === "in-progress" || now >= Date.parse(booking.from)) && now < end + AFTER_VISIT_MS;
    })
    .sort((a, b) => Date.parse(a.booking!.from) - Date.parse(b.booking!.from))[0];
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
