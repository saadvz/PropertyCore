import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOOR_GRANTS_FILE, type GrantFlow, type StoredGrant } from "../hub/grants";
import { codePerson, type CodeNames, type CodePerson } from "../visits/events";
import { visitLogFor } from "../visits/store";
import type { KeypadEntryResult } from "./seam";
import { readDoorLocks } from "./settings";

/**
 * The operator's sandbox keypad entry (#303): finds whose code to type on one property's sandbox lock and
 * has the lock partner type it, so a real unlock comes back through the webhook into door activity, the
 * visit record and the same-day check. It's an operator command only: no agent tool, and nothing is added
 * to any bot's tool list. It refuses any workspace that isn't a sandbox, and it never prints, logs or
 * returns a code: what it says names whose code it was, the door and the time.
 */

export const ENTRY_WHO = ["cleaner", "pro", "vendor", "visitor", "host", "guest", "package", "shared"] as const;
export type EntryWho = (typeof ENTRY_WHO)[number];

/** The words each person is named by in what the command says. */
const WHO_WORDS: Record<EntryWho, string> = {
  cleaner: "the cleaner",
  pro: "the pro",
  vendor: "the vendor",
  visitor: "the visitor",
  host: "the host",
  guest: "the guest",
  package: "the package helper",
  shared: "the standing-code holder",
};

/** Whose a flow's code is when the visit log didn't save a name for it. Standing codes are the host's or someone they named, so they need the saved name. */
const FLOW_PERSON: Partial<Record<GrantFlow, CodePerson["role"]>> = { cleaning: "cleaner", repair: "pro", guest: "guest", visit: "visitor", "bring-in": "package" };

/** The partner calls the command needs: the adapter's sandbox-only pair. Tests pass a fake. */
export interface SandboxKeypad {
  isSandbox(): Promise<boolean>;
  simulateKeypadEntry(input: { deviceId: string; codeId: string }): Promise<KeypadEntryResult>;
}

/** One code the command could type: never its value. */
export interface EntryCandidate {
  grantId: string;
  jobId: string;
  who: EntryWho;
  label?: string;
  window: { from: string; until: string };
  createdAt: string;
  doors: { deviceId: string; codeId: string; door: string }[];
}

/** Routine vendor jobs on this property: Fixer Core jobs booked under a standing yes (#237). An unreadable file is none. */
function vendorJobs(root: string): Set<string> {
  const path = join(root, "fixer.json");
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { jobs?: { id?: unknown; booking?: { vendor?: unknown } }[] };
    return new Set((Array.isArray(raw.jobs) ? raw.jobs : []).filter((job) => typeof job?.id === "string" && job.booking?.vendor).map((job) => job.id as string));
  } catch {
    return new Set();
  }
}

function grantsOf(root: string): StoredGrant[] {
  const path = join(root, DOOR_GRANTS_FILE);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { grants?: unknown };
  return Array.isArray(raw.grants) ? (raw.grants as StoredGrant[]) : [];
}

function whoOf(grant: StoredGrant, names: CodeNames, vendors: Set<string>): EntryWho | undefined {
  const role = codePerson(names, grant.codeName)?.role ?? FLOW_PERSON[grant.flow];
  if (!role) return undefined;
  if (role === "pro") return vendors.has(grant.jobId) ? "vendor" : "pro";
  return role;
}

/**
 * Every code on this property's locks that the command could type for `who`: grants not revoked, with a
 * code id on a door this property holds. A window that's over or not open yet is kept, so an entry
 * outside the window can be tried on purpose. Newest first.
 */
export function entryCandidates(root: string, who: EntryWho): EntryCandidate[] {
  const locks = readDoorLocks(root);
  const names = visitLogFor(root).codeNames();
  const vendors = vendorJobs(root);
  const doorName = new Map(locks.devices.map((device) => [device.id, device.name]));
  return grantsOf(root)
    .filter((grant) => !grant.revokedAt && whoOf(grant, names, vendors) === who)
    .map((grant) => ({
      grantId: grant.id,
      jobId: grant.jobId,
      who,
      ...(grant.label ? { label: grant.label } : {}),
      window: { ...grant.window },
      createdAt: grant.createdAt,
      doors: (grant.devices ?? []).filter((device) => device.codeId && doorName.has(device.deviceId) && device.status !== "removed").map((device) => ({ deviceId: device.deviceId, codeId: device.codeId!, door: doorName.get(device.deviceId)! })),
    }))
    .filter((candidate) => candidate.doors.length > 0)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** "Nov 24, 9:14 PM": no year, so nothing the command says ever holds four digits in a row. */
function when(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(at);
}

function windowWords(window: { from: string; until: string }, timeZone: string): string {
  return `${when(new Date(window.from), timeZone)} to ${when(new Date(window.until), timeZone)}`;
}

/** The last guard: a line with four or more digits in a row is never printed, whatever put them there. */
export function safeLine(line: string): string {
  return /\d{4,}/.test(line) ? "(A line was held back because it held a run of digits.)" : line;
}

export interface EntryInput {
  root: string;
  who: EntryWho;
  /** Picks one code when the person has several: the job id, or its 1-based place in the list printed. */
  pick?: string;
  /** Picks the door by its name, when the code is on several. */
  door?: string;
  keypad: SandboxKeypad;
  now: () => Date;
  timeZone?: string;
}

export interface EntryOutcome {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

/** Finds the code, checks the workspace, has the lock partner type it, and says what happened. */
export async function sandboxEntry(input: EntryInput): Promise<EntryOutcome> {
  const timeZone = input.timeZone ?? "UTC";
  const say = (exitCode: EntryOutcome["exitCode"], ...lines: string[]): EntryOutcome => ({ exitCode, lines: lines.map(safeLine) });
  const person = WHO_WORDS[input.who];

  // The workspace first: nothing on this property is even read for a key that isn't a sandbox's.
  if (!(await input.keypad.isSandbox())) return say(1, "Refused: the lock partner's key isn't for a sandbox workspace. This command only runs against a sandbox.");

  const candidates = entryCandidates(input.root, input.who);
  if (candidates.length === 0) return say(1, `No code on this property's locks is ${person}'s right now.`);
  let chosen: EntryCandidate | undefined;
  if (input.pick) {
    const place = /^\d{1,2}$/.test(input.pick) ? Number(input.pick) : NaN;
    chosen = Number.isInteger(place) && place >= 1 ? candidates[place - 1] : candidates.find((candidate) => candidate.jobId === input.pick);
    if (!chosen) return say(2, `None of ${person}'s codes matches that pick.`);
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // More than one: the one whose window is open now, else the operator picks.
    const now = input.now().getTime();
    const open = candidates.filter((candidate) => Date.parse(candidate.window.from) <= now && now < Date.parse(candidate.window.until));
    if (open.length === 1) chosen = open[0];
    else
      return say(
        2,
        `${capital(person)} has ${candidates.length} codes on this property's locks. Run again with --pick and one of these:`,
        ...candidates.map((candidate, index) => `  ${index + 1}. ${candidate.label ? `${candidate.label}, ` : ""}${windowWords(candidate.window, timeZone)}`),
      );
  }

  if (!chosen) return say(2, `None of ${person}'s codes matches that pick.`);
  const picked = chosen;
  const doors = input.door ? picked.doors.filter((door) => door.door.trim().toLowerCase() === input.door!.trim().toLowerCase()) : picked.doors;
  if (doors.length === 0) return say(2, `That code isn't on a door named that. It's on: ${picked.doors.map((door) => door.door).join(", ")}.`);
  if (doors.length > 1) return say(2, `That code is on ${doors.length} doors. Run again with --door and one of: ${doors.map((door) => door.door).join(", ")}.`);
  const door = doors[0]!;

  const whose = `${person}'s code${picked.label ? ` (${picked.label})` : ""}`;
  const result = await input.keypad.simulateKeypadEntry({ deviceId: door.deviceId, codeId: door.codeId });
  const at = when(input.now(), timeZone);
  const now = input.now().getTime();
  const outside = now < Date.parse(picked.window.from) || now >= Date.parse(picked.window.until) ? ` That was outside its window (${windowWords(picked.window, timeZone)}).` : "";
  switch (result.status) {
    case "success":
      return say(0, `Entered ${whose} on the ${door.door} keypad at ${at}.${outside}`);
    case "pending":
      return say(0, `Sent ${whose} to the ${door.door} keypad at ${at}. The lock partner still had it pending after ten seconds: check door activity.${outside}`);
    case "error":
      // The first live run (24 Nov) ended in an error from the partner, yet the unlock came through the webhook: so it isn't called a failure.
      return say(1, `The lock partner reported an error entering ${whose} on the ${door.door} keypad at ${at}${result.errorType ? ` (${result.errorType})` : ""}, but the unlock can still arrive. Check door activity before you try again.${outside}`);
    case "refused":
      return say(
        1,
        result.reason === "not-sandbox"
          ? "Refused: the lock partner's key isn't for a sandbox workspace. This command only runs against a sandbox."
          : result.reason === "not-on-device"
            ? `The lock partner doesn't list ${whose} on the ${door.door}. Nothing was entered.`
            : `The lock partner had no code value for ${whose} on the ${door.door}. Nothing was entered.`,
      );
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
