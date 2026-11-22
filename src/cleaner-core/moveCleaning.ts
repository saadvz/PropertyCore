import { createHash } from "node:crypto";
import { formatWhen, zonedInstant } from "../hub/calendar";
import { minutesOf } from "./bookingEmailDesk";
import { movedCleaningBody } from "./cleanerTexts";
import { MOVE_CHECK_IN_LEAD_MS, MOVE_MAX_DAYS, type CleanerCore, type MoveRefusal } from "./core";
import { stayCodeHook } from "./stayCodeHook";

/**
 * Moves one cleaning to another day or time between its checkout and the next check-in, on the host's
 * yes, and puts the cleaner back on it after a decline (saadvz/PropertyCore finding #8). The first call
 * shows the change, the cleaner's exact text and a code; the second, with the code, moves it through the
 * engine's moveCleaning. The cleaner must reply YES to the update, as to any offer. Then the usual flow
 * runs for the new day: the reminder, the door code (by the property's release setting, never before the
 * new start), photos, DONE and the pay link. With connected locks the cleaner's own code moves with it.
 */

export const MOVE_CLEANING_ACTION = "cleaner-move-cleaning";

export interface MoveCleaningDesk {
  now(): Date;
  engine(): CleanerCore | undefined;
  timeZone(): string | undefined;
  address(): string | undefined;
  /** The property's nickname or address, so the host knows which cleaning moves. */
  propertyLabel(): string | undefined;
  /** The cleaner's saved name, or undefined. */
  cleanerName(): string | undefined;
  /** What the host is told about the cleaner's reply: "I'll post here…" only when a wake-up can reach the chat. */
  replyPromise(who: string): string;
  issueApproval(target: string, fingerprint: string, next: string): { code: string; question: string; expiresInMinutes?: number };
  redeem(code: string, target: string, fingerprint: string): boolean;
}

export type MoveCleaningReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function moveCleaning(desk: MoveCleaningDesk, input: { checkout?: string; date?: string; time?: string; confirmation?: string }): Promise<MoveCleaningReply> {
  const engine = desk.engine();
  if (!engine) return { ok: false, error: "Run the checks first." };
  const checkout = input.checkout ?? "";
  const date = input.date ?? "";
  const time = input.time ?? "";
  if (!DATE.test(checkout) || !DATE.test(date) || !TIME.test(time)) return { ok: false, error: "Give checkout as the cleaning's checkout date YYYY-MM-DD, and the new day as date YYYY-MM-DD with time as 24-hour HH:MM." };
  const job = engine.jobs().find((item) => item.checkoutDate === checkout && item.status !== "canceled");
  const who = desk.cleanerName()?.trim() || "The cleaner";
  const whoLower = who === "The cleaner" ? "the cleaner" : who;
  if (!job) return { ok: false, error: `No cleaning checks out on ${checkout}, so nothing changed. Check the date with the host.` };
  const minutes = minutesOf(time);
  const zone = desk.timeZone() ?? "UTC";
  const say = (ymd: string, hm: string) => formatWhen(zonedInstant(ymd, hm, zone), zone);
  const refusal = engine.moveCheck({ jobId: job.id, date, minutes });
  if (refusal) return { ok: false, error: refusalLine(refusal, { job, whoLower, say, wanted: say(date, time) }) };
  const address = desk.address() ?? "the property";
  const when = say(date, time);
  const body = movedCleaningBody(address, when);
  const declined = job.status === "declined";
  const fingerprint = createHash("sha256")
    .update(`move-cleaning|${job.id}|${checkout}|${date}|${time}|${job.status}|${job.movedTo?.round ?? 0}|${job.checkoutTime ?? ""}|${job.nextCheckInTime ?? ""}`)
    .digest("hex");
  const code = input.confirmation?.trim() ?? "";
  if (!code) {
    const label = desk.propertyLabel();
    const from = job.movedTo ? `${job.movedTo.day} at ${job.movedTo.time}` : `checkout, ${say(checkout, "12:00").day}${job.checkoutTime ? ` at ${job.checkoutTime}` : ""}`;
    const back = declined ? ` ${who} said no to it before, so this asks them again.` : "";
    const next = `${label ? `At ${label}, the` : "The"} cleaning moves from ${from} to ${when.day} at ${when.time}.${back} ${who} gets this text: "${body}" Only their YES puts them on it. Then they get the usual reminder, door code (not before ${when.time} on ${when.day}), and pay link for the new day. Reply yes to allow it.`;
    return { ok: true, result: { next, texts: [{ to: "cleaner", body }], confirmation: desk.issueApproval(job.id, fingerprint, next) } };
  }
  if (!desk.redeem(code, job.id, fingerprint)) return { ok: false, error: "That approval has expired or doesn't match. Ask the host again." };
  const result = await engine.moveCleaning({ jobId: job.id, date, minutes });
  if (!result.applied) return { ok: false, error: refusalLine(result.reason ?? "closed", { job, whoLower, say, wanted: when }) };
  const after = engine.jobs().find((item) => item.id === job.id);
  // With connected locks, the cleaner's own code follows the moved window (#180). It is made only at their YES.
  if (after?.movedTo) await stayCodeHook().windowMoved({ jobId: job.id, window: { start: after.movedTo.at, end: after.nextCheckInAt } });
  const sent = result.sent.some((text) => text.kind === "corrected");
  const line = sent ? `Done. ${who} got the update for ${when.day} at ${when.time}. ${desk.replyPromise(whoLower)}` : `Done. The cleaning is now ${when.day} at ${when.time}. The update to ${whoLower} goes out at the next check. ${desk.replyPromise(whoLower)}`;
  return { ok: true, result: { applied: true, checkout, date, time, next: line } };
}

function refusalLine(
  reason: MoveRefusal,
  ctx: { job: { checkoutDate: string; checkoutTime: string | null; nextCheckInDate: string | null; nextCheckInTime: string | null }; whoLower: string; say: (ymd: string, hm: string) => { day: string; time: string }; wanted: { day: string; time: string } },
): string {
  const { job, whoLower, say, wanted } = ctx;
  const checkoutDay = say(job.checkoutDate, "12:00").day;
  const ask = `Ask the host for another time.`;
  switch (reason) {
    case "unknown":
      return `No cleaning checks out on ${job.checkoutDate}, so nothing changed. Check the date with the host.`;
    case "closed":
      return "That cleaning is called off, under way, or done, so I left it as it was.";
    case "code-sent":
      return `The door code already went out for that cleaning, so I left it as it was. Tell the host to arrange the change with ${whoLower} themselves.`;
    case "not-offered":
      return `That cleaning hasn't been offered to ${whoLower} yet, so there's nothing to move. Its offer goes out as usual once its times are set.`;
    case "no-cleaner":
      return `${whoLower[0]!.toUpperCase()}${whoLower.slice(1)} isn't opted in to cleaning texts, so I can't put them on a cleaning. Nothing changed.`;
    case "held":
      return "The cleaning is paused. Resume it first, then move it. Nothing changed.";
    case "before-checkout":
      return `The guests check out ${checkoutDay}${job.checkoutTime ? ` at ${job.checkoutTime}` : ""}, so the cleaning can't start before then. Nothing changed. ${ask}`;
    case "into-check-in": {
      const next = job.nextCheckInDate ? `${say(job.nextCheckInDate, "12:00").day}${job.nextCheckInTime ? ` at ${job.nextCheckInTime}` : ""}` : "soon";
      return `The next guests check in ${next}. A cleaning has to start at least ${MOVE_CHECK_IN_LEAD_MS / 3_600_000} hours before that, so ${wanted.day} at ${wanted.time} is too late. Nothing changed. ${ask}`;
    }
    case "too-far":
      return `There's no next booking on the calendar, so a cleaning can move at most ${MOVE_MAX_DAYS} days past checkout. Nothing changed. ${ask}`;
    case "past":
      return `${wanted.day} at ${wanted.time} has already passed. Nothing changed. ${ask}`;
    case "same":
      return `The cleaning is already ${wanted.day} at ${wanted.time}. Nothing changed.`;
  }
}
