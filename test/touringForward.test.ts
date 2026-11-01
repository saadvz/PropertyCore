import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedRequest } from "../src/cleaner-core/hosted/router";
import { WORKER_CLIENT_HEADER } from "../src/hosted/ipc";
import { deliverText, forwardMcp, forwardTenantPath, replayInbox, TouringInbox } from "../src/hosted/touringForward";
import { Installation } from "../src/install/installation";
import { readSendblueEnv } from "../src/messaging/sendblue/runtime";
import { setTwilioClient } from "../src/messaging/twilio/provider";
import { PropertyWorkspace } from "../src/setup/workspace";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer, WORKER_KEY_HEADER } from "../src/web/server";

/** Forwarding from the shared service to one touring process. Only 555 numbers; Twilio is faked. */

const ORIGIN = "https://shared.up.railway.app";
const LANE = "tnt_lane000001";
const LANE_NUMBER = "+15555550150";
const AUTH = "shared-twilio-auth-token";
const KEY = "k-forward-test-key-0123456789abcdef";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

const form = (fields: Record<string, string>) => Buffer.from(new URLSearchParams(fields).toString());
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

/** A real touring process, in this test's process, on loopback. */
async function realWorker() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-forward-"));
  const env: NodeJS.ProcessEnv = {
    TOURCORE_DEPLOYMENT_MODE: "TENANT_WORKER",
    TOURCORE_WORKER_KEY: KEY,
    PUBLIC_BASE_URL: `${ORIGIN}/t/${LANE}`,
    TOURCORE_MESSAGING_PROVIDER: "twilio",
    TOURCORE_TWILIO_ACCOUNT_SID: "ACforward",
    TOURCORE_TWILIO_AUTH_TOKEN: AUTH,
    TOURCORE_TWILIO_PHONE_NUMBER: LANE_NUMBER,
  };
  const restoreTwilio = setTwilioClient(() => ({ sendSms: async () => ({ sid: "SMfake", status: "queued" }) }) as never);
  let inst!: Installation;
  inst = new Installation({ root, runtime: new FileRuntimeStore(join(root, "runtime")), env: () => env, sendblueEnv: () => readSendblueEnv(inst.env()) });
  const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation: inst, log: () => {} });
  const port = await listen(server);
  cleanups.push(() => {
    server.close();
    restoreTwilio();
    rmSync(root, { recursive: true, force: true });
  });
  return { port, key: KEY };
}

/** A stand-in touring process that records what it got. It can go down and come back on the same port. */
async function stubWorker() {
  const received: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      res.end(JSON.stringify({ ok: true }));
    });
  };
  let server = createServer(handler);
  const port = await listen(server);
  cleanups.push(() => server.close());
  return {
    target: { port, key: KEY },
    received,
    down: () => new Promise<void>((resolve) => server.close(() => resolve())),
    up: async () => {
      server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    },
  };
}

/** A front door that hands each request to `handle` as the shared service's router would. */
async function front(handle: (r: HostedRequest) => Promise<void>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const r: HostedRequest = {
      req,
      res,
      url,
      method: req.method ?? "GET",
      send: (status, type, body, extra = {}) => {
        res.writeHead(status, { "Content-Type": type, ...extra });
        res.end(body);
      },
      readRaw: () =>
        new Promise((resolve) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
        }),
      readCapped: async () => undefined,
    };
    void handle(r);
  });
  const port = await listen(server);
  cleanups.push(() => server.close());
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; text: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      req.on("error", reject);
      if (init.body) req.write(init.body);
      req.end();
    });
}

describe("texts to a touring process", () => {
  it("hands a text to the worker with a signature the worker accepts", async () => {
    const w = await realWorker();
    const raw = form({ MessageSid: "SM1", From: "+15555550177", To: LANE_NUMBER, Body: "Tour", SmsStatus: "received" });
    expect(await deliverText(w, ORIGIN, LANE, raw, AUTH)).toBe(true);
  });

  it("is refused by the worker when signed with another token", async () => {
    const w = await realWorker();
    const raw = form({ MessageSid: "SM2", From: "+15555550177", To: LANE_NUMBER, Body: "Tour", SmsStatus: "received" });
    expect(await deliverText(w, ORIGIN, LANE, raw, "some-other-token")).toBe(false);
  });

  it("keeps a text the worker didn't take, and replays it once", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-inbox-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const inbox = new TouringInbox(root, () => new Date("2026-10-30T12:00:00Z"));
    const stub = await stubWorker();
    const raw = form({ MessageSid: "SM3", From: "+15555550177", To: LANE_NUMBER, Body: "Tour" });
    const path = inbox.save(LANE, raw);
    expect(path.startsWith(join(root, "tenants", LANE, "tour-core-inbound"))).toBe(true);
    await stub.down();
    expect(await deliverText(stub.target, ORIGIN, LANE, raw, AUTH)).toBe(false);
    expect(inbox.pending(LANE)).toEqual([path]);
    await stub.up();
    await replayInbox(inbox, stub.target, ORIGIN, LANE, AUTH);
    await replayInbox(inbox, stub.target, ORIGIN, LANE, AUTH);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]!.body).toBe(raw.toString());
    expect(existsSync(path)).toBe(false);
  });

  it("replays saved texts oldest first and stops at the first one the worker refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-inbox-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let at = Date.parse("2026-10-30T12:00:00Z");
    const inbox = new TouringInbox(root, () => new Date(at));
    const first = inbox.save(LANE, form({ MessageSid: "SMa", Body: "1" }));
    at += 1000;
    const second = inbox.save(LANE, form({ MessageSid: "SMb", Body: "2" }));
    expect(inbox.pending(LANE)).toEqual([first, second]);
    const stub = await stubWorker();
    await replayInbox(inbox, stub.target, ORIGIN, LANE, AUTH);
    expect(stub.received.map((r) => new URLSearchParams(r.body).get("Body"))).toEqual(["1", "2"]);
    expect(readdirSync(join(root, "tenants", LANE, "tour-core-inbound"))).toEqual([]);
  });
});

describe("the saved-text queue", () => {
  async function refusingStub(refuse: (body: string) => boolean) {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(body);
        res.writeHead(refuse(body) ? 400 : 200);
        res.end();
      });
    });
    const port = await listen(server);
    cleanups.push(() => server.close());
    return { target: { port, key: KEY }, received };
  }

  function inboxWith(...bodies: string[]) {
    const root = mkdtempSync(join(tmpdir(), "tourcore-inbox-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let at = Date.parse("2026-10-30T12:00:00Z");
    const inbox = new TouringInbox(root, () => new Date((at += 1000)));
    const paths = bodies.map((body, i) => inbox.save(LANE, form({ MessageSid: `SMq${i}`, From: "+15555550177", To: LANE_NUMBER, Body: body })));
    return { inbox, paths };
  }

  it("moves a text the process refuses aside and hands over the ones behind it", async () => {
    const { inbox } = inboxWith("bad", "good");
    const stub = await refusingStub((body) => new URLSearchParams(body).get("Body") === "bad");
    await replayInbox(inbox, stub.target, ORIGIN, LANE, AUTH);
    expect(stub.received.map((b) => new URLSearchParams(b).get("Body"))).toEqual(["bad", "good"]);
    expect(inbox.pending(LANE)).toEqual([]);
  });

  it("drops a saved text the screen turns away, without handing it over", async () => {
    const { inbox } = inboxWith("from someone who opted out", "fine");
    const stub = await refusingStub(() => false);
    await replayInbox(inbox, stub.target, ORIGIN, LANE, AUTH, { screen: async (raw) => new URLSearchParams(raw.toString()).get("Body") === "fine" });
    expect(stub.received.map((b) => new URLSearchParams(b).get("Body"))).toEqual(["fine"]);
    expect(inbox.pending(LANE)).toEqual([]);
  });

  it("empties a tenant's queue on request", () => {
    const { inbox } = inboxWith("one", "two");
    expect(inbox.clear(LANE)).toBe(2);
    expect(inbox.pending(LANE)).toEqual([]);
  });
});

describe("links and calls to a touring process", () => {
  it("forwards a visitor identity link under /t/<id>/ to the worker's own path", async () => {
    const w = await realWorker();
    const call = await front((r) => forwardTenantPath(w, r, r.url.pathname.replace(`/t/${LANE}`, "")));
    const page = await call(`/t/${LANE}/verify/abcdefghijklmnop`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("<html");
  });

  it("never forwards the caller's bearer token or cookie, and adds the worker key", async () => {
    const stub = await stubWorker();
    const call = await front((r) => forwardTenantPath(stub.target, r, "/api/verify/abc"));
    await call(`/t/${LANE}/api/verify/abc?x=1`, { method: "POST", headers: { authorization: "Bearer caller-token", cookie: "a=b", "content-type": "application/json" }, body: "{}" });
    const got = stub.received[0]!;
    expect(got.path).toBe("/api/verify/abc?x=1");
    expect(got.headers.authorization).toBeUndefined();
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers[WORKER_KEY_HEADER]).toBe(KEY);
    expect(got.body).toBe("{}");
  });

  it("forwards an MCP call with the worker key as the bearer, and passes the session id both ways", async () => {
    const stub = await stubWorker();
    const call = await front((r) => forwardMcp(stub.target, r));
    const reply = await call("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer caller-token", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "sess-0" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["mcp-session-id"]).toBe("sess-1");
    const got = stub.received[0]!;
    expect(got.path).toBe("/mcp");
    expect(got.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(got.headers[WORKER_KEY_HEADER]).toBe(KEY);
    expect(got.headers["mcp-session-id"]).toBe("sess-0");
    expect(got.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });

  it("names the chat its sign-in recorded, and never one a caller made up", async () => {
    const stub = await stubWorker();
    const call = await front((r) => forwardMcp(stub.target, r, undefined, "grok"));
    const forged = await front((r) => forwardMcp(stub.target, r));
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", [WORKER_CLIENT_HEADER]: "Claude" };
    await call("/mcp", { method: "POST", headers, body });
    await forged("/mcp", { method: "POST", headers, body });
    expect(stub.received[0]!.headers[WORKER_CLIENT_HEADER]).toBe("Grok");
    expect(stub.received[1]!.headers[WORKER_CLIENT_HEADER]).toBeUndefined();
  });

  it("answers 503 when the worker can't be reached", async () => {
    const stub = await stubWorker();
    await stub.down();
    const call = await front((r) => forwardMcp(stub.target, r));
    const reply = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(reply.status).toBe(503);
  });
});
