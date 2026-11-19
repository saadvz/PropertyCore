import { liveDeskFor } from "../cleaner-core/liveDesk";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import type { GrantNote } from "../hub/doorAccess";
import { hubFor } from "../hub/hub";
import type { LockWebhookEvent } from "../locks/adapter";
import { applyLockEvent, lockHealthNotes } from "../locks/inbound";
import { lockAdapter, smartLocksOn } from "../locks/registry";
import { readDoorLocks } from "../locks/settings";
import { fixerDesk } from "./fixer";

/**
 * Connected locks on the shared service (#180): the lock partner's webhook, and the clock pass for
 * lock health. A webhook is verified by the adapter before anything in it is read, and goes only to
 * the one property whose account and device it names. Nothing here logs a body or a code.
 */

export const LOCK_WEBHOOK_PATH = "/webhooks/seam";
const MAX_WEBHOOK_BYTES = 64 * 1024;

interface Owner {
  tenant: Tenant;
  property: Property;
}

/**
 * The property an event belongs to: the one whose saved devices hold its device, under the account
 * the partner tagged (its customer key is the account id). An account-wide event (disconnected) goes
 * to each of that account's properties using the partner account. None when nothing matches.
 */
export function lockOwners(h: HostedCleaner, event: LockWebhookEvent): Owner[] {
  const owners: Owner[] = [];
  for (const listed of h.registry.list()) {
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled) continue;
    if (event.customerKey && event.customerKey !== tenant.id) continue;
    for (const property of tenant.properties) {
      let file;
      try {
        file = readDoorLocks(propertyFolder(h.dataRoot, tenant.id, property));
      } catch {
        continue;
      }
      if (file.customerKey !== tenant.id) continue;
      const holds = event.deviceId ? file.devices.some((device) => device.id === event.deviceId) : event.accountId ? file.devices.some((device) => device.accountId === event.accountId) : false;
      if (holds) owners.push({ tenant, property });
    }
  }
  // A device belongs to one property. Two matches for one device means the mapping is wrong: drop it.
  if (event.deviceId && owners.length > 1) return [];
  return owners;
}

/** Tells the host through Cleaner Core's notes, or Fixer Core's when cleaning is off here. */
export async function tellLockNote(h: HostedCleaner, owner: Owner, note: GrantNote): Promise<void> {
  const { tenant, property } = owner;
  try {
    if (property.flows.cleaning.on) {
      const ctx = propertyContext(h, tenant, property);
      await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteForHost(`host:${note.id}`, note.text);
      return;
    }
    if (property.flows.fixer.on) await fixerDesk(h, tenant, property).noteForHost(note.id, note.text, note.jobId);
  } catch {
    h.log(`A lock note for ${tenant.id}/${property.id} couldn't be kept this time.`);
  }
}

/** POST /webhooks/seam. Answered 401 when the signature fails, 200 otherwise, so the partner doesn't resend a dropped event. */
export async function handleLockWebhook(h: HostedCleaner, r: HostedRequest): Promise<void> {
  const adapter = lockAdapter();
  if (!smartLocksOn(h.baseEnv()) || !adapter) {
    r.send(404, "text/plain", "Not found");
    return;
  }
  const raw = await r.readCapped(MAX_WEBHOOK_BYTES);
  if (!raw) {
    r.send(413, "text/plain", "Too large", { Connection: "close" });
    return;
  }
  const event = adapter.parseWebhook({ headers: r.req.headers as Record<string, string | string[] | undefined>, body: raw.toString("utf8") });
  if (!event) {
    r.send(401, "text/plain", "Unauthorized");
    return;
  }
  const owners = lockOwners(h, event);
  if (owners.length === 0) {
    h.log("A lock event for an unknown account or device was dropped.");
    r.send(200, "text/plain", "ok");
    return;
  }
  for (const owner of owners) {
    const ctx = propertyContext(h, owner.tenant, owner.property);
    const hub = hubFor(ctx.root, { now: () => h.now() });
    const door = hub.doorAccess(ctx.env);
    try {
      const result = await applyLockEvent(door, adapter, event, h.now(), hub.property().timeZone);
      for (const note of result.notes) await tellLockNote(h, owner, note);
    } catch {
      h.log(`A lock event for ${owner.tenant.id}/${owner.property.id} couldn't be applied.`);
    }
  }
  r.send(200, "text/plain", "ok");
}

/**
 * The lock clock pass, on Fixer's tick: a lock offline for 30 minutes is told once, and on a property
 * with Cleaner Core on, the checkout-time release and a paused turnover's reminders.
 */
export async function tickAllLocks(h: HostedCleaner): Promise<void> {
  if (!smartLocksOn(h.baseEnv()) || !lockAdapter()) return;
  for (const listed of h.registry.list()) {
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled) continue;
    for (const property of tenant.properties) {
      const ctx = propertyContext(h, tenant, property);
      try {
        const door = hubFor(ctx.root, { now: () => h.now() }).doorAccess(ctx.env);
        if (!door.locks().activeAt) continue;
        for (const note of lockHealthNotes(door, h.now())) await tellLockNote(h, { tenant, property }, note);
        // The checkout-time release and a paused turnover's reminders run on this clock.
        if (property.flows.cleaning.on) await liveDeskFor(ctx.root, ctx.env, () => h.now()).lockClock();
      } catch {
        h.log(`The lock check for ${tenant.id}/${property.id} couldn't run this round.`);
      }
    }
  }
}
