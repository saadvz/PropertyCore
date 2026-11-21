import { zonedParts } from "../core/timezone";
import { addCalendarDays } from "../hub/calendar";
import type { CameraDesk } from "../cameras/desk";
import type { OversightDesk } from "../oversight/desk";
import type { PackageDesk } from "../package-arrivals/desk";
import type { AlertSource, DueItem } from "./clock";
import type { HostAlertLedger } from "./ledger";

/**
 * The four producers as the host-alert clock reads them (#250). Each says what's due, read only, and how to mark it
 * told in the producer's own record. None of them decides anything new: the producers' own rules stand.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** Today's date at the property. */
export function localToday(now: Date, timeZone: string): string {
  const d = zonedParts(now, timeZone);
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** The local hour at the property, 0 to 23. */
export function localHour(now: Date, timeZone: string): number {
  return zonedParts(now, timeZone).hour;
}

/**
 * The same-day check (#240) for today only, so its "Today at…" text is always sent the same day. The alert's id
 * names the visits newly in it, which is exactly the set runDay then marks as flagged.
 */
export function oversightSource(desk: OversightDesk, today: string, label: string): AlertSource {
  return {
    kind: "oversight",
    due: (): DueItem[] => {
      const result = desk.peekDay(today, label);
      if (result.status !== "flags" || !result.alert) return [];
      const fresh = [...result.missed, ...result.unsure]
        .filter((visit) => !visit.alreadyFlagged)
        .map((visit) => visit.id)
        .sort();
      if (!fresh.length) return [];
      return [{ alert: { id: `oversight:${today}:${fresh.join(",")}`, kind: "oversight", text: result.alert }, commit: () => void desk.runDay(today, label) }];
    },
  };
}

/** Saad, 21 Nov: the night's check runs 30 minutes after its window closes, so counting can finish. */
export const NIGHT_GRACE_MS = 30 * 60_000;
/** An event still not counted then waits at most this long after the window closes, then counts as unchecked. */
export const NIGHT_COUNT_WAIT_MS = 60 * 60_000;
/** A night whose window closed longer ago than this is not told late. */
export const NIGHT_STALE_MS = 12 * 60 * 60_000;

/**
 * The nightly stay check (#239) on the property's camera events, once per night: last night and tonight are looked
 * at, and a night is checked once its window (ending at the host's check time, or checkout on the last night) has
 * been closed for 30 minutes. A clean night is recorded too, so each night is checked and told once.
 */
export function stayNightSource(desk: CameraDesk, ledger: HostAlertLedger, now: Date, timeZone: string): AlertSource {
  return {
    kind: "stay-night",
    due: (): DueItem[] => {
      const today = localToday(now, timeZone);
      const items: DueItem[] = [];
      for (const night of [addCalendarDays(today, -1), today]) {
        const window = desk.nightWindow(night);
        if (!window) continue;
        const since = now.getTime() - Date.parse(window.to);
        if (since < NIGHT_GRACE_MS || since > NIGHT_STALE_MS || ledger.nightDone(night)) continue;
        const result = desk.runNight(night);
        if (result.status === "skipped") continue;
        if (result.unchecked.length && since < NIGHT_COUNT_WAIT_MS) continue;
        items.push({
          ...(result.status === "flags" ? { alert: { id: `stay-night:${night}`, kind: "stay-night" as const, text: result.alert } } : {}),
          commit: () => ledger.markNight(night),
        });
      }
      return items;
    },
  };
}

/** Packages not seen by 9 PM on their day (#241), each told once through check_packages' own notSeenTold. */
export function packageSource(desk: PackageDesk, label: string): AlertSource {
  return {
    kind: "packages",
    due: (): DueItem[] => desk.dueNotSeen(label).map(({ key, text }) => ({ alert: { id: `packages:${key}:not-seen`, kind: "packages" as const, text }, commit: () => desk.markNotSeenTold([key]) })),
  };
}

/** A camera offline for 30 minutes, and back online (#239), each told once through cameras.json's own told ids. */
export function cameraHealthSource(desk: CameraDesk): AlertSource {
  return {
    kind: "camera-health",
    due: (): DueItem[] => desk.dueNotes().map((note) => ({ alert: { id: note.id, kind: "camera-health" as const, text: note.text }, commit: () => desk.markTold([note.id]) })),
  };
}
