import { featureOn } from "../features/features";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { parseAirbnbMessage } from "../guest-messages/airbnbMessage";
import { guestDeskFor } from "../guest-messages/desk";
import { GUEST_TOOL_NAMES, GUEST_TOOLS, handleGuestTool } from "../guest-messages/tools";
import { normalizeListing, type BookingEmailInput } from "../hub/airbnbEmail";
import { readBookingEmails, rebuildBookings } from "../hub/bookingEmails";
import { readHubFile } from "../hub/store";
import type { FrontReply } from "./serviceTools";

/**
 * Guest messages (#242) on the shared service, behind the account's "guest-messages" switch, answered in this process. It writes
 * only the property's guest-facts.json, guest-messages.jsonl and guest-approvals.json (and stay-check.json, once, to move an
 * older rules fact onto the one house rules list, #15), and sends nothing to a
 * guest: the host pastes each approved reply into Airbnb. Sending through booking software waits on #239.
 */

export const GUEST_FRONT_NAMES: ReadonlySet<string> = GUEST_TOOL_NAMES;

/** Said on initialize after Property Core's own line, while the account's switch is on. */
export const GUEST_MESSAGES_INSTRUCTION =
  "When the host's email is connected, pass each Airbnb guest-message email to read_guest_message as it arrives, exactly as received, and follow its next. Never pass a reservation email there. Don't ask the host for house facts up front: when a guest asks something nothing saved answers, ask the host, and on their okay keep the answer with save_guest_facts so the next guest gets a draft. House rules are one list, in get_house_rules. Nothing reaches a guest from Property Core: the host pastes each approved reply into Airbnb.";

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The guest tools as tools/list shows them: while the account's switch is on and any property runs a flow. */
export function listedGuestFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!featureOn(tenant, "guest-messages", h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...GUEST_TOOLS];
}

/** Answers one guest tool for the property it names. */
export function guestCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!featureOn(tenant, "guest-messages", h.baseEnv())) return { text: "Guest messages aren't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no guest messages.`, isError: true };
  const desk = guestDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now() });
  return handleGuestTool(desk, name, args) ?? { text: "Guest messages couldn't answer that.", isError: true };
}

/**
 * read_guest_message with no property on an account of two or more: the one property with a flow on whose
 * saved Airbnb listing titles or nickname match the email's listing, or that took a booking email with its
 * confirmation code. None, or more than one, and nothing is stored: the host names the property.
 */
export function guestMessageProperty(dataRoot: string, tenant: Tenant, args: unknown, now: () => Date): { property: Property } | { refusal: string } {
  const email = (args && typeof args === "object" ? (args as { email?: unknown }).email : undefined) as BookingEmailInput | undefined;
  const running = tenant.properties.filter(anyFlowOn);
  const which = `Which property is this Airbnb message for? Ask the host, then pass property as one of: ${running.map((p) => `${p.id} (${p.label})`).join(", ")}.`;
  if (!email || typeof email.from !== "string" || typeof email.subject !== "string" || typeof email.body !== "string") return { refusal: "Pass the email as from, subject and body (plain text)." };
  const read = parseAirbnbMessage(email, now());
  if (!read.ok) return { refusal: which };
  const listing = read.parsed.listing ? normalizeListing(read.parsed.listing) : undefined;
  const code = read.parsed.confirmationCode;
  const matches = running.filter((property) => {
    const root = propertyFolder(dataRoot, tenant.id, property);
    let hub;
    try {
      hub = readHubFile(root);
    } catch {
      hub = undefined;
    }
    const names = [...(hub?.airbnbListings ?? []), ...(hub?.property.nickname ? [hub.property.nickname] : [])].map(normalizeListing).filter(Boolean);
    if (listing && names.includes(listing)) return true;
    return !!code && rebuildBookings(readBookingEmails(root)).has(code);
  });
  if (matches.length === 1) return { property: matches[0]! };
  return { refusal: read.parsed.listing ? `The Airbnb listing "${read.parsed.listing}" ${matches.length > 1 ? "matches more than one property" : "doesn't match a property yet"}. ${which}` : which };
}

/** A routed read names its property, so the reply and any late checkout go to the same one. */
export function withRoutedProperty(reply: FrontReply, property: Property): FrontReply {
  if (reply.isError || !reply.structured) return reply;
  const next = `${String(reply.structured.next ?? "")} This message is for ${property.label}: pass property ${property.id} on save_guest_reply and set_late_checkout.`.trim();
  const structured = { ...reply.structured, property: { id: property.id, label: property.label }, next };
  return { ...reply, text: JSON.stringify(structured), structured };
}
