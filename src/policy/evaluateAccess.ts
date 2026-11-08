import type { DurinHealth } from "../durin/DurinAccessAdapter";
import type { Consent, Prospect, Reservation, Verification } from "../domain/model";

export type AccessDecisionCode =
  | "ALLOW"
  | "DENY_NO_RESERVATION"
  | "DENY_PROSPECT_MISMATCH"
  | "DENY_CANCELLED"
  | "DENY_REVOKED"
  | "DENY_OPERATOR_HOLD"
  | "DENY_PROVIDER_FAILURE"
  | "DENY_STORAGE_FAILURE"
  | "DENY_VERIFICATION_FAILED"
  | "DENY_TOUR_COMPLETED"
  | "DENY_CONSENT_MISSING"
  | "DENY_VERIFICATION_INCOMPLETE"
  | "DENY_VERIFICATION_STALE"
  | "DENY_NOT_READY"
  | "DENY_TOO_EARLY"
  | "DENY_EXPIRED"
  | "DENY_WRONG_ROUTE"
  | "DENY_DOOR_UNHEALTHY"
  | "DENY_UNKNOWN";

/**
 * Decision codes kept in the append-only audit before saadvz/PropertyCore#179.
 * Readers of old audit events map them to the current code.
 */
const LEGACY_DECISION_CODES: Readonly<Record<string, AccessDecisionCode>> = { DENY_DURIN_UNHEALTHY: "DENY_DOOR_UNHEALTHY" };

export function currentDecisionCode(code: string | undefined): string | undefined {
  return code === undefined ? undefined : (LEGACY_DECISION_CODES[code] ?? code);
}

export interface AccessDecision {
  allowed: boolean;
  code: AccessDecisionCode;
  reason: string;
}

export interface AccessPolicyInput {
  reservation: Reservation | undefined;
  prospect: Prospect | undefined;
  consent: Consent | undefined;
  verification: Verification | undefined;
  doorId: string;
  requestedAt: Date;
  durinHealth: DurinHealth | undefined;
}

const deny = (code: Exclude<AccessDecisionCode, "ALLOW">, reason: string): AccessDecision => ({ allowed: false, code, reason });

/**
 * The single gate in front of Durin. Pure and deterministic: same input, same
 * answer. Anything not explicitly proven safe is denied.
 */
export function evaluateAccess(input: AccessPolicyInput): AccessDecision {
  try {
    return evaluate(input);
  } catch {
    return deny("DENY_UNKNOWN", "policy could not evaluate the request");
  }
}

function evaluate({ reservation, prospect, consent, verification, doorId, requestedAt, durinHealth }: AccessPolicyInput): AccessDecision {
  if (!reservation) return deny("DENY_NO_RESERVATION", "no reservation found");
  if (!prospect || prospect.id !== reservation.prospectId) {
    return deny("DENY_PROSPECT_MISMATCH", "requester is not the prospect on this reservation");
  }

  switch (reservation.status) {
    case "CANCELLED":
      return deny("DENY_CANCELLED", "reservation was cancelled");
    case "REVOKED":
      return deny("DENY_REVOKED", "reservation was revoked");
    case "OPERATOR_HOLD":
      return deny("DENY_OPERATOR_HOLD", "an operator hold is in place");
    case "PROVIDER_FAILURE":
      return deny("DENY_PROVIDER_FAILURE", "reservation is paused after an access provider failure");
    case "VERIFICATION_FAILED":
      return deny("DENY_VERIFICATION_FAILED", "identity verification failed");
    case "EXPIRED":
      return deny("DENY_EXPIRED", "reservation has expired");
    case "COMPLETED":
      return deny("DENY_TOUR_COMPLETED", "tour is already complete");
    case "INQUIRY":
    case "RESERVED":
    case "AWAITING_CONSENT":
    case "AWAITING_VERIFICATION":
    case "READY":
    case "TOURING":
      break;
    default:
      return deny("DENY_UNKNOWN", "unrecognized reservation status");
  }

  if (!consent || !consent.granted || consent.id !== reservation.consentId || consent.prospectId !== prospect.id) {
    return deny("DENY_CONSENT_MISSING", "consent has not been recorded");
  }

  if (
    !verification ||
    verification.status !== "PASSED" ||
    verification.id !== reservation.verificationId ||
    verification.prospectId !== prospect.id
  ) {
    return deny("DENY_VERIFICATION_INCOMPLETE", "identity verification is not complete");
  }

  if (reservation.status !== "READY" && reservation.status !== "TOURING") {
    return deny("DENY_NOT_READY", `reservation is ${reservation.status}, not ready for access`);
  }

  const now = requestedAt.getTime();
  const windowStart = reservation.windowStart ? Date.parse(reservation.windowStart) : NaN;
  const windowEnd = reservation.windowEnd ? Date.parse(reservation.windowEnd) : NaN;
  // No form has no identity expiry. The booked window and route still decide access.
  const identityExpires = verification.method !== "none";
  const verifiedUntil = identityExpires ? Date.parse(verification.validUntil) : now;
  if ([now, windowStart, windowEnd, verifiedUntil].some(Number.isNaN)) {
    return deny("DENY_UNKNOWN", "reservation time window is missing or invalid");
  }
  if (identityExpires && now >= verifiedUntil) return deny("DENY_VERIFICATION_STALE", "identity verification has lapsed");
  if (now < windowStart) return deny("DENY_TOO_EARLY", "tour window has not opened yet");
  if (now >= windowEnd) return deny("DENY_EXPIRED", "tour window has closed");

  if (!reservation.allowedRoute.includes(doorId)) {
    return deny("DENY_WRONG_ROUTE", "door not part of reserved route");
  }

  if (!durinHealth || durinHealth.healthy !== true) {
    return deny("DENY_DOOR_UNHEALTHY", `The door system is not healthy${durinHealth?.detail ? `: ${durinHealth.detail}` : ""}`);
  }

  return { allowed: true, code: "ALLOW", reason: "all access checks passed" };
}
