import { fromAirbnb, normalizeListing, parseAirbnbEmail, redactBookingEmail, type BookingEmailInput } from "../hub/airbnbEmail";
import { bookingKey } from "../hub/bookingEmails";
import { sourceFor } from "../hub/bookingSources";
import { readBookingEmails, rebuildBookings } from "../hub/bookingEmails";
import { hubFor } from "../hub/hub";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";

/**
 * On an account with several properties, an Airbnb booking email the agent passes without naming a
 * property goes to the one property with Cleaner Core on whose saved listing titles or nickname match
 * the email's listing, or that already took an email for its confirmation code (#244). None, or more
 * than one, and nothing is stored: the host names the property.
 */
export function bookingEmailProperty(dataRoot: string, tenant: Tenant, args: unknown, now: () => Date, platforms = false): { property: Property } | { refusal: string } {
  const email = (args && typeof args === "object" ? (args as { email?: unknown }).email : undefined) as BookingEmailInput | undefined;
  const cleaning = tenant.properties.filter((p) => p.flows.cleaning.on);
  // With the account's booking platforms on (#263), an email from any platform but Airbnb goes to the property that saved its sender.
  if (platforms && email && typeof email.from === "string" && !fromAirbnb(email.from)) return otherPlatformProperty(dataRoot, tenant, cleaning, email, args, now);
  const which = `Which property is this Airbnb email for? Ask the host, then pass property as one of: ${cleaning.map((p) => `${p.id} (${p.label})`).join(", ")}.`;
  if (!email || typeof email.from !== "string" || typeof email.subject !== "string" || typeof email.body !== "string") return { refusal: "Pass the email as from, subject and body (plain text)." };
  // Read with door codes taken out, as the desk does, so a listing echoed in the refusal never carries one.
  const read = parseAirbnbEmail({ ...email, subject: redactBookingEmail(email.subject), body: redactBookingEmail(email.body) }, now());
  // A refusal (not Airbnb, a guest message) is the desk's to say; any property's desk says the same, but none stores it without a property.
  if (!read.ok) return { refusal: which };
  const listing = read.parsed.listing ? normalizeListing(read.parsed.listing) : undefined;
  const code = read.parsed.confirmationCode;
  const matches = cleaning.filter((property) => {
    const root = propertyFolder(dataRoot, tenant.id, property);
    const hub = hubFor(root, { now });
    const names = [...hub.airbnbListings(), ...(hub.property().nickname ? [hub.property().nickname!] : [])].map(normalizeListing).filter(Boolean);
    if (listing && names.includes(listing)) return true;
    return !listing && rebuildBookings(readBookingEmails(root)).has(code);
  });
  if (matches.length === 1) return { property: matches[0]! };
  return { refusal: read.parsed.listing ? `The Airbnb listing "${read.parsed.listing}" ${matches.length > 1 ? "matches more than one property" : "doesn't match a property yet"}. ${which}` : which };
}

/**
 * A booking email from another platform (#263): the one property with Cleaner Core on that saved its
 * sender. When several did (one booking site for several places), the agent's listing picks the one
 * whose saved listing titles or nickname match, else a reference one of them already logged. Otherwise
 * nothing is stored, and the host names the property.
 */
function otherPlatformProperty(dataRoot: string, tenant: Tenant, cleaning: Property[], email: BookingEmailInput, args: unknown, now: () => Date): { property: Property } | { refusal: string } {
  const which = `Which property is this booking email for? Ask the host, then pass property as one of: ${cleaning.map((p) => `${p.id} (${p.label})`).join(", ")}.`;
  const hubOf = (property: Property) => hubFor(propertyFolder(dataRoot, tenant.id, property), { now });
  const saved = cleaning.filter((property) => {
    const source = sourceFor(hubOf(property).bookingSources(), email.from);
    return source !== undefined && source.platform !== "airbnb";
  });
  if (saved.length === 1) return { property: saved[0]! };
  if (saved.length === 0) return { refusal: which };
  const extracted = (args && typeof args === "object" ? (args as { extracted?: unknown }).extracted : undefined) as { listing?: unknown; reference?: unknown } | undefined;
  const listing = typeof extracted?.listing === "string" ? normalizeListing(extracted.listing) : "";
  if (listing) {
    const named = saved.filter((property) => {
      const hub = hubOf(property);
      return [...hub.airbnbListings(), ...(hub.property().nickname ? [hub.property().nickname!] : [])].map(normalizeListing).includes(listing);
    });
    if (named.length === 1) return { property: named[0]! };
  }
  const reference = typeof extracted?.reference === "string" ? extracted.reference : "";
  if (reference) {
    const logged = saved.filter((property) => {
      const platform = sourceFor(hubOf(property).bookingSources(), email.from)!.platform;
      return rebuildBookings(readBookingEmails(propertyFolder(dataRoot, tenant.id, property))).has(bookingKey({ platform, confirmationCode: reference }));
    });
    if (logged.length === 1) return { property: logged[0]! };
  }
  return { refusal: which };
}
