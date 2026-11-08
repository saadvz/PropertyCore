import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../storage/atomicWrite";
import { tenantFolder } from "./registry";

/**
 * One tenant's secrets, in that tenant's own folder: its door-code and photo keys, and each
 * connection's alert routine address and key. Never in the process environment, so no tenant can
 * read another's.
 */

interface Doc {
  tenant: Record<string, string>;
  connections: Record<string, Record<string, string>>;
}

export class TenantSecrets {
  constructor(private readonly dataRoot: string) {}

  private path(id: string): string {
    return join(tenantFolder(this.dataRoot, id), "secrets.json");
  }

  private read(id: string): Doc {
    const path = this.path(id);
    if (!existsSync(path)) return { tenant: {}, connections: {} };
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<Doc>;
    return { tenant: doc.tenant ?? {}, connections: doc.connections ?? {} };
  }

  private write(id: string, doc: Doc): void {
    const path = this.path(id);
    writeJsonAtomic(path, doc);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Not every filesystem keeps modes.
    }
  }

  tenant(id: string): Record<string, string> {
    return { ...this.read(id).tenant };
  }

  connection(id: string, grantId: string): Record<string, string> {
    return { ...(this.read(id).connections[grantId] ?? {}) };
  }

  set(id: string, values: Record<string, string>): void {
    const doc = this.read(id);
    doc.tenant = { ...doc.tenant, ...values };
    this.write(id, doc);
  }

  setForConnection(id: string, grantId: string, values: Record<string, string>): void {
    const doc = this.read(id);
    doc.connections[grantId] = { ...(doc.connections[grantId] ?? {}), ...values };
    this.write(id, doc);
  }

  /** Removes these names from the tenant and from every connection. */
  delete(id: string, names: string[]): void {
    const doc = this.read(id);
    for (const name of names) {
      delete doc.tenant[name];
      for (const values of Object.values(doc.connections)) delete values[name];
    }
    this.write(id, doc);
  }

  deleteConnection(id: string, grantId: string): void {
    const doc = this.read(id);
    if (!(grantId in doc.connections)) return;
    delete doc.connections[grantId];
    this.write(id, doc);
  }
}
