import { SchemaVersionError, StorageConflictError, StorageTornError, StorageUnavailableError, isTransientStatus } from "./errors";
import { assertStoreSchema, sha256Json, type DocumentStore, type PutOptions, type StoredDocument } from "./documentStore";

/** What Tour Core needs from Google Drive. No sharing, no full-Drive listing. */
export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  etag: string;
  trashed: boolean;
  appProperties: Record<string, string>;
  /** True only if a permission other than the owner exists. Tour Core never sets that. */
  shared: boolean;
}

export interface DriveClient {
  createFolder(input: { name: string; parentId?: string; appProperties: Record<string, string> }): Promise<DriveFileMeta>;
  createFile(input: { name: string; parentId: string; content: string; appProperties: Record<string, string> }): Promise<DriveFileMeta>;
  readFile(id: string): Promise<{ meta: DriveFileMeta; content: string }>;
  /** Conditional write. 412 when etag doesn't match. Safe to retry: the same bytes and etag either apply once or fail. */
  updateContent(id: string, content: string, ifMatch: string): Promise<DriveFileMeta>;
  trash(id: string): Promise<void>;
  listByAppProperty(key: string, value: string): Promise<DriveFileMeta[]>;
}

export class DriveStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const FOLDER = "application/vnd.google-apps.folder";

/**
 * In-memory Drive. Files are private. Conditional updates use etags.
 * `loseCreateResponse` simulates a create that landed but whose response was lost.
 */
export class FakeGoogleDrive implements DriveClient {
  readonly files = new Map<string, { meta: DriveFileMeta; content: string }>();
  private seq = 1;
  failReads = 0;
  failReadStatus = 503;
  failCreates = 0;
  loseCreateResponse = false;
  failCatalogUpdates = 0;
  readonly reads: string[] = [];
  readonly creates: string[] = [];

  private nextId(prefix: string): string {
    return `${prefix}_${this.seq++}`;
  }

  private etag(): string {
    return `"rev-${this.seq++}"`;
  }

  async createFolder(input: { name: string; parentId?: string; appProperties: Record<string, string> }): Promise<DriveFileMeta> {
    const meta: DriveFileMeta = {
      id: this.nextId("folder"),
      name: input.name,
      mimeType: FOLDER,
      parents: input.parentId ? [input.parentId] : [],
      etag: this.etag(),
      trashed: false,
      appProperties: { ...input.appProperties },
      shared: false,
    };
    this.files.set(meta.id, { meta, content: "" });
    return structuredClone(meta);
  }

  async createFile(input: { name: string; parentId: string; content: string; appProperties: Record<string, string> }): Promise<DriveFileMeta> {
    this.creates.push(input.appProperties.tourCoreRequest ?? input.name);
    if (this.loseCreateResponse) {
      this.loseCreateResponse = false;
      this.insertFile(input);
      throw new DriveStatusError(503, "response lost");
    }
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new DriveStatusError(503, "unavailable");
    }
    return this.insertFile(input);
  }

  private insertFile(input: { name: string; parentId: string; content: string; appProperties: Record<string, string> }): DriveFileMeta {
    const meta: DriveFileMeta = {
      id: this.nextId("file"),
      name: input.name,
      mimeType: "application/json",
      parents: [input.parentId],
      etag: this.etag(),
      trashed: false,
      appProperties: { ...input.appProperties },
      shared: false,
    };
    this.files.set(meta.id, { meta, content: input.content });
    return structuredClone(meta);
  }

  async readFile(id: string): Promise<{ meta: DriveFileMeta; content: string }> {
    this.reads.push(id);
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new DriveStatusError(this.failReadStatus, "unavailable");
    }
    const file = this.files.get(id);
    if (!file || file.meta.trashed) throw new DriveStatusError(404, "missing");
    return { meta: structuredClone(file.meta), content: file.content };
  }

  async updateContent(id: string, content: string, ifMatch: string): Promise<DriveFileMeta> {
    const file = this.files.get(id);
    if (!file || file.meta.trashed) throw new DriveStatusError(404, "missing");
    if (file.meta.name === "_catalog.json" && this.failCatalogUpdates > 0) {
      this.failCatalogUpdates -= 1;
      throw new DriveStatusError(500, "catalog write failed");
    }
    if (file.meta.etag !== ifMatch) throw new DriveStatusError(412, "precondition failed");
    file.content = content;
    file.meta.etag = this.etag();
    return structuredClone(file.meta);
  }

  async trash(id: string): Promise<void> {
    const file = this.files.get(id);
    if (file) file.meta.trashed = true;
  }

  async listByAppProperty(key: string, value: string): Promise<DriveFileMeta[]> {
    return [...this.files.values()].filter((f) => !f.meta.trashed && f.meta.appProperties[key] === value).map((f) => structuredClone(f.meta));
  }
}

async function retryIdempotent<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (err) {
      last = err;
      const status = err instanceof DriveStatusError ? err.status : 0;
      if (!isTransientStatus(status)) throw err;
      if (i === attempts - 1) break;
    }
  }
  if (last instanceof DriveStatusError && isTransientStatus(last.status)) throw new StorageUnavailableError("Google Drive didn't answer.");
  throw last;
}

interface CatalogEntry {
  fileId: string;
  sha256: string;
  kind: string;
  schemaVersion: number;
}

interface Catalog {
  schemaVersion: 1;
  generation: number;
  entries: Record<string, CatalogEntry>;
}

interface Envelope {
  schemaVersion: number;
  kind: string;
  body: unknown;
}

const emptyCatalog = (): Catalog => ({ schemaVersion: 1, generation: 0, entries: {} });

/**
 * Canonical documents in one private Tour Core folder.
 * A write lands as a new file first. The catalog is the commit marker:
 * readers trust a file only when the catalog names its checksum.
 * The catalog update is conditional on its etag, so two writers can't
 * silently overwrite each other.
 */
export class GoogleDriveStore implements DocumentStore {
  private constructor(
    private readonly client: DriveClient,
    readonly folderId: string,
    private catalogId: string,
    private catalogEtag: string,
    private catalog: Catalog,
  ) {}

  static async open(client: DriveClient, folderName = "Tour Core", storeId?: string): Promise<GoogleDriveStore> {
    const existing = await client.listByAppProperty("tourCoreRole", "store");
    const match = storeId ? existing.find((f) => f.appProperties.storeId === storeId) : existing[0];
    const folder =
      match ??
      (await client.createFolder({
        name: folderName,
        appProperties: { tourCoreRole: "store", tourCore: "1", ...(storeId ? { storeId } : { storeId: `store_${Math.random().toString(36).slice(2, 10)}` }) },
      }));
    const catalogs = (await client.listByAppProperty("tourCoreRole", "catalog")).filter((f) => f.parents.includes(folder.id));
    if (!catalogs[0]) {
      const created = await client.createFile({
        name: "_catalog.json",
        parentId: folder.id,
        content: JSON.stringify(emptyCatalog()),
        appProperties: { tourCoreRole: "catalog", tourCorePath: "_catalog.json" },
      });
      return new GoogleDriveStore(client, folder.id, created.id, created.etag, emptyCatalog());
    }
    const read = await retryIdempotent(() => client.readFile(catalogs[0]!.id));
    const catalog = JSON.parse(read.content) as Catalog;
    assertStoreSchema(catalog.schemaVersion);
    return new GoogleDriveStore(client, folder.id, catalogs[0]!.id, read.meta.etag, catalog);
  }

  private async reloadCatalog(): Promise<void> {
    const read = await retryIdempotent(() => this.client.readFile(this.catalogId));
    this.catalogEtag = read.meta.etag;
    this.catalog = JSON.parse(read.content) as Catalog;
    assertStoreSchema(this.catalog.schemaVersion);
  }

  async get(path: string): Promise<StoredDocument | undefined> {
    await this.reloadCatalog();
    return this.readListed(path);
  }

  /** Reads one catalog entry already loaded. Does not reload the catalog. */
  private async readListed(path: string): Promise<StoredDocument | undefined> {
    const entry = this.catalog.entries[path];
    if (!entry) return undefined;
    const generation = this.catalog.generation;
    const read = await retryIdempotent(() => this.client.readFile(entry.fileId));
    let envelope: Envelope;
    try {
      envelope = JSON.parse(read.content) as Envelope;
    } catch {
      throw new StorageTornError();
    }
    if (envelope.schemaVersion !== entry.schemaVersion) throw new SchemaVersionError(envelope.schemaVersion);
    assertStoreSchema(envelope.schemaVersion);
    const sha256 = sha256Json(envelope.body);
    if (sha256 !== entry.sha256) throw new StorageTornError();
    return { path, schemaVersion: envelope.schemaVersion, kind: envelope.kind, body: envelope.body, revision: `${generation}:${sha256}`, sha256 };
  }

  async put(path: string, body: unknown, options: PutOptions): Promise<StoredDocument> {
    assertStoreSchema(options.schemaVersion);
    const current = await this.get(path);
    if (current && current.sha256 === sha256Json(body) && current.kind === options.kind) return current;
    const committed = await this.commit([{ path, body, ...options }]);
    return committed[0]!;
  }

  /**
   * Writes every document, then updates the catalog once.
   * If the catalog update fails, the new files are trashed and the previous catalog still names the old files.
   */
  async commit(docs: Array<{ path: string; body: unknown; schemaVersion: number; kind: string; ifRevision?: string }>): Promise<StoredDocument[]> {
    await this.reloadCatalog();
    const generation = this.catalog.generation;
    for (const doc of docs) {
      assertStoreSchema(doc.schemaVersion);
      const current = this.catalog.entries[doc.path];
      const revision = current ? `${generation}:${current.sha256}` : undefined;
      if (current && doc.ifRevision !== revision) throw new StorageConflictError();
      if (!current && doc.ifRevision) throw new StorageConflictError("That record is no longer there.");
    }
    const created: { path: string; fileId: string; sha256: string; kind: string; schemaVersion: number; body: unknown }[] = [];
    const stored = (gen: number): StoredDocument[] =>
      created.map((file) => ({ path: file.path, schemaVersion: file.schemaVersion, kind: file.kind, body: file.body, revision: `${gen}:${file.sha256}`, sha256: file.sha256 }));
    try {
      for (const doc of docs) {
        const sha256 = sha256Json(doc.body);
        const requestId = `${generation}:${doc.path}:${sha256}`;
        const content = JSON.stringify({ schemaVersion: doc.schemaVersion, kind: doc.kind, body: doc.body } satisfies Envelope);
        const file = await this.createOnce(requestId, content, doc.path);
        created.push({ path: doc.path, fileId: file.id, sha256, kind: doc.kind, schemaVersion: doc.schemaVersion, body: doc.body });
      }
      const next: Catalog = {
        schemaVersion: 1,
        generation: generation + 1,
        entries: { ...this.catalog.entries },
      };
      for (const file of created) next.entries[file.path] = { fileId: file.fileId, sha256: file.sha256, kind: file.kind, schemaVersion: file.schemaVersion };
      const previousIds = docs.map((d) => this.catalog.entries[d.path]?.fileId).filter((id): id is string => !!id);
      const updated = await retryIdempotent(() => this.client.updateContent(this.catalogId, JSON.stringify(next), this.catalogEtag));
      this.catalog = next;
      this.catalogEtag = updated.etag;
      for (const id of previousIds) await this.client.trash(id).catch(() => undefined);
      return stored(next.generation);
    } catch (err) {
      // A lost response can still have committed. Trust the catalog if it already names these checksums.
      try {
        await this.reloadCatalog();
      } catch {
        // Drive is down; leave the new files in place (the old catalog still names the old files) and fail closed.
        throw new StorageUnavailableError("Google Drive didn't save the records.");
      }
      const committed = created.every((file) => this.catalog.entries[file.path]?.sha256 === file.sha256 && this.catalog.entries[file.path]?.fileId === file.fileId);
      if (committed) return stored(this.catalog.generation);
      for (const file of created) await this.client.trash(file.fileId).catch(() => undefined);
      if (err instanceof StorageConflictError) throw err;
      if (err instanceof DriveStatusError && err.status === 412) throw new StorageConflictError();
      if (err instanceof StorageUnavailableError) throw err;
      if (err instanceof DriveStatusError && isTransientStatus(err.status)) throw new StorageUnavailableError("Google Drive didn't save the records.");
      throw err;
    }
  }

  private async createOnce(requestId: string, content: string, path: string): Promise<DriveFileMeta> {
    const already = (await this.client.listByAppProperty("tourCoreRequest", requestId)).find((f) => f.parents.includes(this.folderId));
    if (already) return already;
    try {
      return await this.client.createFile({
        name: path.split("/").pop()!,
        parentId: this.folderId,
        content,
        appProperties: { tourCoreRequest: requestId, tourCorePath: path, tourCore: "1" },
      });
    } catch (err) {
      if (!(err instanceof DriveStatusError) || !isTransientStatus(err.status)) throw err;
      const again = (await this.client.listByAppProperty("tourCoreRequest", requestId)).find((f) => f.parents.includes(this.folderId));
      if (again) return again;
      throw new StorageUnavailableError("Google Drive didn't save the records.");
    }
  }

  async list(prefix = ""): Promise<StoredDocument[]> {
    await this.reloadCatalog();
    const paths = Object.keys(this.catalog.entries).filter((path) => path.startsWith(prefix));
    const docs = await Promise.all(paths.map((path) => this.readListed(path)));
    return docs.filter((doc): doc is StoredDocument => !!doc);
  }

  async delete(path: string, options?: { ifRevision?: string }): Promise<void> {
    await this.reloadCatalog();
    const current = this.catalog.entries[path];
    if (!current) return;
    const revision = `${this.catalog.generation}:${current.sha256}`;
    if (options?.ifRevision && options.ifRevision !== revision) throw new StorageConflictError();
    const next: Catalog = { schemaVersion: 1, generation: this.catalog.generation + 1, entries: { ...this.catalog.entries } };
    delete next.entries[path];
    try {
      const updated = await retryIdempotent(() => this.client.updateContent(this.catalogId, JSON.stringify(next), this.catalogEtag));
      this.catalog = next;
      this.catalogEtag = updated.etag;
      await this.client.trash(current.fileId).catch(() => undefined);
    } catch (err) {
      if (err instanceof DriveStatusError && err.status === 412) throw new StorageConflictError();
      if (err instanceof DriveStatusError && isTransientStatus(err.status)) throw new StorageUnavailableError();
      throw err;
    }
  }
}

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
export const GOOGLE_SCOPES = [DRIVE_FILE_SCOPE, DRIVE_EMAIL_SCOPE];

/** Narrowest practical scope: files Tour Core creates, plus the account email so the operator can see which Google account it is. */
export function googleScopeParam(): string {
  return GOOGLE_SCOPES.join(" ");
}
