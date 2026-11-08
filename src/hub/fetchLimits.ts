import { isPrivateAddress } from "../net/addresses";

const MAX_BYTES = 1_000_000;
const MAX_MS = 10_000;

export const CALENDAR_URL_REFUSAL =
  "I can't read that calendar link. It has to be a public https address, and I will not follow it to a private network.";

export function calendarUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "metadata.google.internal") return false;
  if (isPrivateAddress(host)) return false;
  return true;
}

export interface CalendarFetch {
  (url: string, init: { redirect: "manual"; signal: AbortSignal }): Promise<{ status: number; url: string; text(): Promise<string> }>;
}

/** HTTPS only, no private host, no redirect, and a size and time limit. The URL is not returned. */
export async function readPublicCalendar(raw: string, fetchImpl: CalendarFetch): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  if (!calendarUrlAllowed(raw)) return { ok: false, reason: CALENDAR_URL_REFUSAL };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_MS);
  try {
    const response = await fetchImpl(raw, { redirect: "manual", signal: controller.signal });
    if (response.status !== 200) return { ok: false, reason: CALENDAR_URL_REFUSAL };
    if (!calendarUrlAllowed(response.url)) return { ok: false, reason: CALENDAR_URL_REFUSAL };
    const body = await response.text();
    if (body.length > MAX_BYTES) return { ok: false, reason: CALENDAR_URL_REFUSAL };
    if (Date.now() - started > MAX_MS) return { ok: false, reason: CALENDAR_URL_REFUSAL };
    return { ok: true, body };
  } catch {
    return { ok: false, reason: CALENDAR_URL_REFUSAL };
  } finally {
    clearTimeout(timer);
  }
}
