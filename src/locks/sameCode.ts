import { randomInt } from "node:crypto";
import { CodeValueRefused, type CodeStatus, type CodeWindow, type LockAdapter, type LockDevice } from "./adapter";

/** One device's part of a code: its id on the device once made, and where it is. */
export interface DeviceCode {
  deviceId: string;
  codeId?: string;
  status: CodeStatus;
}

const TRIES = 5;
const DEFAULT_LENGTH = 6;

/** The code length every device accepts, preferring 6, else the longest shared one, else 6. */
export function sharedLength(devices: readonly Pick<LockDevice, "codeLengths">[]): number {
  const lists = devices.map((device) => device.codeLengths).filter((lengths): lengths is number[] => Array.isArray(lengths) && lengths.length > 0);
  if (lists.length === 0) return DEFAULT_LENGTH;
  const shared = lists[0]!.filter((length) => length >= 4 && length <= 8 && lists.every((list) => list.includes(length)));
  if (shared.includes(DEFAULT_LENGTH)) return DEFAULT_LENGTH;
  return shared.length > 0 ? Math.max(...shared) : DEFAULT_LENGTH;
}

/** True for a code anyone would guess: one digit repeated, or a straight run up or down. */
export function guessable(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  const digits = [...code].map(Number);
  const steps = new Set(digits.slice(1).map((digit, index) => (digit - digits[index]! + 10) % 10));
  return steps.size === 1 && (steps.has(1) || steps.has(9));
}

/** A fresh code of `length` digits that isn't guessable, doesn't start with 0, and isn't in `avoid`. */
export function freshCode(length: number, avoid: ReadonlySet<string>): string {
  for (;;) {
    let code = String(randomInt(1, 10));
    while (code.length < length) code += String(randomInt(0, 10));
    if (!guessable(code) && ![...avoid].some((other) => other.includes(code) || code.includes(other))) return code;
  }
}

/**
 * Puts one code value on every device, so the person has one code to type. When a lock refuses the
 * value, every code made for this value is removed and a new value is tried on all of them. A device
 * that fails for another reason (no answer) is kept as `failed` with no code id, for the release's
 * backup or a later retry. Never logs the code.
 */
export async function makeSameCode(
  adapter: LockAdapter,
  input: { devices: readonly LockDevice[]; name: string; window: CodeWindow; avoid: ReadonlySet<string> },
): Promise<{ code: string; devices: DeviceCode[] } | undefined> {
  const length = sharedLength(input.devices);
  const avoid = new Set(input.avoid);
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const code = freshCode(length, avoid);
    avoid.add(code);
    const made: DeviceCode[] = [];
    let refused = false;
    for (const device of input.devices) {
      try {
        const result = await adapter.createCode({ deviceId: device.id, code, name: input.name, window: input.window });
        made.push({ deviceId: device.id, codeId: result.codeId, status: result.status });
      } catch (error) {
        if (error instanceof CodeValueRefused) {
          refused = true;
          break;
        }
        made.push({ deviceId: device.id, status: "failed" });
      }
    }
    if (!refused) return { code, devices: made };
    await removeAll(adapter, made);
  }
  return undefined;
}

/** Removes every code made. A remove that fails is left for the window's end. */
export async function removeAll(adapter: LockAdapter, devices: readonly DeviceCode[]): Promise<boolean> {
  let all = true;
  for (const device of devices) {
    if (!device.codeId || device.status === "removed") continue;
    try {
      await adapter.removeCode({ deviceId: device.deviceId, codeId: device.codeId });
    } catch {
      all = false;
    }
  }
  return all;
}
