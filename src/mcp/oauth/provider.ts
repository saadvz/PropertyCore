import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
  TemporarilyUnavailableError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkRedirectUri, ClientMetadataError, fetchMetadataDocument, isMetadataDocumentClientId, parseMetadataDocument, redirectLogParts, type RedirectPolicy } from "./clients";
import { consentPage, PAGE_HEADERS, problemPage } from "./pages";
import { hashSecret, newSecret, type OAuthGrantStore } from "./store";
import { assistantForRedirect, type CleanerAssistant } from "../../cleaner-core/assistant";
import type { InviteRefusal } from "../../cleaner-core/hosted/registry";

/**
 * Tour Core's authorization server, behind the official MCP SDK's OAuth
 * handlers (which do the protocol parsing, PKCE S256 verification, error
 * responses and rate limits). This class decides the Tour Core parts: which
 * clients exist, that the owner approved on the Tour Core computer, what the
 * tokens are for and how long they last.
 *
 * It only answers "may this client call Tour Core's operator tools?".
 * Consequential actions still need Tour Core's own confirmation codes.
 */

export const OPERATOR_SCOPE = "tourcore.operator";
/** Cleaner Core's own scope. Its grants open only /mcp/cleaner-core. */
export const CLEANER_SCOPE = "cleanercore.operator";
export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
export const APPROVAL_MAX_SECONDS = 90 * 24 * 60 * 60;
export const CODE_SECONDS = 5 * 60;
export const REQUEST_SECONDS = 10 * 60;
const MAX_PENDING = 10;
const METADATA_CACHE_MS = 5 * 60_000;

export interface OAuthEndpoints {
  /** PUBLIC_BASE_URL's origin. Also the `iss` value. */
  issuer: string;
  /** Canonical MCP server URI (RFC 8707 audience). */
  resource: string;
  resourceMetadataUrl: string;
}

export function endpointsFor(publicBaseUrl: string, mcpPath: string): OAuthEndpoints {
  const origin = new URL(publicBaseUrl).origin;
  return { issuer: origin, resource: `${origin}${mcpPath}`, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${mcpPath}` };
}

export type ResourceLabel = "Tour Core" | "Cleaner Core" | "Tour Core and Cleaner Core";

/** One protected MCP resource on this authorization server, with its own scope. */
export interface OAuthResource {
  path: string;
  scope: string;
  label: ResourceLabel;
  /** Unset means always on. Off means no metadata, no approvals and no tokens for it. */
  enabled?: () => boolean;
}

/** The endpoints of one active resource. */
export interface ResourceEndpoints extends OAuthEndpoints {
  path: string;
  scope: string;
  label: ResourceLabel;
}

/**
 * Accepts the canonical URI (case-insensitive scheme/host, optional trailing
 * slash). The bare origin also names the default resource (Tour Core's /mcp),
 * never another one.
 */
function sameResource(given: string | URL, ep: OAuthEndpoints, isDefault: boolean): boolean {
  try {
    const url = new URL(given.toString());
    if (url.hash || url.search) return false;
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return normalized === ep.resource || (isDefault && normalized === ep.issuer);
  } catch {
    return false;
  }
}

export interface ApprovalRequestView {
  id: string;
  matchCode: string;
  clientName: string;
  clientId: string;
  redirectHost: string;
  createdAt: number;
  expiresAt: number;
  /** Which resource the client asked for. */
  label: ResourceLabel;
}

interface ApprovalRequest extends ApprovalRequestView {
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  issuer: string;
  resource: string;
  resourcePath: string;
  status: "pending" | "approved" | "denied";
  /** Multi-tenant Cleaner Core: set when the host's invite code was accepted. */
  tenantId?: string;
}

interface CodeEntry {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  issuer: string;
  resource: string;
  expiresAt: number;
  used: boolean;
  grantId?: string;
  tenantId?: string;
  assistant?: CleanerAssistant;
}

/** Multi-tenant Cleaner Core: invite codes on the Allow page decide which tenant a grant belongs to. */
export interface InviteBook {
  /** Uses the invite up when it is good. */
  claim(code: string): { tenantId: string } | { refused: InviteRefusal };
  /** The grant now exists. */
  connected(tenantId: string, grantId: string, assistant: CleanerAssistant): void;
  /** The words for each refusal. */
  refusal(reason: InviteRefusal): string;
}

export interface ProviderOptions {
  store: OAuthGrantStore;
  /** One per active resource; the first is the default (Tour Core's /mcp). Undefined without a public address. */
  endpoints: () => ResourceEndpoints[] | undefined;
  redirectPolicy: () => RedirectPolicy;
  now?: () => number;
  /** Fetches a Client ID Metadata Document. Tests replace the network here. */
  fetchClientMetadata?: (clientId: string) => Promise<unknown>;
  /** A new approval is waiting. */
  onApprovalRequest?: (request: ApprovalRequestView) => void;
  /** HOSTED_RAILWAY_P0 refuses a second operator client, per resource. Other modes allow everyone through. */
  tenantPolicy?: (clientId: string, resourcePath: string) => { allowed: true } | { allowed: false; message: string };
  /** Called once when the owner approves. Used to bind that resource's hosted owner. */
  onOwnerApproved?: (clientId: string, resourcePath: string) => void;
  /** Where the human clicks Allow. */
  approvalPlace?: () => "computer" | "hosted";
  /**
   * HOSTED_RAILWAY_P0 only. The public authorization page may approve this
   * client when the demo is unclaimed, or when this client is already the owner.
   * Unrelated clients are refused. Other deployment modes leave this unset.
   */
  publicApproval?: (clientId: string, resourcePath: string) => boolean;
  /** True after the first hosted Allow has bound an owner client for that resource. */
  hostedClaimed?: (resourcePath: string) => boolean;
  /** Which chat Cleaner Core's approval page names. Unset is Grok. */
  cleanerAssistant?: () => CleanerAssistant;
  /** Set on a multi-tenant Cleaner Core. Cleaner Core approvals then need an invite code. */
  invites?: InviteBook;
  log?: (line: string) => void;
}

function codesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given.replace(/\s+/g, ""));
  const b = Buffer.from(expected.replace(/\s+/g, ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const matchCode = () => {
  const n = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return `${n.slice(0, 3)} ${n.slice(3)}`;
};
/** Where a redirect goes, for people and logs: the host for web addresses, scheme and host for an app (cursor://...). */
const hostOf = (uri: string) => {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
};
/** scheme://host/path with no query: safe to log. */
const redirectForLog = (uri: string) => {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unreadable)";
  }
};

export class TourCoreOAuthProvider implements OAuthServerProvider {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly codes = new Map<string, CodeEntry>();
  private readonly metadataCache = new Map<string, { client: OAuthClientInformationFull; until: number }>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: ProviderOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** The default resource's endpoints (Tour Core's /mcp). Its issuer is every resource's issuer. */
  private defaultEndpoints(): ResourceEndpoints | undefined {
    return this.options.endpoints()?.[0];
  }

  /**
   * Which active resource a request names. No resource: the one whose scope
   * was asked for, else the default. The bare origin is the default only.
   * Undefined when it names nothing this server protects.
   */
  private resourceFor(given: string | URL | undefined, scopes: string[] = []): ResourceEndpoints | undefined {
    const all = this.options.endpoints() ?? [];
    if (given === undefined) return all.find((ep) => scopes.includes(ep.scope)) ?? all[0];
    return all.find((ep, i) => sameResource(given, ep, i === 0));
  }

  /** The active resource a code or grant was issued for, matched exactly, and whether it is the default (Tour Core). */
  private resourceOf(issuer: string, resource: string): { ep: ResourceEndpoints; isDefault: boolean } | undefined {
    const all = this.options.endpoints() ?? [];
    const i = all.findIndex((ep) => ep.issuer === issuer && ep.resource === resource);
    return i < 0 ? undefined : { ep: all[i]!, isDefault: i === 0 };
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client as OAuthClientInformationFull),
    };
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (typeof clientId !== "string" || !clientId || clientId.length > 2000) return undefined;
    if (isMetadataDocumentClientId(clientId)) return this.metadataDocumentClient(clientId);
    const ep = this.defaultEndpoints();
    const stored = this.options.store.getClient(clientId);
    // Registrations belong to one authorization server: a new tunnel address means registering again.
    if (!stored || !ep || stored.issuer !== ep.issuer) return undefined;
    return stored.info;
  }

  private async metadataDocumentClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.metadataCache.get(clientId);
    if (cached && cached.until > this.now()) return cached.client;
    try {
      const document = await (this.options.fetchClientMetadata ?? fetchMetadataDocument)(clientId);
      const client = parseMetadataDocument(clientId, document, this.options.redirectPolicy());
      this.metadataCache.set(clientId, { client, until: this.now() + METADATA_CACHE_MS });
      return client;
    } catch (err) {
      const why = err instanceof ClientMetadataError ? err.message : "it couldn't be fetched";
      this.log(`Refused an OAuth client metadata document from ${hostOf(clientId)}: ${why}`);
      return undefined;
    }
  }

  /** Called by the SDK's registration handler after Tour Core's metadata checks. The secret is stored hashed and returned once. */
  private async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const ep = this.defaultEndpoints();
    if (!ep) throw new ServerError("Tour Core's public address isn't set.");
    const secret = client.client_secret;
    this.options.store.putClient({
      info: { ...client, ...(secret ? { client_secret: hashSecret(secret) } : {}) },
      issuer: ep.issuer,
      registeredAt: this.now(),
    });
    this.log(
      `An MCP client registered for Tour Core access: ${client.client_name ?? "unnamed"} (redirects: ${client.redirect_uris.map(redirectForLog).join(", ")}; ` +
        `${client.token_endpoint_auth_method === "none" ? "public client" : `authenticates with ${client.token_endpoint_auth_method}`}; refresh tokens ${client.grant_types?.includes("refresh_token") ? "requested" : "not requested"}).`,
    );
    const exact = this.options.redirectPolicy().exact;
    for (const uri of client.redirect_uris) {
      if (!exact.includes(uri)) continue;
      const parts = redirectLogParts(uri);
      this.log(`accepted redirect: scheme=${parts.scheme} host=${parts.host} path=${parts.path} reason: known Grok legacy callback`);
    }
    return client;
  }

  // ---- Authorization: an approval request the owner answers on the Tour Core computer ----

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.defaultEndpoints()) throw new TemporarilyUnavailableError("Tour Core's public address isn't set.");
    // Registered redirect URIs are re-checked here too, in case the allowed hosts changed since registration.
    const redirectProblem = checkRedirectUri(params.redirectUri, this.options.redirectPolicy());
    if (redirectProblem) {
      this.log(`Refused an authorization request: its redirect ${redirectForLog(params.redirectUri)} isn't allowed any more (was compatibility mode turned off?).`);
      this.log(`  refused redirect: scheme=${redirectProblem.scheme ?? "?"} host=${redirectProblem.host ?? "-"} path=${redirectProblem.path ?? "-"} reason: ${redirectProblem.reason}`);
      res.status(400).set(PAGE_HEADERS).type("html").send(problemPage("Tour Core can't send you back there", "The app that sent you here asked to return to an address Tour Core doesn't allow. Nothing was approved."));
      return;
    }
    // The SDK requires S256 but accepts any string; a real S256 challenge is 43 base64url characters.
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError("code_challenge must be an S256 challenge.");
    const ep = this.resourceFor(params.resource, params.scopes);
    if (!ep) throw new InvalidTargetError("That resource isn't this Tour Core's MCP server.");
    const tenant = this.options.tenantPolicy?.(client.client_id, ep.path);
    if (tenant && !tenant.allowed) {
      const cleaner = ep.label === "Cleaner Core";
      // The multi-tenant Cleaner Core service refuses Tour Core; the hosted Tour Core demo refuses a second account.
      const title = cleaner ? "Cleaner Core isn't available here" : this.options.invites ? "Tour Core isn't on this service" : "This Tour Core demo is already in use";
      this.log(cleaner || this.options.invites ? `Refused a connection: ${title}.` : "Refused a connection from a second account. This hosted demo is single-tenant.");
      res.status(403).set(PAGE_HEADERS).type("html").send(problemPage(title, tenant.message));
      return;
    }
    this.prune();
    if ([...this.requests.values()].filter((r) => r.status === "pending").length >= MAX_PENDING) {
      throw new TemporarilyUnavailableError("Too many connection requests are waiting. Try again in a few minutes.");
    }
    const t = this.now();
    const request: ApprovalRequest = {
      id: randomBytes(24).toString("base64url"),
      matchCode: matchCode(),
      clientName: (client.client_name || "An MCP client").slice(0, 80),
      clientId: client.client_id,
      redirectHost: hostOf(params.redirectUri),
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      // One scope per resource. Other requested scopes are ignored, never granted (RFC 6749 §3.3); the token response says what was granted.
      scopes: [ep.scope],
      issuer: ep.issuer,
      resource: ep.resource,
      resourcePath: ep.path,
      label: ep.label,
      createdAt: t,
      expiresAt: t + REQUEST_SECONDS * 1000,
      status: "pending",
    };
    this.requests.set(request.id, request);
    this.log(`Authorization request from ${request.clientName}${ep.label === "Tour Core" ? "" : ` for ${ep.label}`}: will return to ${redirectForLog(request.redirectUri)}.`);
    this.options.onApprovalRequest?.(this.view(request));
    const hosted = this.options.approvalPlace?.() === "hosted";
    res.status(200).set(PAGE_HEADERS).type("html").send(consentPage({
      requestId: request.id,
      matchCode: request.matchCode,
      clientName: request.clientName,
      redirectHost: request.redirectHost,
      hosted,
      firstClaim: hosted && !this.options.invites && !(this.options.hostedClaimed?.(ep.path) ?? false),
      label: ep.label,
      // On the multi-tenant service every address takes an invite code.
      ...(this.options.invites
        ? { assistant: assistantForRedirect(request.redirectUri), invite: true }
        : ep.label === "Cleaner Core" && this.options.cleanerAssistant
          ? { assistant: this.options.cleanerAssistant() }
          : {}),
    }));
  }

  /**
   * Human Allow on the hosted authorization page. Registration and a bearer
   * token cannot call this. A second client is refused by publicApproval.
   */
  approveFromBrowser(id: string, matchCodeGiven: string): boolean {
    this.prune();
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return false;
    if (!this.options.publicApproval?.(request.clientId, request.resourcePath)) return false;
    // On the multi-tenant service, only an invite code says whose this connection is.
    if (this.options.invites) return false;
    if (!codesMatch(matchCodeGiven, request.matchCode)) return false;
    return this.decide(id, "approved");
  }

  /**
   * Allow with the invite code from the multi-tenant Cleaner Core's page. The match code is checked
   * first, then the invite is used up and the request remembers its tenant.
   */
  approveWithInvite(id: string, matchCodeGiven: string, inviteCode: string): { ok: true } | { ok: false; message: string } {
    const invites = this.options.invites;
    const refused = { ok: false as const, message: "That connection can't be approved from here." };
    if (!invites) return refused;
    this.prune();
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return refused;
    if (!codesMatch(matchCodeGiven, request.matchCode)) return refused;
    const claim = invites.claim(inviteCode);
    if ("refused" in claim) {
      this.log(`Refused a Cleaner Core approval: the invite code was ${claim.refused}.`);
      return { ok: false, message: invites.refusal(claim.refused) };
    }
    request.tenantId = claim.tenantId;
    if (!this.decide(id, "approved")) return refused;
    this.log(`A Cleaner Core approval used an invite for ${claim.tenantId}.`);
    return { ok: true };
  }

  /** Pending, already decided, expired, or not a request this process has. */
  requestDisposition(id: string): "pending" | "used" | "expired" | "missing" {
    const request = this.requests.get(id);
    if (!request) return "missing";
    if (request.expiresAt <= this.now()) {
      this.requests.delete(id);
      return "expired";
    }
    return request.status === "pending" ? "pending" : "used";
  }

  private view(r: ApprovalRequest): ApprovalRequestView {
    return { id: r.id, matchCode: r.matchCode, clientName: r.clientName, clientId: r.clientId, redirectHost: r.redirectHost, createdAt: r.createdAt, expiresAt: r.expiresAt, label: r.label };
  }

  private prune(): void {
    const t = this.now();
    for (const [id, r] of this.requests) if (r.expiresAt <= t) this.requests.delete(id);
    // Used codes are remembered a while longer so a replay can still be caught.
    for (const [h, c] of this.codes) if (c.expiresAt + (c.used ? 60 * 60_000 : 0) <= t) this.codes.delete(h);
  }

  pendingRequests(): ApprovalRequestView[] {
    this.prune();
    return [...this.requests.values()].filter((r) => r.status === "pending").map((r) => this.view(r));
  }

  /** Only the Tour Core computer's own address reaches this (the local operator app). */
  decide(id: string, decision: "approved" | "denied"): boolean {
    this.prune();
    const r = this.requests.get(id);
    if (!r || r.status !== "pending") return false;
    r.status = decision;
    if (decision === "approved") this.options.onOwnerApproved?.(r.clientId, r.resourcePath);
    this.log(decision === "approved" ? `Approved ${r.clientName}'s access to ${r.label}.` : `Denied ${r.clientName}'s request to connect to ${r.label}.`);
    return true;
  }

  /** The browser that started the request may only ever say no. */
  denyFromBrowser(id: string): boolean {
    return this.decide(id, "denied");
  }

  requestStatus(id: string): "pending" | "approved" | "denied" | "expired" {
    this.prune();
    return this.requests.get(id)?.status ?? "expired";
  }

  /**
   * Finishes a decided request exactly once: the redirect back to the client
   * with a single-use code (or access_denied), the state echoed and `iss`
   * (RFC 9207) set. Undefined while pending or once used/expired.
   */
  finish(id: string): string | undefined {
    this.prune();
    const r = this.requests.get(id);
    if (!r || r.status === "pending") return undefined;
    this.requests.delete(id);
    const url = new URL(r.redirectUri);
    if (r.status === "approved") {
      const code = newSecret("tcc_");
      this.codes.set(hashSecret(code), {
        clientId: r.clientId,
        clientName: r.clientName,
        redirectUri: r.redirectUri,
        codeChallenge: r.codeChallenge,
        scopes: r.scopes,
        issuer: r.issuer,
        resource: r.resource,
        expiresAt: this.now() + CODE_SECONDS * 1000,
        used: false,
        ...(r.tenantId ? { tenantId: r.tenantId, assistant: assistantForRedirect(r.redirectUri) } : {}),
      });
      url.searchParams.set("code", code);
    } else {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "The Tour Core owner didn't approve this connection.");
    }
    if (r.state !== undefined) url.searchParams.set("state", r.state);
    url.searchParams.set("iss", r.issuer);
    return url.href;
  }

  // ---- Tokens ----

  /** A code presented twice is treated as stolen: the tokens it produced are revoked (OAuth 2.1 §4.1.3). */
  private liveCode(client: OAuthClientInformationFull, code: string): CodeEntry {
    const hash = hashSecret(String(code));
    const entry = this.codes.get(hash);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("The authorization code isn't valid.");
    if (entry.used) {
      if (entry.grantId) this.options.store.revokeGrant(entry.grantId);
      this.codes.delete(hash);
      this.log("An authorization code was used twice; the access it produced was revoked.");
      throw new InvalidGrantError("The authorization code was already used.");
    }
    if (entry.expiresAt <= this.now()) {
      this.codes.delete(hash);
      throw new InvalidGrantError("The authorization code has expired.");
    }
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.liveCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    // The SDK has already checked the PKCE verifier against challengeForAuthorizationCode.
    const entry = this.liveCode(client, authorizationCode);
    entry.used = true;
    const target = this.resourceOf(entry.issuer, entry.resource);
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError("redirect_uri doesn't match the authorization request.");
    if (!target) throw new InvalidGrantError("Tour Core's public address changed; connect again.");
    if (resource && !sameResource(resource, target.ep, target.isDefault)) throw new InvalidTargetError("That resource isn't this Tour Core's MCP server.");
    const t = this.now();
    const access = newSecret("tca_");
    const refresh = client.grant_types?.includes("refresh_token") ? newSecret("tcr_") : undefined;
    const approvalEnds = t + APPROVAL_MAX_SECONDS * 1000;
    const grant = this.options.store.addGrant({
      clientId: client.client_id,
      clientName: entry.clientName,
      issuer: entry.issuer,
      resource: entry.resource,
      scopes: entry.scopes,
      createdAt: t,
      expiresAt: approvalEnds,
      accessHash: hashSecret(access),
      accessExpiresAt: t + ACCESS_TOKEN_SECONDS * 1000,
      ...(refresh ? { refreshHash: hashSecret(refresh), refreshExpiresAt: Math.min(approvalEnds, t + REFRESH_TOKEN_SECONDS * 1000) } : {}),
      ...(entry.tenantId && entry.assistant ? { tenantId: entry.tenantId, assistant: entry.assistant } : {}),
    });
    entry.grantId = grant.id;
    if (entry.tenantId && entry.assistant) this.options.invites?.connected(entry.tenantId, grant.id, entry.assistant);
    return this.tokens(access, refresh, grant.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const found = this.options.store.findByRefreshHash(hashSecret(String(refreshToken)));
    if (!found || found.grant.clientId !== client.client_id) throw new InvalidGrantError("The refresh token isn't valid.");
    const { grant } = found;
    if (found.retired) {
      this.options.store.revokeGrant(grant.id);
      this.log("A refresh token that had already been replaced was used again; that Grok access was revoked. Reconnect Grok if this was you.");
      throw new InvalidGrantError("The refresh token isn't valid.");
    }
    if (!client.grant_types?.includes("refresh_token")) throw new UnauthorizedClientError("This client didn't register for refresh tokens.");
    const t = this.now();
    if ((grant.refreshExpiresAt ?? 0) <= t || grant.expiresAt <= t) {
      this.options.store.revokeGrant(grant.id);
      throw new InvalidGrantError("The refresh token has expired; connect again.");
    }
    const target = this.resourceOf(grant.issuer, grant.resource);
    if (!target) throw new InvalidGrantError("Tour Core's public address changed; connect again.");
    if (resource && !sameResource(resource, target.ep, target.isDefault)) throw new InvalidTargetError("That resource isn't this Tour Core's MCP server.");
    if (scopes?.length && scopes.some((s) => !grant.scopes.includes(s))) throw new InvalidScopeError("A refresh can't add scopes.");
    const access = newSecret("tca_");
    const refresh = newSecret("tcr_");
    const rotated = this.options.store.rotate(grant.id, {
      accessHash: hashSecret(access),
      accessExpiresAt: Math.min(grant.expiresAt, t + ACCESS_TOKEN_SECONDS * 1000),
      refreshHash: hashSecret(refresh),
      refreshExpiresAt: Math.min(grant.expiresAt, t + REFRESH_TOKEN_SECONDS * 1000),
    });
    if (!rotated) throw new InvalidGrantError("The refresh token isn't valid.");
    return this.tokens(access, refresh, rotated.scopes, Math.round((rotated.accessExpiresAt - t) / 1000));
  }

  private tokens(access: string, refresh: string | undefined, scopes: string[], expiresIn = ACCESS_TOKEN_SECONDS): OAuthTokens {
    return { access_token: access, token_type: "Bearer", expires_in: expiresIn, scope: scopes.join(" "), ...(refresh ? { refresh_token: refresh } : {}) };
  }

  /**
   * Every protected request. The grant must be for exactly this resource, so
   * a Tour Core token never opens Cleaner Core and the other way round. Unknown, revoked, expired or wrong-audience tokens are
   * all "invalid_token" (401). Without `expected` this is Tour Core's /mcp.
   */
  async verifyAccessToken(token: string, expected?: ResourceEndpoints): Promise<AuthInfo> {
    const ep = expected ?? this.defaultEndpoints();
    if (!ep) throw new InvalidTokenError("Tour Core's public address isn't set.");
    const grant = this.options.store.findByAccessHash(hashSecret(token));
    if (!grant) throw new InvalidTokenError("The access token isn't valid.");
    // The scope is checked by the gate (requiredScopes): a right-resource grant without it gets 403 insufficient_scope.
    if (grant.issuer !== ep.issuer || grant.resource !== ep.resource) throw new InvalidTokenError("The access token was issued for a different Tour Core address.");
    if (grant.accessExpiresAt <= this.now()) throw new InvalidTokenError("The access token has expired.");
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.accessExpiresAt / 1000),
      resource: new URL(grant.resource),
      extra: { grantId: grant.id, ...(grant.tenantId ? { tenantId: grant.tenantId } : {}), ...(grant.assistant ? { assistant: grant.assistant } : {}) },
    };
  }

  /** RFC 7009: revoking either token of a grant ends the whole grant. Unknown tokens are silently ignored. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashSecret(request.token);
    const grant = this.options.store.findByAccessHash(hash) ?? this.options.store.findByRefreshHash(hash)?.grant;
    if (grant && grant.clientId === client.client_id) this.options.store.revokeGrant(grant.id);
  }

  /** Drops approval requests and codes held in this process. Stored grants are separate. */
  discardPending(): void {
    this.requests.clear();
    this.codes.clear();
    this.metadataCache.clear();
  }

  /** "Disconnect Grok" on this computer. */
  disconnectAll(): { grants: number; clients: number } {
    this.requests.clear();
    for (const [h, c] of this.codes) if (!c.used) this.codes.delete(h);
    this.metadataCache.clear();
    return this.options.store.revokeAll();
  }
}
