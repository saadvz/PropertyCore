import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * An account's people, held once for all its properties (saadvz/PropertyCore#190): the cleaner and contacts,
 * with the properties they're on, their one YES, and their own STOP. Kept in people.json in the account
 * folder. Each property's desk keeps its own roles and setup; this list holds who the person is and what
 * they agreed to. The landlord's phone is never a person here: it is kept per property for routing only.
 * Reads and writes are synchronous on an in-memory copy, so writes never interleave. Sends nothing.
 */

export const PEOPLE_FILE = "people.json";

export type Role = "cleaner" | "co-host" | "assistant" | "observer" | "pro";

export interface Person {
  phone: string;
  /** The latest name the host gave. */
  name?: string;
  /** The person's YES, once, for every property they're on. */
  optedIn?: { at: string; propertyId: string };
  /** The person's own STOP, for every property. START removes it. */
  stopped?: { at: string };
  /** The property whose invite is out, until the YES. */
  invitedFrom?: string;
  /** One entry per property and role: a person can be a pro and, say, the cleaner on the same property. */
  where: { propertyId: string; role: Role }[];
}

export interface PeopleFile {
  schemaVersion: 1;
  people: Person[];
  /** propertyId → the landlord's phone, for routing only. */
  hosts: Record<string, string>;
  /** Set when the move from the older files finished. */
  movedAt?: string;
}

/** What changed for one person, for every property they're on to apply. `from` already has it. */
export type PersonChange = { phone: string; kind: "opted-in" | "stopped" | "started"; from?: string; properties: string[] };

/** One property's people and consent from the older files, for the one-time move. */
export interface MoveSource {
  propertyId: string;
  host?: string;
  people: { phone: string; role: Role; name?: string }[];
  /** Phones that opted out of the line. */
  stopped: string[];
  /** Phones the property's engine has "in". */
  optedIn: string[];
  /** Phones the property's engine has "out". */
  optedOut: string[];
}

const PROPERTY_ID = /^prp_[a-z0-9]{10}$/;

/** The account folder and property id of a property folder (…/tenants/<id>/properties/<pid>), else undefined. */
export function accountOf(propertyRoot: string): { accountRoot: string; propertyId: string } | undefined {
  const propertyId = basename(propertyRoot);
  const parent = dirname(propertyRoot);
  if (!PROPERTY_ID.test(propertyId) || basename(parent) !== "properties") return undefined;
  return { accountRoot: dirname(parent), propertyId };
}

/** The street part of an address: the text before its first comma. */
export function streetOf(address: string): string {
  return address.split(",")[0]!.trim();
}

const lists = new Map<string, People>();

export function peopleFor(accountRoot: string, deps: { now(): Date }): People {
  const existing = lists.get(accountRoot);
  if (existing) return existing;
  const people = new People(accountRoot, deps);
  lists.set(accountRoot, people);
  return people;
}

export function forgetPeople(accountRoot: string): void {
  lists.delete(accountRoot);
}

export function resetPeople(): void {
  lists.clear();
}

function emptyFile(): PeopleFile {
  return { schemaVersion: 1, people: [], hosts: {} };
}

export class People {
  private file: PeopleFile;
  private listener: ((change: PersonChange) => Promise<void>) | undefined;
  /**
   * people.json couldn't be read. The list fails closed: every phone reads as stopped, nobody reads as
   * opted in, no invite is claimed, and the file is kept as it is for the operator, never overwritten.
   */
  private readonly broken: boolean;

  constructor(
    readonly accountRoot: string,
    private readonly deps: { now(): Date },
  ) {
    let broken = false;
    try {
      this.file = this.read();
    } catch {
      broken = true;
      this.file = { ...emptyFile(), movedAt: deps.now().toISOString() };
    }
    this.broken = broken;
  }

  private read(): PeopleFile {
    const path = join(this.accountRoot, PEOPLE_FILE);
    if (!existsSync(path)) return emptyFile();
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PeopleFile>;
    return { ...emptyFile(), ...raw, people: raw.people ?? [], hosts: raw.hosts ?? {} };
  }

  private save(): void {
    if (this.broken) return;
    mkdirSync(this.accountRoot, { recursive: true });
    writeJsonAtomic(join(this.accountRoot, PEOPLE_FILE), this.file);
  }

  private at(): string {
    return this.deps.now().toISOString();
  }

  /** The person's entry, made when missing. Not saved here. */
  private entry(phone: string): Person {
    let person = this.file.people.find((p) => p.phone === phone);
    if (!person) {
      person = { phone, where: [] };
      this.file.people.push(person);
    }
    return person;
  }

  person(phone: string): Person | undefined {
    const person = this.file.people.find((p) => p.phone === phone);
    return person ? { ...person, where: [...person.where] } : undefined;
  }

  /** Every person on the account, as copies. */
  everyone(): Person[] {
    return this.file.people.map((person) => ({ ...person, where: [...person.where] }));
  }

  /** The properties the person is on in a Cleaner Core role, once each. A pro-only entry is not listed. */
  propertiesOf(phone: string): string[] {
    const where = this.file.people.find((p) => p.phone === phone)?.where ?? [];
    return [...new Set(where.filter((w) => w.role !== "pro").map((w) => w.propertyId))];
  }

  /** The person's first non-pro role on the property, else "pro" when they are only a pro there. */
  roleOn(phone: string, propertyId: string): Role | undefined {
    const roles = this.rolesOn(phone, propertyId);
    return roles.find((role) => role !== "pro") ?? roles[0];
  }

  /** Every role the person holds on the property, in the order saved. */
  rolesOn(phone: string, propertyId: string): Role[] {
    return this.file.people.find((p) => p.phone === phone)?.where.filter((w) => w.propertyId === propertyId).map((w) => w.role) ?? [];
  }

  hostOf(propertyId: string): string | undefined {
    return this.file.hosts[propertyId];
  }

  stopped(phone: string): boolean {
    if (this.broken) return true;
    return !!this.file.people.find((p) => p.phone === phone)?.stopped;
  }

  optedIn(phone: string): boolean {
    if (this.broken) return false;
    return !!this.file.people.find((p) => p.phone === phone)?.optedIn;
  }

  /** True while another property's invite to this person is out and they haven't said YES. */
  invitedElsewhere(phone: string, propertyId: string): boolean {
    const person = this.file.people.find((p) => p.phone === phone);
    if (!person || person.optedIn || !person.invitedFrom || person.invitedFrom === propertyId) return false;
    return person.where.some((w) => w.propertyId === person.invitedFrom);
  }

  /**
   * Sets who is on this property in the non-pro roles. Anyone not in `people` loses those roles here; their
   * entry stays. Every pro entry is left alone, and a pro passed in `people` is ignored: pros are saved
   * through saveRolePeople.
   */
  savePropertyPeople(propertyId: string, host: string | undefined, people: { phone: string; role: Role; name?: string }[]): void {
    if (host) this.file.hosts[propertyId] = host;
    else delete this.file.hosts[propertyId];
    const wanted = new Map(people.filter((p) => p.phone !== host && p.role !== "pro").map((p) => [p.phone, p]));
    for (const person of this.file.people) {
      if (wanted.has(person.phone)) continue;
      person.where = person.where.filter((w) => w.propertyId !== propertyId || w.role === "pro");
      if (person.invitedFrom === propertyId && !person.where.some((w) => w.propertyId === propertyId)) delete person.invitedFrom;
    }
    for (const saved of wanted.values()) {
      const person = this.entry(saved.phone);
      if (saved.name) person.name = saved.name;
      const here = person.where.find((w) => w.propertyId === propertyId && w.role !== "pro");
      if (here) here.role = saved.role;
      else person.where.push({ propertyId, role: saved.role });
    }
    this.save();
  }

  /** Replaces exactly this role's entries on the property with `people`. Other roles are left alone. */
  saveRolePeople(propertyId: string, role: "pro", people: { phone: string; name?: string }[]): void {
    const host = this.file.hosts[propertyId];
    const wanted = new Map(people.filter((p) => p.phone !== host).map((p) => [p.phone, p]));
    for (const person of this.file.people) {
      if (wanted.has(person.phone)) continue;
      person.where = person.where.filter((w) => !(w.propertyId === propertyId && w.role === role));
    }
    for (const saved of wanted.values()) {
      const person = this.entry(saved.phone);
      if (saved.name) person.name = saved.name;
      if (!person.where.some((w) => w.propertyId === propertyId && w.role === role)) person.where.push({ propertyId, role });
    }
    this.save();
  }

  /**
   * True when this property may send the person's invite, and records that it is the one sending it.
   * Checked and recorded in one step, so two properties can't both send it. False once they said YES,
   * while they're stopped, or while another property's invite to them is out.
   */
  claimInvite(phone: string, propertyId: string): boolean {
    if (this.broken) return false;
    const person = this.file.people.find((p) => p.phone === phone);
    if (!person) return true;
    if (person.optedIn || person.stopped) return false;
    if (person.invitedFrom && person.invitedFrom !== propertyId && person.where.some((w) => w.propertyId === person.invitedFrom)) return false;
    if (person.invitedFrom !== propertyId) {
      person.invitedFrom = propertyId;
      this.save();
    }
    return true;
  }

  markInvited(phone: string, propertyId: string): void {
    const person = this.file.people.find((p) => p.phone === phone);
    if (!person || person.optedIn || person.invitedFrom === propertyId) return;
    if (person.invitedFrom && person.where.some((w) => w.propertyId === person.invitedFrom)) return;
    person.invitedFrom = propertyId;
    this.save();
  }

  optIn(phone: string, propertyId: string): PersonChange | undefined {
    const person = this.entry(phone);
    if (person.optedIn) return undefined;
    person.optedIn = { at: this.at(), propertyId };
    delete person.invitedFrom;
    this.save();
    return { phone, kind: "opted-in", from: propertyId, properties: [...new Set(person.where.map((w) => w.propertyId))] };
  }

  stop(phone: string): PersonChange | undefined {
    const person = this.entry(phone);
    if (person.stopped) return undefined;
    person.stopped = { at: this.at() };
    this.save();
    return { phone, kind: "stopped", properties: [...new Set(person.where.map((w) => w.propertyId))] };
  }

  start(phone: string): PersonChange | undefined {
    const person = this.file.people.find((p) => p.phone === phone);
    if (!person?.stopped) return undefined;
    delete person.stopped;
    this.save();
    return { phone, kind: "started", properties: [...new Set(person.where.map((w) => w.propertyId))] };
  }

  /** The hosted layer's relay, which tells every property's desk about a change. The last one set wins. */
  onChange(relay: (change: PersonChange) => Promise<void>): void {
    this.listener = relay;
  }

  async relay(change: PersonChange | undefined): Promise<void> {
    if (change && this.listener) await this.listener(change);
  }

  moved(): boolean {
    return !!this.file.movedAt;
  }

  /** Builds the list from the older files, once. A second call changes nothing. */
  move(sources: MoveSource[]): void {
    if (this.file.movedAt) return;
    // The landlord is never a person here, even when an older STOP list holds their phone.
    const hosts = new Set(sources.map((source) => source.host).filter((host): host is string => !!host));
    for (const source of sources) {
      if (source.host) this.file.hosts[source.propertyId] = source.host;
      for (const saved of source.people) {
        if (saved.phone === source.host) continue;
        const person = this.entry(saved.phone);
        if (saved.name && !person.name) person.name = saved.name;
        if (!person.where.some((w) => w.propertyId === source.propertyId)) person.where.push({ propertyId: source.propertyId, role: saved.role });
      }
      for (const phone of [...source.stopped, ...source.optedOut]) {
        if (hosts.has(phone)) continue;
        const person = this.entry(phone);
        person.stopped ??= { at: this.at() };
      }
      for (const phone of source.optedIn) {
        const person = this.entry(phone);
        person.optedIn ??= { at: this.at(), propertyId: source.propertyId };
      }
    }
    this.file.movedAt = this.at();
    this.save();
  }
}
