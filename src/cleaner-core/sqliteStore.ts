import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../storage/atomicWrite";

const require = createRequire(import.meta.url);

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: (string | null)[]): unknown; get(...args: string[]): unknown };
  close(): void;
}

function openDb(path: string, readOnly = false): SqliteDb {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb };
  return new DatabaseSync(path, { readOnly });
}

function sqlPath(path: string): string {
  return path.replaceAll("'", "''");
}

/** Write every tenant slice into the SQLite store. The body is the redacted JSON slice. */
export function mirrorStore(dbPath: string, fileJson: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS tenant_slice (tenant_id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM tenant_slice");
    const insert = db.prepare("INSERT INTO tenant_slice (tenant_id, body) VALUES (?, ?)");
    for (const [tenantId, body] of slicesOf(fileJson)) insert.run(tenantId, body);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** Consistent snapshot of the SQLite store. VACUUM INTO is the snapshot; the live file is not shared. */
export function snapshotStore(dbPath: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) unlinkSync(dest);
  const db = openDb(dbPath);
  try {
    db.exec(`VACUUM INTO '${sqlPath(dest)}'`);
  } finally {
    db.close();
  }
}

export function readSlice(backupPath: string, tenantId: string): string | undefined {
  const db = openDb(backupPath, true);
  try {
    const row = db.prepare("SELECT body FROM tenant_slice WHERE tenant_id = ?").get(tenantId) as { body?: string } | undefined;
    return typeof row?.body === "string" ? row.body : undefined;
  } finally {
    db.close();
  }
}

/**
 * Replace one tenant in the live JSON file from a backup snapshot.
 * Every other tenant slice stays as it was.
 */
export function restoreTenantSlice(jsonPath: string, backupPath: string, tenantId: string): void {
  const body = readSlice(backupPath, tenantId);
  if (!body) throw new Error("That backup has no slice for this property.");
  const slice = JSON.parse(body) as Record<string, unknown>;
  const existing = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>) : undefined;
  const next = mergeSlice(existing, tenantId, slice);
  writeFileAtomic(jsonPath, `${JSON.stringify(next)}\n`);
}

function slicesOf(fileJson: string): [string, string][] {
  const file = JSON.parse(fileJson) as { tenants?: Record<string, unknown>; tenantId?: string };
  if (file.tenants && typeof file.tenants === "object") {
    return Object.entries(file.tenants).map(([tenantId, slice]) => [tenantId, JSON.stringify(slice)]);
  }
  const tenantId = typeof file.tenantId === "string" && file.tenantId !== "" ? file.tenantId : "default";
  return [[tenantId, fileJson]];
}

function mergeSlice(existing: Record<string, unknown> | undefined, tenantId: string, slice: Record<string, unknown>): Record<string, unknown> {
  const others: Record<string, unknown> = {};
  if (existing?.tenants && typeof existing.tenants === "object") {
    for (const [key, value] of Object.entries(existing.tenants as Record<string, unknown>)) {
      if (key !== tenantId) others[key] = value;
    }
  } else if (existing && existing.tenantId !== tenantId && Array.isArray(existing.jobs)) {
    const key = typeof existing.tenantId === "string" && existing.tenantId !== "" ? existing.tenantId : "default";
    if (key !== tenantId) others[key] = existing;
  }
  if (Object.keys(others).length === 0) return { ...slice, tenantId };
  return { schemaVersion: 1, tenants: { ...others, [tenantId]: { ...slice, tenantId } } };
}
