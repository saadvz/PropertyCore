import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { TourCore, VisitorDenialCopy } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { createVerificationProvider } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { Installation } from "../src/install/installation";
import { listExceptions } from "../src/operator/exceptions";
import { PropertyWorkspace } from "../src/setup/workspace";
import { ConsoleMessenger } from "../src/messaging/Messenger";
import { InMemoryStore } from "../src/storage/Store";
import { claimLease, collectCanonical, copyMigration, factReadMode, prepareMigration, resolveCachedRecord, restoreCanonical, verifyMigration } from "../src/storage/canonical";
import { LocalDocumentStore, MemoryDocumentStore, type DocumentStore } from "../src/storage/documentStore";
import { DurableTourStore } from "../src/storage/durableTourStore";
import { StorageConflictError, StorageUnavailableError } from "../src/storage/errors";
import { FakeGoogleDrive, GoogleDriveStore, googleScopeParam } from "../src/storage/googleDrive";
import { authorizationUrl, checkState, createPending, exchangeCode } from "../src/storage/googleOAuth";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { describeHistory } from "../src/audit/describe";
import { basicForm, TOUR_DAY } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-drive-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function contract(label: string, open: () => Promise<DocumentStore>) {
  it(`${label}: create, read, update, delete, and reject a bad schema`, async () => {
    const store = await open();
    const created = await store.put("properties/p1/property.json", { schemaVersion: 1, name: "Elm" }, { schemaVersion: 1, kind: "property" });
    expect((await store.get(created.path))?.body).toMatchObject({ name: "Elm" });
    const updated = await store.put(created.path, { schemaVersion: 1, name: "Elm St" }, { schemaVersion: 1, kind: "property", ifRevision: created.revision });
    expect(updated.revision).not.toBe(created.revision);
    await expect(store.put(created.path, { schemaVersion: 1, name: "lost" }, { schemaVersion: 1, kind: "property", ifRevision: created.revision })).rejects.toBeInstanceOf(StorageConflictError);
    expect((await store.get(created.path))?.body).toMatchObject({ name: "Elm St" });
    const listed = await store.list("properties/");
    expect(listed.map((doc) => doc.path)).toContain(created.path);
    await store.delete(created.path, { ifRevision: updated.revision });
    expect(await store.get(created.path)).toBeUndefined();
    await expect(store.put("x.json", { schemaVersion: 2 }, { schemaVersion: 2, kind: "record" })).rejects.toThrow(/schema version 2/);
  });
}

describe("document store contract", () => {
  contract("memory", async () => new MemoryDocumentStore());
  contract("local", async () => new LocalDocumentStore(tempDir()));
  contract("google drive", async () => GoogleDriveStore.open(new FakeGoogleDrive(), "Tour Core", "store_contract"));
});

describe("Google Drive store", () => {
  it("retries a transient read and does not duplicate a create whose response was lost", async () => {
    const fake = new FakeGoogleDrive();
    const store = await GoogleDriveStore.open(fake, "Tour Core", "store_retry");
    fake.failReads = 2;
    const doc = await store.put("a.json", { schemaVersion: 1, n: 1 }, { schemaVersion: 1, kind: "record" });
    expect((await store.get("a.json"))?.sha256).toBe(doc.sha256);
    expect(fake.reads.length).toBeGreaterThan(2);

    fake.loseCreateResponse = true;
    const before = [...fake.files.values()].filter((file) => !file.meta.trashed && file.meta.name !== "_catalog.json").length;
    await store.put("b.json", { schemaVersion: 1, n: 2 }, { schemaVersion: 1, kind: "record" });
    const names = [...fake.files.values()].filter((file) => !file.meta.trashed).map((file) => file.meta.appProperties.tourCorePath);
    expect(names.filter((name) => name === "b.json")).toHaveLength(1);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it("keeps the previous record when the catalog update fails", async () => {
    const fake = new FakeGoogleDrive();
    const store = await GoogleDriveStore.open(fake, "Tour Core", "store_catalog");
    const first = await store.put("a.json", { schemaVersion: 1, n: 1 }, { schemaVersion: 1, kind: "record" });
    fake.failCatalogUpdates = 5;
    await expect(store.put("a.json", { schemaVersion: 1, n: 2 }, { schemaVersion: 1, kind: "record", ifRevision: first.revision })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(await store.get("a.json")).toMatchObject({ body: { n: 1 } });
  });

  it("lists files with one catalog read", async () => {
    const fake = new FakeGoogleDrive();
    const store = await GoogleDriveStore.open(fake, "Tour Core", "store_list");
    await store.put("a.json", { schemaVersion: 1, n: 1 }, { schemaVersion: 1, kind: "record" });
    await store.put("b.json", { schemaVersion: 1, n: 2 }, { schemaVersion: 1, kind: "record" });
    await store.put("c.json", { schemaVersion: 1, n: 3 }, { schemaVersion: 1, kind: "record" });
    const catalogId = [...fake.files.values()].find((file) => file.meta.name === "_catalog.json")!.meta.id;
    fake.reads.length = 0;
    const listed = await store.list("");
    expect(listed.map((doc) => doc.path).sort()).toEqual(["a.json", "b.json", "c.json"]);
    expect(fake.reads.filter((id) => id === catalogId)).toHaveLength(1);
    expect(fake.reads).toHaveLength(4);
    fake.reads.length = 0;
    expect(await store.get("b.json")).toMatchObject({ body: { n: 2 } });
    expect(fake.reads.filter((id) => id === catalogId)).toHaveLength(1);
    expect(fake.reads).toHaveLength(2);
  });

  it("leaves every file private", async () => {
    const fake = new FakeGoogleDrive();
    const store = await GoogleDriveStore.open(fake, "Tour Core", "store_private");
    await store.put("secrets-shape-ok.json", { schemaVersion: 1, note: "a tour" }, { schemaVersion: 1, kind: "record" });
    for (const file of fake.files.values()) expect(file.meta.shared).toBe(false);
    expect(JSON.stringify([...fake.files.values()])).not.toMatch(/refresh_token|access_token/);
  });
});

describe("canonical files, migration, restore, lease", () => {
  function writeTree(root: string) {
    mkdirSync(join(root, "install"), { recursive: true });
    mkdirSync(join(root, "properties", "prop_elm", "operator"), { recursive: true });
    mkdirSync(join(root, "properties", "prop_elm", "visitor-demos", "tour_1"), { recursive: true });
    mkdirSync(join(root, "runtime", "sessions"), { recursive: true });
    mkdirSync(join(root, "runtime", "operator-events"), { recursive: true });
    mkdirSync(join(root, "runtime", "oauth"), { recursive: true });
    writeFileSync(join(root, "install", "manifest.json"), JSON.stringify({ schemaVersion: 1, installationId: "inst_elm" }));
    writeFileSync(join(root, "install", "secrets.json"), JSON.stringify({ values: { SENDBLUE_API_API_KEY: "sb-live-secret-value" } }));
    writeFileSync(join(root, "runtime", "oauth", "grok-access.json"), JSON.stringify({ refreshHash: "not-a-token-but-oauth" }));
    writeFileSync(join(root, "properties", "prop_elm", "tourcore.config.json"), JSON.stringify({ schemaVersion: 1, property: { id: "prop_elm", name: "Elm" }, units: [{ id: "u1", profile: { bedrooms: { value: 2 } } }] }));
    writeFileSync(join(root, "properties", "prop_elm", "operator", "exception-resolutions.json"), JSON.stringify({ schemaVersion: 1, resolutions: [{ id: "ex1" }] }));
    writeFileSync(join(root, "properties", "prop_elm", "visitor-demos", "tour_1", "record.json"), JSON.stringify({ schemaVersion: 1, tourId: "tour_1", outcome: "in-progress" }));
    writeFileSync(
      join(root, "properties", "prop_elm", "visitor-demos", "tour_1", "tour-export.json"),
      JSON.stringify({ schemaVersion: 1, property: { id: "prop_elm" }, prospects: [{ id: "prs_1", phone: "+15550100001" }], reservations: [{ id: "res_1", status: "RESERVED", propertyId: "prop_elm" }], auditEvents: [{ id: "evt_1", type: "RESERVATION_CREATED" }] }),
    );
    writeFileSync(join(root, "runtime", "sessions", "sess_1.json"), JSON.stringify({ schemaVersion: 1, sessionId: "sess_1", reservationId: "res_1" }));
    writeFileSync(join(root, "runtime", "operator-events", "evt.json"), JSON.stringify({ schemaVersion: 1, event: { eventId: "evt_out" } }));
  }

  it("copies local records to Drive, skips secrets, and a second copy is idempotent", async () => {
    const root = tempDir();
    writeTree(root);
    const fake = new FakeGoogleDrive();
    const store = await GoogleDriveStore.open(fake, "Tour Core", "store_mig");
    const prepared = prepareMigration(root, new Date("2026-09-28T12:00:00.000Z"), ["sb-live-secret-value"]);
    const copied = await copyMigration(store, root, prepared, ["sb-live-secret-value"], new Date("2026-09-28T12:01:00.000Z"));
    expect(copied.phase).toBe("COPIED");
    const dumped = JSON.stringify(await store.list(""));
    expect(dumped).not.toContain("sb-live-secret-value");
    expect(dumped).not.toContain("grok-access");
    const verified = await verifyMigration(store, copied);
    expect(verified.phase).toBe("VERIFIED");
    const creates = fake.creates.length;
    const again = await copyMigration(store, root, verified, ["sb-live-secret-value"], new Date("2026-09-28T12:01:00.000Z"));
    expect(again.phase).toBe("COPIED");
    expect(fake.creates.length).toBe(creates);
    const index = await store.get("indexes/lookup.json");
    expect(index?.body).toMatchObject({ properties: [{ id: "prop_elm", name: "Elm" }], reservations: [{ id: "res_1" }] });
  });

  it("an interrupted copy resumes, and a failed check leaves the local files canonical", async () => {
    const root = tempDir();
    writeTree(root);
    const store = await GoogleDriveStore.open(new FakeGoogleDrive(), "Tour Core", "store_resume");
    const prepared = prepareMigration(root, new Date("2026-09-28T12:00:00.000Z"));
    const partial = { ...prepared, phase: "COPYING" as const, copied: ["install/manifest.json"] };
    const copied = await copyMigration(store, root, partial);
    expect(copied.copied).toContain("properties/prop_elm/tourcore.config.json");
    const localBefore = readFileSync(join(root, "properties", "prop_elm", "tourcore.config.json"), "utf8");
    const broken = { ...copied, hashes: { ...copied.hashes, "install/manifest.json": "deadbeef" } };
    const failed = await verifyMigration(store, broken);
    expect(failed.phase).toBe("FAILED");
    expect(readFileSync(join(root, "properties", "prop_elm", "tourcore.config.json"), "utf8")).toBe(localBefore);
  });

  it("a clean host restores records from Drive and not secrets", async () => {
    const hostA = tempDir();
    writeTree(hostA);
    const store = await GoogleDriveStore.open(new FakeGoogleDrive(), "Tour Core", "store_restore");
    const copied = await copyMigration(store, hostA, prepareMigration(hostA, new Date()));
    expect((await verifyMigration(store, copied)).phase).toBe("VERIFIED");
    const hostB = tempDir();
    const restored = await restoreCanonical(store, hostB, ["sb-live-secret-value"]);
    expect(restored.files).toBeGreaterThan(3);
    const property = JSON.parse(readFileSync(join(hostB, "properties", "prop_elm", "tourcore.config.json"), "utf8"));
    expect(property.units[0].profile.bedrooms.value).toBe(2);
    expect(JSON.parse(readFileSync(join(hostB, "runtime", "sessions", "sess_1.json"), "utf8")).reservationId).toBe("res_1");
    expect(JSON.parse(readFileSync(join(hostB, "properties", "prop_elm", "operator", "exception-resolutions.json"), "utf8")).resolutions[0].id).toBe("ex1");
    expect(JSON.parse(readFileSync(join(hostB, "properties", "prop_elm", "visitor-demos", "tour_1", "tour-export.json"), "utf8")).auditEvents[0].type).toBe("RESERVATION_CREATED");
    const tree = JSON.stringify(collectCanonical(hostB));
    expect(tree).not.toContain("sb-live-secret-value");
    expect(tree).not.toContain("refreshToken");
  });

  it("allows one writer, refuses a second live writer, and lets an expired lease be taken", async () => {
    const store = await GoogleDriveStore.open(new FakeGoogleDrive(), "Tour Core", "store_lease");
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    await claimLease(store, { storeId: "store_lease", writerHostId: "host_a", installationId: "inst_a" }, now, 60_000);
    await expect(claimLease(store, { storeId: "store_lease", writerHostId: "host_b", installationId: "inst_b" }, now + 1000, 60_000)).rejects.toThrow(/Another Tour Core/);
    const taken = await claimLease(store, { storeId: "store_lease", writerHostId: "host_b", installationId: "inst_b" }, now + 1000, 60_000, true);
    expect(taken.tookOver).toBe(true);
    const expired = await claimLease(store, { storeId: "store_lease", writerHostId: "host_c", installationId: "inst_c" }, now + 120_000, 60_000);
    expect(expired.expired).toBe(true);
    expect(expired.lease.writerHostId).toBe("host_c");
  });

  it("does not let a stale local cache override Drive", () => {
    const remote = { revision: "2:bbb", body: { bedrooms: 3 } };
    const local = { revision: "1:aaa", body: { bedrooms: 2 } };
    expect(resolveCachedRecord(local, remote)).toEqual({ bedrooms: 3 });
    expect(resolveCachedRecord({ revision: remote.revision, body: remote.body }, remote)).toEqual({ bedrooms: 3 });
    expect(factReadMode({ driveUp: false, cacheValidatedAt: 1_000, now: 2_000, maxAgeMs: 5_000 })).toBe("cached");
    expect(factReadMode({ driveUp: false, cacheValidatedAt: 1_000, now: 9_000, maxAgeMs: 5_000 })).toBe("stale");
    expect(factReadMode({ driveUp: true, now: 9_000 })).toBe("live");
  });
});

describe("failure behavior", () => {
  it("answers an approved fact from a fresh cache and refuses when the cache is stale", async () => {
    const config = loadConfig();
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
    const lines: string[] = [];
    const core = (mode: "cached" | "stale") =>
      new TourCore({
        config,
        clock,
        store: new InMemoryStore(),
        durin: new MockDurinAccessAdapter({ doorNames: {}, now: () => clock.now() }),
        messenger: new ConsoleMessenger((line) => lines.push(line)),
        verification: createVerificationProvider(config),
        storageRead: () => mode,
      });
    lines.length = 0;
    const answered = await core("cached").answerPropertyQuestion({ phone: "5550101234", question: "How many bedrooms are in unit 101?", unitId: "apt_101" });
    expect(answered.outcome).toBe("answered");
    expect(lines.join("\n")).toMatch(/2 bedroom/);
    lines.length = 0;
    const stale = await core("stale").answerPropertyQuestion({ phone: "5550101234", question: "How many bedrooms are in unit 101?", unitId: "apt_101" });
    expect(stale.outcome).toBe("unknown");
    expect(stale.facts).toEqual([]);
    expect(lines.join("\n")).toMatch(/can't check that right now/);
    expect(lines.join("\n")).not.toMatch(/2 bedroom/);
  });

  it("does not confirm a booking when Drive cannot save it", async () => {
    const config = loadConfig();
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
    const lines: string[] = [];
    const inner = new InMemoryStore();
    const drive = await GoogleDriveStore.open(new FakeGoogleDrive(), "Tour Core", "store_down");
    const core = new TourCore({
      config,
      clock,
      store: new DurableTourStore(inner, () => drive, () => false),
      durin: new MockDurinAccessAdapter({ doorNames: {}, now: () => clock.now() }),
      messenger: new ConsoleMessenger((line) => lines.push(line)),
      verification: createVerificationProvider(config),
    });
    await expect(core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(lines.join("\n")).not.toMatch(/booked/);
    expect(await inner.list("reservations")).toEqual([]);
  });

  it("a tour store made before Drive opens saves to Drive once it opens, not to memory", async () => {
    const root = tempDir();
    const drive = new FakeGoogleDrive();
    const installation = () => new Installation({ root, runtime: new FileRuntimeStore(join(root, "runtime")), env: () => ({}), driveClient: drive, now: () => Date.parse("2026-10-08T12:00:00.000Z") });
    const first = installation();
    first.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
    first.secrets.set({ GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh-test-token" });
    expect((await first.records.finish()).ok).toBe(true);

    // A restart: Drive is the canonical store, but this process hasn't opened it yet.
    const restarted = installation();
    expect(restarted.records.provider()).toBe("GOOGLE_DRIVE_READY");
    const config = loadConfig();
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
    const core = new TourCore({
      config,
      clock,
      store: restarted.records.wrapStore(new InMemoryStore()),
      durin: new MockDurinAccessAdapter({ doorNames: {}, now: () => clock.now() }),
      messenger: new ConsoleMessenger(() => {}),
      verification: createVerificationProvider(config),
    });
    await expect(core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" })).rejects.toBeInstanceOf(StorageUnavailableError);

    await restarted.records.beforeAccess();
    const started = await core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
    const saved = [...drive.files.values()].map((file) => file.meta.appProperties.tourCorePath);
    expect(saved).toContain(`tours-data/reservations/${started.reservation.id}.json`);
    expect(saved).toContain(`tours-data/prospects/${started.prospect.id}.json`);
  });

  it("does not call Durin when canonical records cannot be confirmed before unlock, keeps the booking ready, and hands the visitor off", async () => {
    const config = loadConfig();
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
    const durin = new MockDurinAccessAdapter({ doorNames: Object.fromEntries(config.doors.map((door) => [door.id, door.name])), now: () => clock.now() });
    const closed = new TourCore({
      config,
      clock,
      store: new InMemoryStore(),
      durin,
      messenger: new ConsoleMessenger(() => {}),
      verification: createVerificationProvider(config),
      beforeAccess: async () => {
        throw new StorageUnavailableError("closed");
      },
    });
    const started = await closed.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
    const slot = (await closed.availableSlots(TOUR_DAY))[0]!;
    await closed.reserveSlot(started.reservation.id, slot.start.toISOString());
    let reservation = await closed.recordConsent(started.reservation.id, true);
    if (reservation.status === "AWAITING_VERIFICATION") reservation = await closed.submitVerification(started.reservation.id, basicForm());
    clock.set(slot.start);
    const denied = await closed.requestAccess({ reservationId: reservation.id, prospectId: started.prospect.id, doorId: "entrance" });
    expect(denied.durinCalled).toBe(false);
    expect(denied.decision.code).toBe("DENY_STORAGE_FAILURE");
    expect(durin.calls.requestAccess).toHaveLength(0);
    const bundle = await closed.exportRecords();
    const door = config.doors.find((d) => d.id === "entrance")!.name;
    const locked = `Tour Core couldn't save the visit record, so ${door} stayed locked.`;
    expect(bundle.reservations.find((r) => r.id === reservation.id)?.status).toBe("READY");
    expect(bundle.auditEvents.some((e) => e.type === "PROVIDER_FAILURE")).toBe(false);
    expect(bundle.auditEvents.filter((e) => e.type === "OPERATOR_NOTIFIED").map((e) => e.detail)).toContain(locked);
    const visitorReply = bundle.messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body).at(-1);
    const expectedVisitor = VisitorDenialCopy.doorsNotResponding(config.operator.name, config.operator.visitorContact);
    expect(visitorReply).toBe(expectedVisitor);
    expect(visitorReply).toContain("I've let the property team know");
    expect(visitorReply).toMatch(/Stay where you are and reply here|or call/);
    expect(visitorReply).not.toMatch(/durin/i);
    const history = describeHistory(bundle.auditEvents, bundle, config.property.timezone).map((e) => e.text);
    expect(history).toContain(locked);
    expect(history).not.toContain("Tour Core couldn't save the visit record, so the tour was paused.");
    const ws = new PropertyWorkspace(tempDir());
    ws.save(config);
    ws.recordVisitorDemo(config.property.id, {
      schemaVersion: 1,
      tourId: "2026-09-28T14-00-00-000Z_storage-pre",
      kind: "visitor-demo",
      ranAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
      outcome: "in-progress",
    }, bundle);
    const issues = await listExceptions({ workspace: ws, now: () => clock.now() });
    expect(issues).toEqual([]);
  });

  it("revokes if the grant cannot be saved and pauses the tour", async () => {
    const config = loadConfig();
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
    let grants = 0;
    const flaky = new InMemoryStore();
    const basePut = flaky.put.bind(flaky);
    flaky.put = async (collection, record) => {
      if (collection === "accessGrants") {
        grants += 1;
        throw new StorageUnavailableError("grant not saved");
      }
      return basePut(collection, record);
    };
    const durin2 = new MockDurinAccessAdapter({ doorNames: Object.fromEntries(config.doors.map((door) => [door.id, door.name])), now: () => clock.now() });
    const core2 = new TourCore({ config, clock, store: flaky, durin: durin2, messenger: new ConsoleMessenger(() => {}), verification: createVerificationProvider(config) });
    const started2 = await core2.startInquiry({ name: "Jane Smith", phone: "(555) 010-9999", unitId: "apt_101" });
    const slot = (await core2.availableSlots(TOUR_DAY))[0]!;
    await core2.reserveSlot(started2.reservation.id, slot.start.toISOString());
    let ready = await core2.recordConsent(started2.reservation.id, true);
    if (ready.status === "AWAITING_VERIFICATION") ready = await core2.submitVerification(started2.reservation.id, basicForm("(555) 010-9999"));
    clock.set(slot.start);
    const outcome = await core2.requestAccess({ reservationId: ready.id, prospectId: started2.prospect.id, doorId: "entrance" });
    expect(outcome.decision.allowed).toBe(false);
    expect(outcome.decision.code).toBe("DENY_STORAGE_FAILURE");
    expect(durin2.calls.requestAccess).toHaveLength(1);
    expect(durin2.calls.revokeAccess).toHaveLength(1);
    expect(grants).toBe(1);
    const bundle = await core2.exportRecords();
    const door = config.doors.find((d) => d.id === "entrance")!.name;
    const paused = "Tour Core couldn't save the visit record, so the tour was paused.";
    expect(bundle.reservations.find((r) => r.id === ready.id)?.status).toBe("PROVIDER_FAILURE");
    expect(bundle.auditEvents.some((e) => e.type === "ACCESS_DENIED" && e.code === "DENY_STORAGE_FAILURE")).toBe(true);
    expect(bundle.auditEvents.some((e) => e.type === "PROVIDER_FAILURE" && e.code === "DENY_STORAGE_FAILURE")).toBe(true);
    expect(bundle.auditEvents.filter((e) => e.type === "OPERATOR_NOTIFIED").map((e) => e.detail)).toContain(paused);
    expect(bundle.auditEvents.filter((e) => e.type === "OPERATOR_NOTIFIED").map((e) => e.detail)).not.toContain(
      `Tour Core couldn't save the visit record, so ${door} stayed locked.`,
    );
    const history = describeHistory(bundle.auditEvents, bundle, config.property.timezone).map((e) => e.text);
    expect(history).toContain(`Tour Core couldn't save the visit record, so ${door} stayed locked.`);
    expect(history).toContain(paused);
    expect(history).not.toContain(`The door system couldn't open ${door}, so it stayed locked.`);
    const ws = new PropertyWorkspace(tempDir());
    ws.save(config);
    ws.recordVisitorDemo(config.property.id, {
      schemaVersion: 1,
      tourId: "2026-09-28T14-00-00-000Z_storage",
      kind: "visitor-demo",
      ranAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
      outcome: "in-progress",
    }, bundle);
    const issues = await listExceptions({ workspace: ws, now: () => clock.now() });
    expect(issues.map((e) => e.summary)).toContain(paused);
    expect(issues.map((e) => e.summary)).not.toContain(`The door system couldn't open ${door}, so the tour was paused.`);
  });
});

describe("Google authorization and Grok copy", () => {
  it("uses authorization code and PKCE, and never puts a token in an error", async () => {
    const pending = createPending("https://brave-otter.example/google/oauth/callback", 1_000);
    const url = new URL(authorizationUrl({ clientId: "tourcore-client", clientSecret: "secret" }, pending));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(googleScopeParam()).toBe("https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email");
    expect(url.searchParams.get("scope")).not.toContain("https://www.googleapis.com/auth/drive ");
    expect(() => checkState(pending, "wrong", 1_000)).toThrow(/didn't match/);
    const tokenBody = { access_token: "ya29.secret-access", refresh_token: "1//secret-refresh", expires_in: 3600 };
    await expect(
      exchangeCode({ clientId: "tourcore-client", clientSecret: "secret" }, pending, "auth-code", async () => ({ status: 400, json: async () => tokenBody })),
    ).rejects.toThrow(/didn't accept/);
    try {
      await exchangeCode({ clientId: "tourcore-client", clientSecret: "secret" }, pending, "auth-code", async () => ({ status: 400, json: async () => tokenBody }));
    } catch (err) {
      expect(String(err)).not.toContain("ya29");
      expect(String(err)).not.toContain("secret-refresh");
    }
    expect(() => createPending("http://evil.example/callback", 1)).toThrow(/https/);
  });

  it("recommends Drive without asking for a Google password, and the template carries no Drive account", async () => {
    const root = tempDir();
    const inst = new Installation({
      root,
      runtime: new FileRuntimeStore(join(root, "runtime")),
      env: () => ({ TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0", PUBLIC_BASE_URL: "https://brave-otter.example" }),
    });
    inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    inst.files.setPublicBaseUrl("https://brave-otter.example", "CLOUDFLARE_QUICK_TUNNEL");
    const started = inst.records.beginConnect();
    expect(started.configured).toBe(false);
    if (!started.configured) {
      expect(started.summary).toMatch(/isn't on this computer yet/);
      expect(started.summary).not.toMatch(/password|client secret|api key/i);
      expect(started.technical).toMatch(/TOURCORE_GOOGLE_OAUTH_CLIENT_ID/);
      expect(started.technical).toMatch(/no documented xAI API/);
    }
    const template = readFileSync(new URL("../grok-template/template.json", import.meta.url), "utf8");
    const skill = readFileSync(new URL("../.grok/skills/install-tour-core/SKILL.md", import.meta.url), "utf8");
    // Google tokens and folder ids stay out of the template and skills: the secrets scan in grokTemplate.test.ts.
    expect(template).toContain("Google Drive");
    expect(template).toContain("travelsWithTemplate");
    expect(skill).toMatch(/built-in Google Drive connector/);
    expect(skill).toMatch(/won't be portable/);
  });
});
