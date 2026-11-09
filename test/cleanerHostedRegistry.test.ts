import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanerMultiTenant, tourCoreTenants } from "../src/cleaner-core/flag";
import { findProperty, isPropertyId, migratedPropertyId, newPropertyId, propertyBasePath, propertyFolder } from "../src/cleaner-core/hosted/properties";
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

describe("an account's properties", () => {
  it("creates a new account with no properties and no service", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    expect(tenant.properties).toEqual([]);
    expect(tenant.service).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "tenants.json"), "utf8")).schemaVersion).toBe(3);
  });

  it("adds a property with every flow off", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    const property = reg.addProperty(tenant.id, " 12 Scratch Lane ");
    expect(isPropertyId(property.id)).toBe(true);
    expect(property.label).toBe("12 Scratch Lane");
    expect(property.flows).toEqual({ cleaning: { on: false }, supplies: { on: false }, fixer: { on: false } });
    expect(reg.get(tenant.id)?.properties).toEqual([property]);
    expect(() => reg.addProperty(tenant.id, "  ")).toThrow(expect.objectContaining({ reason: "bad-label" }));
    expect(() => reg.addProperty("tnt_nobody0000", "Court")).toThrow(expect.objectContaining({ reason: "unknown-tenant" }));
  });

  it("switches one flow on one property", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    const lane = reg.addProperty(tenant.id, "12 Scratch Lane");
    const court = reg.addProperty(tenant.id, "8 Scratch Court");
    advance(MINUTE);
    const changed = reg.setFlow(tenant.id, lane.id, "cleaning", true);
    expect(changed.flows.cleaning).toEqual({ on: true, changedAt: new Date(at).toISOString() });
    expect(reg.get(tenant.id)?.properties.find((p) => p.id === court.id)?.flows).toEqual(court.flows);
    expect(() => reg.setFlow(tenant.id, "prp_nothere000", "cleaning", true)).toThrow(expect.objectContaining({ reason: "unknown-property" }));
  });

  it("refuses a second property with the same label, in any case", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    reg.addProperty(tenant.id, "12 Scratch Lane");
    expect(() => reg.addProperty(tenant.id, " 12 SCRATCH lane ")).toThrow(expect.objectContaining({ reason: "duplicate-label" }));
    const other = reg.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    expect(reg.addProperty(other.id, "12 Scratch Lane").label).toBe("12 Scratch Lane");
  });

  // FIXER_CORE and the chat are set_flows' checks (test/fixerHosted.test.ts): the registry only saves the switch.
  it("switches fixer on and off", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    const lane = reg.addProperty(tenant.id, "12 Scratch Lane");
    expect(reg.setFlow(tenant.id, lane.id, "fixer", true).flows.fixer.on).toBe(true);
    expect(reg.setFlow(tenant.id, lane.id, "fixer", false).flows.fixer.on).toBe(false);
  });

  it("refuses a v2 file", () => {
    writeFileSync(join(dir, "tenants.json"), JSON.stringify({ schemaVersion: 2, tenants: [] }));
    expect(() => reg.list()).toThrow(expect.objectContaining({ reason: "needs-migration" }));
  });

  it("setTouring makes an account touring, and refuses one with properties", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    advance(MINUTE);
    reg.setTouring(tenant.id);
    expect(reg.get(tenant.id)).toMatchObject({ service: "touring", serviceChangedAt: new Date(at).toISOString() });
    const other = reg.create({ label: "Court", twilioNumber: "+15555550160" }).tenant;
    reg.addProperty(other.id, "8 Scratch Court");
    expect(() => reg.setTouring(other.id)).toThrow(expect.objectContaining({ reason: "has-properties" }));
  });

  it("findProperty takes an id or a unique label, in any case", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    const lane = reg.addProperty(tenant.id, "12 Scratch Lane");
    reg.addProperty(tenant.id, "8 Scratch Court");
    const account = reg.get(tenant.id)!;
    expect(findProperty(account, lane.id)).toEqual(lane);
    expect(findProperty(account, " 12 scratch lane ")).toEqual(lane);
    expect(findProperty(account, "Scratch")).toBeUndefined();
    // Labels are unique per account, so a label names one property.
    const twice = { ...account, properties: [...account.properties, { ...lane, id: "prp_twice00000" }] };
    expect(findProperty(twice, "12 scratch lane")).toBeUndefined();
  });

  it("names folders and link bases for a property", () => {
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    const lane = reg.addProperty(tenant.id, "12 Scratch Lane");
    expect(propertyFolder(dir, tenant.id, lane)).toBe(join(dir, "tenants", tenant.id, "properties", lane.id));
    expect(propertyBasePath(tenant.id, lane)).toBe(`/t/${tenant.id}/p/${lane.id}`);
    expect(propertyBasePath(tenant.id, { ...lane, legacyPaths: true })).toBe(`/t/${tenant.id}`);
    expect(migratedPropertyId("tnt_lane000001")).toBe("prp_lane000001");
    expect(newPropertyId((id) => id === "prp_taken00000")).toMatch(/^prp_[a-z0-9]{10}$/);
  });
});
