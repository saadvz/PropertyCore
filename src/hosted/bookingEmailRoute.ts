import { normalizeListing, parseAirbnbEmail, redactBookingEmail, type BookingEmailInput } from "../hub/airbnbEmail";
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
export function bookingEmailProperty(dataRoot: string, tenant: Tenant, args: unknown, now: () => Date): { property: Property } | { refusal: string } {
  const email = (args && typeof args === "object" ? (args as { email?: unknown }).email : undefined) as BookingEmailInput | undefined;
  const cleaning = tenant.properties.filter((p) => p.flows.cleaning.on);
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
