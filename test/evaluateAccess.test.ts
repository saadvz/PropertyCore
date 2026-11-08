import { describe, expect, it } from "vitest";
import type { Consent, Prospect, Reservation, Verification } from "../src/domain/model";
import { evaluateAccess, type AccessPolicyInput } from "../src/policy/evaluateAccess";

const at = (h: number, m: number) => new Date(2026, 8, 28, h, m);
const iso = (h: number, m: number) => at(h, m).toISOString();

const prospect: Prospect = { id: "prs_1", name: "Jane Smith", phone: "+15550101234", createdAt: iso(10, 0) };
const consent: Consent = {
  id: "cns_1",
  prospectId: "prs_1",
  reservationId: "res_1",
  granted: true,
  scope: ["messaging", "tour_records"],
  text: "ok",
  recordedAt: iso(10, 0),
};
const verification: Verification = {
  id: "ver_1",
  prospectId: "prs_1",
  reservationId: "res_1",
  method: "basic-form",
  status: "PASSED",
  reference: "form_1",
  completedAt: iso(10, 5),
  validUntil: new Date(2026, 9, 28).toISOString(),
};
const reservation: Reservation = {
  id: "res_1",
  prospectId: "prs_1",
  propertyId: "prop_100_alfred_way",
  unitId: "apt_101",
  routeId: "route_apt_101",
  allowedRoute: ["entrance", "unit_101"],
  status: "READY",
  slotStart: iso(14, 0),
  windowStart: iso(13, 50),
  windowEnd: iso(14, 45),
  consentId: "cns_1",
  verificationId: "ver_1",
  createdAt: iso(10, 0),
  updatedAt: iso(10, 5),
};

const input = (overrides: Partial<AccessPolicyInput> = {}): AccessPolicyInput => ({
  reservation,
  prospect,
  consent,
  verification,
  doorId: "entrance",
  requestedAt: at(14, 0),
  durinHealth: { healthy: true, checkedAt: iso(14, 0) },
  ...overrides,
});

describe("evaluateAccess", () => {
  it("allows the entrance and the reserved unit during the window", () => {
    expect(evaluateAccess(input({ doorId: "entrance" }))).toMatchObject({ allowed: true, code: "ALLOW" });
    expect(evaluateAccess(input({ doorId: "unit_101", reservation: { ...reservation, status: "TOURING" } }))).toMatchObject({ allowed: true, code: "ALLOW" });
  });

  it("denies a door outside the reserved route", () => {
    expect(evaluateAccess(input({ doorId: "unit_102" }))).toMatchObject({ allowed: false, code: "DENY_WRONG_ROUTE" });
  });

  it("denies too early", () => {
    expect(evaluateAccess(input({ requestedAt: at(13, 49) }))).toMatchObject({ allowed: false, code: "DENY_TOO_EARLY" });
  });

  it("denies after the window closes, and for an EXPIRED reservation", () => {
    expect(evaluateAccess(input({ requestedAt: at(14, 45) }))).toMatchObject({ allowed: false, code: "DENY_EXPIRED" });
    expect(evaluateAccess(input({ reservation: { ...reservation, status: "EXPIRED" } }))).toMatchObject({ allowed: false, code: "DENY_EXPIRED" });
  });

  it("denies a revoked reservation", () => {
    expect(evaluateAccess(input({ reservation: { ...reservation, status: "REVOKED" } }))).toMatchObject({ allowed: false, code: "DENY_REVOKED" });
  });

  it("denies when verification is incomplete or failed", () => {
    const pending = { ...reservation, status: "AWAITING_VERIFICATION" as const, verificationId: undefined };
    expect(evaluateAccess(input({ reservation: pending, verification: undefined }))).toMatchObject({ code: "DENY_VERIFICATION_INCOMPLETE" });
    expect(evaluateAccess(input({ verification: { ...verification, status: "FAILED" } }))).toMatchObject({ code: "DENY_VERIFICATION_INCOMPLETE" });
  });

  it("denies when consent is missing", () => {
    expect(evaluateAccess(input({ consent: undefined }))).toMatchObject({ allowed: false, code: "DENY_CONSENT_MISSING" });
  });

  it("denies when verification has lapsed", () => {
    expect(evaluateAccess(input({ verification: { ...verification, validUntil: iso(13, 0) } }))).toMatchObject({
      allowed: false,
      code: "DENY_VERIFICATION_STALE",
    });
  });

  it("does not expire a no-form verification; the window and route still apply", () => {
    const none = { ...verification, method: "none" as const, validUntil: iso(13, 0) };
    expect(evaluateAccess(input({ verification: none }))).toMatchObject({ allowed: true, code: "ALLOW" });
    expect(evaluateAccess(input({ verification: { ...none, validUntil: "not-a-date" } }))).toMatchObject({ allowed: true, code: "ALLOW" });
    expect(evaluateAccess(input({ verification: none, requestedAt: at(13, 49) }))).toMatchObject({ code: "DENY_TOO_EARLY" });
    expect(evaluateAccess(input({ verification: none, requestedAt: at(14, 45) }))).toMatchObject({ code: "DENY_EXPIRED" });
    expect(evaluateAccess(input({ verification: none, doorId: "unit_102" }))).toMatchObject({ code: "DENY_WRONG_ROUTE" });
  });

  it("denies under an operator hold", () => {
    expect(evaluateAccess(input({ reservation: { ...reservation, status: "OPERATOR_HOLD" } }))).toMatchObject({ allowed: false, code: "DENY_OPERATOR_HOLD" });
  });

  it("fails closed when Durin is unhealthy or health is unknown", () => {
    expect(evaluateAccess(input({ durinHealth: { healthy: false, checkedAt: iso(14, 0) } }))).toMatchObject({ allowed: false, code: "DENY_DOOR_UNHEALTHY" });
    expect(evaluateAccess(input({ durinHealth: undefined }))).toMatchObject({ allowed: false, code: "DENY_DOOR_UNHEALTHY" });
  });

  it("denies a different prospect and a missing reservation", () => {
    expect(evaluateAccess(input({ prospect: { ...prospect, id: "prs_other" } }))).toMatchObject({ code: "DENY_PROSPECT_MISMATCH" });
    expect(evaluateAccess(input({ reservation: undefined }))).toMatchObject({ code: "DENY_NO_RESERVATION" });
  });

  it("denies unknown conditions", () => {
    expect(evaluateAccess(input({ reservation: { ...reservation, windowEnd: undefined } }))).toMatchObject({ allowed: false, code: "DENY_UNKNOWN" });
    expect(evaluateAccess(input({ reservation: { ...reservation, status: "SOMETHING_NEW" as never } }))).toMatchObject({ allowed: false, code: "DENY_UNKNOWN" });
    expect(evaluateAccess(input({ requestedAt: new Date(NaN) }))).toMatchObject({ allowed: false, code: "DENY_UNKNOWN" });
  });
});
