import { isIP } from "node:net";

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
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "metadata.google.internal") return false;
  if (isIP(host) && privateAddress(host)) return false;
  return true;
}

function privateAddress(host: string): boolean {
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export interface CalendarFetch {
  (url: string, init: { redirect: "manual"; signal: AbortSignal }): Promise<{ status: number; url: string; text(): Promise<string> }>;
}

/** HTTPS only, no private host, no redirect, and a size and time limit. The URL is not returned. */
export async function readPublicCalendar(raw: string, fetchImpl: CalendarFetch, now = Date.now()): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  if (!calendarUrlAllowed(raw)) return { ok: false, reason: CALENDAR_URL_REFUSAL };
  const started = now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_MS);
  try {
    const response = await fetchImpl(raw, { redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) return { ok: false, reason: CALENDAR_URL_REFUSAL };
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
