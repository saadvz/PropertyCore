import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { DeploymentMode } from "../../install/deployment";
import { assistantProfile, CHATGPT_REDIRECT_HOST, CLAUDE_REDIRECT_HOST, MUSE_REDIRECT_HOST } from "../../cleaner-core/assistant";
import { cleanerMultiTenant } from "../../cleaner-core/flag";
import { isPrivateAddress } from "../../net/addresses";

/**
 * Which OAuth clients may be sent an authorization code, and where. Grok
 * registers itself (RFC 7591 Dynamic Client Registration) with redirect URIs
 * on its own hosts; a client using a Client ID Metadata Document names its
 * redirect URIs there. Either way every redirect URI must pass the same rule:
 * https on an allowed host, or a loopback address (RFC 8252 native apps).
 * Nothing else: no wildcards, custom schemes, fragments or credentials. The
 * one opt-in exception is a short list of exact URIs (Grok legacy compat).
 */

/** Grok's hosts. Extend with TOURCORE_OAUTH_REDIRECT_HOSTS (comma-separated). Subdomains are included. */
export const DEFAULT_REDIRECT_HOSTS = ["grok.com", "x.ai", "x.com"];
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The callbacks Grok Bot (through Cursor's MCP client) was seen registering
 * that the strict rule refuses. Accepted only as these exact strings.
 * (Its third callback, http://localhost:8787/callback, is loopback and
 * already allowed.)
 *
 * Precedence for whether this list is active:
 * 1. TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true forces it on in every mode.
 * 2. TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false forces it off, including
 *    HOSTED_RAILWAY_P0. Only that exact word (ignoring case and surrounding
 *    space) is an explicit disable. "1" and "yes" are not.
 * 3. Otherwise HOSTED_RAILWAY_P0 is on. LOCAL_DEVELOPER and SELF_HOSTED stay
 *    off. GROK_MANAGED_P0 stays off here; its bootstrap still turns the flag
 *    on unless --strict-oauth was used.
 */
export const GROK_LEGACY_REDIRECT_URIS = ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback"] as const;

export interface RedirectPolicy {
  /** https hosts (and their subdomains). */
  hosts: string[];
  /** Individual redirect URIs allowed by exact string match, outside the host rule. */
  exact: readonly string[];
}

/** TOURCORE_GROK_LEGACY_OAUTH_COMPAT, trimmed and in lower case. */
const legacyCompatSetting = (env: NodeJS.ProcessEnv) => env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT?.trim().toLowerCase();

/** True only when the variable is exactly `true`. Does not apply the hosted default. */
export const grokLegacyCompatFromEnv = (env: NodeJS.ProcessEnv = process.env) => legacyCompatSetting(env) === "true";

/**
 * Whether the narrow legacy callback list is active.
 * Explicit true/false wins. HOSTED_RAILWAY_P0 is on when the variable is unset
 * or set to anything other than false.
 */
export function grokLegacyCompatEnabled(env: NodeJS.ProcessEnv = process.env, mode?: DeploymentMode): boolean {
  const raw = legacyCompatSetting(env);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return mode === "HOSTED_RAILWAY_P0";
}

/** Startup line for the hosted service. Undefined when this mode has nothing to say. */
export function hostedCompatStartupLine(env: NodeJS.ProcessEnv, mode: DeploymentMode | undefined): string | undefined {
  if (mode !== "HOSTED_RAILWAY_P0") return undefined;
  if (grokLegacyCompatEnabled(env, mode)) return "Grok legacy OAuth compatibility active for HOSTED_RAILWAY_P0.";
  if (legacyCompatSetting(env) === "false") return "Grok legacy OAuth compatibility is off (TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false).";
  return undefined;
}

export function redirectHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.TOURCORE_OAUTH_REDIRECT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter((h) => /^[a-z0-9.-]+$/.test(h) && h.includes("."));
  // A Cleaner Core deployment set to Claude, ChatGPT, or Muse takes that chat's connector callback without extra config.
  const own = assistantProfile(env).redirectHost;
  // A multi-tenant Cleaner Core serves every chat at once.
  const all = cleanerMultiTenant(env) ? [CLAUDE_REDIRECT_HOST, CHATGPT_REDIRECT_HOST, MUSE_REDIRECT_HOST] : [];
  return [...new Set([...DEFAULT_REDIRECT_HOSTS, ...(own ? [own] : []), ...all, ...extra])];
}

export function redirectPolicyFor(env: NodeJS.ProcessEnv = process.env, mode?: DeploymentMode): RedirectPolicy {
  return { hosts: redirectHostsFromEnv(env), exact: grokLegacyCompatEnabled(env, mode) ? GROK_LEGACY_REDIRECT_URIS : [] };
}

/** Env-only policy. HOSTED_RAILWAY_P0's default is applied by redirectPolicyFor. */
export function redirectPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RedirectPolicy {
  return redirectPolicyFor(env);
}

/** scheme, host and path only. Query, fragment and credentials are left out so logs can use this. */
export function redirectLogParts(uri: string): { scheme: string; host: string; path: string } {
  try {
    const url = new URL(uri);
    return { scheme: url.protocol.replace(/:$/, ""), host: (url.host || "-").toLowerCase(), path: url.pathname || "/" };
  } catch {
    return { scheme: "?", host: "-", path: "-" };
  }
}

export const strictPolicy = (hosts: string[] = DEFAULT_REDIRECT_HOSTS): RedirectPolicy => ({ hosts, exact: [] });

const hostAllowed = (hostname: string, hosts: string[]) => hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));

export interface RedirectProblem {
  uri: string;
  reason: string;
  /** For logs: the URI's parts without its query or fragment. */
  scheme?: string;
  host?: string;
  path?: string;
}

/** Undefined when the redirect URI is acceptable; otherwise why not. */
export function checkRedirectUri(uri: string, policy: RedirectPolicy, applicationType?: "web" | "native"): RedirectProblem | undefined {
  if (typeof uri === "string" && policy.exact.includes(uri)) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(uri);
  } catch {
    // Reported below as not a web address.
  }
  const parts: Pick<RedirectProblem, "scheme" | "host" | "path"> = url ? { scheme: url.protocol.replace(/:$/, ""), host: url.host.toLowerCase() || undefined, path: url.pathname || "/" } : {};
  const problem = (reason: string): RedirectProblem => ({ uri, reason, ...parts });
  const hosts = policy.hosts;
  if (typeof uri !== "string" || !uri || uri.length > 2000) return problem("isn't a web address");
  if (uri.includes("*")) return problem("uses a wildcard");
  if (!url) return problem("isn't a web address");
  if (url.hash || uri.includes("#")) return problem("has a fragment");
  if (url.username || url.password) return problem("contains credentials");
  const hostname = url.hostname.toLowerCase();
  if (url.protocol === "http:") {
    if (!LOOPBACK.has(hostname)) return problem("isn't https");
    if (applicationType === "web") return problem("is a loopback address, which a web client can't use");
    return undefined;
  }
  if (url.protocol !== "https:") return problem(url.protocol === "cursor:" ? "uses a custom scheme (cursor://)" : "isn't https");
  if (!hostAllowed(hostname, hosts)) return problem("isn't on an allowed host");
  return undefined;
}

export class ClientMetadataError extends Error {
  constructor(
    readonly code: "invalid_redirect_uri" | "invalid_client_metadata",
    message: string,
    /** Every refused redirect URI in the request, not just the first. */
    readonly redirects: RedirectProblem[] = [],
  ) {
    super(message);
  }
}

const GRANTS = new Set(["authorization_code", "refresh_token"]);
export const AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);

type Metadata = Record<string, unknown>;
const stringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * RFC 7591 / OpenID registration checks the SDK's schema doesn't make
 * (it strips application_type and accepts any grant or auth method).
 * Returns the metadata with RFC 7591 defaults filled in.
 */
export function checkClientMetadata(body: unknown, policy: RedirectPolicy, allowedAuthMethods: Set<string> = AUTH_METHODS): Metadata {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientMetadataError("invalid_client_metadata", "Client metadata must be a JSON object.");
  const m = body as Metadata;
  if (m.application_type !== undefined && m.application_type !== "web" && m.application_type !== "native") {
    throw new ClientMetadataError("invalid_client_metadata", "application_type must be web or native.");
  }
  const appType = m.application_type as "web" | "native" | undefined;
  if (!stringArray(m.redirect_uris) || !(m.redirect_uris as string[]).length) throw new ClientMetadataError("invalid_redirect_uri", "redirect_uris must list at least one address.");
  if ((m.redirect_uris as string[]).length > 10) throw new ClientMetadataError("invalid_redirect_uri", "Too many redirect_uris.");
  // One bad URI refuses the whole registration (never silently dropped), but every bad one is reported.
  const refused = (m.redirect_uris as string[]).map((uri) => checkRedirectUri(uri, policy, appType)).filter((p): p is RedirectProblem => !!p);
  if (refused.length) throw new ClientMetadataError("invalid_redirect_uri", `redirect_uri ${refused[0]!.reason}.`, refused);
  const asked = m.grant_types === undefined ? ["authorization_code"] : m.grant_types;
  if (!stringArray(asked) || !(asked as string[]).includes("authorization_code")) {
    throw new ClientMetadataError("invalid_client_metadata", "grant_types must be authorization_code, optionally with refresh_token.");
  }
  // Grants this server never issues are dropped, not refused (RFC 7591 §3.2.1 lets a server
  // pare a client's metadata down). Claude's published identity also lists jwt-bearer.
  const grantTypes = (asked as string[]).filter((g) => GRANTS.has(g));
  const responseTypes = m.response_types === undefined ? ["code"] : m.response_types;
  if (!stringArray(responseTypes) || (responseTypes as string[]).length !== 1 || (responseTypes as string[])[0] !== "code") {
    throw new ClientMetadataError("invalid_client_metadata", "response_types must be code.");
  }
  const authMethod = m.token_endpoint_auth_method === undefined ? "client_secret_basic" : m.token_endpoint_auth_method;
  if (typeof authMethod !== "string" || !allowedAuthMethods.has(authMethod)) {
    throw new ClientMetadataError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${[...allowedAuthMethods].join(", ")}.`);
  }
  if (m.client_name !== undefined && (typeof m.client_name !== "string" || m.client_name.length > 200)) {
    throw new ClientMetadataError("invalid_client_metadata", "client_name must be a short string.");
  }
  return { ...m, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: authMethod };
}

// ---- Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document) ----

export const isMetadataDocumentClientId = (clientId: string) => /^https:\/\//i.test(clientId);

/** The client_id URL itself: https, a real path, and a public host (the server fetches it, so no internal addresses). */
export function checkMetadataDocumentUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError("invalid_client_metadata", "client_id isn't a valid URL.");
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password || url.href !== clientId || /\/\.\.?(\/|$)/.test(url.pathname)) {
    throw new ClientMetadataError("invalid_client_metadata", "client_id must be an https URL with a path.");
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ClientMetadataError("invalid_client_metadata", "client_id must be on a public host.");
  }
  return url;
}

const MAX_DOCUMENT_BYTES = 5 * 1024;
const NOT_PUBLIC = "client_id must resolve to a public address.";
const NOT_FETCHED = "The client metadata document couldn't be fetched.";
const TOO_LARGE = "The client metadata document is too large.";

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolve: Resolve = (host) => lookup(host, { all: true });

/**
 * The socket's own DNS lookup: it resolves once and refuses the connection if any
 * address is internal, so the address that was checked is the one connected to.
 */
export function publicOnlyLookup(resolve: Resolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        const addresses = options.family === 4 || options.family === 6 ? found.filter((a) => a.family === options.family) : found;
        if (!addresses.length || found.some((a) => isPrivateAddress(a.address))) {
          callback(new ClientMetadataError("invalid_client_metadata", NOT_PUBLIC) as NodeJS.ErrnoException, "", 0);
        } else if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      () => callback(new ClientMetadataError("invalid_client_metadata", NOT_PUBLIC) as NodeJS.ErrnoException, "", 0),
    );
  };
}

/** Reads a stream as UTF-8, or gives undefined (and stops reading) once it passes max bytes. */
export function readCapped(stream: Readable, max: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > max) {
        stream.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(bytes);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
    stream.on("close", () => reject(new Error("closed before the end")));
  });
}

/** Fetches a Client ID Metadata Document with SSRF guards: public addresses only (checked at connect), no redirects, 5 KB, 5 seconds. */
export async function fetchMetadataDocument(clientId: string, deps: { resolve?: Resolve } = {}): Promise<unknown> {
  const url = checkMetadataDocumentUrl(clientId);
  const text = await new Promise<string>((resolve, reject) => {
    const fail = (message: string) => reject(new ClientMetadataError("invalid_client_metadata", message));
    const req = request(url, {
      headers: { Accept: "application/json", "User-Agent": "property-core" },
      lookup: publicOnlyLookup(deps.resolve ?? systemResolve),
      signal: AbortSignal.timeout(5000),
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 299) {
        req.destroy();
        return fail(NOT_FETCHED);
      }
      if (Number(res.headers["content-length"] ?? 0) > MAX_DOCUMENT_BYTES) {
        req.destroy();
        return fail(TOO_LARGE);
      }
      readCapped(res, MAX_DOCUMENT_BYTES).then((body) => (body === undefined ? fail(TOO_LARGE) : resolve(body)), () => fail(NOT_FETCHED));
    });
    req.on("error", (err) => (err instanceof ClientMetadataError ? reject(err) : fail(NOT_FETCHED)));
    req.end();
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientMetadataError("invalid_client_metadata", "The client metadata document isn't JSON.");
  }
}

/** Validates a fetched document. Such clients have no shared secret with Tour Core, so only public-client auth ("none") is accepted. */
export function parseMetadataDocument(clientId: string, document: unknown, policy: RedirectPolicy): OAuthClientInformationFull {
  checkMetadataDocumentUrl(clientId);
  const doc = document as Metadata;
  if (!doc || typeof doc !== "object" || doc.client_id !== clientId) throw new ClientMetadataError("invalid_client_metadata", "The metadata document's client_id doesn't match its URL.");
  if (doc.client_secret !== undefined || doc.client_secret_expires_at !== undefined) {
    throw new ClientMetadataError("invalid_client_metadata", "A client metadata document can't carry a client secret.");
  }
  // A client may prefer a stronger method but list "none" among those it supports (ChatGPT's does).
  // A metadata-document client shares no secret with this server, so "none" is the only method it can use here.
  const supported = (doc as { token_endpoint_auth_methods_supported?: unknown }).token_endpoint_auth_methods_supported;
  const publicToo = Array.isArray(supported) && supported.includes("none");
  const checked = checkClientMetadata({ ...doc, token_endpoint_auth_method: publicToo ? "none" : (doc.token_endpoint_auth_method ?? "none") }, policy, new Set(["none"]));
  return {
    client_id: clientId,
    client_name: typeof doc.client_name === "string" ? doc.client_name : undefined,
    client_uri: typeof doc.client_uri === "string" ? doc.client_uri : undefined,
    redirect_uris: checked.redirect_uris as string[],
    grant_types: checked.grant_types as string[],
    response_types: checked.response_types as string[],
    token_endpoint_auth_method: "none",
  };
}
