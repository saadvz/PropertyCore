import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFixer, FIXER_FILE } from "../fixer-core/store";
import type { OccupyInput } from "../fixer-core/window";
import type { DoorAccess, GrantNote } from "../hub/doorAccess";
import { streetOf } from "../hub/people";
import { readHubFile, type Stay } from "../hub/store";
import { readOversight, writeOversight, type OversightFile } from "./store";
import { visitWindow, wantedVisitCodes } from "./visitCodes";
import { visitCodeText, visitDuringStayNote, visitHostPhoneNote, visitInviteFailedNote, visitInviteText, visitNotSentNote, visitRefusedNote, visitTextedNote, visitTrimmedNote, visitTextsOffNote, visitUnsureNote } from "./visitCodeTexts";
import type { ExpectedVisit, Visitor } from "./visits";

/**
 * The visitor's own door code (#280 17), on the lock clock: one opt-in text to each visitor with an upcoming visit,
 * their YES or STOP from the shared line, the visit codes on the connected locks through the hub's `visit` grants,
 * and one text with the code from 30 minutes before the visit. Host notes come back from `sync`, never a code.
 */

const MINUTE_MS = 60_000;
const INVITE_RETRY_MS = 10 * MINUTE_MS;
const INVITE_TRIES = 6;
const DEFAULT_BUFFER_MINUTES = 60;
const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];
const START_WORDS = ["start", "unstop"];

export interface VisitCodeDeps {
  now(): Date;
  /** The property's door, or undefined. Nothing happens off connected locks. */
  door(): DoorAccess | undefined;
  /** The property's texts may go (the host's phone is confirmed and the account's texting consent is on). */
  textsAllowed(): Promise<boolean>;
  /** This phone replied STOP to the account's line. */
  stopped(phone: string): boolean;
  /** The consent-checked send. The body is never logged or kept. */
  send(to: string, body: string): Promise<boolean>;
  /** Already a person on the property who said YES (a cleaner, co-host, assistant or pro): their YES stands. */
  optedInHere(phone: string): boolean;
  /** The host's confirmed phone: never a visitor here, whatever the people list says. */
  hostPhone?(): Promise<string | undefined>;
}

export class VisitCodeDesk {
  /** The host's confirmed phone as this pass read it. */
  private host: string | undefined;

  constructor(
    private readonly root: string,
    private readonly deps: VisitCodeDeps,
  ) {}

  private read(): OversightFile | undefined {
    try {
      return readOversight(this.root);
    } catch {
      return undefined;
    }
  }

  /** Re-reads the record and changes it, so a host's add or cancel in between is never written over. */
  private patch(change: (file: OversightFile) => void): void {
    const file = this.read();
    if (!file) return;
    change(file);
    writeOversight(this.root, file);
  }

  private connected(): DoorAccess | undefined {
    try {
      const door = this.deps.door();
      return door?.connected() ? door : undefined;
    } catch {
      return undefined;
    }
  }

  private timeZone(): string | undefined {
    return readHubFile(this.root)?.property.timeZone || undefined;
  }

  private stays(): Stay[] {
    try {
      return readHubFile(this.root)?.stays ?? [];
    } catch {
      return [];
    }
  }

  private occupy(timeZone: string): OccupyInput {
    const property = readHubFile(this.root)?.property;
    let buffer = DEFAULT_BUFFER_MINUTES;
    try {
      if (existsSync(join(this.root, FIXER_FILE))) buffer = readFixer(this.root).settings.checkInBufferMinutes ?? DEFAULT_BUFFER_MINUTES;
    } catch {
      // A damaged Fixer Core record keeps the default buffer.
    }
    return { timeZone, ...(property?.checkoutTime ? { checkoutTime: property.checkoutTime } : {}), ...(property?.checkInTime ? { checkInTime: property.checkInTime } : {}), checkInBufferMinutes: buffer };
  }

  private street(): string {
    return streetOf(readHubFile(this.root)?.property.address ?? "") || "the property";
  }

  private visitorOf(file: OversightFile, phone: string): Visitor | undefined {
    return file.visitors?.find((item) => item.phone === phone);
  }

  /** The visitor said YES here or on the property, and nobody said STOP. */
  private mayHaveCode(file: OversightFile, phone: string): boolean {
    if (phone === this.host) return false;
    const visitor = this.visitorOf(file, phone);
    if (visitor?.stoppedAt || this.deps.stopped(phone)) return false;
    return Boolean(visitor?.yesAt) || this.deps.optedInHere(phone);
  }

  /** A visit still ahead: not cancelled, with a phone, its own window (without stays) not over. */
  private upcoming(visit: ExpectedVisit, timeZone: string): boolean {
    if (visit.cancelledAt || !visit.phone) return false;
    try {
      const window = visitWindow(visit, { timeZone, stays: [], occupy: { timeZone, checkInBufferMinutes: 0 } });
      return window !== "during-stay" && Date.parse(window.until) > this.deps.now().getTime();
    } catch {
      return false;
    }
  }

  /** A host note at most once per visit and kind; the mark is saved with it. */
  private once(visit: ExpectedVisit, kind: string, text: string): GrantNote[] {
    if (visit.code?.told?.includes(kind)) return [];
    this.patch((file) => {
      const current = file.visits.find((item) => item.id === visit.id);
      if (current) ((current.code ??= {}).told ??= []).push(kind);
    });
    ((visit.code ??= {}).told ??= []).push(kind);
    return [{ id: `visit:${kind}:${visit.id}`, text }];
  }

  async sync(): Promise<GrantNote[]> {
    const door = this.connected();
    const timeZone = this.timeZone();
    const start = this.read();
    if (!door || !timeZone || !start) return [];
    try {
      this.host = await this.deps.hostPhone?.();
    } catch {
      // The host's phone unknown just now: the people-list check at add_expected_visit still stands.
    }
    const notes: GrantNote[] = [];
    for (const visit of start.visits) {
      if (this.host && visit.phone === this.host && this.upcoming(visit, timeZone)) notes.push(...this.once(visit, "host-phone", visitHostPhoneNote(visit.who)));
    }
    notes.push(...(await this.invites(start, timeZone)));
    const file = this.read() ?? start;
    const { wanted, duringStay } = wantedVisitCodes(file, { now: this.deps.now(), timeZone, stays: this.stays(), occupy: this.occupy(timeZone), mayHaveCode: (phone) => this.mayHaveCode(file, phone) });
    try {
      notes.push(...(await door.syncGrants("visit", wanted)));
    } catch {
      return notes;
    }
    for (const id of duringStay) {
      const visit = file.visits.find((item) => item.id === id);
      if (visit) notes.push(...this.once(visit, "during-stay", visitDuringStayNote(visit.who)));
    }
    for (const want of wanted) {
      const visit = file.visits.find((item) => item.id === want.jobId);
      if (!visit) continue;
      const whole = visitWindow(visit, { timeZone, stays: [], occupy: this.occupy(timeZone) });
      if (whole !== "during-stay" && (whole.from !== want.window.from || whole.until !== want.window.until)) notes.push(...this.once(visit, "trimmed", visitTrimmedNote(visit.who, want.window, timeZone)));
    }
    const now = this.deps.now().getTime();
    for (const want of wanted) {
      const visit = file.visits.find((item) => item.id === want.jobId);
      if (!visit || visit.phone !== want.person || now < Date.parse(want.window.from)) continue;
      notes.push(...(await this.release(door, visit, want.window, timeZone)));
    }
    return notes;
  }

  /** The one opt-in text to each visitor with a visit ahead who hasn't said YES. Marked only once it went. */
  private async invites(file: OversightFile, timeZone: string): Promise<GrantNote[]> {
    const notes: GrantNote[] = [];
    const now = this.deps.now().getTime();
    for (const visitor of file.visitors ?? []) {
      if (visitor.phone === this.host || visitor.yesAt || visitor.stoppedAt || visitor.invitedAt || this.deps.stopped(visitor.phone) || this.deps.optedInHere(visitor.phone)) continue;
      const visits = file.visits.filter((visit) => visit.phone === visitor.phone && this.upcoming(visit, timeZone));
      if (!visits.length) continue;
      if ((visitor.inviteTries ?? 0) >= INVITE_TRIES) continue;
      if (visitor.inviteTriedAt && now - Date.parse(visitor.inviteTriedAt) < INVITE_RETRY_MS) continue;
      let allowed = false;
      try {
        allowed = await this.deps.textsAllowed();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        for (const visit of visits) notes.push(...this.once(visit, "texts-off", visitTextsOffNote(visit.who)));
        continue;
      }
      let sent = false;
      try {
        sent = await this.deps.send(visitor.phone, visitInviteText(this.street()));
      } catch {
        sent = false;
      }
      const at = this.deps.now().toISOString();
      let tries = 0;
      this.patch((current) => {
        const mine = this.visitorOf(current, visitor.phone);
        if (!mine) return;
        if (sent) {
          mine.invitedAt ??= at;
          delete mine.inviteTriedAt;
          delete mine.inviteTries;
        } else {
          mine.inviteTriedAt = at;
          mine.inviteTries = tries = (mine.inviteTries ?? 0) + 1;
        }
      });
      if (!sent && tries >= INVITE_TRIES) for (const visit of visits) notes.push(...this.once(visit, "invite-failed", visitInviteFailedNote(visit.who)));
    }
    return notes;
  }

  /** One visit's code text: at most once, the mark saved before the send. */
  private async release(door: DoorAccess, visit: ExpectedVisit, window: { from: string; until: string }, timeZone: string): Promise<GrantNote[]> {
    if (visit.code?.textAt) return visit.code.sent || visit.code.notSent ? [] : this.once(visit, "unsure", visitUnsureNote(visit.who));
    let allowed = false;
    try {
      allowed = await this.deps.textsAllowed();
    } catch {
      allowed = false;
    }
    if (!allowed) return this.once(visit, "texts-off", visitTextsOffNote(visit.who));
    const at = this.deps.now().toISOString();
    // Checked and marked on a fresh read in one step, so two passes at once, a STOP or a cancel in between never
    // lets the code go twice or go at all.
    let go = false;
    this.patch((file) => {
      const current = file.visits.find((item) => item.id === visit.id);
      if (!current || current.cancelledAt || current.code?.textAt || current.phone !== visit.phone || !this.mayHaveCode(file, visit.phone!)) return;
      (current.code ??= {}).textAt = at;
      go = true;
    });
    if (!go) return [];
    (visit.code ??= {}).textAt = at;
    const grant = await door.request({ person: visit.phone!, window, purpose: "visit", jobId: visit.id, label: visit.who });
    const notes: GrantNote[] = [...(grant.notes ?? [])];
    if (!grant.ok || grant.kind !== "code" || !/^\d{4,8}$/.test(grant.code)) return [...notes, ...this.once(visit, "refused", visitRefusedNote(visit.who))];
    let sent: boolean | undefined;
    try {
      sent = (await this.deps.send(visit.phone!, visitCodeText({ name: visit.who, street: this.street(), code: grant.code, ...(grant.lockLocation ? { lockLocation: grant.lockLocation } : {}), ...(grant.doors ? { doors: grant.doors } : {}), until: window.until, timeZone }))) === true;
    } catch {
      // Whether it went is unknown, so it is never sent again.
    }
    if (sent === undefined) return [...notes, ...this.once(visit, "unsure", visitUnsureNote(visit.who))];
    if (!sent) {
      // The send said plainly it didn't go: the host hears that, not "unsure".
      this.patch((file) => {
        const current = file.visits.find((item) => item.id === visit.id);
        if (current) (current.code ??= {}).notSent = true;
      });
      visit.code.notSent = true;
      return [...notes, ...this.once(visit, "not-sent", visitNotSentNote(visit.who))];
    }
    this.patch((file) => {
      const current = file.visits.find((item) => item.id === visit.id);
      if (current) (current.code ??= {}).sent = true;
    });
    visit.code.sent = true;
    return [...notes, { id: `visit:texted:${visit.id}`, text: visitTextedNote(visit.who) }];
  }

  /** A visitor on this property, so the shared line hands their text here (a stopped one only acts on START or YES). */
  hasVisitor(phone: string): boolean {
    return Boolean(this.read()?.visitors?.some((item) => item.phone === phone));
  }

  /**
   * A visitor's text on the shared line. Their YES (after the invite) is taken and their code follows on this
   * sync; STOP takes their codes off and returns false, so the usual routing still records it. After a STOP, their
   * START or YES puts them back (a YES after the invite is their YES too) and returns false, so the line's own START
   * handling lifts the account-wide opt-out; their codes come back on the next pass.
   */
  async visitorText(from: string, text: string): Promise<boolean> {
    const file = this.read();
    const visitor = file && this.visitorOf(file, from);
    if (!visitor) return false;
    const word = text.trim().toLowerCase().replace(/[.!]+$/, "");
    if (visitor.stoppedAt) {
      if (!START_WORDS.includes(word) && word !== "yes") return false;
      const at = this.deps.now().toISOString();
      this.patch((current) => {
        const mine = this.visitorOf(current, from);
        if (!mine) return;
        delete mine.stoppedAt;
        if (word === "yes" && mine.invitedAt) mine.yesAt ??= at;
      });
      return false;
    }
    if (STOP_WORDS.includes(word)) {
      this.patch((current) => {
        const mine = this.visitorOf(current, from);
        if (mine) mine.stoppedAt = this.deps.now().toISOString();
      });
      await this.sync();
      return false;
    }
    if (word !== "yes" || !visitor.invitedAt || visitor.yesAt) return false;
    this.patch((current) => {
      const mine = this.visitorOf(current, from);
      if (mine) mine.yesAt = this.deps.now().toISOString();
    });
    await this.sync();
    return true;
  }

  /** Where a visit's code is on the locks now, for list_expected_visits. Never a code. */
  codeStatus(visit: ExpectedVisit): string | undefined {
    const door = this.connected();
    const timeZone = this.timeZone();
    if (!door || !timeZone) return undefined;
    try {
      if (visitWindow(visit, { timeZone, stays: this.stays(), occupy: this.occupy(timeZone) }) === "during-stay") return "none-during-stay";
    } catch {
      return undefined;
    }
    const grant = door.grants().live("visit", visit.id);
    if (!grant || grant.doors.length === 0) return "making";
    if (grant.doors.every((item) => item.status === "set" || item.status === "backup")) return "on-lock";
    if (grant.doors.some((item) => item.status === "failed")) return "failed";
    return "programming";
  }
}
