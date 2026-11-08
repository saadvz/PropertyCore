import { DriveStatusError, type DriveClient, type DriveFileMeta } from "./googleDrive";
import { isTransientStatus } from "./errors";

/**
 * Google Drive API v3 over HTTPS. Uses drive.file: Tour Core can see files
 * it created (or that were opened with it), not the rest of the user's Drive.
 * This client never calls the permissions API, so new files stay private.
 */

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,parents,etag,trashed,appProperties,shared";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export class HttpDriveClient implements DriveClient {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
  ) {}

  private async request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, attempt = 0): Promise<{ status: number; text: string }> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    const text = await res.text();
    if (isTransientStatus(res.status) && attempt < 2 && init.method !== "POST") {
      return this.request(url, init, attempt + 1);
    }
    return { status: res.status, text };
  }

  private meta(body: Record<string, unknown>): DriveFileMeta {
    return {
      id: String(body.id),
      name: String(body.name ?? ""),
      mimeType: String(body.mimeType ?? ""),
      parents: Array.isArray(body.parents) ? body.parents.map(String) : [],
      etag: String(body.etag ?? ""),
      trashed: body.trashed === true,
      appProperties: (body.appProperties as Record<string, string>) ?? {},
      shared: body.shared === true,
    };
  }

  async createFolder(input: { name: string; parentId?: string; appProperties: Record<string, string> }): Promise<DriveFileMeta> {
    const res = await this.request(`${DRIVE}/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, mimeType: FOLDER, appProperties: input.appProperties, ...(input.parentId ? { parents: [input.parentId] } : {}) }),
    });
    if (res.status !== 200) throw new DriveStatusError(res.status, "Drive folder wasn't created.");
    return this.meta(JSON.parse(res.text) as Record<string, unknown>);
  }

  async createFile(input: { name: string; parentId: string; content: string; appProperties: Record<string, string> }): Promise<DriveFileMeta> {
    const boundary = "tourcore";
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
      name: input.name,
      parents: [input.parentId],
      mimeType: "application/json",
      appProperties: input.appProperties,
    })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${input.content}\r\n--${boundary}--`;
    const res = await this.request(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (res.status !== 200) throw new DriveStatusError(res.status, "Drive file wasn't created.");
    return this.meta(JSON.parse(res.text) as Record<string, unknown>);
  }

  async readFile(id: string): Promise<{ meta: DriveFileMeta; content: string }> {
    const metaRes = await this.request(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${FIELDS}`);
    if (metaRes.status !== 200) throw new DriveStatusError(metaRes.status, "Drive file wasn't read.");
    const media = await this.request(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`);
    if (media.status !== 200) throw new DriveStatusError(media.status, "Drive file wasn't read.");
    return { meta: this.meta(JSON.parse(metaRes.text) as Record<string, unknown>), content: media.text };
  }

  async updateContent(id: string, content: string, ifMatch: string): Promise<DriveFileMeta> {
    const boundary = "tourcore";
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ mimeType: "application/json" })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await this.request(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=multipart&fields=${FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "If-Match": ifMatch },
      body,
    });
    if (res.status === 412) throw new DriveStatusError(412, "precondition failed");
    if (res.status !== 200) throw new DriveStatusError(res.status, "Drive file wasn't updated.");
    return this.meta(JSON.parse(res.text) as Record<string, unknown>);
  }

  async trash(id: string): Promise<void> {
    const res = await this.request(`${DRIVE}/files/${encodeURIComponent(id)}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    if (res.status !== 200) throw new DriveStatusError(res.status, "Drive file wasn't removed.");
  }

  async listByAppProperty(key: string, value: string): Promise<DriveFileMeta[]> {
    const q = `appProperties has { key='${key}' and value='${value}' } and trashed=false`;
    const res = await this.request(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(${FIELDS})&pageSize=100`);
    if (res.status !== 200) throw new DriveStatusError(res.status, "Drive didn't list files.");
    const body = JSON.parse(res.text) as { files?: Record<string, unknown>[] };
    return (body.files ?? []).map((file) => this.meta(file));
  }
}
