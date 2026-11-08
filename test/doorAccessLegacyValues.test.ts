import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeHistory } from "../src/audit/describe";
import { safetyHash } from "../src/config/changeKinds";
import { loadConfig, TourCoreConfigShape } from "../src/config/tourCoreConfig";
import { AccessGrantSchema, type AuditEvent } from "../src/domain/model";
import { ManifestSchema } from "../src/install/manifest";
import { currentDecisionCode } from "../src/policy/evaluateAccess";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { MemoryDocumentStore } from "../src/storage/documentStore";
import { DurableTourStore } from "../src/storage/durableTourStore";
import { InMemoryStore } from "../src/storage/Store";
import { configHash, isCurrent, PropertyWorkspace } from "../src/setup/workspace";

/**
 * saadvz/PropertyCore#179: the door access values that named the lock provider are
 * renamed. Config files, manifests, records and audit saved before still read.
 */

/** The demo property's fingerprints from before the rename, when it said "durin-mock". */
const DEMO_FULL_HASH = "2045e27936c2df7e";
const DEMO_SAFETY_HASH = "c0c0c6997b2dc5dd";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const grant = { id: "grant_1", reservationId: "res_1", prospectId: "pro_1", doorId: "front", status: "ACTIVE", validFrom: "2026-10-01T10:00:00.000Z", validUntil: "2026-10-01T11:00:00.000Z", createdAt: "2026-10-01T09:59:00.000Z" };

describe("door access values saved before #179", () => {
  it("reads the old access modes as the new ones", () => {
    const base = loadConfig();
    expect(base.accessMode).toBe("door-demo");
    expect(TourCoreConfigShape.parse({ ...base, accessMode: "durin-mock" }).accessMode).toBe("door-demo");
    expect(TourCoreConfigShape.parse({ ...base, accessMode: "durin" }).accessMode).toBe("door");
    expect(TourCoreConfigShape.safeParse({ ...base, accessMode: "lock" }).success).toBe(false);
  });

  it("keeps the fingerprints a property was published with", () => {
    const config = loadConfig();
    expect(configHash(config)).toBe(DEMO_FULL_HASH);
    expect(safetyHash(config)).toBe(DEMO_SAFETY_HASH);
  });

  it("leaves a property saved with durin-mock published, and the next save writes door-demo", () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-door-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const saved = ws.save(loadConfig());
    const id = saved.config.property.id;
    const file = join(root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { accessMode: string };
    raw.accessMode = "durin-mock";
    writeJsonAtomic(file, raw);
    // The fingerprints are the same as before the rename (the test above), so these are what was published.
    const full = configHash(saved.config);
    const safety = safetyHash(saved.config);
    const at = "2026-10-02T12:00:00.000Z";
    writeJsonAtomic(join(root, "properties", id, "status.json"), {
      propertyId: id,
      status: "PUBLISHED_FOR_DEMO",
      configHash: full,
      safetyHash: safety,
      savedAt: at,
      publishedAt: at,
      readiness: { passed: true, checkedAt: at, configHash: full, safetyHash: safety, problems: [] },
      dryTour: { passed: true, ranAt: at, configHash: full, safetyHash: safety },
    });

    const loaded = ws.load(id);
    expect(loaded.config.accessMode).toBe("door-demo");
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(isCurrent(loaded.state.readiness, loaded.state)).toBe(true);
    expect(isCurrent(loaded.state.dryTour, loaded.state)).toBe(true);

    ws.save(loaded.config);
    expect(JSON.parse(readFileSync(file, "utf8")).accessMode).toBe("door-demo");
  });

  it("reads a manifest that says DURIN_DEMO", () => {
    const manifest = {
      schemaVersion: 1,
      deploymentMode: "LOCAL_DEVELOPER",
      installationId: "inst_abcdefghijkl",
      publicEndpointProvider: "NONE",
      messagingProvider: "UNSET",
      storageProvider: "LOCAL_DEMO",
      accessProvider: "DURIN_DEMO",
      operatorNotificationProvider: "NONE",
      installedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(ManifestSchema.parse(manifest).accessProvider).toBe("DOOR_DEMO");
  });

  it("reads a grant's durinGrantRef as doorGrantRef, from a backup and from Drive", async () => {
    const parsed = AccessGrantSchema.parse({ ...grant, durinGrantRef: "demo_grant_1" });
    expect(parsed.doorGrantRef).toBe("demo_grant_1");
    expect(parsed).not.toHaveProperty("durinGrantRef");

    const remote = new MemoryDocumentStore();
    await remote.put("tours-data/accessGrants/grant_1.json", { ...grant, durinGrantRef: "demo_grant_1" }, { schemaVersion: 1, kind: "accessGrants" });
    const store = new DurableTourStore(new InMemoryStore(), () => remote, () => true);
    expect((await store.get("accessGrants", "grant_1"))?.doorGrantRef).toBe("demo_grant_1");
    expect((await store.list("accessGrants"))[0]?.doorGrantRef).toBe("demo_grant_1");
  });

  it("words an old DENY_DURIN_UNHEALTHY audit event like the new code", () => {
    expect(currentDecisionCode("DENY_DURIN_UNHEALTHY")).toBe("DENY_DOOR_UNHEALTHY");
    expect(currentDecisionCode("DENY_TOO_EARLY")).toBe("DENY_TOO_EARLY");
    const event = (code: string): AuditEvent => ({ id: `aud_${code}`, seq: 1, type: "ACCESS_DENIED", at: "2026-10-01T10:00:00.000Z", doorId: "front", code, detail: "door system down" });
    const context = { doors: [{ id: "front", name: "Front door" }], units: [], prospects: [], reservations: [] };
    const old = describeHistory([event("DENY_DURIN_UNHEALTHY")], context as never, "America/New_York");
    const current = describeHistory([event("DENY_DOOR_UNHEALTHY")], context as never, "America/New_York");
    expect(old.map((e) => e.text)).toEqual(current.map((e) => e.text));
    expect(current[0]?.text).toContain("door system wasn't responding");
  });
});
