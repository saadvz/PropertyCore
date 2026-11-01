import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanerMultiTenant, tourCoreTenants } from "../src/cleaner-core/flag";
import { isTenantId, TenantRegistry, tenantFolder } from "../src/cleaner-core/hosted/registry";

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;

let dir: string;
let at: number;
let reg: TenantRegistry;
const advance = (ms: number) => void (at += ms);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cleaner-registry-"));
  at = Date.parse("2026-10-27T10:00:00.000Z");
  reg = new TenantRegistry(dir, () => new Date(at));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cleanerMultiTenant", () => {
  it("is on only for 1 or true", () => {
    expect(cleanerMultiTenant({ CLEANER_CORE_MULTI_TENANT: "1" })).toBe(true);
    expect(cleanerMultiTenant({ CLEANER_CORE_MULTI_TENANT: " TRUE " })).toBe(true);
    expect(cleanerMultiTenant({ CLEANER_CORE_MULTI_TENANT: "yes" })).toBe(false);
    expect(cleanerMultiTenant({})).toBe(false);
  });
});

describe("TenantRegistry", () => {
  it("creates a tenant with a normalized unique number and a one-time invite", () => {
    const { tenant, inviteCode } = reg.create({ label: "Lane", twilioNumber: "(555) 555-0150" });
    expect(tenant.id).toMatch(/^tnt_[a-z0-9]{10}$/);
    expect(isTenantId(tenant.id)).toBe(true);
    expect(tenant.twilioNumber).toBe("+15555550150");
    expect(inviteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(readFileSync(join(dir, "tenants.json"), "utf8")).not.toContain(inviteCode.replaceAll("-", ""));
    expect(() => reg.create({ label: "Court", twilioNumber: "+1 555 555 0150" })).toThrow(expect.objectContaining({ reason: "number-taken" }));
    expect(() => reg.create({ label: " ", twilioNumber: "+15555550151" })).toThrow(expect.objectContaining({ reason: "bad-label" }));
    expect(() => reg.create({ label: "Court", twilioNumber: "12" })).toThrow(expect.objectContaining({ reason: "bad-number" }));
    expect(tenantFolder(dir, tenant.id)).toBe(join(dir, "tenants", tenant.id));
  });

  it("claims an invite once, ignoring case, spaces and dashes", () => {
    const { tenant, inviteCode } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    expect(reg.claimInvite(inviteCode.toLowerCase().replaceAll("-", " "))).toEqual({ tenantId: tenant.id });
    expect(reg.claimInvite(inviteCode)).toEqual({ refused: "used" });
    expect(reg.claimInvite("AAAA-AAAA-AAAA")).toEqual({ refused: "invalid" });
    expect(reg.claimInvite("")).toEqual({ refused: "invalid" });
  });

  it("refuses an expired invite and an invite for a disabled tenant", () => {
    const a = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    advance(7 * DAY + 1);
    expect(reg.claimInvite(a.inviteCode)).toEqual({ refused: "expired" });
    const code = reg.invite(a.tenant.id);
    reg.setDisabled(a.tenant.id, true);
    expect(reg.claimInvite(code)).toEqual({ refused: "disabled" });
    reg.setDisabled(a.tenant.id, false);
    expect(reg.claimInvite(code)).toEqual({ tenantId: a.tenant.id });
  });

  it("refuses work on an unknown tenant", () => {
    expect(() => reg.invite("tnt_aaaaaaaaaa")).toThrow(expect.objectContaining({ reason: "unknown-tenant" }));
  });

  it("makes the first connection primary and falls back to the oldest live one", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    reg.connect(tenant.id, { grantId: "g1", assistant: "grok", connectedAt: "2026-10-27T10:00:00.000Z" });
    reg.connect(tenant.id, { grantId: "g2", assistant: "claude", connectedAt: "2026-10-27T11:00:00.000Z" });
    reg.connect(tenant.id, { grantId: "g3", assistant: "chatgpt", connectedAt: "2026-10-27T12:00:00.000Z" });
    expect(reg.get(tenant.id)?.primaryGrantId).toBe("g1");
    expect(reg.primary(tenant.id, () => true)?.grantId).toBe("g1");
    expect(reg.primary(tenant.id, (g) => g !== "g1")?.grantId).toBe("g2");
    expect(reg.primary(tenant.id, () => false)).toBeUndefined();
    reg.setPrimary(tenant.id, "g3");
    expect(reg.primary(tenant.id, () => true)?.assistant).toBe("chatgpt");
    reg.disconnect(tenant.id, "g3");
    expect(reg.get(tenant.id)?.primaryGrantId).toBe("g1");
    reg.disconnect(tenant.id, "g1");
    reg.disconnect(tenant.id, "g2");
    expect(reg.get(tenant.id)?.primaryGrantId).toBeUndefined();
  });

  it("finds a tenant by number in any format, and remove frees the number", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    expect(reg.byNumber("+1 (555) 555-0150")?.id).toBe(tenant.id);
    expect(reg.byNumber("nonsense")).toBeUndefined();
    expect(reg.remove(tenant.id)?.id).toBe(tenant.id);
    expect(reg.byNumber("+15555550150")).toBeUndefined();
    expect(() => reg.create({ label: "Court", twilioNumber: "+15555550150" })).not.toThrow();
  });

  it("writes lastActivityAt at most every 5 minutes", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    reg.touch(tenant.id);
    const first = reg.get(tenant.id)?.lastActivityAt;
    expect(first).toBe(new Date(at).toISOString());
    advance(4 * MINUTE);
    reg.touch(tenant.id);
    expect(reg.get(tenant.id)?.lastActivityAt).toBe(first);
    advance(2 * MINUTE);
    reg.touch(tenant.id);
    expect(reg.get(tenant.id)?.lastActivityAt).toBe(new Date(at).toISOString());
  });

  it("rejects a malformed tenant id", () => {
    expect(isTenantId("tnt_AAAAAAAAAA")).toBe(false);
    expect(isTenantId("../etc")).toBe(false);
    expect(reg.get("../etc")).toBeUndefined();
  });
});

describe("tourCoreTenants", () => {
  it("reads TOUR_CORE_TENANTS as on only for 1 or true", () => {
    expect(tourCoreTenants({ TOUR_CORE_TENANTS: "1" })).toBe(true);
    expect(tourCoreTenants({ TOUR_CORE_TENANTS: " true " })).toBe(true);
    expect(tourCoreTenants({ TOUR_CORE_TENANTS: "yes" })).toBe(false);
    expect(tourCoreTenants({})).toBe(false);
  });
});

describe("a tenant's service", () => {
  const lane = {
    id: "tnt_lane000001",
    label: "Lane",
    twilioNumber: "+15555550150",
    connections: [],
    invites: [],
    createdAt: "2026-10-01T00:00:00.000Z",
  };

  it("turns every tenant in a version-1 file into a cleaning tenant, once", () => {
    writeFileSync(join(dir, "tenants.json"), JSON.stringify({ schemaVersion: 1, tenants: [lane] }));
    expect(reg.get(lane.id)?.service).toBe("cleaning");
    expect(JSON.parse(readFileSync(join(dir, "tenants.json"), "utf8")).schemaVersion).toBe(2);
    expect(reg.list()[0]?.service).toBe("cleaning");
  });

  it("creates a new tenant with no service", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    expect(tenant.service).toBeUndefined();
    expect(reg.get(tenant.id)?.service).toBeUndefined();
  });

  it("does not turn a new tenant in a version-2 file into a cleaning tenant", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    const again = new TenantRegistry(dir, () => new Date(at));
    expect(again.get(tenant.id)?.service).toBeUndefined();
  });

  it("records a service change and when it happened", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    advance(MINUTE);
    reg.setService(tenant.id, "touring");
    expect(reg.get(tenant.id)).toMatchObject({ service: "touring", serviceChangedAt: new Date(at).toISOString() });
  });

  it("refuses a service change for an unknown tenant", () => {
    expect(() => reg.setService("tnt_nobody0000", "touring")).toThrow("unknown-tenant");
  });
});
