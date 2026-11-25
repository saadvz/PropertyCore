import { createHash, randomInt } from "node:crypto";
import { join } from "node:path";
import { recordHostStep } from "../hours-log/hostSteps";
import { hubFor } from "../hub/hub";
import type { DoorAccess, GrantNote } from "../hub/doorAccess";
import { issueFailedNote } from "../hub/grants";
import { sameHash } from "../hub/uploadCode";
import { ConfirmationBook } from "../operator/confirmations";
import { recordLockConnection } from "./eventLog";
import { markDisconnected, markReconnected, onceNotes } from "./inbound";
import type { DeviceKind, LockDevice } from "./adapter";
import { lockAdapter } from "./registry";
import { deskFeatureOn } from "../features/features";
import { pairPicked } from "./rehome";
import { allDoorsConnected, packagesRelease, readDoorLocks, storedDevice, type DoorLocksFile, type ReleaseMode, type StandingPerson, type StandingRole } from "./settings";

export type { StandingPerson, StandingRole };

/**
 * One property's connected locks, for the host's agent (#180): the sign-in link, which locks and
 * sensors are this property's, how codes go out, and standing codes for the host and the people they
 * name. No tool returns a code: only statuses. Nothing here names the lock partner. A standing code
 * reaches its person only on a single-use page, after their own YES; its digits are never in a text,
 * a tool result or a log.
 */

export const STANDING_PAGE_PREFIX = "/locks/code/";
/** How long a standing code's page link works. */
export const STANDING_LINK_HOURS = 24;
/** A standing code has no end; its window is this long, renewed when the host makes a new link. */
const STANDING_YEARS = 20;
const APPROVAL_MS = 10 * 60_000;

export interface LockDeskDeps {
  now(): Date;
  env(): NodeJS.ProcessEnv;
  /** The Property Core account id: the lock partner tags the host's lock account with it. */
  customerKey: string;
  /** The account's other properties' saved devices, so a device belongs to only one property. */
  otherDevices(): string[];
  /** True when the account's alerts routine reaches the host's agent chat. */
  alertsWorking(): Promise<boolean>;
  /** True when this property's texts may go (the host's phone is confirmed). */
  textsAllowed(): Promise<boolean>;
  /** The person's own STOP, account-wide. */
  stopped(phone: string): boolean;
  send(to: string, body: string): Promise<boolean>;
  /** This property's public address on the service, for the page link. */
  publicBase(): string | undefined;
  cleaningOn(): boolean;
  /** The property's saved host phone, only when it's the account's confirmed landlord phone. For the host's own standing code. */
  hostPhone?(): Promise<string | undefined>;
  /** Tells the host each note once, by its id (the alerts path). Never holds a code. */
  tell?(notes: GrantNote[]): Promise<void>;
}

/** What a code page's "show my code" gets: the code once, or why not. Never logged. */
export type CodeShown = { ok: true; code: string; doors?: { door: string; code: string }[] } | { ok: false; reason: "gone" | "pending" | "failed" };

/** Why a standing code's invite didn't go: each says what happens next, so the agent never guesses. */
type InviteResult = "sent" | "already" | "opted-out" | "texts-off" | "send-failed";

/** How long a failed invite waits before the clock tries it again, and how many tries it gets. */
const INVITE_RETRY_MS = 10 * 60_000;
const INVITE_TRIES = 6;
const NO_CONSENT_TOOL = "No tool changes who may be texted, so never tell the host you turned texts on, and don't remove and remake the code for this.";

export interface LockReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

const ok = (structured: Record<string, unknown>): LockReply => ({ text: typeof structured.next === "string" ? structured.next : "Done.", structured, isError: false });
const fail = (text: string): LockReply => ({ text, isError: true });

export const LOCKS_OFF = "Connected locks aren't available yet.";
const APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";

function letters(length: number): string {
  let out = "";
  while (out.length < length) out += "abcdefghjkmnpqrstuvwxyz"[randomInt(0, 23)];
  return out;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

const KIND_WORDS: Record<DeviceKind, string> = { lock: "lock", thermostat: "thermostat", "noise-sensor": "noise sensor", other: "other device" };

/** What the agent does next on a property not yet on connected locks, from what the host's lock account shows. */
function setupNext(account: "connected" | "none" | "unknown", available: { name: string; kind: DeviceKind; online: boolean }[], inAccount: number): string {
  if (account === "unknown") return "I couldn't reach the host's lock account just now, so I can't see its devices. Call get_locks again in a minute. Don't send a new sign-in link for this.";
  if (account === "none") return "No lock account is connected here yet. If the host just signed in, wait a minute and call get_locks again. If the sign-in page showed an error, or they haven't signed in, connect_lock gives a fresh link.";
  if (available.length === 0) {
    return inAccount > 0
      ? "The host's lock account is connected, but every device in it is already on another property. A device belongs to one property."
      : "The host's lock account is connected, but it shows no lock yet. Ask them to check the lock is added and online in its own app, then call get_locks again. A new sign-in link won't help.";
  }
  const listed = available.map((device) => `${device.name} (${KIND_WORDS[device.kind]}${device.online ? "" : ", offline"})`).join(", ");
  const locks = available.some((device) => device.kind === "lock");
  return locks
    ? `The host's lock account is connected and shows: ${listed}. Ask the host which locks the cleaner and pros go through, and whether any other door they use isn't a connected lock. Then call save_locks with those ids from available.`
    : `The host's lock account is connected and shows: ${listed}, but no lock. Ask them to check the lock is added and online in its own app, then call get_locks again.`;
}

function streetOf(address: string | undefined): string {
  return (address ?? "the property").split(",")[0]!.trim();
}

/** The second problem while the lock account is down: why get_locks shows the doors and codes as unknown. */
export const ACCOUNT_DOWN_UNKNOWN = "Until the host signs in again, Property Core can't see the doors or tell whether the codes are on them. Once they do, everyone's codes go back on the doors with the same times.";

export class LockDesk {
  private readonly approvals: ConfirmationBook;

  constructor(
    readonly root: string,
    private readonly deps: LockDeskDeps,
  ) {
    this.approvals = new ConfirmationBook(APPROVAL_MS, () => this.deps.now().getTime(), { file: join(root, "lock-approvals.json") });
  }

  private door(): DoorAccess {
    return hubFor(this.root, { now: () => this.deps.now() }).doorAccess(() => this.deps.env());
  }

  private street(): string {
    return streetOf(hubFor(this.root, { now: () => this.deps.now() }).property().address);
  }

  private available(): boolean {
    return deskFeatureOn(this.deps.env(), "locks") && Boolean(lockAdapter());
  }

  private confirm(action: string, fingerprint: string, code: string | undefined, question: string): LockReply | "go" {
    if (!code) return ok({ question, confirmation: this.approvals.issue(action, "locks", fingerprint, question), next: `Ask the host: "${question}" Call again with the confirmation code only after their yes.` });
    try {
      this.approvals.redeem(code, action, "locks", fingerprint);
    } catch {
      return fail(APPROVAL_STALE);
    }
    return "go";
  }

  /** What the agent may see: connected or not, each device's health, the settings, standing people, and each code's status. Never a code. */
  status(): LockReply {
    if (!this.available()) return fail(LOCKS_OFF);
    const door = this.door();
    const file = door.locks();
    const problems: string[] = [];
    // While the lock account is disconnected or gone, the saved device health and code statuses are from before
    // the drop (#180 live run, Nov 24: the door read online at 100% and every code set after the partner removed
    // them). They read as unknown until the host signs in again.
    const down = Boolean(file.activeAt && file.disconnectedAt);
    if (!down) {
      for (const device of file.devices) {
        if (!device.online) problems.push(`${device.name} is offline.`);
        if (typeof device.battery === "number" && device.battery < 0.2) problems.push(`${device.name}'s battery is low.`);
      }
    }
    if (file.blockedBy === "mixed-doors") problems.push("Not every door the cleaner and pros use is a connected lock, so the saved door code is used.");
    if (file.blockedBy === "no-alerts") problems.push("Connected locks wait for a working alerts routine.");
    if (down) problems.unshift("The host's lock account is disconnected, so codes can't be made or changed. connect_lock gives the host a sign-in link.", ACCOUNT_DOWN_UNKNOWN);
    return ok({
      connected: door.connected() && !down,
      ...(down ? { disconnected: true } : {}),
      devices: file.devices.map((device) => ({ id: device.id, name: device.name, kind: device.kind, ...(down ? { online: "unknown" } : { online: device.online, ...(typeof device.battery === "number" ? { battery: Math.round(device.battery * 100) } : {}) }), door: file.doors.includes(device.id) })),
      release: file.release,
      extend: file.extend,
      standing: this.standing(file).map((person) => ({ id: person.id, name: person.name, role: person.role, status: standingStatus(person, this.deps.now()), ...(person.yesAt ? { lock: down ? "unknown" : standingOnLock(door, person.id) } : {}) })),
      codes: door.grants().statuses().filter((grant) => !grant.revoked).map((grant) => ({ flow: grant.flow, jobId: grant.jobId, from: grant.window.from, until: grant.window.until, doors: down ? grant.doors.map((item) => ({ door: item.door, status: "unknown" as const })) : grant.doors })),
      problems,
      next: problems[0] ?? (door.connected() ? "The locks are connected." : "No lock is connected here. connect_lock gives the host a sign-in link."),
    });
  }

  /**
   * After a reconnect (#280 22): when the lock account answers and isn't disconnected, saved doors that came back
   * under new ids get everyone's codes again. Each note goes to the host once, through `tell`. Never a code.
   */
  private async doorCheck(from: "clock" | "host"): Promise<GrantNote[]> {
    const door = this.door();
    const file = door.locks();
    if (!file.activeAt || file.devices.length === 0) return [];
    const listed = await lockAdapter()!.devices({ customerKey: this.deps.customerKey });
    // Right after a fresh sign-in the account lists its locks a few at a time: while it lists fewer locks than the
    // property's doors, the clock moves what matches and waits, with no "can't tell which lock" note.
    const kinds = new Set(file.devices.filter((device) => file.doors.includes(device.id)).map((device) => device.kind));
    const syncing = listed.filter((device) => kinds.has(device.kind)).length < file.doors.length;
    if (listed.length === 0) return [];
    const result = await door.rehome(listed, { recordMissing: from === "host" || !syncing });
    const notes = [...result.notes];
    // The account answers and every door is accounted for: the disconnect is over (#280 21), even when the
    // partner's connected event went to a new connection this property doesn't know yet.
    const now = door.locks();
    if (now.disconnectedAt && (!syncing || result.missing.length === 0)) {
      notes.unshift(...markReconnected(now));
      door.saveLocks(now);
    }
    const told = onceNotes(door, notes);
    if (told.length > 0) await this.deps.tell?.(told);
    return told;
  }

  /** The lock clock while a disconnect is unresolved or a door is still unmatched: re-homes once the doors show up. */
  async reconnectClock(): Promise<GrantNote[]> {
    if (!this.available()) return [];
    const file = this.door().locks();
    if (!file.disconnectedAt && !(file.rehomeNeeded ?? []).length) return [];
    try {
      const accounts = await lockAdapter()!.accounts({ customerKey: this.deps.customerKey });
      if (accounts.length === 0 || accounts.some((account) => account.disconnected)) return [];
      return await this.doorCheck("clock");
    } catch {
      return [];
    }
  }

  /**
   * get_locks: the status, plus what the host's connected lock account holds now, so the agent can
   * offer the devices to pick (#180 sandbox run: a finished sign-in showed nothing until save_locks,
   * which needs these ids). Only devices in accounts tagged with this Property Core account, not yet
   * on this or another property. A partner error is said, never shown as an empty account. A lock
   * account the partner still lists as disconnected says how to fix it, and doors that came back under
   * new ids get everyone's codes again (#280 22).
   */
  async list(): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    let account: "connected" | "disconnected" | "none" | "unknown" = "unknown";
    let inAccount: LockDevice[] = [];
    try {
      const adapter = lockAdapter()!;
      const accounts = await adapter.accounts({ customerKey: this.deps.customerKey });
      account = accounts.length === 0 ? "none" : accounts.some((item) => item.disconnected) ? "disconnected" : "connected";
      if (account !== "none") inAccount = await adapter.devices({ customerKey: this.deps.customerKey });
      if (account === "connected") await this.doorCheck("host");
    } catch {
      account = "unknown";
    }
    // A saved lock account that no longer shows up at all (removed in the partner's console, with its devices and
    // codes) is a disconnect too: the host hears it and gets a sign-in link. Signing in again re-homes the codes.
    const vanished = account === "none" ? await this.accountVanished() : undefined;
    const base = this.status();
    if (base.isError || !base.structured) return base;
    const file = this.door().locks();
    const taken = new Set([...file.devices.map((device) => device.id), ...this.deps.otherDevices()]);
    const available = inAccount.filter((device) => !taken.has(device.id)).map((device) => ({ id: device.id, name: device.name, kind: device.kind, online: device.online }));
    const structured = { ...base.structured, account, available };
    if (vanished) {
      return ok({ ...structured, ...(vanished.url ? { url: vanished.url } : {}), next: vanished.url ? `The host's lock account is gone: it no longer shows up, so codes can't be made or changed. Send the host this sign-in link: ${vanished.url} They sign in there, never in chat. Once they do, call get_locks again: everyone's codes go back on the doors with the same times.` : "The host's lock account is gone: it no longer shows up, so codes can't be made or changed. I couldn't make a sign-in link just now. Call connect_lock in a minute for one." });
    }
    if (account === "disconnected") {
      return ok({ ...structured, next: "The host's lock account is still disconnected, so codes can't be made or changed. Send a fresh sign-in link with connect_lock. If they signed in and it still shows disconnected, call connect_lock with fresh: true: it removes the stuck connection, with the host's yes, and gives a new link. Codes already made go back on the doors once they show up." });
    }
    const unmatched = (file.rehomeNeeded ?? []).map((id) => file.devices.find((device) => device.id === id)?.name ?? "a door");
    if (unmatched.length > 0) {
      return ok({ ...structured, next: `After the reconnect, ${unmatched.join(" and ")} isn't in the lock account under its old id, and I can't tell which lock it is now. Until the host picks the doors again, visits use the saved door code. Ask which locks the cleaner and pros go through, then call save_locks with those ids from available. Everyone's codes go back on them.` });
    }
    if (base.structured.connected === true || (base.structured.problems as string[]).length > 0) return ok(structured);
    return ok({ ...structured, next: setupNext(account === "connected" ? "connected" : account, available, inAccount.length) });
  }

  /**
   * get_locks found no lock account on a property that was on connected locks: marks the disconnect (so the lock
   * clock re-homes once the account is back, and the host hears that), tells the host any pause once, and makes a
   * sign-in link. Undefined when the property never had connected locks.
   */
  private async accountVanished(): Promise<{ url?: string } | undefined> {
    const door = this.door();
    const file = door.locks();
    if (!file.activeAt || file.devices.length === 0) return undefined;
    const at = file.disconnectedAt ?? this.deps.now().toISOString();
    const notes = markDisconnected(file, at, `vanished:${at}`);
    door.saveLocks(file);
    const told = onceNotes(door, notes);
    if (told.length > 0) await this.deps.tell?.(told);
    try {
      return { url: (await lockAdapter()!.connectLink({ customerKey: this.deps.customerKey, kind: "locks" })).url };
    } catch {
      return {};
    }
  }

  /**
   * A single-use sign-in link for the host's lock (or sensor) account. Not a secret, but it names the account.
   * `fresh: true`, with the host's yes, first removes a connection the partner still lists as disconnected (#280 22).
   */
  async connectLink(input: { kind?: unknown; fresh?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const kind = input.kind === "sensors" ? "sensors" : "locks";
    if (input.fresh === true) {
      let stuck: string[];
      try {
        stuck = (await lockAdapter()!.accounts({ customerKey: this.deps.customerKey })).filter((account) => account.disconnected).map((account) => account.id);
      } catch {
        return fail("I couldn't reach the host's lock account just now. Try again in a minute.");
      }
      if (stuck.length === 0) return fail("The lock account isn't stuck, so there's nothing to remove. connect_lock without fresh gives a sign-in link if the host needs one.");
      const gate = this.confirm("locks-fresh", stuck.join(","), typeof input.confirmation === "string" ? input.confirmation : undefined, "Remove the stuck connection to your lock account and start a new sign-in? Codes already made go back on your doors once they show up again.");
      if (gate !== "go") return gate;
      for (const accountId of stuck) await lockAdapter()!.removeAccount({ customerKey: this.deps.customerKey, accountId });
    }
    const link = await lockAdapter()!.connectLink({ customerKey: this.deps.customerKey, kind });
    const file = this.door().locks();
    if (!file.customerKey) this.door().saveLocks({ ...file, customerKey: this.deps.customerKey });
    return ok({ url: link.url, next: `Send the host this link. They sign in to their ${kind === "sensors" ? "thermostat or noise sensor" : "lock"} account there, never in chat. Then call get_locks to see their devices.` });
  }

  /**
   * Which devices are this property's, and which locks the cleaner and pros go through. The property
   * switches to connected locks only when every such door is a connected lock (otherDoors false) and
   * the alerts routine works. Two calls, with the host's yes. `off: true` switches back to the saved code.
   */
  async saveLocks(input: { doors?: unknown; sensors?: unknown; otherDoors?: unknown; off?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const confirmation = typeof input.confirmation === "string" ? input.confirmation : undefined;
    const door = this.door();
    if (input.off === true) {
      const gate = this.confirm("locks-off", "off", confirmation, "Switch this property back to your saved door code? I'll remove every per-visit code here.");
      if (gate !== "go") return gate;
      const file = door.locks();
      for (const flow of ["cleaning", "repair", "standing", "bring-in", "visit"] as const) await door.syncGrants(flow, []);
      const { activeAt: _off, ...rest } = file;
      door.saveLocks({ ...rest, release: { ...file.release, cleaners: "ask" } });
      if (file.activeAt) recordLockConnection(this.root, false, () => this.deps.now());
      recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "locks-off" });
      return ok({ connected: false, next: "This property uses the saved door code again." });
    }
    const doors = Array.isArray(input.doors) ? input.doors.filter((id): id is string => typeof id === "string") : [];
    const sensors = Array.isArray(input.sensors) ? input.sensors.filter((id): id is string => typeof id === "string") : [];
    if (doors.length === 0) return fail("Name the locks the cleaner and pros go through, by their ids from get_locks.");
    const listed = await lockAdapter()!.devices({ customerKey: this.deps.customerKey });
    const byId = new Map(listed.map((device) => [device.id, device]));
    const others = new Set(this.deps.otherDevices());
    for (const id of [...doors, ...sensors]) {
      if (!byId.has(id)) return fail("That device isn't in the host's connected account. Call get_locks for the ids.");
      if (others.has(id)) return fail(`${byId.get(id)!.name} is already on another property. A device belongs to one property.`);
    }
    if (doors.some((id) => byId.get(id)!.kind !== "lock")) return fail("Only a lock can be a door. Pass thermostats and noise sensors as sensors.");
    const names = doors.map((id) => byId.get(id)!.name).join(", ");
    const gate = this.confirm("locks-save", JSON.stringify([doors, sensors, input.otherDoors === true]), confirmation, `Use ${names} for the cleaner's and pros' codes${sensors.length > 0 ? `, and keep an eye on ${sensors.map((id) => byId.get(id)!.name).join(", ")}` : ""}?`);
    if (gate !== "go") return gate;
    const before = door.locks();
    const file: DoorLocksFile = {
      ...before,
      customerKey: this.deps.customerKey,
      devices: [...doors, ...sensors].map((id) => storedDevice(byId.get(id)!, before.devices.find((item) => item.id === id))),
      doors: input.otherDoors === true ? [...doors, "other"] : doors,
    };
    delete file.blockedBy;
    delete file.rehomeNeeded;
    // Doors the lock account no longer lists, replaced by new ones (#280 22): live codes move to the picked door of the same name with the same digits; a gone door with no clear pair has its codes made again.
    const gone = before.doors.filter((id) => id !== "other" && !byId.has(id));
    const added = doors.filter((id) => !before.doors.includes(id));
    const { moves } = pairPicked(before.devices.filter((item) => gone.includes(item.id)), added.map((id) => byId.get(id)!));
    const unpaired = gone.filter((id) => !moves[id]);
    if (!allDoorsConnected(file)) {
      file.blockedBy = "mixed-doors";
      delete file.activeAt;
      door.saveLocks(file);
      return ok({ connected: false, next: "Not every door the cleaner and pros use is a connected lock, so this property keeps the saved door code. Tell the host why: one code per visit only works when every door takes it." });
    }
    if (!(await this.deps.alertsWorking())) {
      file.blockedBy = "no-alerts";
      delete file.activeAt;
      door.saveLocks(file);
      return ok({ connected: false, next: "The locks are saved, but they switch on only once the alerts routine works, so a lock problem reaches the host in chat. Set up the alerts routine, then call save_locks again." });
    }
    const switchedOn = !file.activeAt;
    const at = this.deps.now().toISOString();
    file.activeAt ??= at;
    door.saveLocks(file);
    if (Object.keys(moves).length > 0) await door.grants().rehome(moves);
    if (unpaired.length > 0) await door.grants().revokeOn(unpaired);
    // Visit records count a lock as connected from the latest connection line.
    if (switchedOn) recordLockConnection(this.root, true, () => this.deps.now());
    recordHostStep(this.root, { at, kind: "locks-on", about: names });
    return ok({ connected: true, next: "Connected. From the next booked visit, each cleaner and pro gets their own code. Ask the host how codes should go out, and call lock_settings." });
  }

  /** How codes go out, cleaners and pros apart, and how a pro who runs late gets more time. Two calls. */
  async settings(input: { cleaners?: unknown; pros?: unknown; packages?: unknown; extend?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const door = this.door();
    const file = door.locks();
    const mode = (value: unknown, current: ReleaseMode): ReleaseMode => (value === "automatic" ? "automatic" : value === "ask" ? "ask" : current);
    const next = { cleaners: mode(input.cleaners, file.release.cleaners), pros: mode(input.pros, file.release.pros), extend: mode(input.extend, file.extend) };
    // A package helper's bring-in code (#241): asked about only when the host names it or already chose automatic.
    const packages = input.packages === undefined && file.release.packages === undefined ? undefined : mode(input.packages, packagesRelease(file));
    if (next.cleaners === "automatic" && (!door.connected() || !this.deps.cleaningOn())) return fail("The cleaner's code can go at checkout time only on a property with connected locks and Cleaner Core on.");
    const words = [
      next.cleaners === "automatic" ? "the cleaner's code goes out at checkout without waiting for you" : "the cleaner's code waits for your \"guests have left\"",
      next.pros === "automatic" ? "a pro's code shows when they reach the door in their window" : "each pro's code waits for your OK",
      next.extend === "automatic" ? "a pro still inside gets 30 more minutes" : "I'll ask before giving a pro more time",
      ...(packages === undefined ? [] : [packages === "automatic" ? "whoever brings in a package gets their code by text once it's at the door" : "the code for whoever brings in a package waits for your OK"]),
    ];
    const question = `Just to check: ${words.join("; ")}. Okay?`;
    const gate = this.confirm("locks-settings", JSON.stringify({ ...next, ...(packages ? { packages } : {}) }), typeof input.confirmation === "string" ? input.confirmation : undefined, question);
    if (gate !== "go") return gate;
    door.saveLocks({ ...file, release: { cleaners: next.cleaners, pros: next.pros, ...(packages ? { packages } : {}) }, extend: next.extend });
    recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "lock-settings" });
    return ok({ ...next, ...(packages ? { packages } : {}), next: "Saved." });
  }

  private standing(file: DoorLocksFile): StandingPerson[] {
    return (file.standing ?? []).filter((person) => !person.removedAt);
  }

  private saveStanding(file: DoorLocksFile, people: StandingPerson[]): void {
    this.door().saveLocks({ ...file, standing: people });
  }

  private allStanding(file: DoorLocksFile): StandingPerson[] {
    return file.standing ?? [];
  }

  /**
   * A standing code for the host or a person they name. Naming them, with the host's yes, is the yes
   * for the code. The person gets one text asking them to reply YES; nothing else until they do. For
   * the host (owner) with no phone given, their confirmed number on file is used, named by its last
   * four, so they never type it.
   */
  async addStanding(input: { name?: unknown; phone?: unknown; role?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const door = this.door();
    if (!door.connected()) return fail("Standing codes need connected locks here first.");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const role: StandingRole | undefined = input.role === "owner" || input.role === "co-owner" || input.role === "co-host" ? input.role : undefined;
    if (!name || name.length > 60 || /\d{4,}/.test(name)) return fail("Give the person's name, with no numbers in it.");
    if (!role) return fail("Say who they are: owner (the host), co-owner, or co-host.");
    const typed = typeof input.phone === "string" && input.phone.trim() !== "";
    let phone = typed ? normalizePhone(input.phone as string) : undefined;
    if (typed && !phone) return fail("That isn't a mobile number I can use. Ask for it with its country code, like +1 555 555 0142.");
    const onFile = role === "owner" ? await this.deps.hostPhone?.() : undefined;
    if (!phone) {
      if (role !== "owner") return fail(`Ask the host for ${name}'s mobile number, with its country code.`);
      if (!onFile) return fail("I don't have the host's confirmed mobile on file for this property. Ask them for the number to use, and pass it as phone.");
      phone = onFile;
    }
    const own = role === "owner" && phone === onFile;
    const file = door.locks();
    if (this.standing(file).some((person) => person.phone === phone)) return fail(own ? "The host already has a standing code here. get_locks shows where it is." : `${name} already has a standing code here.`);
    const question = own
      ? `Give you your own standing door code at ${this.street()}? I'll text a private link to your number ending ${phone.slice(-4)}.`
      : `Give ${name} their own standing door code at ${this.street()}? They get one text asking them to reply YES first.`;
    const gate = this.confirm("locks-standing", JSON.stringify([name, phone, role]), typeof input.confirmation === "string" ? input.confirmation : undefined, question);
    if (gate !== "go") return gate;
    const person: StandingPerson = { id: `std_${letters(10)}`, name, phone, role, addedAt: this.deps.now().toISOString() };
    // The host's own code on their confirmed number (#280 decision 1): their yes in chat is the YES, so
    // no opt-in text goes; the code is made and the private link goes to that number at once.
    if (own) person.yesAt = person.addedAt;
    this.saveStanding(file, [...this.allStanding(file), person]);
    recordHostStep(this.root, { at: person.addedAt, kind: "standing-add", about: name, ref: person.id });
    if (own) {
      await this.syncStanding();
      const linkSent = await this.sendLink(person.id);
      return ok({
        id: person.id,
        invited: false,
        linkSent,
        next: linkSent
          ? `The host's code is going on the lock, and the private link to it went to their number ending ${phone.slice(-4)}.`
          : "The host's code is going on the lock, but the private link couldn't be texted just now. Call standing_code_link to send it again.",
      });
    }
    const result = await this.invite(person.id);
    return ok({ id: person.id, invited: result === "sent", ...(result === "sent" ? {} : { waiting: result }), next: inviteNext(result, own ? "the host" : name) });
  }

  /** The one opt-in text. Never twice (unless the host asks again), never to a STOP. Marked sent only once it went. */
  private readonly inviting = new Set<string>();

  private async invite(id: string, again = false): Promise<InviteResult> {
    if (this.inviting.has(id)) return "already";
    this.inviting.add(id);
    try {
      const person = this.allStanding(this.door().locks()).find((item) => item.id === id);
      if (!person || person.removedAt || person.yesAt || (person.invitedAt && !again)) return "already";
      if (person.stoppedAt || this.deps.stopped(person.phone)) return "opted-out";
      if (!(await this.deps.textsAllowed())) return "texts-off";
      let sent = false;
      try {
        sent = await this.deps.send(person.phone, `This is the text line for ${this.street()}. The host wants to give you your own door code there. Reply YES to get a private link to it, or STOP to opt out.`);
      } catch {
        sent = false;
      }
      const file = this.door().locks();
      const all = this.allStanding(file);
      const mine = all.find((item) => item.id === id);
      if (mine) {
        const at = this.deps.now().toISOString();
        if (sent) {
          mine.invitedAt ??= at;
          if (again) mine.reinvitedAt = at;
          delete mine.inviteTriedAt;
          delete mine.inviteTries;
        } else {
          mine.inviteTriedAt = at;
          mine.inviteTries = (mine.inviteTries ?? 0) + 1;
        }
        this.saveStanding(file, all);
      }
      return sent ? "sent" : "send-failed";
    } finally {
      this.inviting.delete(id);
    }
  }

  /**
   * The clock pass for standing codes: an invite that couldn't go yet (texts not on, or a send that
   * failed) goes once it can, so nobody removes and remakes a code; and each code after its YES is
   * kept on the locks, a door that refused it tried again. Notes go to the host once each.
   */
  async standingClock(): Promise<GrantNote[]> {
    if (!this.available()) return [];
    const now = this.deps.now().getTime();
    const notes: GrantNote[] = [];
    for (const person of this.standing(this.door().locks())) {
      if (person.invitedAt || person.yesAt || person.stoppedAt) continue;
      if ((person.inviteTries ?? 0) >= INVITE_TRIES) continue;
      if (person.inviteTriedAt && now - Date.parse(person.inviteTriedAt) < INVITE_RETRY_MS) continue;
      const result = await this.invite(person.id);
      const after = this.standing(this.door().locks()).find((item) => item.id === person.id);
      if (result === "send-failed" && (after?.inviteTries ?? 0) >= INVITE_TRIES) {
        notes.push({ id: `lock:standing-invite:${person.id}`, text: `The text asking ${person.name} to reply YES for their standing code couldn't go out after several tries. Check the number with the host; standing_code_link tries once more.` });
      }
    }
    if (this.standing(this.door().locks()).some((person) => person.yesAt && !person.stoppedAt)) notes.push(...(await this.syncStanding(false)));
    await this.tellHost(notes);
    return notes;
  }

  private async tellHost(notes: readonly GrantNote[] | undefined): Promise<void> {
    if (!notes || notes.length === 0 || !this.deps.tell) return;
    try {
      await this.deps.tell([...notes]);
    } catch {
      // The note waits for the next pass: the grant keeps its state.
    }
  }

  /**
   * A text from a phone with a standing code here. Only YES and STOP are this desk's: YES (after the
   * invite) makes the code on the locks and texts a single-use link; STOP removes the code. Anything
   * else is left for the property's flows. Never replies with a code.
   */
  async standingText(from: string, text: string): Promise<boolean> {
    const file = this.door().locks();
    const all = this.allStanding(file);
    const person = all.find((item) => item.phone === from && !item.removedAt);
    if (!person) return false;
    const word = text.trim().toLowerCase().replace(/[.!]+$/, "");
    if (["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(word)) {
      person.stoppedAt = this.deps.now().toISOString();
      delete person.link;
      this.saveStanding(file, all);
      await this.syncStanding();
      return false;
    }
    if (word !== "yes" || !person.invitedAt || person.yesAt) return false;
    person.yesAt = this.deps.now().toISOString();
    this.saveStanding(file, all);
    await this.syncStanding();
    await this.sendLink(person.id);
    return true;
  }

  private wantedStanding(person: StandingPerson) {
    return { jobId: person.id, person: person.phone, label: person.name, who: person.role === "owner" ? ({ role: "host" } as const) : ({ role: "shared" } as const), window: standingWindow(person) };
  }

  /** The standing codes on the locks: each named person after their YES, not stopped or removed. A note for the host goes on (once each) unless the caller tells it. */
  async syncStanding(tell = true): Promise<GrantNote[]> {
    const door = this.door();
    const wanted = this.standing(door.locks())
      .filter((person) => person.yesAt && !person.stoppedAt)
      .map((person) => this.wantedStanding(person));
    const notes = await door.syncGrants("standing", wanted);
    if (tell) await this.tellHost(notes);
    return notes;
  }

  /** Texts a new single-use link, after the person's YES. The link holds a letters-only token, never the code. */
  private async sendLink(id: string): Promise<boolean> {
    const base = this.deps.publicBase();
    if (!base || !(await this.deps.textsAllowed())) return false;
    const file = this.door().locks();
    const all = this.allStanding(file);
    const person = all.find((item) => item.id === id);
    if (!person?.yesAt || person.stoppedAt || person.removedAt || this.deps.stopped(person.phone)) return false;
    const token = letters(40);
    person.link = { hash: hashOf(token), expiresAt: new Date(this.deps.now().getTime() + STANDING_LINK_HOURS * 3600_000).toISOString(), sentAt: this.deps.now().toISOString() };
    this.saveStanding(file, all);
    try {
      return await this.deps.send(person.phone, `Here's your private link to your door code at ${this.street()}. It works once, in the next ${STANDING_LINK_HOURS} hours: ${base}${STANDING_PAGE_PREFIX}${token}`);
    } catch {
      return false;
    }
  }

  /**
   * A new page link for a standing code, with the host's yes, only after the person's own YES. Before
   * their YES it sends the invite again instead (at most once an hour), so a code whose invite never
   * arrived needs no remove and remake.
   */
  async newLink(input: { id?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const person = this.standing(this.door().locks()).find((item) => item.id === input.id);
    if (!person) return fail("No standing code with that id. Call get_locks.");
    if (person.stoppedAt || this.deps.stopped(person.phone)) return fail(`${person.name} opted out of texts from this line (they replied STOP). Only their own START by text turns that back on. ${NO_CONSENT_TOOL}`);
    const confirmation = typeof input.confirmation === "string" ? input.confirmation : undefined;
    if (!person.yesAt) {
      const last = person.reinvitedAt ? Date.parse(person.reinvitedAt) : 0;
      if (this.deps.now().getTime() - last < 3600_000) return fail(`The invite went to ${person.name} again within the hour. Give it time; they reply YES to it.`);
      const gate = this.confirm("locks-standing-invite", person.id, confirmation, `Text ${person.name} the invite again, asking them to reply YES for their door code?`);
      if (gate !== "go") return gate;
      const result = await this.invite(person.id, true);
      if (result === "sent") recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "standing-invite", about: person.name, ref: person.id });
      return result === "sent" ? ok({ sent: true, next: `${person.name} got the invite again. Their code link goes once they reply YES.` }) : ok({ sent: false, waiting: result, next: inviteNext(result, person.name) });
    }
    const gate = this.confirm("locks-standing-link", person.id, confirmation, `Text ${person.name} a new private link to their door code?`);
    if (gate !== "go") return gate;
    const sent = await this.sendLink(person.id);
    if (sent) recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "standing-link", about: person.name, ref: person.id });
    return sent ? ok({ sent: true, next: `${person.name} got a new link. The old one no longer works.` }) : fail(`The link couldn't go to ${person.name} now.`);
  }

  /** Removes a standing code from the locks, with the host's yes. */
  async removeStanding(input: { id?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const file = this.door().locks();
    const all = this.allStanding(file);
    const person = all.find((item) => item.id === input.id && !item.removedAt);
    if (!person) return fail("No standing code with that id. Call get_locks.");
    const gate = this.confirm("locks-standing-remove", person.id, typeof input.confirmation === "string" ? input.confirmation : undefined, `Remove ${person.name}'s standing door code?`);
    if (gate !== "go") return gate;
    person.removedAt = this.deps.now().toISOString();
    delete person.link;
    this.saveStanding(file, all);
    recordHostStep(this.root, { at: person.removedAt, kind: "standing-remove", about: person.name, ref: person.id });
    await this.syncStanding();
    return ok({ removed: true, next: `${person.name}'s code is removed from the locks.` });
  }

  /** Whether a page token is live: for showing the page. Reads only. */
  pageOpen(token: string): { name: string; street: string } | undefined {
    const person = this.byToken(token);
    return person ? { name: person.name, street: this.street() } : undefined;
  }

  private byToken(token: string): StandingPerson | undefined {
    if (!/^[a-z]{40}$/.test(token)) return undefined;
    const hash = hashOf(token);
    const now = this.deps.now().getTime();
    return this.standing(this.door().locks()).find((person) => person.link && !person.link.usedAt && !person.stoppedAt && sameHash(hash, person.link.hash) && now < Date.parse(person.link.expiresAt));
  }

  /**
   * The page's "show my code": the person's code, once. The link is used up only when the code is
   * shown. While the code is still going on the lock the link keeps working ("pending"); a lock that
   * refused it is "failed", and the host hears it once. The caller never logs the code.
   */
  async showCode(token: string): Promise<CodeShown> {
    const person = this.byToken(token);
    if (!person) return { ok: false, reason: "gone" };
    const door = this.door();
    let state = await door.checkGrant("standing", person.id);
    if (state === "none" || state === "failed") {
      // Nothing on the lock yet, or a door that didn't take it (the YES-time try didn't reach it): try now, and the page says to wait.
      await this.syncStanding();
      state = await door.checkGrant("standing", person.id);
    }
    if (state === "failed") {
      await this.tellHost([issueFailedNote("standing", this.wantedStanding(person))]);
      return { ok: false, reason: "failed" };
    }
    if (state !== "set") return { ok: false, reason: "pending" };
    // Claimed before the release, so two taps can't both show it; given back when nothing shows.
    if (!this.useLink(person.id, token, true)) return { ok: false, reason: "gone" };
    const grant = await door.request({ person: person.phone, window: standingWindow(person), purpose: "standing", jobId: person.id, label: person.name });
    await this.tellHost(grant.notes);
    if (!grant.ok) {
      this.useLink(person.id, token, false);
      return { ok: false, reason: "failed" };
    }
    return { ok: true, code: grant.code, ...(grant.doors ? { doors: grant.doors } : {}) };
  }

  /** Marks the link used (or gives it back). False when it was used in the meantime. */
  private useLink(id: string, token: string, use: boolean): boolean {
    const file = this.door().locks();
    const all = this.allStanding(file);
    const mine = all.find((item) => item.id === id);
    if (!mine?.link || !sameHash(hashOf(token), mine.link.hash)) return false;
    if (use) {
      if (mine.link.usedAt) return false;
      mine.link = { ...mine.link, usedAt: this.deps.now().toISOString() };
    } else {
      const { usedAt: _given, ...rest } = mine.link;
      mine.link = rest;
    }
    this.saveStanding(file, all);
    return true;
  }

  /** The owners' standing codes, for the hours log: the grant ids whose unlocks are the host's own. */
  ownerCodes(): string[] {
    return this.standing(this.door().locks()).filter((person) => person.role === "owner").map((person) => person.id);
  }
}

/** A mobile number as E.164, or undefined. */
export function normalizePhone(raw: string): string | undefined {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return undefined;
}

/** Where a standing code is on the locks, from the kept statuses: set, programming, failed, or none yet. */
function standingOnLock(door: DoorAccess, id: string): "set" | "programming" | "failed" | "none" {
  const grant = door.grants().live("standing", id);
  if (!grant || grant.doors.length === 0) return "none";
  if (grant.doors.some((item) => item.status === "failed" || item.status === "removed")) return "failed";
  return grant.doors.every((item) => item.status === "set" || item.status === "backup") ? "set" : "programming";
}

/** A standing code's window: from the person's YES, with no end the lock needs to know about. */
function standingWindow(person: StandingPerson): { from: string; until: string } {
  return { from: person.yesAt!, until: new Date(Date.parse(person.yesAt!) + STANDING_YEARS * 365 * 24 * 3600_000).toISOString() };
}

/** What the agent tells the host about an invite, by why it did or didn't go. */
function inviteNext(result: InviteResult, name: string): string {
  if (result === "sent") return `${name.charAt(0).toUpperCase()}${name.slice(1)} got one text asking them to reply YES. Their code link goes once they do.`;
  if (result === "opted-out") return `${name} opted out of texts from this line (they replied STOP), so no invite went. Only their own START by text turns that back on. ${NO_CONSENT_TOOL}`;
  if (result === "texts-off") return `No invite went yet: this property's texts wait until the host's own phone is confirmed for this account. The invite goes on its own once it is. ${NO_CONSENT_TOOL}`;
  if (result === "send-failed") return `The invite text to ${name} didn't go out just now. I'll try again on my own in a few minutes, and tell you if it still can't go. ${NO_CONSENT_TOOL}`;
  return `The invite to ${name} already went. They reply YES to it.`;
}

function standingStatus(person: StandingPerson, now: Date): string {
  if (person.stoppedAt) return "opted-out";
  if (!person.invitedAt) return person.inviteTriedAt ? "invite-not-sent-yet" : "not-texted";
  if (!person.yesAt) return "waiting-for-yes";
  if (person.link?.usedAt) return "code-seen";
  if (person.link && now.getTime() >= Date.parse(person.link.expiresAt)) return "link-expired";
  if (person.link) return "link-sent";
  return "on-locks";
}

/** The standing people saved in a property's lock settings. */
export function standingPeople(root: string): StandingPerson[] {
  return (readDoorLocks(root).standing ?? []).filter((person) => !person.removedAt);
}
