import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { holdsCodeToken } from "./digits";
import { openPin, sealPin, type PinSeal } from "./pinSeal";
import { writeFileAtomic } from "../storage/atomicWrite";
import { CodeValueRefused, type CodeStatus, type CodeWindow, type LockAdapter, type LockDevice } from "../locks/adapter";
import { makeSameCode, removeAll, type DeviceCode } from "../locks/sameCode";

/**
 * One property's per-visit codes, in door-grants.json next to door-access.json. One entry per code:
 * who it's for, which flow and job, the window, its status on each door, and the code sealed with the
 * account's own server key. A code is opened only for its release or a leak check, and never logged.
 * Calls run one at a time per property, so two flows can't issue the same code twice.
 */

export const DOOR_GRANTS_FILE = "door-grants.json";
/** How long release waits for a code still programming. */
export const PROGRAMMING_WAIT_MS = 2 * 60_000;
const POLL_MS = 15_000;
/** A grant stays in the leak checks this long after its window ends. */
export const KEEP_AFTER_MS = 24 * 60 * 60_000;
const CODE_SHAPE = /^\d{4,8}$/;

export type GrantFlow = "cleaning" | "repair" | "standing";

/** A code a flow wants on the locks now. */
export interface WantedCode {
  jobId: string;
  /** E.164 phone of the person it's for. */
  person: string;
  window: CodeWindow;
  /** How the host's notes name them ("Maria", "the cleaner"). Never a phone. */
  label?: string;
}

interface StoredBackup {
  deviceId: string;
  codeId: string;
  seal: PinSeal;
}

export interface StoredGrant {
  id: string;
  flow: GrantFlow;
  jobId: string;
  person: string;
  label?: string;
  window: CodeWindow;
  /** The name the code carries on the lock. Names the grant, never the person or phone. */
  codeName: string;
  devices: DeviceCode[];
  seal: PinSeal;
  backups?: StoredBackup[];
  createdAt: string;
  movedAt?: string;
  revokedAt?: string;
  releasedAt?: string;
}

interface GrantsFile {
  schemaVersion: 1;
  grants: StoredGrant[];
}

/** A note for the host. The id is stable, so the flow tells each once. Never holds a code. */
export interface GrantNote {
  id: string;
  text: string;
  urgent?: boolean;
  /** The flow's job the note is about. */
  jobId?: string;
}

/** What the release hands over. `doors` is set when the doors take different codes. */
export type GrantRelease =
  | { ok: true; code: string; doors?: { door: string; code: string }[]; source: "grant" | "backup" | "saved"; notes: GrantNote[] }
  | { ok: false; reason: "lock-failed" | "no-key"; notes: GrantNote[] };

export interface GrantDeps {
  now(): Date;
  adapter(): LockAdapter | undefined;
  /** The account's own server key. Undefined when there's none and it can't be made. */
  key(): Buffer | undefined;
  /** The doors the cleaner and pros go through. */
  doors(): LockDevice[];
  sleep?(ms: number): Promise<void>;
}

/** What a tool or get_state may see of a grant: never the code. */
export interface GrantStatus {
  flow: GrantFlow;
  jobId: string;
  window: CodeWindow;
  doors: { door: string; status: CodeStatus | "backup" }[];
  revoked: boolean;
  released: boolean;
}

/** A letters-only id, so a grant's id and code name never hold digits. */
function letters(length: number): string {
  let out = "";
  while (out.length < length) out += "abcdefghjkmnpqrstuvwxyz"[randomInt(0, 23)];
  return out;
}

function sameWindow(a: CodeWindow, b: CodeWindow): boolean {
  return Date.parse(a.from) === Date.parse(b.from) && Date.parse(a.until) === Date.parse(b.until);
}

function whoOf(flow: GrantFlow, label: string | undefined): string {
  return label?.trim() || (flow === "cleaning" ? "the cleaner" : flow === "repair" ? "the pro" : "they");
}

export class GrantBook {
  private file: GrantsFile;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly deps: GrantDeps,
  ) {
    this.file = this.load();
  }

  private load(): GrantsFile {
    const path = join(this.root, DOOR_GRANTS_FILE);
    if (!existsSync(path)) return { schemaVersion: 1, grants: [] };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GrantsFile>;
    return { schemaVersion: 1, grants: Array.isArray(raw.grants) ? raw.grants : [] };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Every live grant's code and backup codes, opened for the leak checks only. Never sent. */
  codesForChecks(): string[] {
    const key = this.deps.key();
    if (!key) return [];
    const now = this.deps.now().getTime();
    const codes = new Set<string>();
    for (const grant of this.file.grants) {
      if (Date.parse(grant.window.until) + KEEP_AFTER_MS <= now) continue;
      for (const seal of [grant.seal, ...(grant.backups ?? []).map((backup) => backup.seal)]) {
        const code = this.open(seal, key);
        if (code) codes.add(code);
      }
    }
    return [...codes];
  }

  statuses(flow?: GrantFlow): GrantStatus[] {
    const names = new Map(this.deps.doors().map((device) => [device.id, device.name]));
    return this.file.grants
      .filter((grant) => !flow || grant.flow === flow)
      .map((grant) => ({
        flow: grant.flow,
        jobId: grant.jobId,
        window: { ...grant.window },
        doors: grant.devices.map((device) => ({ door: names.get(device.deviceId) ?? "a door", status: grant.backups?.some((backup) => backup.deviceId === device.deviceId) ? ("backup" as const) : device.status })),
        revoked: Boolean(grant.revokedAt),
        released: Boolean(grant.releasedAt),
      }));
  }

  /** The live grant for this flow's job, if any. No code. */
  live(flow: GrantFlow, jobId: string): GrantStatus | undefined {
    return this.statuses(flow).find((grant) => grant.jobId === jobId && !grant.revoked);
  }

  /**
   * Makes the locks hold exactly the codes the flow wants now: issues each new one, moves one whose
   * window changed, and revokes every other live code of that flow (a cancel, decline, pause, a new
   * person). A wanted code whose window is already over is skipped. Retries a door that didn't answer.
   */
  sync(flow: GrantFlow, wanted: readonly WantedCode[]): Promise<GrantNote[]> {
    return this.serial(async () => {
      const adapter = this.deps.adapter();
      if (!adapter) return [];
      const notes: GrantNote[] = [];
      const now = this.deps.now();
      this.prune(now);
      for (const grant of this.liveOf(flow)) {
        const want = wanted.find((item) => item.jobId === grant.jobId);
        if (!want || want.person !== grant.person) await this.revokeGrant(adapter, grant);
        else if (!sameWindow(want.window, grant.window)) await this.moveGrant(adapter, grant, want.window);
      }
      for (const want of wanted) {
        if (Date.parse(want.window.until) <= now.getTime()) continue;
        const live = this.liveOf(flow).find((grant) => grant.jobId === want.jobId);
        if (live) {
          await this.retryDoors(adapter, live);
          continue;
        }
        const made = await this.issue(adapter, flow, want);
        if (!made.ok) notes.push(made.note);
      }
      this.write();
      return notes;
    });
  }

  /** Revokes one job's code now (a hold, a cancel). */
  revoke(flow: GrantFlow, jobId: string): Promise<void> {
    return this.serial(async () => {
      const adapter = this.deps.adapter();
      if (!adapter) return;
      for (const grant of this.liveOf(flow).filter((item) => item.jobId === jobId)) await this.revokeGrant(adapter, grant);
      this.write();
    });
  }

  /** A webhook said where a code is on a device. Unknown codes change nothing. Returns the grant's flow and job. */
  markDevice(codeId: string, status: CodeStatus): { flow: GrantFlow; jobId: string; deviceId: string; label?: string } | undefined {
    for (const grant of this.file.grants) {
      const device = grant.devices.find((item) => item.codeId === codeId);
      if (!device) continue;
      if (device.status !== "removed") device.status = status;
      this.write();
      return { flow: grant.flow, jobId: grant.jobId, deviceId: device.deviceId, ...(grant.label ? { label: grant.label } : {}) };
    }
    return undefined;
  }

  /**
   * A webhook said this code failed on its device: pulls a backup code for that grant and door now,
   * kept for the release. True when one is ready (already, or just pulled).
   */
  backupNow(codeId: string): Promise<boolean> {
    return this.serial(async () => {
      const adapter = this.deps.adapter();
      const key = this.deps.key();
      const grant = this.file.grants.find((item) => !item.revokedAt && item.devices.some((device) => device.codeId === codeId));
      const device = grant?.devices.find((item) => item.codeId === codeId);
      if (!adapter || !key || !grant || !device) return false;
      device.status = "failed";
      const got = await this.backupFor(adapter, grant, device.deviceId, key);
      this.write();
      return got !== undefined;
    });
  }

  /** How notes name the person on this job's code. Never a phone. */
  labelOf(flow: GrantFlow, jobId: string): string | undefined {
    return [...this.file.grants].reverse().find((grant) => grant.flow === flow && grant.jobId === jobId)?.label;
  }

  /** Which grant a code id on the lock belongs to, for an event. Never the code. */
  grantOf(codeId: string): { grantId: string; flow: GrantFlow; jobId: string; backup: boolean } | undefined {
    for (const grant of this.file.grants) {
      if (grant.devices.some((device) => device.codeId === codeId)) return { grantId: grant.id, flow: grant.flow, jobId: grant.jobId, backup: false };
      if (grant.backups?.some((backup) => backup.codeId === codeId)) return { grantId: grant.id, flow: grant.flow, jobId: grant.jobId, backup: true };
    }
    return undefined;
  }

  /**
   * The release: the code already on the locks for this person and job. A door whose code failed gets
   * a backup code (kept on the grant, for this person and job only); while a code is still
   * programming, up to two minutes are waited first. With no backup for a door, the host's saved code
   * goes instead, else nothing does (`lock-failed`). The host is told whenever it isn't the plain code.
   */
  release(input: { flow: GrantFlow; jobId: string; person: string; window: CodeWindow; label?: string }, saved: string | undefined): Promise<GrantRelease> {
    return this.serial(async () => {
      const adapter = this.deps.adapter();
      const key = this.deps.key();
      const who = whoOf(input.flow, input.label);
      if (!adapter) return { ok: false, reason: "lock-failed", notes: [] };
      if (!key) return { ok: false, reason: "no-key", notes: [] };
      let grant = this.liveOf(input.flow).find((item) => item.jobId === input.jobId && item.person === input.person);
      if (!grant) {
        const made = await this.issue(adapter, input.flow, { jobId: input.jobId, person: input.person, window: input.window, ...(input.label ? { label: input.label } : {}) });
        this.write();
        grant = made.ok ? made.grant : undefined;
      } else if (!sameWindow(grant.window, input.window)) {
        await this.moveGrant(adapter, grant, input.window);
      }
      if (!grant) return this.fallback(input, saved, who, []);
      await this.refresh(adapter, grant);
      const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      for (let polls = 0; polls < PROGRAMMING_WAIT_MS / POLL_MS && grant.devices.some((device) => device.status === "programming"); polls++) {
        await sleep(POLL_MS);
        await this.refresh(adapter, grant);
      }
      const code = this.open(grant.seal, key);
      if (!code) return this.fallback(input, saved, who, []);
      const names = new Map(this.deps.doors().map((device) => [device.id, device.name]));
      const doors: { door: string; code: string }[] = [];
      const notes: GrantNote[] = [];
      for (const device of grant.devices) {
        const door = names.get(device.deviceId) ?? "the door";
        if (device.status === "set") {
          doors.push({ door, code });
          continue;
        }
        const backup = await this.backupFor(adapter, grant, device.deviceId, key);
        if (!backup) {
          this.write();
          return this.fallback(input, saved, who, [{ id: `lock:no-backup:${grant.id}:${device.deviceId}`, text: `The ${door} didn't take ${who}'s code and has no backup code left.`, urgent: true }]);
        }
        doors.push({ door, code: backup });
        notes.push({ id: `lock:backup:${grant.id}:${device.deviceId}`, text: `The ${door} didn't take ${who}'s code, so ${who} got a backup code for it.`, urgent: true });
      }
      grant.releasedAt = this.deps.now().toISOString();
      this.write();
      const values = new Set(doors.map((item) => item.code));
      if (values.size <= 1) return { ok: true, code: doors[0]?.code ?? code, source: notes.length > 0 ? "backup" : "grant", notes };
      return { ok: true, code: doors[0]!.code, doors, source: "backup", notes };
    });
  }

  private fallback(input: { flow: GrantFlow; jobId: string }, saved: string | undefined, who: string, notes: GrantNote[]): GrantRelease {
    if (saved && CODE_SHAPE.test(saved)) {
      return { ok: true, code: saved, source: "saved", notes: [...notes, { id: `lock:saved:${input.flow}:${input.jobId}`, text: `The lock didn't take ${who}'s own code, so ${who} got your saved door code.`, urgent: true }] };
    }
    return { ok: false, reason: "lock-failed", notes };
  }

  private async backupFor(adapter: LockAdapter, grant: StoredGrant, deviceId: string, key: Buffer): Promise<string | undefined> {
    const kept = grant.backups?.find((backup) => backup.deviceId === deviceId);
    if (kept) return this.open(kept.seal, key);
    let pulled: { codeId: string; code: string } | undefined;
    try {
      const failed = grant.devices.find((device) => device.deviceId === deviceId)?.codeId;
      pulled = await adapter.backupCode({ deviceId, ...(failed ? { codeId: failed } : {}), name: grant.codeName, window: grant.window });
    } catch {
      return undefined;
    }
    if (!pulled || !CODE_SHAPE.test(pulled.code)) return undefined;
    const seal = this.seal(pulled.code, key);
    if (!seal) return undefined;
    (grant.backups ??= []).push({ deviceId, codeId: pulled.codeId, seal });
    return pulled.code;
  }

  private async issue(adapter: LockAdapter, flow: GrantFlow, want: WantedCode): Promise<{ ok: true; grant: StoredGrant } | { ok: false; note: GrantNote }> {
    const who = whoOf(flow, want.label);
    const failed: GrantNote = { id: `lock:issue-failed:${flow}:${want.jobId}`, jobId: want.jobId, text: `I couldn't put ${who}'s code on the lock yet. I'll keep trying, and I'll tell you if it isn't there when they arrive.` };
    const key = this.deps.key();
    const doors = this.deps.doors();
    if (!key || doors.length === 0) return { ok: false, note: failed };
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = letters(8);
      const codeName = `${flow === "cleaning" ? "Cleaning" : flow === "repair" ? "Repair" : "Standing"} ${id}`;
      let made: Awaited<ReturnType<typeof makeSameCode>>;
      try {
        made = await makeSameCode(adapter, { devices: doors, name: codeName, window: want.window, avoid: new Set(this.codesForChecks()) });
      } catch {
        made = undefined;
      }
      if (!made) return { ok: false, note: failed };
      const seal = this.seal(made.code, key);
      const grant: StoredGrant = {
        id,
        flow,
        jobId: want.jobId,
        person: want.person,
        ...(want.label ? { label: want.label } : {}),
        window: { ...want.window },
        codeName,
        devices: made.devices,
        seal: seal ?? { iv: "", tag: "", data: "" },
        createdAt: this.deps.now().toISOString(),
      };
      // A code that happens to match a date, phone or job id in the file is never kept: a new one is made.
      if (!seal || holdsCodeToken(JSON.stringify({ ...this.file, grants: [...this.file.grants, grant] }), made.code)) {
        await removeAll(adapter, made.devices);
        continue;
      }
      this.file.grants.push(grant);
      return { ok: true, grant };
    }
    return { ok: false, note: failed };
  }

  private async moveGrant(adapter: LockAdapter, grant: StoredGrant, window: CodeWindow): Promise<void> {
    for (const device of grant.devices) {
      if (!device.codeId) continue;
      try {
        const moved = await adapter.moveCode({ deviceId: device.deviceId, codeId: device.codeId, window });
        device.status = moved.status;
      } catch {
        device.status = "failed";
      }
    }
    for (const backup of grant.backups ?? []) {
      try {
        await adapter.moveCode({ deviceId: backup.deviceId, codeId: backup.codeId, window });
      } catch {
        // A backup code that can't move ends at its old window's end: the release pulls a new one.
        grant.backups = grant.backups?.filter((item) => item !== backup);
      }
    }
    grant.window = { ...window };
    grant.movedAt = this.deps.now().toISOString();
  }

  private async revokeGrant(adapter: LockAdapter, grant: StoredGrant): Promise<void> {
    await removeAll(adapter, grant.devices);
    for (const backup of grant.backups ?? []) {
      try {
        await adapter.removeCode({ deviceId: backup.deviceId, codeId: backup.codeId });
      } catch {
        // It still ends at the window's end.
      }
    }
    for (const device of grant.devices) device.status = "removed";
    grant.revokedAt = this.deps.now().toISOString();
  }

  /** A door with no code on it (it didn't answer at issue) gets the same value again. */
  private async retryDoors(adapter: LockAdapter, grant: StoredGrant): Promise<void> {
    const missing = grant.devices.filter((device) => !device.codeId);
    if (missing.length === 0) return;
    const key = this.deps.key();
    const code = key ? this.open(grant.seal, key) : undefined;
    if (!code) return;
    for (const device of missing) {
      try {
        const made = await adapter.createCode({ deviceId: device.deviceId, code, name: grant.codeName, window: grant.window });
        device.codeId = made.codeId;
        device.status = made.status;
      } catch (error) {
        // A clash keeps it failed for the release's backup code; no answer tries again next time.
        if (error instanceof CodeValueRefused) device.status = "failed";
      }
    }
  }

  private async refresh(adapter: LockAdapter, grant: StoredGrant): Promise<void> {
    for (const device of grant.devices) {
      if (!device.codeId || device.status === "set" || device.status === "removed") continue;
      try {
        device.status = (await adapter.codeStatus({ deviceId: device.deviceId, codeId: device.codeId })).status;
      } catch {
        // Unknown stays as it was.
      }
    }
  }

  private liveOf(flow: GrantFlow): StoredGrant[] {
    return this.file.grants.filter((grant) => grant.flow === flow && !grant.revokedAt);
  }

  private prune(now: Date): void {
    this.file.grants = this.file.grants.filter((grant) => Date.parse(grant.window.until) + KEEP_AFTER_MS > now.getTime());
  }

  private open(seal: PinSeal, key: Buffer): string | undefined {
    try {
      const code = openPin(seal, key);
      return CODE_SHAPE.test(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }

  private seal(code: string, key: Buffer): PinSeal | undefined {
    for (let attempt = 0; attempt < 8; attempt++) {
      const seal = sealPin(code, key);
      if (!holdsCodeToken(JSON.stringify(seal), code)) return seal;
    }
    return undefined;
  }

  /** Writes the file only when it holds none of the codes as a token. */
  private write(): void {
    const json = `${JSON.stringify(this.file)}\n`;
    const key = this.deps.key();
    const open = key ? this.allCodes(key) : [];
    if (open.some((code) => holdsCodeToken(json, code))) throw new Error("door-grants.json would hold a code.");
    writeFileAtomic(join(this.root, DOOR_GRANTS_FILE), json);
  }

  private allCodes(key: Buffer): string[] {
    const codes: string[] = [];
    for (const grant of this.file.grants) for (const seal of [grant.seal, ...(grant.backups ?? []).map((backup) => backup.seal)]) {
      const code = this.open(seal, key);
      if (code) codes.push(code);
    }
    return codes;
  }
}
