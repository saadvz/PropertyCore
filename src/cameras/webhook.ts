import type { CameraProvider } from "./adapter";
import { routeDevice, type CameraPlace } from "./accounts";
import type { CameraEventLine, EventLog } from "./lines";

/**
 * One webhook delivery from the camera provider (#239): verified before anything is read, routed to the one
 * property that picked the camera, and stored once. Nothing slow happens here: counting, package sightings and the
 * offline timer run later off the stored line, so the provider gets its answer within its few seconds. The body is
 * never logged.
 */

export interface IngestInput {
  provider: CameraProvider;
  /** Read only after the signature checks, so an unsigned request costs nothing. */
  places: readonly CameraPlace[] | (() => readonly CameraPlace[]);
  logFor(tenantId: string, propertyId: string): EventLog;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export type IngestResult =
  | { status: 401 }
  | { status: 200; stored?: { tenantId: string; propertyId: string; line: CameraEventLine }; unlinked?: string; dropped?: Dropped };

/** Why a signed delivery stored nothing, for one log line without its body (#239). */
export type Dropped = { reason: "skipped"; eventType?: string } | { reason: "not picked" } | { reason: "repeat" };

export function ingestWebhook(input: IngestInput): IngestResult {
  const parsed = input.provider.parseWebhook(input.rawBody, input.headers);
  if (!parsed) return { status: 401 };
  if (parsed.type === "unlinked") return { status: 200, unlinked: parsed.accountId };
  if (parsed.type === "ignored") return { status: 200, dropped: { reason: "skipped", ...(parsed.eventType ? { eventType: parsed.eventType } : {}) } };
  const route = routeDevice(typeof input.places === "function" ? input.places() : input.places, parsed.event.deviceId);
  if (!route) return { status: 200, dropped: { reason: "not picked" } };
  const line: CameraEventLine = {
    type: "camera",
    id: parsed.event.id,
    at: parsed.event.at,
    device: route.camera.name,
    deviceId: parsed.event.deviceId,
    provider: input.provider.name,
    kind: parsed.event.kind,
    ...(parsed.event.label ? { label: parsed.event.label } : {}),
  };
  if (!input.logFor(route.tenantId, route.propertyId).append(line)) return { status: 200, dropped: { reason: "repeat" } };
  return { status: 200, stored: { tenantId: route.tenantId, propertyId: route.propertyId, line } };
}
