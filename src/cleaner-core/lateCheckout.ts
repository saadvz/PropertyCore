import { createHash } from "node:crypto";
import { appendGuestMessage } from "../guest-messages/store";
import { formatWhen, zonedInstant } from "../hub/calendar";
import { clock, clockMinutes, minutesOf } from "./bookingEmailDesk";
import type { CleanerCore, JobView } from "./core";
import { stayCodeHook } from "./stayCodeHook";

/**
 * A guest's late checkout, on the host's yes (#242). The first call shows the change and returns a code;
 * the second, with the code, moves the stay's checkout through the engine's setJobTimes (the method #244
 * added), so the cleaner hears through Cleaner Core's usual update text. The guest log keeps the new time,
 * so the next draft to the guest quotes it. See docs/superpowers/specs/2026-11-17-guest-messages-design.md.
 */

export const LATE_CHECKOUT_ACTION = "cleaner-late-checkout";

export interface LateCheckoutDesk {
  root: string;
  now(): Date;
  engine(): CleanerCore | undefined;
  timeZone(): string | undefined;
  /** The checkout time the property uses when a job has none, "HH:MM". */
  usualCheckout(): string | undefined;
  /** The check-in time the property uses when the next stay has none yet, "HH:MM". */
  usualCheckIn(): string | undefined;
  /** The property's nickname or address, so the host knows which cleaning moves. */
  propertyLabel(): string | undefined;
  cleanerName(): string;
  issueApproval(target: string, fingerprint: string, next: string): { code: string; question: string; expiresInMinutes?: number };
  redeem(code: string, target: string, fingerprint: string): boolean;
}

export type LateCheckoutReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSED: Partial<Record<JobView["status"], string>> = {
  cleared: "the door code already went out",
  in_progress: "the cleaning is under way",
  done: "the cleaning is done",
};

export async function setLateCheckout(desk: LateCheckoutDesk, input: { checkout?: string; time?: string; confirmation?: string }): Promise<LateCheckoutReply> {
  const engine = desk.engine();
  if (!engine) return { ok: false, error: "Run the checks first." };
  const checkout = input.checkout ?? "";
  const time = input.time ?? "";
  if (!DATE.test(checkout) || !TIME.test(time)) return { ok: false, error: "Give checkout as YYYY-MM-DD and the new time as 24-hour HH:MM." };
  const job = engine.jobs().find((item) => item.checkoutDate === checkout && item.status !== "canceled" && item.status !== "declined");
  if (!job) return { ok: false, error: `No cleaning checks out on ${checkout}, so nothing changed. Check the date with the host.` };
  const closed = CLOSED[job.status];
  if (closed) return { ok: false, error: `${closed[0]!.toUpperCase()}${closed.slice(1)} for checkout on ${checkout}, so I left it as it was. Tell the host to arrange the late checkout with the cleaner themselves.` };
  const minutes = minutesOf(time);
  const current = (job.checkoutTime ? clockMinutes(job.checkoutTime) : undefined) ?? (desk.usualCheckout() ? minutesOf(desk.usualCheckout()!) : undefined);
  if (current !== undefined && minutes <= current) return { ok: false, error: `Checkout is already ${clock(current)} that day, so ${clock(minutes)} isn't a late checkout. Nothing changed. Ask the host for a later time.` };
  const sameDay = job.nextCheckInDate === checkout;
  const nextIn = !sameDay ? undefined : job.nextCheckInTime ? clockMinutes(job.nextCheckInTime) : desk.usualCheckIn() ? minutesOf(desk.usualCheckIn()!) : undefined;
  if (nextIn !== undefined && minutes >= nextIn) return { ok: false, error: `The next guest checks in at ${clock(nextIn)} that day, so a checkout at ${clock(minutes)} leaves no time to clean. Nothing changed. Ask the host for an earlier time.` };
  const fingerprint = createHash("sha256").update(`late-checkout|${job.id}|${checkout}|${time}|${current ?? ""}`).digest("hex");
  const code = input.confirmation?.trim() ?? "";
  if (!code) {
    const zone = desk.timeZone() ?? "UTC";
    const day = formatWhen(zonedInstant(checkout, "12:00", zone), zone).day;
    const from = current !== undefined ? ` from ${clock(current)}` : "";
    const gap = nextIn !== undefined ? ` ${desk.cleanerName()} then has ${hours(nextIn - minutes)} before the next check-in at ${clock(nextIn)}.` : "";
    const label = desk.propertyLabel();
    const next = `${label ? `At ${label}, checkout` : "Checkout"} on ${day} moves${from} to ${clock(minutes)}.${gap} They get Cleaner Core's usual update text. Reply yes to allow it.`;
    return { ok: true, result: { next, confirmation: desk.issueApproval(job.id, fingerprint, next) } };
  }
  if (!desk.redeem(code, job.id, fingerprint)) return { ok: false, error: "That approval has expired or doesn't match. Ask the host again." };
  const result = await engine.setJobTimes({ jobId: job.id, checkout: minutes });
  if (!result.applied) return { ok: false, error: result.reason === "code-sent" ? "The door code went out before the change, so I left that cleaning as it was." : "That cleaning can't be changed now, so I left it as it was." };
  const after = engine.jobs().find((item) => item.id === job.id);
  if (after?.checkoutAt && after.checkoutTime !== job.checkoutTime) await stayCodeHook().windowMoved({ jobId: job.id, window: { start: after.checkoutAt, end: after.nextCheckInAt } });
  appendGuestMessage(desk.root, { at: desk.now().toISOString(), id: `lc_${job.id}`, event: "late-checkout", lateCheckout: { checkout, time } });
  return { ok: true, result: { applied: true, checkout, time, next: `Done. Checkout is now ${clock(minutes)}. Tell the host, and update the guest's reply if one is waiting.` } };
}

function hours(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  return h ? `${h} hour${h === 1 ? "" : "s"} ${minutes % 60} minutes` : `${minutes} minutes`;
}
