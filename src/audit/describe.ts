import { isTeamTextFailedNotice } from "../core/TourCore";
import { formatPhone, helpNear } from "../core/phone";
import { formatTime } from "../core/timezone";
import { UNNAMED_VISITOR, type AuditEvent } from "../domain/model";
import type { ExportBundle } from "../export/exportBundle";
import { currentDecisionCode } from "../policy/evaluateAccess";

export interface HistoryEntry {
  at: string;
  /** Property-local, e.g. "9:02 AM". */
  time: string;
  /** Operator-facing sentence. Never contains event names or codes. */
  text: string;
  tone: "good" | "blocked" | "info";
  /** Raw event, for developer mode only. */
  dev: { type: AuditEvent["type"]; code?: string; doorId?: string; reservationId?: string; detail: string };
}

type Context = Pick<ExportBundle, "doors" | "units" | "prospects" | "reservations"> & { operatorName?: string };

/**
 * Translates the audit trail into plain sentences. Purely presentational:
 * the append-only audit itself is unchanged. Step-by-step request events are
 * folded into their outcome, so each line is something a person cares about.
 */
export function describeHistory(events: AuditEvent[], context: Context, timeZone: string): HistoryEntry[] {
  const door = (id?: string) => context.doors.find((d) => d.id === id)?.name ?? "a door that isn't on file";
  const person = (id?: string) => {
    const prospect = context.prospects.find((p) => p.id === id);
    const name = prospect?.name?.trim();
    if (name && name !== UNNAMED_VISITOR && !/^A visitor\b/i.test(name) && !/^\(?\+?\d/.test(name)) {
      return name.split(/\s+/)[0]!;
    }
    if (prospect?.phone) return formatPhone(prospect.phone);
    if (name && /^\(?\+?\d/.test(name)) return name;
    return "the visitor";
  };
  const unitFor = (reservationId?: string) => {
    const res = context.reservations.find((r) => r.id === reservationId);
    return context.units.find((u) => u.id === res?.unitId)?.name ?? "the unit";
  };
  const slotFor = (reservationId?: string) => {
    const start = context.reservations.find((r) => r.id === reservationId)?.slotStart;
    return start ? formatTime(new Date(start), timeZone) : undefined;
  };
  const out: HistoryEntry[] = [];
  for (const e of events) {
    const name = person(e.prospectId);
    const said = sentence(e, { name, door: door(e.doorId), unit: unitFor(e.reservationId), slot: slotFor(e.reservationId) });
    if (!said) continue;
    out.push({
      at: e.at,
      time: formatTime(new Date(e.at), timeZone),
      text: said.text,
      tone: said.tone,
      dev: { type: e.type, ...(e.code ? { code: e.code } : {}), ...(e.doorId ? { doorId: e.doorId } : {}), ...(e.reservationId ? { reservationId: e.reservationId } : {}), detail: e.detail },
    });
  }
  return out;
}

function sentence(
  e: AuditEvent,
  c: { name: string; door: string; unit: string; slot?: string },
): { text: string; tone: HistoryEntry["tone"] } | undefined {
  const info = (text: string) => ({ text, tone: "info" as const });
  const good = (text: string) => ({ text, tone: "good" as const });
  const blocked = (text: string) => ({ text, tone: "blocked" as const });

  switch (e.type) {
    case "PROSPECT_CREATED":
      return info(`${c.name} got in touch for the first time.`);
    case "PROSPECT_RETURNED":
      return info(`${c.name} came back to book another tour.`);
    case "INQUIRY_STARTED":
      return info(`${c.name} asked about touring ${c.unit}.`);
    case "RESERVATION_CREATED":
      return good(`${c.name}'s tour was reserved${c.slot ? ` for ${c.slot}` : ""}.`);
    case "CONSENT_REQUESTED":
      return info(`${c.name} was asked for permission to text and keep tour records.`);
    case "CONSENT_RECORDED":
      return e.detail.startsWith("granted") ? good(`${c.name} said yes to texts and tour records.`) : info(`${c.name} said no to texts, so the tour was not booked.`);
    case "VERIFICATION_REQUESTED":
      return info(`${c.name} was asked to confirm their identity.`);
    case "VERIFICATION_COMPLETED":
      return good(`${c.name} completed the identity form.`);
    case "VERIFICATION_REUSED":
      if (e.detail.startsWith("none ")) return undefined;
      return good(`${c.name}'s earlier identity form was reused.`);
    case "VERIFICATION_FAILED":
      return blocked(`${c.name}'s identity details didn't check out. The tour was stopped.`);
    case "TOUR_READY":
      return good(`${c.name}'s tour is ready.`);
    case "ACCESS_REQUESTED":
      return undefined;
    case "ACCESS_ALLOWED":
      return e.detail.startsWith("duplicate")
        ? info(`${c.door} was requested again. It was already open, so no second access was created.`)
        : good(`${c.door} access was approved for ${c.name}.`);
    case "ACCESS_DENIED":
      return blocked(denial(e.code, c));
    case "ACCESS_REVOKED":
      return info(`Access to ${c.door} was switched off.`);
    case "TOUR_STARTED":
      return info(`${c.name} started the tour.`);
    case "TOUR_COMPLETED":
      return good(`${c.name} finished the tour.`);
    case "TOUR_EXTENDED":
      return info(`${c.name}'s tour was extended by 10 minutes.`);
    case "TOUR_OVERSTAY_CLOSED":
      return info(`${c.name}'s tour was closed after they didn't confirm leaving.`);
    case "VISITOR_CONFIRMED_LEFT":
      return good(`${c.name} confirmed they had left after the tour closed.`);
    case "FOLLOW_UP_SENT":
      return info(`A follow-up message was sent to ${c.name}.`);
    case "RESERVATION_CANCELLED":
      return e.detail.includes("replaced by the operator's one-off")
        ? info(`${c.name}'s unfinished conversation was replaced by a tour the property team set up.`)
        : info(`${c.name}'s tour was cancelled.`);
    case "RESERVATION_REVOKED":
      return blocked(`${c.name}'s tour was called off, and their access was switched off.`);
    case "OPERATOR_HOLD_PLACED":
      return blocked(`${c.name}'s tour was paused.`);
    case "RESERVATION_RESUMED":
      return info(`${c.name}'s tour was resumed.`);
    case "PROVIDER_FAILURE":
      return blocked(
        e.code === "DENY_STORAGE_FAILURE"
          ? "Tour Core couldn't save the visit record, so the tour was paused."
          : `The door system had a problem during ${c.name}'s tour, so the tour was paused.`,
      );
    case "OPERATOR_NOTIFIED":
      return info(`The property team was alerted: ${e.detail}`);
    case "RESERVATION_RESCHEDULED":
      return info(`${c.name}'s tour was moved ${e.detail.split(";")[0]}.`);
    case "TOUR_TIME_REQUESTED":
      return info(`${c.name} asked for a different tour time.`);
    case "TOUR_TIME_REQUEST_APPROVED":
      if (e.detail.startsWith("visitor accepted ")) {
        return good(`${c.name} accepted ${e.detail.slice("visitor accepted ".length)}.`);
      }
      return good(`The property team approved ${c.name}'s requested tour time.`);
    case "TOUR_TIME_REQUEST_DECLINED":
      return info(`The property team couldn't do ${c.name}'s requested tour time.`);
    case "TOUR_TIME_REQUEST_WITHDRAWN":
      return info(`${c.name} booked a regular time instead.`);
    case "TOUR_TIME_REQUEST_EXPIRED":
      return info(`${c.name}'s requested tour time had already passed.`);
    case "TOUR_TIME_ALTERNATIVE_PROPOSED":
      return info(`The property team offered ${c.name} a different tour time.`);
    case "TOUR_RESCHEDULED":
      return info(`${c.name}'s tour was moved ${e.detail}.`);
    case "TOUR_TIME_OVERRIDE_APPROVED":
      return info(`The property team approved a one-time tour for ${c.name} outside the normal touring hours.`);
    case "TOURS_PAUSED":
      return info("Tours were paused.");
    case "TOURS_RESUMED":
      return info("Tours were resumed.");
    case "TOURS_BACK_NOTIFIED":
      return info(`${c.name} was told tours are back.`);
    case "PROPERTY_REMOVED":
      return info("The property was removed.");
    case "QUESTION_ANSWERED":
      return good(`${c.name} asked "${quotedHistoryAsk(e.detail)}" and got an answer from your approved facts.`);
    case "QUESTION_UNANSWERED": {
      const asked = quotedHistoryAsk(e.detail);
      const period = /[.!?]$/.test(asked) ? "" : ".";
      return blocked(`${c.name} asked "${asked}"${period} There was no approved answer, so it was flagged for your team.`);
    }
    case "HANDLER_FAILED":
      return blocked(e.detail);
    case "HELP_REQUESTED":
      return blocked(`${c.name} asked for help${helpNear(e.detail)}.`);
    case "MESSAGE_FAILED":
      return isTeamTextFailedNotice(e.detail) ? info(e.detail) : info("Something happened on this tour.");
    case "FOLLOW_UP_RESPONSE":
      return e.detail === "yes" ? good(`${c.name} would like someone to follow up.`) : info(`${c.name} doesn't need a follow-up.`);
    default:
      return info("Something happened on this tour.");
  }
}

/** A double quote inside the visitor's words is a single quote, so the sentence stays one pair of quotes. */
function quotedHistoryAsk(detail: string): string {
  return detail.replaceAll('"', "'");
}

function denial(code: string | undefined, c: { name: string; door: string }): string {
  switch (currentDecisionCode(code)) {
    case "DENY_TOO_EARLY":
      return `${c.name} arrived too early. ${c.door} stayed locked.`;
    case "DENY_WRONG_ROUTE":
      return `Access to ${c.door} was denied because it was not part of ${c.name}'s tour.`;
    case "DENY_EXPIRED":
      return `${c.name}'s tour time had ended. ${c.door} stayed locked.`;
    case "DENY_TOUR_COMPLETED":
      return `${c.name}'s tour was already over. ${c.door} stayed locked.`;
    case "DENY_DOOR_UNHEALTHY":
      return `The door system wasn't responding, so ${c.door} stayed locked.`;
    case "DENY_PROVIDER_FAILURE":
      return `The door system couldn't open ${c.door}, so it stayed locked.`;
    case "DENY_STORAGE_FAILURE":
      return `Tour Core couldn't save the visit record, so ${c.door} stayed locked.`;
    case "DENY_CONSENT_MISSING":
    case "DENY_VERIFICATION_INCOMPLETE":
    case "DENY_VERIFICATION_STALE":
    case "DENY_NOT_READY":
      return `${c.name} hadn't finished the steps before the tour. ${c.door} stayed locked.`;
    case "DENY_CANCELLED":
    case "DENY_REVOKED":
      return `${c.name}'s tour was no longer active. ${c.door} stayed locked.`;
    case "DENY_OPERATOR_HOLD":
      return `${c.name}'s tour was paused. ${c.door} stayed locked.`;
    default:
      return `${c.door} stayed locked for ${c.name}.`;
  }
}
