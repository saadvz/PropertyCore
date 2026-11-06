import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateRegistry, MigrationError, PROPERTY_FILES, setMigrationRename } from "../src/cleaner-core/hosted/migrate";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { resetLiveDesks } from "../src/cleaner-core/liveDesk";
import { openPin } from "../src/cleaner-core/pinSeal";
import { closeHostedApps, hostedApp, hostedEnv } from "./cleanerOauthHarness";
import { cleanupDesks, openDesk, PIN_KEY, setUp } from "./cleanerDeskHarness";
import { CLEANER, DOOR_CODE, HOST } from "./wiringProof";

/** A v2 data folder written by hand, the way a live service holds it today. Only 555 numbers. */

const NOW = () => new Date("2026-11-06T12:00:00.000Z");
const LANE = "tnt_lane000001";
const COURT = "tnt_court00001";
const ANNEX = "tnt_annex00001";
const TOURS = "tnt_tours00001";

const dirs: string[] = [];
afterEach(() => {
  setMigrationRename(undefined);
  cleanupDesks();
  closeHostedApps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "property-migration-"));
  dirs.push(dir);
  return dir;
}

function tenant(id: string, number: string, extra: Record<string, unknown> = {}) {
  return { id, label: `Label ${id}`, twilioNumber: number, connections: [], invites: [], createdAt: "2026-10-01T00:00:00.000Z", ...extra };
}

function writeV2(root: string, tenants: Record<string, unknown>[], version = 2): void {
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ schemaVersion: version, tenants }));
}

function folder(root: string, id: string): string {
  const dir = join(root, "tenants", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value));
}

const version = (root: string) => (JSON.parse(readFileSync(join(root, "tenants.json"), "utf8")) as { schemaVersion: number }).schemaVersion;

describe("migrateRegistry", () => {
  it("a cleaning tenant becomes one property with cleaning on", () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning" })]);
    const dir = folder(root, LANE);
    put(dir, "cleaner-live.json", { address: "12 Scratch Lane, Teaneck, NJ 07666" });
    mkdirSync(join(dir, "cleaner-job"));
    writeFileSync(join(dir, "cleaner-job", "jobs.json"), "[]");
    expect(migrateRegistry(root, NOW)).toEqual({ migrated: 1 });
    expect(version(root)).toBe(3);
    const [lane] = new TenantRegistry(root, NOW).list();
    expect(lane?.service).toBeUndefined();
    expect(lane?.properties).toEqual([
      { id: "prp_lane000001", label: "12 Scratch Lane, Teaneck, NJ 07666", createdAt: NOW().toISOString(), legacyPaths: true, flows: { cleaning: { on: true }, supplies: { on: false }, fixer: { on: false } } },
    ]);
    const moved = join(dir, "properties", "prp_lane000001");
    expect(existsSync(join(moved, "cleaner-live.json"))).toBe(true);
    expect(readFileSync(join(moved, "cleaner-job", "jobs.json"), "utf8")).toBe("[]");
    expect(existsSync(join(dir, "cleaner-live.json"))).toBe(false);
  });

  it("a cleaning tenant with the add-on gets both flows and keeps both files", () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning", supplies: true })]);
    const dir = folder(root, LANE);
    put(dir, "cleaner-live.json", { address: "12 Scratch Lane" });
    put(dir, "supply.json", { settings: { property: { name: "Other name", address: "x", timeZone: "America/New_York" } } });
    migrateRegistry(root, NOW);
    const lane = new TenantRegistry(root, NOW).get(LANE)!;
    expect(lane.properties[0]?.flows).toEqual({ cleaning: { on: true }, supplies: { on: true }, fixer: { on: false } });
    expect(lane.properties[0]?.label).toBe("12 Scratch Lane");
    expect(lane).not.toHaveProperty("supplies");
    const moved = join(dir, "properties", "prp_lane000001");
    expect(existsSync(join(moved, "cleaner-live.json")) && existsSync(join(moved, "supply.json"))).toBe(true);
  });

  it("a supplies tenant gets supplies on, labeled from supply.json's property name", () => {
    const root = dataRoot();
    writeV2(root, [tenant(COURT, "+15555550160", { service: "supplies" })]);
    put(folder(root, COURT), "supply.json", { settings: { property: { name: "Scratch Court", address: "8 Scratch Court", timeZone: "America/New_York" } } });
    migrateRegistry(root, NOW);
    const court = new TenantRegistry(root, NOW).get(COURT)!;
    expect(court.properties[0]).toMatchObject({ label: "Scratch Court", flows: { cleaning: { on: false }, supplies: { on: true }, fixer: { on: false } } });
  });

  it("an unchosen tenant gets no properties; a touring tenant is untouched", () => {
    const root = dataRoot();
    writeV2(root, [tenant(ANNEX, "+15555550170"), tenant(TOURS, "+15555550180", { service: "touring" })]);
    const tours = folder(root, TOURS);
    mkdirSync(join(tours, "tour-core"));
    put(tours, "cleaner-live.json", { address: "kept from before a switch" });
    migrateRegistry(root, NOW);
    const reg = new TenantRegistry(root, NOW);
    expect(reg.get(ANNEX)).toMatchObject({ properties: [] });
    expect(reg.get(ANNEX)?.service).toBeUndefined();
    expect(reg.get(TOURS)).toMatchObject({ service: "touring", properties: [] });
    expect(existsSync(join(tours, "tour-core"))).toBe(true);
    expect(existsSync(join(tours, "cleaner-live.json"))).toBe(true);
    expect(existsSync(join(tours, "properties"))).toBe(false);
  });

  it("a v1 file migrates as cleaning", () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150")], 1);
    migrateRegistry(root, NOW);
    const lane = new TenantRegistry(root, NOW).get(LANE)!;
    expect(lane.properties[0]?.flows.cleaning.on).toBe(true);
    expect(lane.properties[0]?.label).toBe(`Label ${LANE}`);
  });

  it("does nothing to a v3 file", () => {
    const root = dataRoot();
    new TenantRegistry(root, NOW).create({ label: "Lane", twilioNumber: "+15555550150" });
    const before = readFileSync(join(root, "tenants.json"), "utf8");
    expect(migrateRegistry(root, NOW)).toEqual({ migrated: 0 });
    expect(readFileSync(join(root, "tenants.json"), "utf8")).toBe(before);
  });

  it("a failed rename leaves v2 and the next run finishes", () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning" })]);
    const dir = folder(root, LANE);
    put(dir, "cleaner-live.json", { address: "12 Scratch Lane" });
    mkdirSync(join(dir, "cleaner-job"));
    put(dir, "cleaner-approvals.json", { version: 1, pending: {} });
    let failed = false;
    const flaky = (from: string, to: string) => {
      if (!failed && from.endsWith("cleaner-job")) {
        failed = true;
        throw Object.assign(new Error("disk said no"), { code: "EIO" });
      }
      renameSync(from, to);
    };
    expect(() => migrateRegistry(root, NOW, flaky)).toThrow(MigrationError);
    expect(version(root)).toBe(2);
    expect(migrateRegistry(root, NOW)).toEqual({ migrated: 1 });
    expect(version(root)).toBe(3);
    const moved = join(dir, "properties", "prp_lane000001");
    for (const name of ["cleaner-live.json", "cleaner-job", "cleaner-approvals.json"]) {
      expect(existsSync(join(moved, name))).toBe(true);
      expect(existsSync(join(dir, name))).toBe(false);
    }
  });

  it("secrets.json and service files stay in the account folder", () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning" })]);
    const dir = folder(root, LANE);
    for (const name of ["secrets.json", "service-audit.jsonl", "service-notices.json", "opt-outs.json"]) writeFileSync(join(dir, name), "{}");
    migrateRegistry(root, NOW);
    for (const name of ["secrets.json", "service-audit.jsonl", "service-notices.json", "opt-outs.json"]) expect(existsSync(join(dir, name))).toBe(true);
    expect(PROPERTY_FILES).not.toContain("secrets.json");
  });

  it("a sealed door code still opens after the migration", async () => {
    const opened = openDesk([HOST, CLEANER], "0");
    await setUp(opened.desk, { groupChat: "cleaner-only" });
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning" })]);
    const dir = join(root, "tenants", LANE);
    mkdirSync(join(root, "tenants"), { recursive: true });
    resetLiveDesks();
    // The desk's folder becomes the tenant's folder, as on the live service.
    renameSync(opened.root, dir);
    migrateRegistry(root, NOW);
    const moved = JSON.parse(readFileSync(join(dir, "properties", "prp_lane000001", "cleaner-live.json"), "utf8")) as { pinSeal: Parameters<typeof openPin>[0] };
    expect(openPin(moved.pinSeal, PIN_KEY)).toBe(DOOR_CODE);
  });
});

describe("startup", () => {
  it("the hosted app won't start on a half-migrated folder", async () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning" })]);
    put(folder(root, LANE), "cleaner-live.json", { address: "12 Scratch Lane" });
    setMigrationRename(() => {
      throw Object.assign(new Error("disk said no"), { code: "EIO" });
    });
    await expect(hostedApp({}, { root, env: hostedEnv(root, { CLEANER_CORE_MULTI_TENANT: "1" }) })).rejects.toThrow(MigrationError);
    expect(version(root)).toBe(2);
  });

  it("the hosted app migrates before it serves", async () => {
    const root = dataRoot();
    writeV2(root, [tenant(LANE, "+15555550150", { service: "cleaning" })]);
    put(folder(root, LANE), "cleaner-live.json", { address: "12 Scratch Lane" });
    await hostedApp({}, { root, env: hostedEnv(root, { CLEANER_CORE_MULTI_TENANT: "1" }) });
    expect(version(root)).toBe(3);
  });
});
