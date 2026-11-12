import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteRecording } from "../cleaner-core/hosted/twilioNumbers";
import { writeJsonAtomic } from "../storage/atomicWrite";

/** Tries to delete one recording before it is given up on. */
export const DELETE_TRIES = 20;

interface Pending {
  sid: string;
  tries: number;
}

/** One list write at a time per file, so a retry waiting on Twilio never drops a delete kept meanwhile. */
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(file: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(work, work);
  queues.set(file, run.catch(() => undefined));
  return run;
}

/**
 * Voicemail recordings Twilio didn't delete yet, kept by their sid only (never a phone or words) in the
 * account folder, and tried again on each later call to the line and at startup.
 */
export class VoiceDeletes {
  private readonly file: string;
  constructor(dir: string) {
    this.file = join(dir, "voice-deletes.json");
  }

  private read(): Pending[] {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Pending[]) : [];
  }

  /** Deletes the recording now, and keeps it for a retry if Twilio didn't. */
  async remove(env: NodeJS.ProcessEnv, sid: string): Promise<void> {
    if (await deleteRecording(env, sid)) return;
    await inTurn(this.file, async () => writeJsonAtomic(this.file, [...this.read().filter((p) => p.sid !== sid), { sid, tries: 1 }]));
  }

  /** Tries each kept recording once more; one deleted, or tried DELETE_TRIES times, is dropped. */
  async retry(env: NodeJS.ProcessEnv, log?: (line: string) => void): Promise<void> {
    await inTurn(this.file, async () => {
      const pending = this.read();
      if (pending.length === 0) return;
      const kept: Pending[] = [];
      for (const item of pending) {
        if (await deleteRecording(env, item.sid)) continue;
        if (item.tries + 1 < DELETE_TRIES) kept.push({ sid: item.sid, tries: item.tries + 1 });
        else log?.(`Gave up deleting a voicemail recording after ${DELETE_TRIES} tries. Delete it in the Twilio console.`);
      }
      writeJsonAtomic(this.file, kept);
    });
  }
}
