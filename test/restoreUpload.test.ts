import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handoffIdFromPath } from "../src/backup/handoff";
import { RESTORE_UPLOAD_MAX_BYTES, restoreUploadTooLargeMessage } from "../src/backup/limits";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { installHarness, type InstallHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
const LIMIT_ENV = "TOURCORE_RESTORE_UPLOAD_MAX_BYTES";
afterEach(() => {
  delete process.env[LIMIT_ENV];
  cleanups.splice(0).forEach((run) => run());
});

const RESTORE_NOTE =
  "For you only. Do not show this link or capability to the operator. Upload the backup file once to this address. Then ask Tour Core to check it before anything changes. The link expires and is not a public restore address. A backup up to 50 MB is accepted. Every expired upload says to send the file again. Start a new upload with restore_records, action upload.";

function hosted(): InstallHarness {
  const h = installHarness({
    env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
  });
  cleanups.push(h.cleanup);
  h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  h.inst.files.setPublicBaseUrl("https://demo.up.railway.app", "RAILWAY");
  return h;
}

async function listen(h: InstallHarness): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createSetupServer({
    toolSurface: "all", workspace: new PropertyWorkspace(h.root), installation: h.inst, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function readResponse(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

/** POST a restore upload. `body` is sent in full. `declared` sets Content-Length without sending that many bytes. */
function postUpload(input: {
  port: number;
  path: string;
  capability: string;
  body?: Buffer;
  declared?: number;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tourcore-capability": input.capability,
    };
    if (input.declared !== undefined) headers["content-length"] = String(input.declared);
    else if (input.body) headers["content-length"] = String(input.body.length);
    const req = request(
      { host: "127.0.0.1", port: input.port, path: input.path, method: "POST", headers },
      (res) => {
        readResponse(res).then((body) => resolve({ status: res.statusCode ?? 0, body })).catch(reject);
      },
    );
    req.on("error", reject);
    if (input.body) req.end(input.body);
    else req.end();
  });
}

/** Chunked POST with no Content-Length, so the server has to count bytes. */
function postChunked(port: number, path: string, capability: string, total: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "x-tourcore-capability": capability },
      },
      (res) => {
        readResponse(res).then((body) => resolve({ status: res.statusCode ?? 0, body })).catch(reject);
      },
    );
    req.on("error", reject);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const write = () => {
      while (sent < total) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
          req.once("drain", write);
          return;
        }
      }
      req.end();
    };
    write();
  });
}

function handoffDir(root: string): string {
  return join(root, "portable-handoff");
}

/** Names in the upload directory. Incoming temps are written here too. */
function handoffNames(root: string): string[] {
  const dir = handoffDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/**
 * POST one chunk and leave the body open long enough to see a spool file.
 * The current route creates that file before it checks the link, then deletes
 * it once the body ends, so a check after the response would miss the write.
 */
function postWhileOpen(input: {
  port: number;
  path: string;
  capability: string;
  root: string;
}): Promise<{ status: number; body: string; newNames: string[]; newBytes: number }> {
  const before = new Set(handoffNames(input.root));
  const seen = new Map<string, number>();
  const scan = () => {
    const dir = handoffDir(input.root);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (before.has(name)) continue;
      let bytes = 0;
      try {
        bytes = statSync(join(dir, name)).size;
      } catch {
        bytes = seen.get(name) ?? 0;
      }
      seen.set(name, Math.max(seen.get(name) ?? 0, bytes));
    }
  };
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: "POST",
        headers: { "content-type": "application/json", "x-tourcore-capability": input.capability },
      },
      (res) => {
        readResponse(res)
          .then((body) => {
            scan();
            resolve({
              status: res.statusCode ?? 0,
              body,
              newNames: [...seen.keys()].sort(),
              newBytes: [...seen.values()].reduce((sum, n) => sum + n, 0),
            });
          })
          .catch(reject);
      },
    );
    req.on("error", reject);
    const timer = setInterval(scan, 5);
    const giveUp = setTimeout(() => {
      clearInterval(timer);
      req.destroy();
      reject(new Error("upload response timed out"));
    }, 5_000);
    req.write(Buffer.from("not-a-backup"));
    setTimeout(() => {
      clearInterval(timer);
      scan();
      req.end();
    }, 250);
    req.on("response", () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    });
  });
}

function expectZeroBytes(
  root: string,
  before: string[],
  posted: { status: number; body: string; newNames: string[]; newBytes: number },
): void {
  expect(posted.status).toBe(404);
  expect(posted.body).toBe("Not found");
  expect(posted.newNames).toEqual([]);
  expect(posted.newBytes).toBe(0);
  const after = handoffNames(root);
  expect(after.filter((name) => !before.includes(name))).toEqual([]);
  expect(after.some((name) => name.startsWith(".incoming") || name.endsWith(".tmp"))).toBe(false);
  expect(after.filter((name) => name.endsWith(".body"))).toEqual(before.filter((name) => name.endsWith(".body")));
}

describe("restore upload limit", () => {
  it("uploads a generated backup of about 12 MB, previews it, and imports it with replace", async () => {
    const origin = hosted();
    const propertyId = await origin.setUpAlfredWay();
    const configPath = join(origin.root, "properties", propertyId, "tourcore.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { property: { facts?: string[] } };
    const marker = "restore-marker-large-backup";
    const fact = marker + "a".repeat(12 * 1024 * 1024 - marker.length);
    config.property.facts = [fact];
    writeFileSync(configPath, JSON.stringify(config));

    const created = await origin.ok("create_portable_backup");
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const backupText = origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body;
    const bytes = Buffer.byteLength(backupText);
    expect(bytes).toBeGreaterThanOrEqual(12 * 1024 * 1024);
    expect(bytes).toBeLessThan(14 * 1024 * 1024);

    const occupied = hosted();
    const previousId = await occupied.setUpAlfredWay();
    const upload = await occupied.ok("begin_restore_upload");
    expect(upload.handoff.note).toBe(RESTORE_NOTE);
    expect(String(upload.handoff.note)).not.toContain("save it with the Google Drive connector");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    const app = await listen(occupied);
    cleanups.push(() => void app.close());
    const posted = await postUpload({
      port: app.port,
      path: String(upload.handoff.path),
      capability: String(upload.handoff.capability),
      body: Buffer.from(backupText),
    });
    expect(posted.status).toBe(200);
    expect(posted.body).toContain("Backup received");

    const preview = await occupied.ok("preview_portable_restore", { uploadId });
    expect(preview.summary).toMatch(/Backup contains:/);
    expect(preview.counts.properties).toBeGreaterThanOrEqual(1);
    expect(occupied.workspace.propertyIds()).toContain(previousId);
    const before = JSON.parse(readFileSync(join(occupied.root, "properties", previousId, "tourcore.config.json"), "utf8")) as { property: { facts?: string[] } };
    expect(before.property.facts?.some((fact) => fact.startsWith(marker)) ?? false).toBe(false);

    const asked = await occupied.ok("import_portable_backup", { uploadId, recovery: "replace" });
    expect(asked.requiresConfirmation).toBe(true);
    const restored = await occupied.ok("import_portable_backup", {
      uploadId,
      recovery: "replace",
      confirmationCode: asked.confirmationCode,
    });
    expect(restored.lines).toContain("Property records: restored");
    expect(occupied.workspace.propertyIds()).toContain(propertyId);

    const saved = JSON.parse(readFileSync(join(occupied.root, "properties", propertyId, "tourcore.config.json"), "utf8")) as {
      property: { id: string; name: string; facts: string[] };
      units: { name: string }[];
    };
    const source = (JSON.parse(backupText) as { contents: { files: Array<{ path: string; body: typeof saved }> } }).contents.files.find((file) =>
      file.path.endsWith("/tourcore.config.json"),
    )!.body;
    expect(saved.property.id).toBe(source.property.id);
    expect(saved.property.name).toBe(source.property.name);
    expect(saved.units.map((unit) => unit.name).sort()).toEqual(source.units.map((unit) => unit.name).sort());
    expect(saved.property.facts[0]?.startsWith(marker)).toBe(true);
    expect(saved.property.facts[0]).toHaveLength(fact.length);
    expect(createHash("sha256").update(saved.property.facts[0]!).digest("hex")).toBe(createHash("sha256").update(fact).digest("hex"));
  }, 180_000);

  it("returns 413 with the cap, not 502, when the upload is over the limit", async () => {
    const h = hosted();
    const app = await listen(h);
    cleanups.push(() => void app.close());

    const streamed = await h.ok("begin_restore_upload");
    const uploadId = String(streamed.handoff.path).split("/").pop()!;
    const posted = await postChunked(app.port, String(streamed.handoff.path), String(streamed.handoff.capability), RESTORE_UPLOAD_MAX_BYTES + 1);
    expect(posted.status).toBe(413);
    expect(posted.status).not.toBe(502);
    expect(posted.body).toBe("That file is too big to restore. Backups can be up to 50 MB, so check that it's the Tour Core backup file and try again.");
    expect(handoffNames(h.root).some((name) => name.startsWith(".incoming") || name.endsWith(".tmp"))).toBe(false);
    expect(existsSync(join(handoffDir(h.root), `${uploadId}.body`))).toBe(false);
    expect(await h.fails("preview_portable_restore", { uploadId })).toMatch(/Upload the backup/);

    const declared = await h.ok("begin_restore_upload");
    const byHeader = await postUpload({
      port: app.port,
      path: String(declared.handoff.path),
      capability: String(declared.handoff.capability),
      declared: RESTORE_UPLOAD_MAX_BYTES + 1,
    });
    expect(byHeader.status).toBe(413);
    expect(byHeader.status).not.toBe(502);
    expect(byHeader.body).toBe(restoreUploadTooLargeMessage(RESTORE_UPLOAD_MAX_BYTES));
  }, 120_000);

  it("before: a body over the old 1 MB cap is refused with 413, not a bare 502", async () => {
    process.env[LIMIT_ENV] = "1000000";
    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    const app = await listen(h);
    cleanups.push(() => void app.close());
    const posted = await postChunked(app.port, String(upload.handoff.path), String(upload.handoff.capability), 1_000_001);
    expect(posted.status).toBe(413);
    expect(posted.status).not.toBe(502);
    expect(posted.body).toBe("That file is too big to restore. Backups can be up to 1 MB, so check that it's the Tour Core backup file and try again.");
    expect(handoffNames(h.root).some((name) => name.startsWith(".incoming") || name.endsWith(".tmp"))).toBe(false);
    expect(existsSync(join(handoffDir(h.root), `${uploadId}.body`))).toBe(false);
    expect(await h.fails("preview_portable_restore", { uploadId })).toMatch(/Upload the backup/);
  });

  it("a bad capability writes zero bytes", async () => {
    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const app = await listen(h);
    cleanups.push(() => void app.close());
    const before = handoffNames(h.root);
    const posted = await postWhileOpen({
      port: app.port,
      path: String(upload.handoff.path),
      capability: "wrong-capability",
      root: h.root,
    });
    expectZeroBytes(h.root, before, posted);
  });

  it("an unknown id writes zero bytes", async () => {
    const h = hosted();
    const app = await listen(h);
    cleanups.push(() => void app.close());
    const before = handoffNames(h.root);
    expect(before).toEqual([]);
    const posted = await postWhileOpen({
      port: app.port,
      path: `/portable/uploads/art_${"b".repeat(24)}`,
      capability: "made-up-capability",
      root: h.root,
    });
    expectZeroBytes(h.root, before, posted);
    expect(existsSync(handoffDir(h.root))).toBe(false);
  });

  it("an expired link writes zero bytes", async () => {
    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    const path = join(handoffDir(h.root), `${uploadId}.json`);
    const opened = JSON.parse(readFileSync(path, "utf8")) as { expiresAt: number; body?: string; bodyFile?: boolean };
    expect(opened.body).toBeUndefined();
    expect(opened.bodyFile).toBeUndefined();
    writeFileSync(path, JSON.stringify({ ...opened, expiresAt: h.now() - 1 }, null, 2) + "\n");
    const app = await listen(h);
    cleanups.push(() => void app.close());
    const before = handoffNames(h.root);
    const posted = await postWhileOpen({
      port: app.port,
      path: String(upload.handoff.path),
      capability: String(upload.handoff.capability),
      root: h.root,
    });
    expectZeroBytes(h.root, before, posted);
  });

  it("a second upload writes zero bytes", async () => {
    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    const app = await listen(h);
    cleanups.push(() => void app.close());
    const first = await postUpload({
      port: app.port,
      path: String(upload.handoff.path),
      capability: String(upload.handoff.capability),
      body: Buffer.from('{"ok":true}\n'),
    });
    expect(first.status).toBe(200);
    const before = handoffNames(h.root);
    expect(before).toContain(`${uploadId}.body`);
    const posted = await postWhileOpen({
      port: app.port,
      path: String(upload.handoff.path),
      capability: String(upload.handoff.capability),
      root: h.root,
    });
    expectZeroBytes(h.root, before, posted);
  });
});

describe("expired upload tombstone id", () => {
  it("reads the upload id from a Windows-style handoff path so its body is dropped", () => {
    const id = "art_abcdefghijklmnopqrstuvwx";
    expect(handoffIdFromPath(`C:\\Users\\owner\\TourCore\\portable-handoff\\${id}.json`)).toBe(id);
    expect(handoffIdFromPath(`/home/owner/TourCore/portable-handoff/${id}.json`)).toBe(id);
  });
});
