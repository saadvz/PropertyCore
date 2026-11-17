import { zonedParts } from "../core/timezone";
import { accountOf, peopleFor } from "../hub/people";
import { readHubFile } from "../hub/store";
import { readSupply, type Order, type SupplyFile } from "../supply-core/store";
import { effectiveSeen, PackagesFileError, readPackages, supplyKey, writePackages, type Arrival, type BringInRole, type BringInVisit, type PackagesFile, type SeenHow } from "./store";

/**
 * Package arrivals' desk for one property (#241). Expected deliveries are Supply Core's placed orders, read from
 * `supply.json` on every call and never written there. This desk keeps when each was seen and how, the
 * bring-it-in visit, and the flags the host was told. It texts nobody, the bring-in person included: the
 * result goes back to the host's agent, and the per-visit code waits on the lock connection (#180).
 */

export interface PackageReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface PackageDeps {
  now(): Date;
}

/** Local time at the property after which a package expected that day and not seen is flagged. */
export const END_OF_DAY = "21:00";
/** An order placed longer ago than this is no longer listed. */
export const ARRIVALS_DAYS = 30;
export const MAX_BRING_IN_HOURS = 72;
const SEEN_HOWS: readonly SeenHow[] = ["tracking", "host", "camera"];

export const ASK_HOURS =
  "Ask the host how many hours a package may sit at the door before someone brings it in, from 1 to 72, then call save_package_settings with bringInHours.";
/** The plan_bring_in reply's next step while the per-visit code waits on the lock connection (#180). */
export const CODE_WAITING =
  "Tell the host who is bringing it in and by when. Property Core doesn't text them yet: the bring-in code comes with the lock connection, so for now the host tells them and lets them in their usual way.";
const BRING_IN_ROLES: readonly BringInRole[] = ["cleaner", "co-host", "assistant"];
const PHONE = /^\+\d{8,15}$/;
const MAX_NOTE = 200;
const NO_PEOPLE = "Save the people for this property first: the bring-in person has to be someone saved on it who said YES.";
const NO_TIME_ZONE = "The property's time zone isn't saved yet, so I can't tell when its day ends. Save the property's address first.";
const UNKNOWN_ORDER = "There's no placed Supply Core order with that id at this property.";

export interface Visit {
  orderId: string;
  name?: string;
  /** When it should be inside: the drop plus the host's hours. Absent until the drop is seen. */
  by?: string;
}

export interface Delivery {
  orderId: string;
  store: string;
  items: string[];
  expectedBy?: string;
  seen?: { at: string; how: SeenHow };
}

const ok = (structured: Record<string, unknown>): PackageReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): PackageReply => ({ text, isError: true });

/** An ISO instant, or undefined when it isn't one. */
function instant(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export class PackageDesk {
  constructor(
    protected readonly root: string,
    protected readonly deps: PackageDeps,
  ) {}

  /** A broken packages.json is a plain refusal, and nothing is written over it. */
  protected guarded(run: () => PackageReply): PackageReply {
    try {
      return run();
    } catch (error) {
      if (error instanceof PackagesFileError) return fail(error.message);
      throw error;
    }
  }

  protected timeZone(): string | undefined {
    try {
      return readHubFile(this.root)?.property?.timeZone;
    } catch {
      return undefined;
    }
  }

  protected supply(): SupplyFile {
    return readSupply(this.root);
  }

  /** Supply Core's orders that are deliveries at all: placed or delivered. */
  protected placed(supply: SupplyFile): Order[] {
    return supply.orders.filter((order) => order.status === "placed" || order.status === "delivered");
  }

  /**
   * The deliveries to list: placed or expected in the last 30 days, or with a bring-in visit still open, so an
   * old order nobody planned stops showing up and an open visit never drops off.
   */
  protected orders(supply: SupplyFile, file: PackagesFile): Order[] {
    const since = this.deps.now().getTime() - ARRIVALS_DAYS * 86_400_000;
    return this.placed(supply).filter((order) => {
      const arrival = file.arrivals[supplyKey(order.id)];
      if (arrival?.visit && !arrival.broughtIn) return true;
      const latest = Math.max(Date.parse(order.at), order.expectedBy ? Date.parse(`${order.expectedBy}T23:59:59Z`) : 0);
      return latest >= since;
    });
  }

  /** Any placed order, however old: a write about it is always taken. */
  protected order(supply: SupplyFile, orderId: unknown): Order | undefined {
    return typeof orderId === "string" ? this.placed(supply).find((order) => order.id === orderId) : undefined;
  }

  protected seenOf(order: Order, arrival: Arrival | undefined): Delivery["seen"] {
    return effectiveSeen(order, arrival);
  }

  protected delivery(supply: SupplyFile, order: Order, arrival: Arrival | undefined): Delivery {
    const name = (id: string) => supply.items.find((item) => item.id === id)?.name ?? "an item";
    const seen = this.seenOf(order, arrival);
    return {
      orderId: order.id,
      store: order.store,
      items: order.items.map((line) => `${name(line.itemId)} x${line.qty}`),
      ...(order.expectedBy ? { expectedBy: order.expectedBy } : {}),
      ...(seen ? { seen } : {}),
    };
  }

  /** True once the property's day for `expectedBy` has ended: a later date, or that date from 9 PM. */
  protected pastEndOfDay(expectedBy: string, timeZone: string): boolean {
    const { year, month, day, hour, minute } = zonedParts(this.deps.now(), timeZone);
    const today = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    return today > expectedBy || (today === expectedBy && clock >= END_OF_DAY);
  }

  /** Every expected delivery in its place, with the flags the host hasn't been told yet. */
  check(): PackageReply {
    return this.guarded(() => {
      const timeZone = this.timeZone();
      if (!timeZone) return fail(NO_TIME_ZONE);
      const supply = this.supply();
      const file = readPackages(this.root);
      const expected: Delivery[] = [];
      const notSeen: Delivery[] = [];
      const waiting: Delivery[] = [];
      const toBringIn: Delivery[] = [];
      const visits: Visit[] = [];
      const bringInLate: Visit[] = [];
      const now = this.deps.now().getTime();
      let changed = false;
      for (const order of this.orders(supply, file)) {
        const key = supplyKey(order.id);
        // Registered once listed, so the hours log logs its drop. An order never listed adds no row, so a
        // month the host confirmed before package arrivals ran doesn't change under them.
        if (!file.arrivals[key]) {
          file.arrivals[key] = {};
          changed = true;
        }
        const arrival = file.arrivals[key];
        if (arrival?.broughtIn) continue;
        const delivery = this.delivery(supply, order, arrival);
        if (arrival?.visit) {
          const visit = this.visitOf(order.id, arrival.visit, delivery.seen, file.settings.bringInHours);
          visits.push(visit);
          if (visit.by && Date.parse(visit.by) <= now && !arrival.lateTold) {
            bringInLate.push(visit);
            file.arrivals[key] = { ...arrival, lateTold: true };
            changed = true;
          }
        }
        if (delivery.seen) {
          if (!arrival?.visit) toBringIn.push(delivery);
          continue;
        }
        if (!order.expectedBy || !this.pastEndOfDay(order.expectedBy, timeZone)) {
          expected.push(delivery);
        } else if (arrival?.notSeenTold) {
          waiting.push(delivery);
        } else {
          notSeen.push(delivery);
          file.arrivals[key] = { ...arrival, notSeenTold: true };
          changed = true;
        }
      }
      if (changed) writePackages(this.root, file);
      const next: string[] = [];
      if (notSeen.length) next.push("Tell the host once about each package in notSeen: it was expected and nothing confirmed it arrived by the end of the day. Check its tracking.");
      if (toBringIn.length) next.push("Ask the host who should bring in each package in toBringIn, then call plan_bring_in.");
      if (bringInLate.length) next.push("Tell the host once about each visit in bringInLate: the package isn't marked inside by its deadline.");
      return ok({
        expected,
        notSeen,
        waiting,
        toBringIn,
        visits,
        bringInLate,
        ...(file.settings.bringInHours === undefined ? { ask: ASK_HOURS } : {}),
        ...(next.length ? { next: next.join(" ") } : {}),
      });
    });
  }

  /** Records the drop. A camera sighting replaces any other; otherwise the earliest signal is kept. */
  markSeen(input: { orderId?: unknown; how?: unknown; at?: unknown }): PackageReply {
    return this.guarded(() => {
      if (typeof input.how !== "string" || !(SEEN_HOWS as readonly string[]).includes(input.how)) return fail("Say how the drop was confirmed: tracking, host, or camera.");
      const how = input.how as SeenHow;
      const now = this.deps.now();
      const when = input.at === undefined ? now : instant(input.at);
      if (!when) return fail("Give the time as an ISO time, like 2026-11-17T15:00:00Z.");
      if (when.getTime() > now.getTime()) return fail("That time hasn't happened yet.");
      const supply = this.supply();
      const order = this.order(supply, input.orderId);
      if (!order) return fail(UNKNOWN_ORDER);
      const file = readPackages(this.root);
      const key = supplyKey(order.id);
      const arrival: Arrival = { ...file.arrivals[key] };
      const own = arrival.seen;
      const at = when.toISOString();
      if (!own || how === "camera" || (own.how !== "camera" && Date.parse(at) < Date.parse(own.at))) arrival.seen = { at, how };
      // A saved default person is the host's pick: their visit is planned as soon as the drop is seen.
      const person = file.settings.person;
      if (!arrival.visit && !arrival.broughtIn && person && file.settings.bringInHours !== undefined) {
        const picked = this.pick(person);
        if ("role" in picked) arrival.visit = { person, ...(picked.name ? { name: picked.name } : {}), role: picked.role, plannedAt: now.toISOString() };
      }
      file.arrivals[key] = arrival;
      writePackages(this.root, file);
      const seen = this.seenOf(order, arrival);
      const visit = arrival.visit ? { ...this.visitOf(order.id, arrival.visit, seen, file.settings.bringInHours), code: "waiting" } : undefined;
      return ok({ seen, orderId: order.id, ...(visit ? { visit, next: CODE_WAITING } : {}) });
    });
  }

  /** The visit as the host sees it: who, and when it should be inside once the drop is seen. */
  protected visitOf(orderId: string, visit: BringInVisit, seen: Delivery["seen"], hours: number | undefined): Visit {
    const by = seen && hours !== undefined ? new Date(Date.parse(seen.at) + hours * 3_600_000).toISOString() : undefined;
    return { orderId, ...(visit.name ? { name: visit.name } : {}), ...(by ? { by } : {}) };
  }

  /** Whether this phone may bring a package in here: saved on the property as cleaner, co-host or assistant, said YES, no STOP. */
  protected pick(phone: unknown): { name?: string; role: BringInRole } | { problem: string } {
    if (typeof phone !== "string" || !PHONE.test(phone)) return { problem: "Give the person's phone in +1 format, as saved for this property." };
    const place = accountOf(this.root);
    if (!place) return { problem: NO_PEOPLE };
    const people = peopleFor(place.accountRoot, { now: () => this.deps.now() });
    const roles = people.rolesOn(phone, place.propertyId);
    if (roles.length === 0) return { problem: "That person isn't saved for this property. Save them first, then they reply YES." };
    const role = roles.find((entry): entry is BringInRole => (BRING_IN_ROLES as readonly string[]).includes(entry));
    if (!role) return { problem: "The bring-in person has to be the property's cleaner, a co-host or an assistant." };
    if (people.stopped(phone)) return { problem: "That person texted STOP, so they can't be asked to bring it in." };
    if (!people.optedIn(phone)) return { problem: "That person hasn't said YES to texts yet, so they can't be the bring-in person." };
    const name = people.person(phone)?.name;
    return { ...(name ? { name } : {}), role };
  }

  /** The bring-it-in visit for one delivery: the host's pick, or their saved default. */
  planBringIn(input: { orderId?: unknown; person?: unknown }): PackageReply {
    return this.guarded(() => {
      const supply = this.supply();
      const order = this.order(supply, input.orderId);
      if (!order) return fail(UNKNOWN_ORDER);
      const file = readPackages(this.root);
      if (file.settings.bringInHours === undefined) return fail(ASK_HOURS);
      const phone = input.person ?? file.settings.person;
      if (phone === undefined) return fail("Ask the host who should bring it in: their cleaner, a co-host or an assistant saved for this property. Or save a default person with save_package_settings.");
      const picked = this.pick(phone);
      if ("problem" in picked) return fail(picked.problem);
      const key = supplyKey(order.id);
      const arrival: Arrival = { ...file.arrivals[key] };
      if (arrival.broughtIn) return fail("That package is already marked inside.");
      arrival.visit = { person: phone as string, ...(picked.name ? { name: picked.name } : {}), role: picked.role, plannedAt: this.deps.now().toISOString() };
      delete arrival.lateTold;
      file.arrivals[key] = arrival;
      writePackages(this.root, file);
      const visit = this.visitOf(order.id, arrival.visit, this.seenOf(order, arrival), file.settings.bringInHours);
      return ok({ ...visit, code: "waiting", next: CODE_WAITING });
    });
  }

  /** The package is inside: closes its visit. Times come from the person, as the host passes them on. */
  markBroughtIn(input: { orderId?: unknown; at?: unknown; startedAt?: unknown; note?: unknown }): PackageReply {
    return this.guarded(() => {
      const supply = this.supply();
      const order = this.order(supply, input.orderId);
      if (!order) return fail(UNKNOWN_ORDER);
      const file = readPackages(this.root);
      const key = supplyKey(order.id);
      const arrival: Arrival = { ...file.arrivals[key] };
      const seen = this.seenOf(order, arrival);
      if (!seen) return fail("That package hasn't been seen at the door yet. Call mark_package_seen first.");
      if (!arrival.visit) return fail("No one is set to bring that package in. Call plan_bring_in with the person the host picked first.");
      const now = this.deps.now();
      const end = input.at === undefined ? now : instant(input.at);
      const start = input.startedAt === undefined ? undefined : instant(input.startedAt);
      if (!end || (input.startedAt !== undefined && !start)) return fail("Give the times as ISO times, like 2026-11-17T15:00:00Z.");
      if (end.getTime() > now.getTime()) return fail("That time hasn't happened yet.");
      const dropped = Date.parse(seen.at);
      if (end.getTime() < dropped || (start && start.getTime() < dropped)) return fail("That's before the package was seen at the door.");
      if (start && start.getTime() > end.getTime()) return fail("The start has to be before the time it was inside.");
      if (input.note !== undefined && (typeof input.note !== "string" || !input.note.trim() || input.note.length > MAX_NOTE)) return fail(`Keep the note to ${MAX_NOTE} characters.`);
      if (typeof input.note === "string" && /\d{4,}/.test(input.note)) return fail("Leave codes and long numbers out of the note.");
      arrival.broughtIn = { at: end.toISOString(), ...(start ? { startedAt: start.toISOString() } : {}), ...(typeof input.note === "string" ? { note: input.note.trim() } : {}) };
      file.arrivals[key] = arrival;
      writePackages(this.root, file);
      const visit = this.visitOf(order.id, arrival.visit, seen, file.settings.bringInHours);
      return ok({
        orderId: order.id,
        ...(visit.name ? { name: visit.name } : {}),
        ...(start ? { minutes: Math.round((end.getTime() - start.getTime()) / 60_000) } : {}),
        ...(visit.by ? { onTime: end.getTime() <= Date.parse(visit.by) } : {}),
      });
    });
  }

  /** The host's own settings, only as the host says. */
  saveSettings(input: { bringInHours?: unknown; person?: unknown }): PackageReply {
    return this.guarded(() => {
      if (input.bringInHours === undefined && input.person === undefined) return fail("Give bringInHours, person, or both.");
      const hours = input.bringInHours;
      if (hours !== undefined && (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_BRING_IN_HOURS)) return fail(`Give the hours as a whole number from 1 to ${MAX_BRING_IN_HOURS}.`);
      if (input.person !== undefined && input.person !== null) {
        const picked = this.pick(input.person);
        if ("problem" in picked) return fail(picked.problem);
      }
      const file: PackagesFile = readPackages(this.root);
      if (hours !== undefined) file.settings.bringInHours = hours as number;
      if (input.person === null) delete file.settings.person;
      else if (typeof input.person === "string") file.settings.person = input.person;
      writePackages(this.root, file);
      return ok({ settings: file.settings });
    });
  }
}

const desks = new Map<string, PackageDesk>();

/** One desk per property folder. */
export function packageDeskFor(root: string, deps: PackageDeps): PackageDesk {
  const existing = desks.get(root);
  if (existing) return existing;
  const desk = new PackageDesk(root, deps);
  desks.set(root, desk);
  return desk;
}

/** Forgets every desk, as a restart would. Tests use it. */
export function resetPackageDesks(): void {
  desks.clear();
}
