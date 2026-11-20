/**
 * Where a property takes bookings (#263): the platforms the host picked, and for each one the sender
 * whose reservation emails the agent passes. Airbnb is matched by its domain and read by its own
 * reader. Every other platform is matched by one exact sender address, and its bookings wait on the
 * host's yes (the Other path). Pure: no files. See docs/superpowers/specs/2026-11-20-booking-platforms-design.md.
 */

export type BookingPlatform = "airbnb" | "vrbo" | "booking" | "direct" | "other";

export const BOOKING_PLATFORMS: readonly BookingPlatform[] = ["airbnb", "vrbo", "booking", "direct", "other"];

export interface BookingSource {
  platform: BookingPlatform;
  /** The exact sender address, lower-case. Pre-filled for Vrbo and Booking.com; the host's own for direct and other. Airbnb has none. */
  sender?: string;
  /** The name the host gave an Other platform. */
  name?: string;
}

/**
 * The senders Vrbo and Booking.com send reservation emails from, until real samples say otherwise.
 * Vrbo relays a guest's messages from a per-guest address at the same domain, so only this exact
 * address counts. Booking.com's is heavily spoofed, so its emails also need their sender check.
 */
export const PRESET_SENDERS = { vrbo: "sender@messages.homeaway.com", booking: "noreply@booking.com" } as const;

/** No platforms saved: Airbnb only, as before #263. */
export const AIRBNB_ONLY: readonly BookingSource[] = [{ platform: "airbnb" }];

export const MAX_SOURCES = 8;

const PLATFORM_LABEL: Record<BookingPlatform, string> = { airbnb: "Airbnb", vrbo: "Vrbo", booking: "Booking.com", direct: "your booking site", other: "Other" };

const ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

/** The platform's name as the host would say it: the name they gave an Other platform. */
export function platformLabel(source: Pick<BookingSource, "platform" | "name">): string {
  return source.platform === "other" && source.name ? source.name : PLATFORM_LABEL[source.platform];
}

/** True when this source's sender is one Property Core pre-filled, not one the host named. */
export function presetSender(source: BookingSource): boolean {
  return (source.platform === "vrbo" || source.platform === "booking") && source.sender === PRESET_SENDERS[source.platform];
}

export type SourcesResult = { ok: true; sources: BookingSource[] } | { ok: false; error: string };

/** Checks and fills in the host's platforms. A sender or name that carries the door code is refused. */
export function normalizeSources(input: readonly Partial<BookingSource>[], carriesCode: (text: string) => boolean): SourcesResult {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "Pick at least one platform." };
  if (input.length > MAX_SOURCES) return { ok: false, error: `I can keep up to ${MAX_SOURCES} booking platforms.` };
  const out: BookingSource[] = [];
  for (const item of input) {
    const platform = item?.platform;
    if (!platform || !BOOKING_PLATFORMS.includes(platform)) return { ok: false, error: "Each platform is one of airbnb, vrbo, booking, direct or other." };
    if (platform === "airbnb") {
      if (out.some((source) => source.platform === "airbnb")) return { ok: false, error: "Airbnb is already in the list." };
      out.push({ platform });
      continue;
    }
    const preset = platform === "vrbo" || platform === "booking" ? PRESET_SENDERS[platform as keyof typeof PRESET_SENDERS] : undefined;
    const sender = (item.sender?.trim() || preset || "").toLowerCase();
    if (!sender) return { ok: false, error: `Give the address ${platformLabel({ platform, name: item.name })}'s booking emails come from.` };
    if (!ADDRESS.test(sender) || sender.length > 200) return { ok: false, error: `"${sender}" isn't an email address. Give only the address, like bookings@example.com.` };
    const name = item.name?.trim();
    if (platform === "other" && !name) return { ok: false, error: "Give the Other platform's name." };
    if (name && name.length > 60) return { ok: false, error: "That platform name is too long." };
    if (carriesCode(sender) || (name && carriesCode(name))) return { ok: false, error: "That looks like it carries the door code, so I didn't save it." };
    if (out.some((source) => source.sender === sender)) return { ok: false, error: `${sender} is already in the list.` };
    out.push({ platform, sender, ...(platform === "other" && name ? { name } : {}) });
  }
  return { ok: true, sources: out };
}

/** The address in a From header: the last <...> at its end, or the whole header when it's a bare address. A display name counts for nothing. */
export function senderAddress(from: string): string | undefined {
  const text = from.trim();
  const angled = [...text.matchAll(/<([^<>]*)>/g)];
  if (angled.length && !text.endsWith(">")) return undefined;
  const address = (angled.length ? angled.at(-1)![1]! : text).trim().toLowerCase();
  return /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+$/.test(address) ? address : undefined;
}

/** The domain of an address. */
export function addressDomain(address: string): string {
  return address.split("@")[1] ?? "";
}

/** The saved source this email's sender belongs to: Airbnb by its domain, every other platform by its exact address. */
export function sourceFor(sources: readonly BookingSource[], from: string): BookingSource | undefined {
  const address = senderAddress(from);
  if (!address) return undefined;
  const domain = addressDomain(address);
  for (const source of sources) {
    if (source.platform === "airbnb") {
      if (domain === "airbnb.com" || domain.endsWith(".airbnb.com")) return source;
      continue;
    }
    if (source.sender === address) return source;
  }
  return undefined;
}

/** One line for the agent: the senders to look for, and only those. */
export function bookingEmailsLine(sources: readonly BookingSource[]): string {
  const parts: string[] = [];
  if (sources.some((source) => source.platform === "airbnb")) parts.push("Airbnb's reservation emails");
  const others = sources.filter((source) => source.platform !== "airbnb").map((source) => `${source.sender} (${platformLabel(source)})`);
  if (others.length) parts.push(`reservation emails from ${others.join(", ")}`);
  const what = parts.join(", and ");
  const which = parts.length > 1 ? "For each email from those senders" : "For each one";
  const how = others.length ? ` ${which}, also pass extracted: the kind, dates, times, guest count and reference you read in it.` : "";
  return `Look only for ${what}. Pass each one to read_booking_email as it arrives.${how}`;
}
