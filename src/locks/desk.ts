import { createHash, randomInt } from "node:crypto";
import { join } from "node:path";
import { hubFor } from "../hub/hub";
import type { DoorAccess, GrantNote } from "../hub/doorAccess";
import { sameHash } from "../hub/uploadCode";
import { ConfirmationBook } from "../operator/confirmations";
import { recordLockConnection } from "./eventLog";
import { lockAdapter, smartLocksOn } from "./registry";
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
}

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

function streetOf(address: string | undefined): string {
  return (address ?? "the property").split(",")[0]!.trim();
}

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
    return smartLocksOn(this.deps.env()) && Boolean(lockAdapter());
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
    for (const device of file.devices) {
      if (!device.online) problems.push(`${device.name} is offline.`);
      if (typeof device.battery === "number" && device.battery < 0.2) problems.push(`${device.name}'s battery is low.`);
    }
    if (file.blockedBy === "mixed-doors") problems.push("Not every door the cleaner and pros use is a connected lock, so the saved door code is used.");
    if (file.blockedBy === "no-alerts") problems.push("Connected locks wait for a working alerts routine.");
    return ok({
      connected: door.connected(),
      devices: file.devices.map((device) => ({ id: device.id, name: device.name, kind: device.kind, online: device.online, ...(typeof device.battery === "number" ? { battery: Math.round(device.battery * 100) } : {}), door: file.doors.includes(device.id) })),
      release: file.release,
      extend: file.extend,
      standing: this.standing(file).map((person) => ({ id: person.id, name: person.name, role: person.role, status: standingStatus(person, this.deps.now()) })),
      codes: door.grants().statuses().filter((grant) => !grant.revoked).map((grant) => ({ flow: grant.flow, jobId: grant.jobId, from: grant.window.from, until: grant.window.until, doors: grant.doors })),
      problems,
      next: problems[0] ?? (door.connected() ? "The locks are connected." : "No lock is connected here. connect_lock gives the host a sign-in link."),
    });
  }

  /** A single-use sign-in link for the host's lock (or sensor) account. Not a secret, but it names the account. */
  async connectLink(input: { kind?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const kind = input.kind === "sensors" ? "sensors" : "locks";
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
      for (const flow of ["cleaning", "repair", "standing", "bring-in"] as const) await door.syncGrants(flow, []);
      const { activeAt: _off, ...rest } = file;
      door.saveLocks({ ...rest, release: { ...file.release, cleaners: "ask" } });
      if (file.activeAt) recordLockConnection(this.root, false, () => this.deps.now());
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
    file.activeAt ??= this.deps.now().toISOString();
    door.saveLocks(file);
    // Visit records count a lock as connected from the latest connection line.
    if (switchedOn) recordLockConnection(this.root, true, () => this.deps.now());
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
   * for the code. The person gets one text asking them to reply YES; nothing else until they do.
   */
  async addStanding(input: { name?: unknown; phone?: unknown; role?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const door = this.door();
    if (!door.connected()) return fail("Standing codes need connected locks here first.");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : undefined;
    const role: StandingRole | undefined = input.role === "owner" || input.role === "co-owner" || input.role === "co-host" ? input.role : undefined;
    if (!name || name.length > 60 || /\d{4,}/.test(name)) return fail("Give the person's name, with no numbers in it.");
    if (!phone) return fail("Give their mobile number with its country code, like +1 555 555 0142.");
    if (!role) return fail("Say who they are: owner (the host), co-owner, or co-host.");
    const file = door.locks();
    if (this.standing(file).some((person) => person.phone === phone)) return fail(`${name} already has a standing code here.`);
    const gate = this.confirm("locks-standing", JSON.stringify([name, phone, role]), typeof input.confirmation === "string" ? input.confirmation : undefined, `Give ${name} their own standing door code at ${this.street()}? They get one text asking them to reply YES first.`);
    if (gate !== "go") return gate;
    const person: StandingPerson = { id: `std_${letters(10)}`, name, phone, role, addedAt: this.deps.now().toISOString() };
    const all = [...this.allStanding(file), person];
    this.saveStanding(file, all);
    const invited = await this.invite(person);
    return ok({ id: person.id, invited, next: invited ? `${name} got one text asking them to reply YES. Their code link goes once they do.` : `${name} can't be texted yet (the host's phone isn't confirmed, or they opted out). Their code waits.` });
  }

  /** The one opt-in text. Never twice, never to a STOP. */
  private async invite(person: StandingPerson): Promise<boolean> {
    if (person.invitedAt || this.deps.stopped(person.phone) || !(await this.deps.textsAllowed())) return false;
    const file = this.door().locks();
    const all = this.allStanding(file);
    const mine = all.find((item) => item.id === person.id);
    if (!mine) return false;
    mine.invitedAt = this.deps.now().toISOString();
    this.saveStanding(file, all);
    try {
      return await this.deps.send(person.phone, `This is the text line for ${this.street()}. The host wants to give you your own door code there. Reply YES to get a private link to it, or STOP to opt out.`);
    } catch {
      return false;
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

  /** The standing codes on the locks: each named person after their YES, not stopped or removed. */
  async syncStanding(): Promise<GrantNote[]> {
    const door = this.door();
    const wanted = this.standing(door.locks())
      .filter((person) => person.yesAt && !person.stoppedAt)
      .map((person) => ({ jobId: person.id, person: person.phone, label: person.name, who: person.role === "owner" ? ({ role: "host" } as const) : ({ role: "shared" } as const), window: { from: person.yesAt!, until: new Date(Date.parse(person.yesAt!) + STANDING_YEARS * 365 * 24 * 3600_000).toISOString() } }));
    return door.syncGrants("standing", wanted);
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

  /** A new page link for a standing code, with the host's yes. Only after the person's own YES. */
  async newLink(input: { id?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(LOCKS_OFF);
    const person = this.standing(this.door().locks()).find((item) => item.id === input.id);
    if (!person) return fail("No standing code with that id. Call get_locks.");
    if (!person.yesAt || person.stoppedAt) return fail(`${person.name} hasn't replied YES, so no link can go yet.`);
    const gate = this.confirm("locks-standing-link", person.id, typeof input.confirmation === "string" ? input.confirmation : undefined, `Text ${person.name} a new private link to their door code?`);
    if (gate !== "go") return gate;
    const sent = await this.sendLink(person.id);
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
   * The page's "show my code": the person's code, once. The link is used up when it's shown. Undefined
   * when the link is used, expired or wrong, or the code isn't on the locks. The caller never logs it.
   */
  async showCode(token: string): Promise<{ code: string; doors?: { door: string; code: string }[] } | undefined> {
    const person = this.byToken(token);
    if (!person) return undefined;
    const door = this.door();
    const file = door.locks();
    const all = this.allStanding(file);
    const mine = all.find((item) => item.id === person.id)!;
    mine.link = { ...mine.link!, usedAt: this.deps.now().toISOString() };
    this.saveStanding(file, all);
    const grant = await door.request({ person: person.phone, window: { from: person.yesAt!, until: new Date(Date.parse(person.yesAt!) + STANDING_YEARS * 365 * 24 * 3600_000).toISOString() }, purpose: "standing", jobId: person.id, label: person.name });
    if (!grant.ok) return undefined;
    return { code: grant.code, ...(grant.doors ? { doors: grant.doors } : {}) };
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

function standingStatus(person: StandingPerson, now: Date): string {
  if (person.stoppedAt) return "opted-out";
  if (!person.invitedAt) return "not-texted";
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
