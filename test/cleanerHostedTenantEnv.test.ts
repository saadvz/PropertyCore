import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenantRegistry, tenantFolder, type Tenant } from "../src/cleaner-core/hosted/registry";
import { buildTenantEnv, PER_TENANT_NAMES } from "../src/cleaner-core/hosted/tenantEnv";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";

const NOW = "2026-10-27T10:00:00.000Z";
const ORIGIN = "https://cc.example";

let dir: string;
let t: Tenant;
let secrets: TenantSecrets;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cleaner-tenant-env-"));
  t = new TenantRegistry(dir, () => new Date(NOW)).create({ label: "Lane", twilioNumber: "+15555550150" }).tenant;
  secrets = new TenantSecrets(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildTenantEnv", () => {
  it("strips every per-tenant name from the process env and adds this tenant's own", () => {
    const base = Object.fromEntries(PER_TENANT_NAMES.map((n) => [n, `leak-${n}`]));
    secrets.set(t.id, { CLEANER_CORE_PIN_KEY: "pin-a", CLEANER_CORE_PHOTO_KEY: "photo-a" });
    const env = buildTenantEnv({ base: { ...base, CLEANER_CORE_ENABLED: "1" }, tenant: t, secrets, primary: undefined, origin: ORIGIN });
    expect(Object.values(env).join("\n")).not.toContain("leak-");
    expect(env).toMatchObject({
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_PIN_KEY: "pin-a",
      CLEANER_CORE_PHOTO_KEY: "photo-a",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: "+15555550150",
      PUBLIC_BASE_URL: `${ORIGIN}/t/${t.id}`,
    });
    expect(env.CLEANER_CORE_ASSISTANT).toBeUndefined();
    expect(env.CLEANER_CORE_PRIMARY_CONNECTION).toBeUndefined();
  });

  it("carries the primary's assistant, grant id and routine, never another connection's", () => {
    secrets.setForConnection(t.id, "g1", { CLEANER_CORE_ROUTINE_URL: "https://grok.example/hook", CLEANER_CORE_ROUTINE_KEY: "key-g1-xxxx" });
    secrets.setForConnection(t.id, "g2", { CLEANER_CORE_ROUTINE_URL: "https://claude.example/fire", CLEANER_CORE_ROUTINE_KEY: "key-g2-xxxx" });
    const env = buildTenantEnv({ base: {}, tenant: t, secrets, primary: { grantId: "g2", assistant: "claude", connectedAt: NOW }, origin: ORIGIN });
    expect(env).toMatchObject({
      CLEANER_CORE_ASSISTANT: "claude",
      CLEANER_CORE_PRIMARY_CONNECTION: "g2",
      CLEANER_CORE_ROUTINE_URL: "https://claude.example/fire",
      CLEANER_CORE_ROUTINE_KEY: "key-g2-xxxx",
    });
    expect(Object.values(env).join("\n")).not.toContain("key-g1");
  });

  it("passes the landlord's phone only once its code checked out at sign-up (saadvz/TourCore#164)", () => {
    const owner = { phone: "+15555550160", email: "host@example.com", phoneVerifiedAt: NOW, terms: { version: "1", acceptedAt: NOW } };
    const base = { CLEANER_CORE_LANDLORD_PHONE: "+15555550199" };
    secrets.set(t.id, { CLEANER_CORE_LANDLORD_PHONE: "+15555550198" });
    expect(buildTenantEnv({ base, tenant: t, secrets, primary: undefined, origin: ORIGIN }).CLEANER_CORE_LANDLORD_PHONE).toBeUndefined();
    const { phoneVerifiedAt: _unverified, ...pending } = owner;
    const unconfirmed = { ...t, owner: pending as typeof owner };
    // An owner whose code hasn't checked out is still a landlord record, so it fails closed instead of falling back to the allowlist.
    expect(buildTenantEnv({ base, tenant: unconfirmed, secrets, primary: undefined, origin: ORIGIN }).CLEANER_CORE_LANDLORD_PHONE).toBe("unconfirmed");
    expect(buildTenantEnv({ base, tenant: { ...t, owner }, secrets, primary: undefined, origin: ORIGIN }).CLEANER_CORE_LANDLORD_PHONE).toBe("+15555550160");
  });

  it("never lets a tenant-level value stand in for the primary's routine", () => {
    secrets.set(t.id, { CLEANER_CORE_ROUTINE_URL: "https://stale.example/hook", CLEANER_CORE_ROUTINE_KEY: "stale-key" });
    const env = buildTenantEnv({ base: {}, tenant: t, secrets, primary: { grantId: "g1", assistant: "grok", connectedAt: NOW }, origin: ORIGIN });
    expect(env.CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect(env.CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
  });
});

describe("TenantSecrets", () => {
  it("delete removes a name from the tenant and every connection, and removeTenant removes the file", () => {
    secrets.set(t.id, { CLEANER_CORE_PIN_KEY: "pin-a" });
    secrets.setForConnection(t.id, "g1", { CLEANER_CORE_ROUTINE_URL: "https://grok.example/hook", CLEANER_CORE_ROUTINE_KEY: "k1" });
    secrets.setForConnection(t.id, "g2", { CLEANER_CORE_ROUTINE_KEY: "k2" });
    secrets.delete(t.id, ["CLEANER_CORE_ROUTINE_KEY"]);
    expect(secrets.connection(t.id, "g1")).toEqual({ CLEANER_CORE_ROUTINE_URL: "https://grok.example/hook" });
    expect(secrets.connection(t.id, "g2")).toEqual({});
    expect(secrets.tenant(t.id)).toEqual({ CLEANER_CORE_PIN_KEY: "pin-a" });
    secrets.deleteConnection(t.id, "g1");
    expect(secrets.connection(t.id, "g1")).toEqual({});
    secrets.removeTenant(t.id);
    expect(existsSync(join(tenantFolder(dir, t.id), "secrets.json"))).toBe(false);
    expect(secrets.tenant(t.id)).toEqual({});
  });

  it("writes secrets.json with mode 600", () => {
    secrets.set(t.id, { CLEANER_CORE_PIN_KEY: "pin-a" });
    expect(statSync(join(tenantFolder(dir, t.id), "secrets.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps two tenants' secrets apart", () => {
    const other = new TenantRegistry(dir, () => new Date(NOW)).create({ label: "Court", twilioNumber: "+15555550151" }).tenant;
    secrets.set(t.id, { CLEANER_CORE_PIN_KEY: "pin-a" });
    secrets.set(other.id, { CLEANER_CORE_PIN_KEY: "pin-b" });
    expect(secrets.tenant(t.id).CLEANER_CORE_PIN_KEY).toBe("pin-a");
    expect(secrets.tenant(other.id).CLEANER_CORE_PIN_KEY).toBe("pin-b");
  });
});
