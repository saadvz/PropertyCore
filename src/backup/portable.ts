import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { fullHash, safetyHash } from "../config/changeKinds";
import { TourCoreConfigShape, type TourCoreConfig } from "../config/tourCoreConfig";
import { operatorFacingPropertyName } from "../setup/setupActions";
import { isLegacyVerification, presentVerification } from "../setup/verification";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { collectCanonical, looksLikeSecret, type CanonicalFile } from "../storage/canonical";
import { sha256Json } from "../storage/documentStore";

/** Machine-restorable snapshot. Not a human-readable export. */
export const PORTABLE_FORMAT = "tourcore-portable-backup";
export const PORTABLE_SCHEMA_VERSION = 1;
/** Human-readable reporting file. Restore refuses this format. */
export const READABLE_FORMAT = "tourcore-readable-export";

const SKIP_PREFIXES = ["runtime/oauth/", "runtime/setup-sessions/", "runtime/approval-sessions/", "runtime/probe/", "portable-handoff/"];
const SKIP_FILES = new Set(["install/secrets.json"]);

export class PortableBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableBackupError";
  }
}

const FileSchema = z.strictObject({
  path: z.string().min(3).max(300),
  kind: z.string().min(1).max(40),
  body: z.unknown(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const ContentsSchema = z.strictObject({
  files: z.array(FileSchema).max(5000),
});

export const PortableBackupSchema = z.strictObject({
  format: z.literal(PORTABLE_FORMAT),
  schemaVersion: z.literal(PORTABLE_SCHEMA_VERSION),
  installationId: z.string().min(4).max(80),
  createdAt: z.iso.datetime(),
  tourCoreVersion: z.string().min(1).max(40),
  contents: ContentsSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PortableBackup = z.infer<typeof PortableBackupSchema>;

export interface BackupCounts {
  properties: number;
  units: number;
  facts: number;
  tours: number;
  reservations: number;
  prospects: number;
  contentChanges: number;
  sessions: number;
  operatorEvents: number;
}

export function stableStringify(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  const walk = (node: unknown): string => {
    if (node === null || typeof node !== "object") return JSON.stringify(node) ?? "null";
    if (Array.isArray(node)) return `[${node.map((item) => walk(item)).join(",")}]`;
    const obj = node as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${walk(obj[key])}`)
      .join(",")}}`;
  };
  return walk(normalized);
}

export function checksumOf(contents: unknown): string {
  return createHash("sha256").update(stableStringify(contents), "utf8").digest("hex");
}

/** For Grok. The downloaded file is pretty-printed and also includes this field, so hashing the file does not reproduce it. */
export const CHECKSUM_COVERS =
  "The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \\u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match.";

const FILE_CHANGED = "This backup file was changed or damaged after it was made, so nothing was restored. Try the original file.";
const PART_CHANGED = "Part of this backup file was changed or damaged, so nothing was restored. Try the original file.";
const NOT_A_BACKUP = "This file doesn't look like a Tour Core backup, so nothing was restored. Try the original file.";
const PART_BROKEN = "Part of this backup file is broken, so nothing was restored. Try the original file.";
const NOT_MADE = "The backup wasn't made because some saved records don't fit together. Nothing was changed.";
const NOT_MADE_SECRET = "The backup wasn't made because it would have included a password or key. Nothing was changed.";
const RESTORE_SECRET = "This backup file includes a password or key, so nothing was restored.";

/** On tool results. The prefix keeps the hash construction from being read aloud. */
export const CHECKSUM_COVERS_RESULT = `For you, not out loud: ${CHECKSUM_COVERS}`;

function safePath(path: string): boolean {
  if (path.includes("\\") || path.startsWith("/") || path.includes("..")) return false;
  if (SKIP_FILES.has(path) || SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return path.startsWith("install/") || path.startsWith("properties/") || path.startsWith("runtime/");
}

/** Business JSON that contains a credential must stop the backup, not be silently dropped. */
function assertNoSecretFiles(root: string, secretValues: string[]): void {
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix))) walk(full, path);
        continue;
      }
      if (!name.endsWith(".json") || !safePath(path)) continue;
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (looksLikeSecret(body, secretValues)) {
        throw new PortableBackupError(NOT_MADE_SECRET);
      }
    }
  };
  for (const top of ["install", "properties", "runtime"]) walk(join(root, top), top);
}

export function buildPortableBackup(input: {
  root: string;
  installationId: string;
  createdAt: string;
  tourCoreVersion: string;
  secretValues: string[];
}): PortableBackup {
  assertNoSecretFiles(input.root, input.secretValues);
  const files = collectCanonical(input.root, input.secretValues)
    .filter((file) => safePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const contents = { files };
  const backup: PortableBackup = {
    format: PORTABLE_FORMAT,
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    installationId: input.installationId,
    createdAt: input.createdAt,
    tourCoreVersion: input.tourCoreVersion,
    contents,
    checksum: checksumOf(contents),
  };
  return assertClean(PortableBackupSchema.parse(backup), input.secretValues, "create");
}

export function backupFileName(createdAt: string): string {
  const stamp = createdAt.replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  return `tour-core-backup-${stamp}.json`;
}

export function exportFileName(createdAt: string): string {
  const stamp = createdAt.replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  return `tour-core-export-${stamp}.json`;
}

function assertClean(backup: PortableBackup, secretValues: string[], purpose: "create" | "restore"): PortableBackup {
  if (looksLikeSecret(backup, secretValues)) {
    throw new PortableBackupError(purpose === "create" ? NOT_MADE_SECRET : RESTORE_SECRET);
  }
  const unfit = purpose === "create" ? NOT_MADE : undefined;
  if (backup.checksum !== checksumOf(backup.contents)) throw new PortableBackupError(unfit ?? FILE_CHANGED);
  const problems = relationshipProblems(backup.contents.files);
  if (problems.length) throw new PortableBackupError(unfit ?? problems[0]!);
  return backup;
}

function relationshipProblems(files: CanonicalFile[]): string[] {
  const problems: string[] = [];
  const paths = new Set<string>();
  const propertyIds = new Set<string>();
  const tourIds = new Set<string>();
  for (const file of files) {
    if (!safePath(file.path)) {
      problems.push(NOT_A_BACKUP);
      continue;
    }
    if (paths.has(file.path)) problems.push(PART_BROKEN);
    paths.add(file.path);
    if (sha256Json(file.body) !== file.sha256) problems.push(PART_CHANGED);
    if (!file.path.endsWith("/tourcore.config.json")) continue;
    const body = file.body as { property?: { id?: string }; doors?: { id?: string }[]; routes?: { stops?: { doorId?: string }[] }[]; units?: unknown[] };
    const id = body.property?.id;
    if (!id) {
      problems.push(PART_BROKEN);
      continue;
    }
    if (propertyIds.has(id)) problems.push(PART_BROKEN);
    propertyIds.add(id);
    const doorIds = new Set((body.doors ?? []).map((door) => door.id).filter((doorId): doorId is string => !!doorId));
    for (const route of body.routes ?? []) {
      if (!Array.isArray(route.stops)) {
        problems.push(PART_BROKEN);
        continue;
      }
      for (const stop of route.stops) {
        if (!stop.doorId || (doorIds.size > 0 && !doorIds.has(stop.doorId))) problems.push(PART_BROKEN);
      }
    }
  }
  for (const file of files) {
    if (!file.path.endsWith("/record.json")) continue;
    const tourId = (file.body as { tourId?: string }).tourId;
    if (tourId) {
      if (tourIds.has(tourId)) problems.push(PART_BROKEN);
      tourIds.add(tourId);
    }
  }
  return problems;
}

export function parsePortableBackup(raw: unknown, secretValues: string[] = []): PortableBackup {
  if (!raw || typeof raw !== "object") throw new PortableBackupError("That file isn't a Tour Core backup.");
  const doc = raw as { format?: unknown; schemaVersion?: unknown };
  if (doc.format === READABLE_FORMAT) throw new PortableBackupError("That file is an export, not a restorable backup.");
  if (doc.format !== PORTABLE_FORMAT) throw new PortableBackupError("That file isn't a Tour Core backup.");
  if (doc.schemaVersion !== PORTABLE_SCHEMA_VERSION) throw new PortableBackupError("This backup uses a format this Tour Core doesn't support yet.");
  const parsed = PortableBackupSchema.safeParse(raw);
  if (!parsed.success) throw new PortableBackupError("That backup isn't valid. Nothing was restored.");
  if (parsed.data.checksum !== checksumOf(parsed.data.contents)) throw new PortableBackupError(FILE_CHANGED);
  return assertClean(parsed.data, secretValues, "restore");
}

export function countBackup(backup: PortableBackup): BackupCounts {
  const counts: BackupCounts = { properties: 0, units: 0, facts: 0, tours: 0, reservations: 0, prospects: 0, contentChanges: 0, sessions: 0, operatorEvents: 0 };
  for (const file of backup.contents.files) {
    if (file.path.endsWith("/tourcore.config.json")) {
      counts.properties += 1;
      const body = file.body as { property?: { facts?: unknown[] }; units?: { facts?: unknown[] }[] };
      counts.units += body.units?.length ?? 0;
      counts.facts += (body.property?.facts?.length ?? 0) + (body.units ?? []).reduce((n, unit) => n + (unit.facts?.length ?? 0), 0);
    }
    if (file.path.endsWith("/content-changes.json")) {
      counts.contentChanges += ((file.body as { changes?: unknown[] }).changes ?? []).length;
    }
    if (file.path.endsWith("/record.json")) counts.tours += 1;
    if (file.path.endsWith("/tour-export.json")) {
      const body = file.body as { reservations?: unknown[]; prospects?: unknown[] };
      counts.reservations += body.reservations?.length ?? 0;
      counts.prospects += body.prospects?.length ?? 0;
    }
    if (file.path.startsWith("runtime/sessions/")) counts.sessions += 1;
    if (file.path.startsWith("runtime/operator-events/")) counts.operatorEvents += 1;
  }
  return counts;
}

export function previewLines(backup: PortableBackup, currentInstallationId?: string): string[] {
  const counts = countBackup(backup);
  const lines = [
    "Backup contains:",
    `${counts.properties} ${counts.properties === 1 ? "property" : "properties"}`,
    `${counts.units} tourable ${counts.units === 1 ? "unit" : "units"}`,
    `${counts.tours} tour ${counts.tours === 1 ? "record" : "records"}`,
    `${counts.facts} approved ${counts.facts === 1 ? "fact" : "facts"}`,
    `${counts.reservations} ${counts.reservations === 1 ? "reservation" : "reservations"}`,
    `${counts.prospects} ${counts.prospects === 1 ? "prospect" : "prospects"}`,
  ];
  if (currentInstallationId && currentInstallationId !== backup.installationId) {
    lines.push("This backup is from a different Tour Core installation. Restoring replaces business records. It does not merge them.");
  }
  return lines;
}

export function hasLiveBusinessState(root: string): boolean {
  return collectCanonical(root).some(
    (file) => file.kind === "property" || file.kind === "tour-record" || file.kind === "session" || file.path.includes("/tours/") || file.kind === "tour-export",
  );
}

const RESTORE_RUNTIME = ["sessions", "verification", "endpoints", "messaging-ledger", "operator-events"];

/** Writes business records from a validated backup. Never writes secrets. */
export function applyPortableBackup(root: string, backup: PortableBackup, replace: boolean): { files: number; notes: string[] } {
  if (!replace && hasLiveBusinessState(root)) {
    throw new PortableBackupError("This Tour Core already has records. Restoring would replace them, and that needs an explicit recovery choice. Nothing was changed.");
  }
  if (replace) clearBusinessFiles(root);
  let files = 0;
  const notes: string[] = [];
  const coerced: { id: string; before: TourCoreConfig; after: TourCoreConfig }[] = [];
  for (const file of backup.contents.files) {
    if (!safePath(file.path)) continue;
    const target = join(root, ...file.path.split("/"));
    const rel = relative(root, target);
    if (rel.startsWith("..")) continue;
    let body = file.body;
    if (file.path.endsWith("/tourcore.config.json") && body && typeof body === "object") {
      const record = body as { verificationMode?: string };
      if (isLegacyVerification(record.verificationMode)) {
        const parsed = TourCoreConfigShape.safeParse(body);
        if (record.verificationMode === "mock" && parsed.success) {
          const spoken = operatorFacingPropertyName(parsed.data);
          notes.push(`${spoken} had an older ID check setting, so it now uses the basic identity form. Tell me if you'd rather have no form.`);
        }
        body = { ...record, verificationMode: "basic-form" };
        if (parsed.success) coerced.push({ id: parsed.data.property.id, before: parsed.data, after: presentVerification(parsed.data) });
      }
    }
    writeJsonAtomic(target, body);
    files += 1;
  }
  for (const item of coerced) retargetRestoredVerification(root, item);
  return { files, notes };
}

function retargetRestoredVerification(root: string, item: { id: string; before: TourCoreConfig; after: TourCoreConfig }): void {
  const statePath = join(root, "properties", item.id, "status.json");
  if (!existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    configHash?: string;
    safetyHash?: string;
    readiness?: { configHash: string; safetyHash?: string };
    dryTour?: { configHash: string; safetyHash?: string };
  };
  const old = { full: fullHash(item.before), safety: safetyHash(item.before) };
  const next = { full: fullHash(item.after), safety: safetyHash(item.after) };
  const move = <T extends { configHash: string; safetyHash?: string }>(record: T): T => ({
    ...record,
    ...(record.configHash === old.full ? { configHash: next.full } : {}),
    ...(record.safetyHash === old.safety ? { safetyHash: next.safety } : {}),
  });
  writeJsonAtomic(statePath, {
    ...state,
    ...(state.configHash === old.full ? { configHash: next.full } : {}),
    ...(state.safetyHash === old.safety ? { safetyHash: next.safety } : {}),
    ...(state.readiness ? { readiness: move(state.readiness) } : {}),
    ...(state.dryTour ? { dryTour: move(state.dryTour) } : {}),
  });
}

function clearBusinessFiles(root: string): void {
  rmSync(join(root, "properties"), { recursive: true, force: true });
  for (const name of RESTORE_RUNTIME) rmSync(join(root, "runtime", name), { recursive: true, force: true });
  mkdirSync(join(root, "properties"), { recursive: true });
}

export function buildReadableExport(input: { root: string; installationId: string; createdAt: string; secretValues: string[] }): {
  fileName: string;
  body: unknown;
  text: string;
} {
  assertNoSecretFiles(input.root, input.secretValues);
  const files = collectCanonical(input.root, input.secretValues).filter((file) => safePath(file.path));
  const properties = files
    .filter((file) => file.path.endsWith("/tourcore.config.json"))
    .map((file) => {
      const body = file.body as { property?: { id?: string; name?: string; canonicalAddress?: unknown; propertyType?: string }; units?: { name?: string }[] };
      return {
        id: body.property?.id,
        name: body.property?.name,
        address: body.property?.canonicalAddress,
        propertyType: body.property?.propertyType,
        units: (body.units ?? []).map((unit) => unit.name).filter(Boolean),
      };
    });
  const tours = files
    .filter((file) => file.path.endsWith("/record.json"))
    .map((file) => {
      const body = file.body as { tourId?: string; outcome?: string; ranAt?: string; kind?: string };
      return [body.tourId ?? "", body.kind ?? "", body.outcome ?? "", body.ranAt ?? ""].join(",");
    });
  const body = {
    format: READABLE_FORMAT,
    schemaVersion: 1,
    installationId: input.installationId,
    createdAt: input.createdAt,
    role: "export",
    propertySummary: { schemaVersion: 1, properties },
    tourHistoryCsv: ["tourId,kind,outcome,at", ...tours].join("\n") + "\n",
  };
  const text = JSON.stringify(body, null, 2) + "\n";
  if (input.secretValues.some((secret) => secret.length >= 6 && text.includes(secret))) {
    throw new PortableBackupError("The export contained a credential, so it was not created.");
  }
  return { fileName: exportFileName(input.createdAt), body, text };
}

export function reconnectLines(connected: { texting: boolean; updates: boolean }): string[] {
  return [
    "Property records: restored",
    "Tour history: restored",
    connected.texting ? "Visitor texting: still connected on this Tour Core. The backup did not include those credentials." : "Visitor texting: reconnect required",
    connected.updates ? "Operator updates: still connected on this Tour Core. The backup did not include those credentials." : "Operator updates: reconnect required",
    "Door provider: reconnect required where applicable",
  ];
}
