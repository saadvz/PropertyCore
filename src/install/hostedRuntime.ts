import type { DeploymentMode } from "./deployment";
import { allowEphemeralStorage, pathIsInside } from "./persistentVolume";

/**
 * HOSTED_RAILWAY_P0 runtime decisions. Railway injects PORT and
 * RAILWAY_PUBLIC_DOMAIN. Tour Core does not call the Railway API.
 *
 * P0 persistence: a Railway volume mounted at /data (or
 * RAILWAY_VOLUME_MOUNT_PATH). The container disk is wiped on every deploy.
 * For HOSTED_P0_VOLUME the volume is the live operational store, including
 * secrets. Portable backups live in the user's Google Drive, not here.
 */

const TRYCLOUDFLARE = /trycloudflare\.com/i;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;

export interface HostedUrl {
  url?: string;
  problem?: string;
}

/** https://<RAILWAY_PUBLIC_DOMAIN>. The variable is a hostname, not a URL. */
export function railwayHttpsBase(domain: string | undefined): HostedUrl {
  const raw = domain?.trim().toLowerCase();
  if (!raw) return {};
  if (raw.includes("://") || raw.includes("/") || raw.includes(" ") || TRYCLOUDFLARE.test(raw)) {
    return { problem: "RAILWAY_PUBLIC_DOMAIN must be the Railway hostname, such as example.up.railway.app." };
  }
  if (!HOSTNAME.test(raw)) return { problem: "RAILWAY_PUBLIC_DOMAIN isn't a valid hostname." };
  return { url: `https://${raw}` };
}

function httpsBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * Explicit PUBLIC_BASE_URL wins. Otherwise https://RAILWAY_PUBLIC_DOMAIN.
 * A saved manifest address is only a fallback, and a quick-tunnel address
 * is never accepted in this mode.
 */
export function resolveHostedPublicUrl(env: NodeJS.ProcessEnv, recorded?: string): HostedUrl {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  if (explicit) {
    if (TRYCLOUDFLARE.test(explicit)) return { problem: "HOSTED_RAILWAY_P0 cannot use a trycloudflare address." };
    const url = httpsBase(explicit);
    if (!url) return { problem: "PUBLIC_BASE_URL must be an https address." };
    return { url };
  }
  const fromRailway = railwayHttpsBase(env.RAILWAY_PUBLIC_DOMAIN);
  if (fromRailway.url || fromRailway.problem) return fromRailway;
  if (recorded) {
    if (TRYCLOUDFLARE.test(recorded)) return { problem: "The saved public address is a quick tunnel. Set RAILWAY_PUBLIC_DOMAIN." };
    const url = httpsBase(recorded);
    if (url) return { url };
  }
  return { problem: "Set RAILWAY_PUBLIC_DOMAIN or PUBLIC_BASE_URL to the hosted https address." };
}

export function containsQuickTunnel(value: string | undefined): boolean {
  return !!value && TRYCLOUDFLARE.test(value);
}

/** Railway health checks call this host. It is not the public site. */
export const RAILWAY_HEALTHCHECK_HOST = "healthcheck.railway.app";

export function listenHost(mode: DeploymentMode): "0.0.0.0" | "127.0.0.1" {
  return mode === "HOSTED_RAILWAY_P0" ? "0.0.0.0" : "127.0.0.1";
}

export function listenPort(env: NodeJS.ProcessEnv, mode: DeploymentMode, fallback = 4321): { port: number } | { problem: string } {
  if (mode !== "HOSTED_RAILWAY_P0") return { port: fallback };
  const raw = env.PORT?.trim();
  if (!raw) return { problem: "HOSTED_RAILWAY_P0 requires PORT. Railway sets it; do not default to 4321." };
  if (!/^\d+$/.test(raw)) return { problem: `PORT "${raw}" isn't a valid port.` };
  const port = Number(raw);
  if (port < 1 || port > 65535) return { problem: `PORT "${raw}" isn't a valid port.` };
  return { port };
}

/**
 * Where hosted secrets and cache live. Prefer the Railway volume. Refuse to
 * start on the default relative folder, which does not survive a deploy.
 */
export function hostedStateDir(env: NodeJS.ProcessEnv): { dir: string } | { problem: string } {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const home = env.TOURCORE_HOME?.trim();
  const allow = allowEphemeralStorage(env);
  if (mount && home && !pathIsInside(home, mount) && !allow) {
    return { problem: "TOURCORE_HOME must be on the Railway volume (RAILWAY_VOLUME_MOUNT_PATH). The container disk is not durable." };
  }
  const dir = home || mount;
  if ((!dir || dir === "tourcore-data") && !allow) {
    return { problem: "HOSTED_RAILWAY_P0 needs a Railway volume mounted at /data. Set TOURCORE_HOME to that mount. That volume is the live operational store. The container filesystem is wiped on deploy." };
  }
  return { dir: dir || "tourcore-data" };
}

export interface HostedConfig {
  ok: true;
  port: number;
  host: "0.0.0.0";
  publicUrl: string;
  dataDir: string;
}

/** Everything that must be true before the hosted process listens. No secret values. */
export function validateHostedConfig(env: NodeJS.ProcessEnv, recordedUrl?: string): HostedConfig | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const port = listenPort(env, "HOSTED_RAILWAY_P0");
  if ("problem" in port) problems.push(port.problem);
  const url = resolveHostedPublicUrl(env, recordedUrl);
  if (!url.url) problems.push(url.problem ?? "No public https address.");
  if (url.url && containsQuickTunnel(url.url)) problems.push("HOSTED_RAILWAY_P0 cannot use a trycloudflare address.");
  const data = hostedStateDir(env);
  if ("problem" in data) problems.push(data.problem);
  if (problems.length || !url.url || !("port" in port) || !("dir" in data)) return { ok: false, problems };
  return { ok: true, port: port.port, host: "0.0.0.0", publicUrl: url.url, dataDir: data.dir };
}

export interface StartupFacts {
  version: string;
  mode: string;
  port: number;
  host: string;
  publicHost?: string;
  storage: string;
}

/** Lines for the host log. Caller redacts credentials before printing. */
export function startupLines(facts: StartupFacts): string[] {
  return [
    `Tour Core ${facts.version}`,
    `deployment mode ${facts.mode}`,
    `listening on ${facts.host}:${facts.port}`,
    `public host ${facts.publicHost ?? "not set"}`,
    `storage ${facts.storage}`,
  ];
}

/** What the hosted service is: Tour Core's one-owner demo, or the shared service of many hosts (CLEANER_CORE_MULTI_TENANT). */
export function hostedTenancyLine(multiTenant: boolean): string {
  return multiTenant
    ? "Hosted Railway P0 is multi-tenant: each host's account is kept apart, and /admin manages them."
    : "Hosted Railway P0 is single-tenant. Marketplace publication requires tenant isolation.";
}

/** How a chat connects to the hosted service, and what its Allow page asks. */
export function hostedConnectLine(mcpUrl: string, multiTenant: boolean): string {
  return multiTenant
    ? `Chats connect at ${mcpUrl}. The Allow page takes a host's invite code from /admin, or a sign-in when sign-up is on.`
    : `Grok connects at ${mcpUrl}. The first Allow on the authorization page claims this demo.`;
}

export function redactSecrets(text: string, secrets: string[]): string {
  return secrets.filter((secret) => secret.length >= 6).reduce((out, secret) => out.split(secret).join("[hidden]"), text);
}

/** Paths every external integration must share. */
export function externalUrls(publicBaseUrl: string) {
  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    mcp: `${base}/mcp`,
    sendblueWebhook: `${base}/webhooks/sendblue`,
    verify: (token: string) => `${base}/verify/${token}`,
    googleCallback: `${base}/google/oauth/callback`,
    approval: `${base}/connect`,
    secureSetup: `${base}/install`,
  };
}
