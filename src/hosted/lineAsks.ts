import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * Texts held while a person on several properties is asked "which property?" (saadvz/TourCore#190).
 * One per phone, in line-asks.json in the account folder. A later text replaces the held one; the ask
 * goes out at most once every 10 minutes; after 2 hours the held text is dropped.
 */

export const HOLD_MS = 2 * 60 * 60_000;
export const ASK_EVERY_MS = 10 * 60_000;

export interface HeldText {
  id: string;
  text: string;
  media?: { url: string; contentType: string }[];
  propertyIds: string[];
  heldAt: string;
  askedAt: string;
}

export class LineAsks {
  private readonly path: string;

  constructor(
    private readonly accountRoot: string,
    private readonly now: () => Date,
  ) {
    this.path = join(accountRoot, "line-asks.json");
  }

  private read(): Record<string, HeldText> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, HeldText>;
    } catch {
      return {};
    }
  }

  private write(doc: Record<string, HeldText>): void {
    mkdirSync(this.accountRoot, { recursive: true });
    writeJsonAtomic(this.path, doc);
  }

  private live(text: HeldText | undefined): boolean {
    return !!text && this.now().getTime() - Date.parse(text.heldAt) <= HOLD_MS;
  }

  held(phone: string): HeldText | undefined {
    const text = this.read()[phone];
    return this.live(text) ? text : undefined;
  }

  /** Holds this text in place of any other. `ask` is true when no ask went out in the last 10 minutes. */
  hold(phone: string, text: Omit<HeldText, "heldAt" | "askedAt">): { ask: boolean } {
    const doc = this.read();
    const before = this.live(doc[phone]) ? doc[phone] : undefined;
    const at = this.now();
    const ask = !before || at.getTime() - Date.parse(before.askedAt) >= ASK_EVERY_MS;
    doc[phone] = { ...text, heldAt: at.toISOString(), askedAt: ask ? at.toISOString() : before!.askedAt };
    this.write(doc);
    return { ask };
  }

  take(phone: string): HeldText | undefined {
    const doc = this.read();
    const text = doc[phone];
    if (!text) return undefined;
    delete doc[phone];
    this.write(doc);
    return this.live(text) ? text : undefined;
  }

  /** Removes and returns every held text past 2 hours. */
  expired(): { phone: string; text: HeldText }[] {
    const doc = this.read();
    const out = Object.entries(doc)
      .filter(([, text]) => !this.live(text))
      .map(([phone, text]) => ({ phone, text }));
    if (out.length === 0) return [];
    for (const { phone } of out) delete doc[phone];
    this.write(doc);
    return out;
  }
}
