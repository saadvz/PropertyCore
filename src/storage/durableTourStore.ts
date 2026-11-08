import type { TourCoreStore, CollectionName, Collections } from "./Store";
import { upgradeAccessGrant, type AuditEvent } from "../domain/model";
import { StorageUnavailableError } from "./errors";
import { sha256Json, type DocumentStore } from "./documentStore";

/** A record saved in an older shape, read in the current one. */
function upgradeRecord(collection: CollectionName, body: unknown): unknown {
  return collection === "accessGrants" ? upgradeAccessGrant(body) : body;
}

/**
 * Tour records that must be on Drive before Tour Core tells anyone they
 * happened. The in-memory store updates only after Drive accepts the write.
 */
export class DurableTourStore implements TourCoreStore {
  constructor(
    private readonly inner: TourCoreStore,
    private readonly remote: DocumentStore,
    private readonly available: () => boolean,
  ) {}

  private path(collection: string, id: string): string {
    return `tours-data/${collection}/${id}.json`;
  }

  private async requireUp(): Promise<void> {
    if (!this.available()) throw new StorageUnavailableError("Tour records can't be saved right now, so that wasn't confirmed.");
  }

  async get<K extends CollectionName>(collection: K, id: string): Promise<Collections[K] | undefined> {
    if (!this.available()) return this.inner.get(collection, id);
    try {
      const doc = await this.remote.get(this.path(collection, id));
      if (!doc) return undefined;
      return upgradeRecord(collection, doc.body) as Collections[K];
    } catch (err) {
      if (err instanceof StorageUnavailableError) return this.inner.get(collection, id);
      throw err;
    }
  }

  async put<K extends CollectionName>(collection: K, record: Collections[K]): Promise<void> {
    await this.requireUp();
    const path = this.path(collection, record.id);
    const existing = await this.remote.get(path);
    if (existing?.sha256 !== sha256Json(record)) {
      await this.remote.put(path, record, { schemaVersion: 1, kind: collection, ...(existing ? { ifRevision: existing.revision } : {}) });
    }
    await this.inner.put(collection, record);
  }

  async list<K extends CollectionName>(collection: K): Promise<Collections[K][]> {
    if (!this.available()) return this.inner.list(collection);
    const docs = await this.remote.list(`tours-data/${collection}/`);
    if (!docs.length) return this.inner.list(collection);
    return docs.map((doc) => upgradeRecord(collection, doc.body) as Collections[K]);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.requireUp();
    const path = this.path("audit", event.id);
    const existing = await this.remote.get(path);
    if (!existing) await this.remote.put(path, event, { schemaVersion: 1, kind: "audit" });
    await this.inner.appendAudit(event);
  }

  async listAudit(): Promise<AuditEvent[]> {
    if (!this.available()) return this.inner.listAudit();
    const docs = await this.remote.list("tours-data/audit/");
    if (!docs.length) return this.inner.listAudit();
    return docs.map((doc) => doc.body as AuditEvent).sort((a, b) => a.seq - b.seq);
  }
}
