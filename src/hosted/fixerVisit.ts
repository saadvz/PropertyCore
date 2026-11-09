import type { Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner, HostedRequest } from "../cleaner-core/hosted/router";
import { FIXER_VISIT_PREFIX, handleVisitRequest, visitBodyCap, visitRouteRefusal, type VisitResponse } from "../fixer-core/visitPage";
import { fixerDesk } from "./fixer";

/**
 * The pro's visit page on a property's own path, /t/<id>[/p/<pid>]/fixer-core/visit/<token>[/<sub>].
 * The desk is the path's property, never one a token points to. Nothing here logs the path, the
 * token or a response body: the door's answer holds the code.
 */

/** New visit links looked up (each reads a property's fixer.json) in a minute, across every account in this process. */
export const VISIT_LOOKUPS_PER_MINUTE = 120;
const MINUTE_MS = 60_000;

let lookups = { start: 0, count: 0 };

/** Counts one lookup. False once this minute's are used up. */
function takeLookup(now: number): boolean {
  if (now - lookups.start >= MINUTE_MS || now < lookups.start) lookups = { start: now, count: 0 };
  if (lookups.count >= VISIT_LOOKUPS_PER_MINUTE) return false;
  lookups.count += 1;
  return true;
}

/** Tests only: a fresh minute. */
export function resetVisitLookups(): void {
  lookups = { start: 0, count: 0 };
}

/** True when the property path is the visit page's. */
export function isVisitPath(rest: string): boolean {
  return rest.startsWith(FIXER_VISIT_PREFIX);
}

/** Answers one visit page request for the property. The caller has checked Fixer Core is on there. */
export async function serveFixerVisit(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, rest: string): Promise<void> {
  const tail = rest.slice(FIXER_VISIT_PREFIX.length);
  const slash = tail.indexOf("/");
  const token = slash < 0 ? tail : tail.slice(0, slash);
  const sub = slash < 0 ? "" : tail.slice(slash + 1);
  try {
    const desk = fixerDesk(h, tenant, property);
    if (desk.visitNeedsLookup(token) && !takeLookup(h.now().getTime())) return write(r, visitRouteRefusal(sub, "busy"));
    // The cap is checked before anything is kept: a body over it is answered 413 and never buffered.
    let body: Buffer = Buffer.alloc(0);
    if (r.method === "POST") {
      const read = await r.readCapped(visitBodyCap(sub));
      if (!read) return write(r, visitRouteRefusal(sub, "too-large"));
      body = read;
    }
    const contentType = String(r.req.headers["content-type"] ?? "");
    write(r, await handleVisitRequest(desk, { method: r.method, sub, token, contentType, body }));
  } catch {
    h.log(`Fixer Core's visit page couldn't answer a request for ${tenant.id}/${property.id}.`);
    if (!r.res.headersSent) write(r, visitRouteRefusal(sub, "failed"));
  }
}

function write(r: HostedRequest, response: VisitResponse): void {
  const body = typeof response.body === "string" ? Buffer.from(response.body, "utf8") : response.body;
  r.res.writeHead(response.status, { ...response.headers, "Content-Length": String(body.length) });
  r.res.end(body);
}
