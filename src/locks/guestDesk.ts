import { createHash, randomInt } from "node:crypto";
import { join } from "node:path";
import { recordHostStep } from "../hours-log/hostSteps";
import { formatWhen } from "../hub/calendar";
import type { DoorAccess, GrantNote } from "../hub/doorAccess";
import { hubFor } from "../hub/hub";
import { sameHash } from "../hub/uploadCode";
import { ConfirmationBook } from "../operator/confirmations";
import type { CodeWindow } from "./adapter";
import { normalizePhone, type CodeShown, type LockReply } from "./desk";
import {
  guestStays,
  leaseJob,
  leaseWindow,
  liveLeases,
  readGuestCodes,
  stayDates,
  stayJob,
  stayLabel,
  wantedGuestCodes,
  writeGuestCodes,
  type GuestCodeMode,
  type GuestCodesFile,
  type GuestLink,
  type GuestStay,
  type Lease,
  type StayCodeState,
  type WantedInput,
} from "./guestCodes";
import { lockAdapter } from "./registry";
import { deskFeatureOn } from "../features/features";

/**
 * Guest codes for one property (#262): the host's choice of how they work, a code for each stay in the
 * booking-email log, the host's single-use page for each, and leases. The desk runs the reconcile
 * (`syncGrants("guest", …)`) and turns what changed into notes for the host. No tool, note or text
 * holds a code: the host sees it only on the page, after a tap, once. Nothing here names the lock
 * partner, and nothing is ever sent to a guest.
 */

export const GUEST_PAGE_PREFIX = "/locks/guest/";
/** How long a tenant's page link works. A stay's works until checkout. */
export const LEASE_LINK_HOURS = 24;
/** Within this long before check-in, a stay's code not on the lock is urgent. */
export const URGENT_BEFORE_MS = 24 * 3600_000;
/** The reconcile runs again at least this often, so a lock call that failed is retried. */
const RESYNC_MS = 10 * 60_000;
const APPROVAL_MS = 10 * 60_000;
const DAY_MS = 24 * 3600_000;

export const GUEST_CODES_OFF = "Guest door codes aren't available yet.";
const NOT_CONNECTED = "No lock is connected here, so guest door codes can't be made. connect_lock gives the host a sign-in link to connect it first.";
const APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";

export interface GuestDeskDeps {
  now(): Date;
  env(): NodeJS.ProcessEnv;
  /** True when this property's texts may go (the host's phone is confirmed). */
  textsAllowed(): Promise<boolean>;
  /** The person's own STOP, account-wide. */
  stopped(phone: string): boolean;
  send(to: string, body: string): Promise<boolean>;
  /** This property's public address on the service, for page links. */
  publicBase(): string | undefined;
}

const ok = (structured: Record<string, unknown>): LockReply => ({ text: typeof structured.next === "string" ? structured.next : "Done.", structured, isError: false });
const fail = (text: string): LockReply => ({ text, isError: true });

function letters(length: number): string {
  let out = "";
  while (out.length < length) out += "abcdefghjkmnpqrstuvwxyz"[randomInt(0, 23)];
  return out;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];

function sameWindow(a: CodeWindow, b: CodeWindow): boolean {
  return Date.parse(a.from) === Date.parse(b.from) && Date.parse(a.until) === Date.parse(b.until);
}

function streetOf(address: string | undefined): string {
  return (address ?? "the property").split(",")[0]!.trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Dec 2026" from "2026-12-01". */
function longDate(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return `${day} ${MONTHS[month! - 1]} ${year}`;
}

export class GuestCodeDesk {
  private readonly approvals: ConfirmationBook;
  private last: { signature: string; at: number } | undefined;
  /** Notes from a sync a tool or text ran, handed over on the next pass. */
  private pending: GrantNote[] = [];
  /** When each lease's invite was last tried and didn't go, so the clock tries again at most every 10 minutes. */
  private readonly inviteTried = new Map<string, number>();

  constructor(
    readonly root: string,
    private readonly deps: GuestDeskDeps,
  ) {
    this.approvals = new ConfirmationBook(APPROVAL_MS, () => this.deps.now().getTime(), { file: join(root, "guest-code-approvals.json") });
  }

  /** Guest codes for this account: its "guest-codes" switch (which needs its locks on), with a lock adapter. */
  available(): boolean {
    return deskFeatureOn(this.deps.env(), "guest-codes") && Boolean(lockAdapter());
  }

  private door(): DoorAccess {
    return hubFor(this.root, { now: () => this.deps.now() }).doorAccess(() => this.deps.env());
  }

  private property() {
    return hubFor(this.root, { now: () => this.deps.now() }).property();
  }

  private street(): string {
    return streetOf(this.property().address);
  }

  private input(): WantedInput | undefined {
    const property = this.property();
    if (!property.timeZone) return undefined;
    return { now: this.deps.now(), timeZone: property.timeZone, ...(property.checkInTime ? { checkInTime: property.checkInTime } : {}), ...(property.checkoutTime ? { checkoutTime: property.checkoutTime } : {}) };
  }

  private when(iso: string, timeZone: string): string {
    const at = formatWhen(iso, timeZone);
    return `${at.time} ${at.day}`;
  }

  private span(window: CodeWindow, timeZone: string): string {
    return `from ${this.when(window.from, timeZone)} until ${this.when(window.until, timeZone)}`;
  }

  private confirm(action: string, fingerprint: string, code: unknown, question: string): LockReply | "go" {
    if (typeof code !== "string" || !code) return ok({ question, confirmation: this.approvals.issue(action, "guest-codes", fingerprint, question), next: `Ask the host: "${question}" Call again with the confirmation code only after their yes.` });
    try {
      this.approvals.redeem(code, action, "guest-codes", fingerprint);
    } catch {
      return fail(APPROVAL_STALE);
    }
    return "go";
  }

  /** A fresh single-use link. Only its hash is kept. Undefined when the service has no public address. */
  private link(expiresAt: string): { url: string; link: GuestLink } | undefined {
    const base = this.deps.publicBase();
    if (!base) return undefined;
    const token = letters(40);
    return { url: `${base}${GUEST_PAGE_PREFIX}${token}`, link: { hash: hashOf(token), expiresAt, sentAt: this.deps.now().toISOString() } };
  }

  // ---- The host's choice ----

  /** guest_codes: how guest codes work here. Only on connected locks, with the host's yes. */
  async setMode(input: { mode?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    if (!this.door().connected()) return fail(NOT_CONNECTED);
    const mode = input.mode === "automatic" || input.mode === "ask" || input.mode === "off" ? (input.mode as GuestCodeMode) : undefined;
    if (!mode) return fail("Say automatic, ask or off.");
    const street = this.street();
    const question =
      mode === "automatic"
        ? `Should I make a door code for each booking at ${street}? Each one goes on the lock 7 days ahead and works from check-in to checkout. You'd get a private link to copy it into your arrival message, and you'd stop making guests' codes in the lock app.`
        : mode === "ask"
          ? `Should I ask you before making each booking's door code at ${street}? Once you say yes for a booking, its code follows the booking's changes on its own.`
          : `Turn guest door codes off at ${street}? I'll take every booking's code off the lock, and you'll make guests' codes yourself again.`;
    const gate = this.confirm("guest-codes-mode", mode, input.confirmation, question);
    if (gate !== "go") return gate;
    const file = readGuestCodes(this.root);
    // Automatic to ask keeps the codes already made: each stay with a code on the lock counts as a yes.
    if (mode === "ask" && file.mode === "automatic") {
      const grants = this.door().grants();
      for (const [code, state] of Object.entries(file.stays)) if (!state.yesAt && grants.live("guest", stayJob(code))) state.yesAt = this.deps.now().toISOString();
    }
    file.mode = mode;
    file.modeAt = this.deps.now().toISOString();
    writeGuestCodes(this.root, file);
    recordHostStep(this.root, { at: file.modeAt, kind: "guest-codes-mode", about: mode });
    await this.resync();
    const next =
      mode === "automatic"
        ? "Guest door codes are automatic here. Each booking's code goes on the lock 7 days before check-in, and the host gets a private link to it."
        : mode === "ask"
          ? "I'll ask the host before each booking's door code, 7 days before check-in."
          : "Guest door codes are off here. Every booking's code is coming off the lock.";
    return ok({ mode, next });
  }

  /** make_guest_code: under ask, the host's yes for one booking's code. */
  async makeCode(input: { stay?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    if (!this.door().connected()) return fail(NOT_CONNECTED);
    const file = readGuestCodes(this.root);
    if (file.mode !== "ask") return fail(file.mode === "automatic" ? "Guest door codes are automatic here: each booking gets one on its own." : "Guest door codes are off here. Ask the host how they should work, then call guest_codes.");
    const found = this.stay(input.stay);
    if (!found) return fail("No upcoming booking with that confirmation code. Call get_guest_codes.");
    const gate = this.confirm("guest-codes-make", found.stay.key, input.confirmation, `Make a door code for ${found.stay.label}, ${this.span(found.stay.window, found.timeZone)}?`);
    if (gate !== "go") return gate;
    const fresh = readGuestCodes(this.root);
    const yesAt = this.deps.now().toISOString();
    (fresh.stays[found.stay.key] ??= {}).yesAt = yesAt;
    writeGuestCodes(this.root, fresh);
    recordHostStep(this.root, { at: yesAt, kind: "guest-code-make", about: found.stay.label, ref: found.stay.key });
    await this.resync();
    return ok({ stay: found.stay.key, next: found.stay.due ? `The code for ${found.stay.label} is going on the lock. The host gets a private link to it once it's there.` : `The code for ${found.stay.label} goes on the lock 7 days before check-in, and the host gets a private link then.` });
  }

  /** guest_code_link: a new single-use page link for one stay, with the host's yes. The old one ends. */
  async newLink(input: { stay?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    const found = this.stay(input.stay);
    if (!found || !this.wantedJobs().has(stayJob(found.stay.key)) || !this.door().grants().live("guest", stayJob(found.stay.key))) return fail("That booking has no door code on the lock. Call get_guest_codes.");
    const gate = this.confirm("guest-codes-link", found.stay.key, input.confirmation, `Make a new private link to the door code for ${found.stay.label}? The old link stops working.`);
    if (gate !== "go") return gate;
    const made = this.link(found.stay.window.until);
    if (!made) return fail("I can't make a link until the server's public address is saved.");
    const file = readGuestCodes(this.root);
    (file.stays[found.stay.key] ??= {}).link = made.link;
    writeGuestCodes(this.root, file);
    recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "guest-code-link", about: found.stay.label, ref: found.stay.key });
    return ok({ stay: found.stay.key, next: `Give the host this private link to the door code for ${found.stay.label}. It opens once: ${made.url}` });
  }

  private stay(raw: unknown): { stay: GuestStay; timeZone: string } | undefined {
    const input = this.input();
    if (!input || typeof raw !== "string") return undefined;
    // Airbnb keys are its code in capitals; another platform's are prefixed, like vrbo:HA-1A2B3C (#263).
    const stay = guestStays(this.root, input).find((item) => item.key.toUpperCase() === raw.trim().toUpperCase());
    return stay ? { stay, timeZone: input.timeZone } : undefined;
  }

  private wantedJobs(): Set<string> {
    const input = this.input();
    if (!input) return new Set();
    return new Set(wantedGuestCodes(this.root, readGuestCodes(this.root), input).map((item) => item.jobId));
  }

  // ---- What the agent sees ----

  /** get_guest_codes: each stay's and lease's status. Never a code, never a guest's name. */
  status(): LockReply {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    if (!this.door().connected()) return ok({ connected: false, next: NOT_CONNECTED });
    const input = this.input();
    if (!input) return ok({ connected: true, next: "Save the property's time zone first, so each code runs on the right hours." });
    const file = readGuestCodes(this.root);
    const grants = this.door().grants();
    const wanted = this.wantedJobs();
    const stays = guestStays(this.root, input).map((stay) => {
      const job = stayJob(stay.key);
      const state = file.stays[stay.key];
      const grant = grants.live("guest", job);
      const status = grant && wanted.has(job) ? this.grantStatus(grant.doors) : !file.mode || file.mode === "off" ? "off" : file.mode === "ask" && !state?.yesAt ? "waiting-for-host" : stay.due ? "making" : "waiting-7-days";
      return { stay: stay.key, dates: stayDates(stay.checkIn, stay.checkout), from: stay.window.from, until: stay.window.until, status, link: this.linkStatus(state?.link) };
    });
    const leases = liveLeases(file, input).map((lease) => {
      const grant = grants.live("guest", leaseJob(lease.id));
      const status = !lease.invitedAt ? "not-texted" : !lease.yesAt ? "waiting-for-yes" : grant ? this.grantStatus(grant.doors) : "making";
      return { id: lease.id, name: lease.name, start: lease.start, moveOut: lease.moveOut, status, link: this.linkStatus(lease.link) };
    });
    const next = !file.mode
      ? "Ask the host how guests' door codes should work here: automatic (I make one for each booking, 7 days ahead), ask (I ask before each booking's code), or off (they keep making them). Then call guest_codes."
      : file.mode === "ask"
        ? "Guest door codes are ask here. For a stay with status waiting-for-host, ask the host, and only after their yes call make_guest_code with that stay."
        : `Guest door codes are ${file.mode === "off" ? "off" : file.mode} here.`;
    return ok({ connected: true, mode: file.mode ?? "not-chosen", stays, leases, next });
  }

  private grantStatus(doors: { status: string }[]): string {
    if (doors.length > 0 && doors.every((door) => door.status === "set")) return "on-lock";
    if (doors.length > 0 && doors.every((door) => door.status === "set" || door.status === "backup")) return "backup";
    if (doors.some((door) => door.status === "failed")) return "failed";
    return "programming";
  }

  private linkStatus(link: GuestLink | undefined): string {
    if (!link) return "none";
    if (link.usedAt) return "used";
    if (this.deps.now().getTime() >= Date.parse(link.expiresAt)) return "ended";
    return "sent";
  }

  // ---- The reconcile and the host's notes ----

  /** Forces the next pass's sync now, keeping its notes for the next `sync()`. */
  private async resync(): Promise<void> {
    this.last = undefined;
    this.pending.push(...(await this.sync()));
  }

  /**
   * One pass: puts exactly the wanted guest codes on the locks, then tells the host what changed: an
   * ask under ask mode, a code ready (with its page link), moved, removed, or not on the lock within a
   * day of check-in. Each note has a stable id and goes once.
   */
  async sync(): Promise<GrantNote[]> {
    const notes = this.pending.splice(0);
    if (!this.available()) return notes;
    let door: DoorAccess;
    try {
      door = this.door();
      if (!door.connected()) return notes;
    } catch {
      return notes;
    }
    const input = this.input();
    if (!input) return notes;
    // A lease whose invite couldn't go yet (texts not on, or a failed send) gets it once it can (#180 sandbox run).
    for (const lease of liveLeases(readGuestCodes(this.root), input)) {
      if (lease.invitedAt || lease.yesAt || lease.stoppedAt) continue;
      const tried = this.inviteTried.get(lease.id);
      if (tried !== undefined && input.now.getTime() - tried < 10 * 60_000) continue;
      if (!(await this.invite(lease.id))) this.inviteTried.set(lease.id, input.now.getTime());
      else this.inviteTried.delete(lease.id);
    }
    const file = readGuestCodes(this.root);
    const before = JSON.stringify(file);
    const wanted = wantedGuestCodes(this.root, file, input);
    const live = door.grants().statuses("guest").filter((grant) => !grant.revoked);
    const signature = JSON.stringify(wanted);
    const now = input.now.getTime();
    const fresh = this.last && this.last.signature === signature && now - this.last.at < RESYNC_MS;
    if ((wanted.length > 0 || live.length > 0) && !fresh) {
      notes.push(...(await door.syncGrants("guest", wanted)));
      this.last = { signature, at: now };
    }
    const wantedJobs = new Set(wanted.map((item) => item.jobId));
    const stays = guestStays(this.root, input);
    for (const stay of stays) {
      const job = stayJob(stay.key);
      const state: StayCodeState = (file.stays[stay.key] ??= {});
      if (file.mode === "ask" && stay.due && !state.yesAt && !state.askedAt) {
        state.askedAt = input.now.toISOString();
        notes.push({ id: `guest:ask:${stay.key}`, text: `New booking: ${stay.label}. Should I make their door code, ${this.span(stay.window, input.timeZone)}?` });
      }
      if (!wantedJobs.has(job)) continue;
      if (state.removedTold) {
        delete state.removedTold;
        delete state.toldWindow;
        delete state.urgentTold;
        delete state.link;
      }
      const grant = door.grants().live("guest", job);
      const ready = Boolean(grant && grant.doors.length > 0 && grant.doors.every((item) => item.status === "set" || item.status === "backup"));
      if (ready && !state.toldWindow) {
        const made = this.link(stay.window.until);
        state.toldWindow = { ...stay.window };
        state.checkIn = stay.checkIn;
        state.checkout = stay.checkout;
        if (made) state.link = made.link;
        notes.push({
          id: `guest:ready:${stay.key}`,
          text: made
            ? `The door code for ${stay.label} is on the lock, ${this.span(stay.window, input.timeZone)}. This private link shows it once, so copy it into your arrival message when you open it: ${made.url}`
            : `The door code for ${stay.label} is on the lock, ${this.span(stay.window, input.timeZone)}. Its private link waits until the server's public address is saved.`,
        });
      } else if (ready && state.toldWindow && !sameWindow(state.toldWindow, stay.window)) {
        const startMoved = Date.parse(state.toldWindow.from) !== Date.parse(stay.window.from);
        state.toldWindow = { ...stay.window };
        // The host's link works until the new checkout.
        if (state.link) state.link = { ...state.link, expiresAt: stay.window.until };
        state.checkIn = stay.checkIn;
        state.checkout = stay.checkout;
        notes.push({
          id: `guest:moved:${stay.key}:${stay.window.until}`,
          text: startMoved
            ? `The booking for ${stay.label} moved to ${this.span(stay.window, input.timeZone)}. The door code stays the same, so there's nothing to resend.`
            : `The booking for ${stay.label} now ends ${this.when(stay.window.until, input.timeZone)}. The door code stays the same, so there's nothing to resend.`,
        });
      }
      if (!ready && !state.urgentTold && Date.parse(stay.window.from) - now <= URGENT_BEFORE_MS) {
        state.urgentTold = true;
        notes.push({ id: `guest:not-set:${stay.key}`, urgent: true, text: `The door code for ${stay.label} isn't on the lock yet, and they check in ${this.when(stay.window.from, input.timeZone)}. I'll keep trying; if it isn't there in time, let them in another way.` });
      }
    }
    const listed = new Set(stays.map((stay) => stay.key));
    for (const [code, state] of Object.entries(file.stays)) {
      const told = state.toldWindow;
      if (told && !state.removedTold && !wantedJobs.has(stayJob(code)) && Date.parse(told.until) > now && !door.grants().live("guest", stayJob(code))) {
        state.removedTold = true;
        delete state.link;
        const label = state.checkIn && state.checkout ? stayLabel(state.checkIn, state.checkout) : "a guest";
        notes.push({ id: `guest:removed:${code}`, text: `I took the door code for ${label} off the lock.` });
      }
      // A stay that has checked out, or is gone from the log and was never told, is forgotten after a day.
      const ended = told ? Date.parse(told.until) + DAY_MS <= now : !listed.has(code);
      if (ended && !listed.has(code)) delete file.stays[code];
    }
    if (JSON.stringify(file) !== before) writeGuestCodes(this.root, file);
    return notes;
  }

  // ---- The page ----

  private byToken(token: string): { kind: "stay"; stay: GuestStay } | { kind: "lease"; lease: Lease } | undefined {
    if (!/^[a-z]{40}$/.test(token)) return undefined;
    const input = this.input();
    if (!input || !this.available()) return undefined;
    const hash = hashOf(token);
    const now = input.now.getTime();
    const live = (link: GuestLink | undefined) => Boolean(link && !link.usedAt && now < Date.parse(link.expiresAt) && sameHash(hash, link.hash));
    const file = readGuestCodes(this.root);
    const wanted = new Set(wantedGuestCodes(this.root, file, input).map((item) => item.jobId));
    for (const stay of guestStays(this.root, input)) if (wanted.has(stayJob(stay.key)) && live(file.stays[stay.key]?.link)) return { kind: "stay", stay };
    for (const lease of liveLeases(file, input)) if (lease.yesAt && wanted.has(leaseJob(lease.id)) && live(lease.link)) return { kind: "lease", lease };
    return undefined;
  }

  /** Whether a page token is live: for showing the page. Reads only. */
  pageOpen(token: string): { kind: "stay"; title: string; street: string } | { kind: "lease"; title: string; name: string; street: string } | undefined {
    const found = this.byToken(token);
    if (!found) return undefined;
    const street = this.street();
    return found.kind === "stay" ? { kind: "stay", title: `Door code for ${found.stay.label}`, street } : { kind: "lease", title: `Your door code at ${street}`, name: found.lease.name, street };
  }

  /**
   * The page's "show the code": the stay's or lease's code, once. The link is used up only when the
   * code is shown: while it's still going on the lock the link keeps working ("pending"), and a lock
   * that refused it with no backup is "failed". The caller never logs the code.
   */
  async showCode(token: string): Promise<CodeShown> {
    const found = this.byToken(token);
    const input = this.input();
    if (!found || !input) return { ok: false, reason: "gone" };
    const request =
      found.kind === "stay"
        ? { person: `guest:${found.stay.key}`, window: found.stay.window, jobId: stayJob(found.stay.key), label: found.stay.label }
        : { person: found.lease.phone, window: leaseWindow(found.lease, input.timeZone), jobId: leaseJob(found.lease.id), label: found.lease.name };
    const door = this.door();
    const state = await door.checkGrant("guest", request.jobId);
    // Not on the lock yet: the clock's next pass makes or finishes it, and the link keeps working.
    if (state === "none" || state === "programming") return { ok: false, reason: "pending" };
    // Claimed before the release, so two taps can't both show it; given back when nothing shows.
    if (!this.useLink(found, input.now.toISOString())) return { ok: false, reason: "gone" };
    const grant = await door.request({ ...request, purpose: "guest" });
    if (grant.notes) this.pending.push(...grant.notes);
    if (!grant.ok) {
      this.useLink(found, undefined);
      return { ok: false, reason: "failed" };
    }
    return { ok: true, code: grant.code, ...(grant.doors ? { doors: grant.doors } : {}) };
  }

  /** Marks the found link used at `at`, or gives it back (undefined). False when it was used in the meantime. */
  private useLink(found: { kind: "stay"; stay: GuestStay } | { kind: "lease"; lease: Lease }, at: string | undefined): boolean {
    const file = readGuestCodes(this.root);
    const holder = found.kind === "stay" ? file.stays[found.stay.key] : file.leases.find((item) => item.id === found.lease.id);
    const link = holder?.link;
    if (!holder || !link || (at && link.usedAt)) return false;
    if (at) holder.link = { ...link, usedAt: at };
    else {
      const { usedAt: _given, ...rest } = link;
      holder.link = rest;
    }
    writeGuestCodes(this.root, file);
    return true;
  }

  // ---- Leases ----

  /** add_lease: a tenant's code from the lease's start to the end of move-out day, after their own YES. */
  async addLease(input: { name?: unknown; phone?: unknown; start?: unknown; moveOut?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    if (!this.door().connected()) return fail(NOT_CONNECTED);
    const timing = this.input();
    if (!timing) return fail("Save the property's time zone first.");
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
    const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : undefined;
    const start = typeof input.start === "string" && YMD.test(input.start) ? input.start : undefined;
    const moveOut = typeof input.moveOut === "string" && YMD.test(input.moveOut) ? input.moveOut : undefined;
    if (!name || /\d/.test(name)) return fail("Give the tenant's name, with no numbers in it.");
    if (!phone) return fail("Give the tenant's mobile number, with country code.");
    if (!start || !moveOut || moveOut < start) return fail("Give the lease's start and move-out dates as YYYY-MM-DD, move-out on or after the start.");
    if (Date.parse(leaseWindow({ start, moveOut }, timing.timeZone).until) <= timing.now.getTime()) return fail("That move-out day has passed.");
    const file = readGuestCodes(this.root);
    if (liveLeases(file, timing).some((lease) => lease.phone === phone)) return fail(`${name} already has a lease code here. Use change_lease.`);
    const gate = this.confirm("guest-codes-lease", JSON.stringify([name, phone, start, moveOut]), input.confirmation, `Give ${name} a door code at ${this.street()} from ${longDate(start)} until the end of move-out day, ${longDate(moveOut)}? They get one text asking them to reply YES first.`);
    if (gate !== "go") return gate;
    const lease: Lease = { id: `lease_${letters(10)}`, name, phone, start, moveOut, addedAt: timing.now.toISOString() };
    const fresh = readGuestCodes(this.root);
    fresh.leases.push(lease);
    writeGuestCodes(this.root, fresh);
    recordHostStep(this.root, { at: lease.addedAt, kind: "lease-add", about: name, ref: lease.id });
    const invited = await this.invite(lease.id);
    return ok({ id: lease.id, invited, next: invited ? `${name} got one text asking them to reply YES. Their code link goes once they do.` : `${name} can't be texted yet (the host's phone isn't confirmed, or they opted out). Their code waits.` });
  }

  private async invite(id: string): Promise<boolean> {
    if (!(await this.deps.textsAllowed())) return false;
    const file = readGuestCodes(this.root);
    const lease = file.leases.find((item) => item.id === id);
    if (!lease || lease.invitedAt || lease.removedAt || lease.stoppedAt || this.deps.stopped(lease.phone)) return false;
    let sent = false;
    try {
      sent = await this.deps.send(lease.phone, `This is the text line for ${this.street()}. The host wants to give you your own door code there, from ${longDate(lease.start)} until move-out on ${longDate(lease.moveOut)}. Reply YES to get a private link to it, or STOP to opt out.`);
    } catch {
      sent = false;
    }
    // Marked only once it went (#180 sandbox run): a failed send is tried again on the clock, not lost as "waiting for YES".
    if (sent) {
      const fresh = readGuestCodes(this.root);
      const mine = fresh.leases.find((item) => item.id === id);
      if (mine) {
        mine.invitedAt = this.deps.now().toISOString();
        writeGuestCodes(this.root, fresh);
      }
    }
    return sent;
  }

  private async sendLeaseLink(id: string): Promise<boolean> {
    if (!(await this.deps.textsAllowed())) return false;
    const file = readGuestCodes(this.root);
    const lease = file.leases.find((item) => item.id === id);
    if (!lease?.yesAt || lease.stoppedAt || lease.removedAt || this.deps.stopped(lease.phone)) return false;
    const made = this.link(new Date(this.deps.now().getTime() + LEASE_LINK_HOURS * 3600_000).toISOString());
    if (!made) return false;
    lease.link = made.link;
    writeGuestCodes(this.root, file);
    try {
      return await this.deps.send(lease.phone, `Here's your private link to your door code at ${this.street()}. It works once, in the next ${LEASE_LINK_HOURS} hours: ${made.url}`);
    } catch {
      return false;
    }
  }

  /**
   * A text from a phone with a lease here. Only YES and STOP are this desk's: YES (after the invite)
   * puts the code on the locks and texts a single-use link; STOP takes the code off and is then routed
   * as usual. Never replies with a code.
   */
  async leaseText(from: string, text: string): Promise<boolean> {
    if (!this.available()) return false;
    const file = readGuestCodes(this.root);
    const lease = file.leases.find((item) => item.phone === from && !item.removedAt && !item.stoppedAt);
    if (!lease) return false;
    const word = text.trim().toLowerCase().replace(/[.!]+$/, "");
    if (STOP_WORDS.includes(word)) {
      lease.stoppedAt = this.deps.now().toISOString();
      delete lease.link;
      writeGuestCodes(this.root, file);
      await this.resync();
      return false;
    }
    if (word !== "yes" || !lease.invitedAt || lease.yesAt) return false;
    lease.yesAt = this.deps.now().toISOString();
    writeGuestCodes(this.root, file);
    await this.resync();
    await this.sendLeaseLink(lease.id);
    return true;
  }

  private lease(id: unknown): Lease | undefined {
    const input = this.input();
    if (!input || typeof id !== "string") return undefined;
    return liveLeases(readGuestCodes(this.root), input).find((lease) => lease.id === id);
  }

  /** change_lease: a new move-out day, with the host's yes. The code's end moves. */
  async changeLease(input: { id?: unknown; moveOut?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    const lease = this.lease(input.id);
    if (!lease) return fail("No lease with that id. Call get_guest_codes.");
    const moveOut = typeof input.moveOut === "string" && YMD.test(input.moveOut) ? input.moveOut : undefined;
    if (!moveOut || moveOut < lease.start) return fail("Give the new move-out date as YYYY-MM-DD, on or after the lease's start.");
    const gate = this.confirm("guest-codes-lease-change", JSON.stringify([lease.id, moveOut]), input.confirmation, `Change ${lease.name}'s move-out day to ${longDate(moveOut)}? Their door code then ends at the end of that day.`);
    if (gate !== "go") return gate;
    const file = readGuestCodes(this.root);
    file.leases.find((item) => item.id === lease.id)!.moveOut = moveOut;
    writeGuestCodes(this.root, file);
    recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "lease-change", about: lease.name, ref: lease.id });
    await this.resync();
    return ok({ id: lease.id, next: `${lease.name}'s door code now ends at the end of ${longDate(moveOut)}.` });
  }

  /** remove_lease: takes the tenant's code off the locks, with the host's yes. */
  async removeLease(input: { id?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    const lease = this.lease(input.id);
    if (!lease) return fail("No lease with that id. Call get_guest_codes.");
    const gate = this.confirm("guest-codes-lease-remove", lease.id, input.confirmation, `Remove ${lease.name}'s door code?`);
    if (gate !== "go") return gate;
    const file = readGuestCodes(this.root);
    const stored = file.leases.find((item) => item.id === lease.id)!;
    stored.removedAt = this.deps.now().toISOString();
    delete stored.link;
    writeGuestCodes(this.root, file);
    recordHostStep(this.root, { at: stored.removedAt, kind: "lease-remove", about: lease.name, ref: lease.id });
    await this.resync();
    return ok({ id: lease.id, next: `${lease.name}'s door code is coming off the lock.` });
  }

  /** lease_code_link: texts the tenant a new single-use link, with the host's yes, after their YES. */
  async leaseLink(input: { id?: unknown; confirmation?: unknown }): Promise<LockReply> {
    if (!this.available()) return fail(GUEST_CODES_OFF);
    const lease = this.lease(input.id);
    if (!lease) return fail("No lease with that id. Call get_guest_codes.");
    if (!lease.yesAt) return fail(`${lease.name} hasn't replied YES, so no link can go yet.`);
    const gate = this.confirm("guest-codes-lease-link", lease.id, input.confirmation, `Text ${lease.name} a new private link to their door code?`);
    if (gate !== "go") return gate;
    const sent = await this.sendLeaseLink(lease.id);
    if (sent) recordHostStep(this.root, { at: this.deps.now().toISOString(), kind: "lease-link", about: lease.name, ref: lease.id });
    return sent ? ok({ id: lease.id, sent: true, next: `${lease.name} got a new link. The old one no longer works.` }) : fail(`The link couldn't go to ${lease.name} now.`);
  }

  /** True when this phone has a live lease here, for the line router. */
  hasLease(phone: string): boolean {
    return readGuestCodes(this.root).leases.some((lease) => lease.phone === phone && !lease.removedAt && !lease.stoppedAt);
  }
}

export type { GuestCodesFile };
