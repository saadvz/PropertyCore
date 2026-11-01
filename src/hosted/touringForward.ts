import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { tenantFolder } from "../cleaner-core/hosted/registry";
import type { HostedRequest } from "../cleaner-core/hosted/router";
import { formParams, twilioSignature } from "../messaging/twilio/signature";
import { LOCAL_WEBHOOK_PATH } from "../messaging/local/provider";
import { TWILIO_WEBHOOK_PATH } from "../messaging/twilio/provider";
import { WORKER_CLIENT_HEADER, WORKER_CLIENT_NAMES, WORKER_INTERNAL_HEADER, WORKER_KEY_HEADER } from "./ipc";

/**
 * How the shared service reaches one touring process on loopback: MCP calls after OAuth, the links
 * Tour Core handed out under /t/<id>/, and texts to the tenant's number. A text is saved before it is
 * forwarded and removed only once the process took it, so a crash in between replays it once; the
 * process's inbound ledger drops a repeat by its MessageSid.
 */

export interface WorkerTarget {
  port: number;
  key: string;
}

/** Never forwarded: hop-by-hop headers, the caller's own credentials, and any key a caller made up. */
const DROPPED = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "authorization", "cookie", "content-length", WORKER_KEY_HEADER, WORKER_INTERNAL_HEADER, WORKER_CLIENT_HEADER]);

function forwardedHeaders(headers: IncomingHttpHeaders, key: string, assistant?: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out[WORKER_KEY_HEADER] = key;
  const client = assistant ? WORKER_CLIENT_NAMES[assistant] : undefined;
  if (client) out[WORKER_CLIENT_HEADER] = client;
  return out;
}

/** Sends one request to the process and streams its answer back. 503 when the process can't be reached. */
async function relay(target: WorkerTarget, r: HostedRequest, path: string, headers: Record<string, string | string[]>, read?: Buffer): Promise<void> {
  const body = r.method === "GET" || r.method === "HEAD" ? undefined : (read ?? (await r.readRaw()));
  await new Promise<void>((resolve) => {
    const upstream = request(
      { host: "127.0.0.1", port: target.port, path, method: r.method, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } },
      (res) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined && !["connection", "keep-alive", "transfer-encoding"].includes(name)) out[name] = value;
        }
        r.res.writeHead(res.statusCode ?? 502, out);
        res.pipe(r.res);
        res.on("end", resolve);
        res.on("error", () => resolve());
      },
    );
    upstream.on("error", () => {
      if (!r.res.headersSent) r.send(503, "application/json; charset=utf-8", JSON.stringify({ error: { message: "Touring isn't answering right now. Try again in a minute." } }));
      else r.res.end();
      resolve();
    });
    // A caller that goes away (an SSE stream closed) ends the upstream request too.
    r.res.on("close", () => upstream.destroy());
    if (body) upstream.write(body);
    upstream.end();
  });
}

/**
 * An MCP call for a touring tenant. The process's own key is the bearer; the caller's token never
 * leaves the service. `body` is the request body when the service already read it. `assistant` is
 * the chat its sign-in recorded.
 */
export function forwardMcp(target: WorkerTarget, r: HostedRequest, body?: Buffer, assistant?: string): Promise<void> {
  const headers = forwardedHeaders(r.req.headers, target.key, assistant);
  headers.authorization = `Bearer ${target.key}`;
  return relay(target, r, `/mcp${r.url.search}`, headers, body);
}

/** One MCP POST to the process, answered whole, so the service can add to it. Undefined when it can't be reached. */
export function callWorkerMcp(target: WorkerTarget, body: Buffer, headers: IncomingHttpHeaders = {}, assistant?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer } | undefined> {
  const sent = forwardedHeaders(headers, target.key, assistant);
  sent.authorization = `Bearer ${target.key}`;
  sent["content-type"] = "application/json";
  sent.accept = "application/json, text/event-stream";
  sent["content-length"] = String(body.length);
  return new Promise((resolve) => {
    const upstream = request({ host: "127.0.0.1", port: target.port, path: "/mcp", method: "POST", headers: sent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", () => resolve(undefined));
    });
    upstream.on("error", () => resolve(undefined));
    upstream.write(body);
    upstream.end();
  });
}

/** A link under /t/<id>/: `rest` is the path after the prefix, as the process knows it. */
export function forwardTenantPath(target: WorkerTarget, r: HostedRequest, rest: string): Promise<void> {
  return relay(target, r, `${rest}${r.url.search}`, forwardedHeaders(r.req.headers, target.key));
}

/** Texts for a touring tenant, saved until its process takes them. */
export class TouringInbox {
  constructor(
    private readonly dataRoot: string,
    private readonly now: () => Date,
  ) {}

  private folder(tenantId: string): string {
    return join(tenantFolder(this.dataRoot, tenantId), "tour-core-inbound");
  }

  /** Writes the raw Twilio form. Returns its path. */
  save(tenantId: string, raw: Buffer): string {
    const folder = this.folder(tenantId);
    mkdirSync(folder, { recursive: true });
    const sid = (formParams(raw).MessageSid ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64) || "nosid";
    const stamp = String(this.now().getTime()).padStart(15, "0");
    const path = join(folder, `${stamp}-${sid}.form`);
    const temp = `${path}.tmp`;
    writeFileSync(temp, raw, { mode: 0o600 });
    renameSync(temp, path);
    return path;
  }

  done(path: string): void {
    rmSync(path, { force: true });
  }

  /** A text the process refused: kept beside the queue as `.refused`, so it never blocks the texts behind it. */
  refuse(path: string): void {
    try {
      renameSync(path, `${path}.refused`);
    } catch {
      rmSync(path, { force: true });
    }
  }

  /** Drops every waiting text for the tenant. Returns how many. */
  clear(tenantId: string): number {
    const waiting = this.pending(tenantId);
    for (const path of waiting) rmSync(path, { force: true });
    return waiting.length;
  }

  /** Saved texts, oldest first. */
  pending(tenantId: string): string[] {
    const folder = this.folder(tenantId);
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => name.endsWith(".form"))
      .sort()
      .map((name) => join(folder, name));
  }
}

/**
 * Posts a text to the process's Twilio webhook, signed again with the shared token over the address
 * the process expects (its public base under /t/<id>), so its own signature check runs unchanged.
 */
export async function deliverText(target: WorkerTarget, origin: string, tenantId: string, raw: Buffer, authToken: string, options: { scratch?: boolean } = {}): Promise<boolean> {
  return (await handOver(target, origin, tenantId, raw, authToken, options)) === "taken";
}

/** Taken (2xx), refused by the process (4xx: it will never take it), or down (unreachable or 5xx: try again later). */
type HandOver = "taken" | "refused" | "down";

function handOver(target: WorkerTarget, origin: string, tenantId: string, raw: Buffer, authToken: string, options: { scratch?: boolean } = {}): Promise<HandOver> {
  const fields = formParams(raw);
  // A Scratch tenant's process texts through the local test outbox, so the text goes in that provider's shape.
  const local = options.scratch ? Buffer.from(JSON.stringify({ id: fields.MessageSid, from: fields.From, to: fields.To, text: fields.Body ?? "" })) : undefined;
  const signedUrl = `${origin.replace(/\/+$/, "")}/t/${tenantId}${TWILIO_WEBHOOK_PATH}`;
  const body = local ?? raw;
  const headers = local
    ? { "content-type": "application/json", "content-length": String(body.length), [WORKER_KEY_HEADER]: target.key }
    : { "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length), "x-twilio-signature": twilioSignature(authToken, signedUrl, fields), [WORKER_KEY_HEADER]: target.key };
  return new Promise((resolve) => {
    const upstream = request(
      { host: "127.0.0.1", port: target.port, path: local ? LOCAL_WEBHOOK_PATH : TWILIO_WEBHOOK_PATH, method: "POST", headers },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 500;
        res.on("end", () => resolve(status >= 200 && status < 300 ? "taken" : status >= 400 && status < 500 ? "refused" : "down"));
      },
    );
    upstream.on("error", () => resolve("down"));
    upstream.write(body);
    upstream.end();
  });
}

/**
 * Hands saved texts to the process, oldest first. A text `screen` turns away (an opt-out since it
 * arrived) is dropped; one the process refuses is moved aside; it stops when the process is down.
 * `taken` hears each text that went through.
 */
export async function replayInbox(
  inbox: TouringInbox,
  target: WorkerTarget,
  origin: string,
  tenantId: string,
  authToken: string,
  options: { scratch?: boolean; screen?: (raw: Buffer) => Promise<boolean>; taken?: (raw: Buffer) => void } = {},
): Promise<void> {
  for (const path of inbox.pending(tenantId)) {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      continue;
    }
    if (options.screen && !(await options.screen(raw))) {
      inbox.done(path);
      continue;
    }
    const result = await handOver(target, origin, tenantId, raw, authToken, options);
    if (result === "down") return;
    if (result === "refused") inbox.refuse(path);
    else {
      inbox.done(path);
      options.taken?.(raw);
    }
  }
}

/** One internal JSON call to the process: what's live, or the stand-down. Undefined when it can't be reached. */
export function workerJson<T>(target: WorkerTarget, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T } | undefined> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    const upstream = request(
      {
        host: "127.0.0.1",
        port: target.port,
        path,
        method,
        headers: { [WORKER_KEY_HEADER]: target.key, [WORKER_INTERNAL_HEADER]: target.key, ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 502, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as T });
          } catch {
            resolve(undefined);
          }
        });
        res.on("error", () => resolve(undefined));
      },
    );
    upstream.on("error", () => resolve(undefined));
    if (payload) upstream.write(payload);
    upstream.end();
  });
}
