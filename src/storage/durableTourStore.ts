import type { TourCoreStore, CollectionName, Collections } from "./Store";
import type { AuditEvent } from "../domain/model";
import { StorageUnavailableError } from "./errors";
import { sha256Json, type DocumentStore } from "./documentStore";

/**
 * Tour records that must be on Drive before Tour Core tells anyone they
 * happened. The in-memory store updates only after Drive accepts the write.
 * The Drive store is looked up on each call, so a store made before Drive
 * opened writes to Drive once it does.
 */
export class DurableTourStore implements TourCoreStore {
  constructor(
    private readonly inner: TourCoreStore,
    private readonly current: () => DocumentStore | undefined,
    private readonly available: () => boolean,
  ) {}

  private get remote(): DocumentStore {
    const remote = this.current();
    if (!remote) throw new StorageUnavailableError("Tour records can't be saved right now, so that wasn't confirmed.");
    return remote;
  }

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
      return doc.body as Collections[K];
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
    return docs.map((doc) => doc.body as Collections[K]);
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
