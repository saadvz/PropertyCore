import type { LockDevice } from "./adapter";
import type { StoredDevice } from "./settings";

/**
 * After a lock account comes back (#280 item 22) the partner can list the same doors under new ids. A saved device
 * whose id is gone moves to the one lock in the account with the same name, case and spacing ignored, that isn't
 * already saved. Two locks of that name, or two saved devices of that name, are never guessed: the device is missing,
 * and the host picks the doors again.
 */

const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export function matchDoors(saved: readonly StoredDevice[], listed: readonly LockDevice[]): { moves: Record<string, string>; missing: string[] } {
  const listedIds = new Set(listed.map((device) => device.id));
  const savedIds = new Set(saved.map((device) => device.id));
  const moves: Record<string, string> = {};
  const missing: string[] = [];
  for (const device of saved) {
    if (listedIds.has(device.id)) continue;
    const sameName = saved.filter((other) => key(other.name) === key(device.name));
    const candidates = listed.filter((other) => !savedIds.has(other.id) && other.kind === device.kind && key(other.name) === key(device.name));
    if (sameName.length === 1 && candidates.length === 1) moves[device.id] = candidates[0]!.id;
    else missing.push(device.id);
  }
  return { moves, missing };
}

/**
 * The host picked new doors in save_locks while some saved ones are gone: each gone door pairs with the one picked
 * door of the same name and kind. One gone door left with one picked door left is the host's own replacement, so
 * they pair too. Anything else is never guessed: those gone doors' codes are taken off for their flows to make again.
 */
export function pairPicked(gone: readonly StoredDevice[], picked: readonly LockDevice[]): { moves: Record<string, string>; unpaired: string[] } {
  const moves: Record<string, string> = {};
  const used = new Set<string>();
  for (const device of gone) {
    const sameName = gone.filter((other) => key(other.name) === key(device.name));
    const candidates = picked.filter((other) => other.kind === device.kind && key(other.name) === key(device.name));
    if (sameName.length === 1 && candidates.length === 1 && !used.has(candidates[0]!.id)) {
      moves[device.id] = candidates[0]!.id;
      used.add(candidates[0]!.id);
    }
  }
  const leftGone = gone.filter((device) => !moves[device.id]);
  const leftPicked = picked.filter((device) => !used.has(device.id));
  if (leftGone.length === 1 && leftPicked.length === 1) moves[leftGone[0]!.id] = leftPicked[0]!.id;
  return { moves, unpaired: gone.map((device) => device.id).filter((id) => !moves[id]) };
}
