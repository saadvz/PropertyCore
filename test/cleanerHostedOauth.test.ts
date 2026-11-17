import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { assistantForRedirect } from "../src/cleaner-core/assistant";
import { TenantRegistry, type Tenant } from "../src/cleaner-core/hosted/registry";
import { checkClientMetadata, parseMetadataDocument, redirectHostsFromEnv, redirectPolicyFor } from "../src/mcp/oauth/clients";
import { consentPage, INVITE_REFUSALS, problemPage } from "../src/mcp/oauth/pages";
import { CLEANER_SCOPE, OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { BASE, CLEANER_RESOURCE, closeHostedApps, hostedApp, pkce } from "./cleanerOauthHarness";

const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const DAY = 24 * 60 * 60_000;

afterEach(() => closeHostedApps());

async function multiApp() {
  const app = await hostedApp({ CLEANER_CORE_MULTI_TENANT: "1" });
  const registry = new TenantRegistry(app.root, () => new Date());
  const grants = () => new OAuthGrantStore(app.inst.runtime);
  return { app, registry, grants };
}

async function pendingRequest(app: Awaited<ReturnType<typeof hostedApp>>, clientId: string, resource = CLEANER_RESOURCE, scope = CLEANER_SCOPE) {
  const { challenge } = pkce();
  const page = await app.authorize(clientId, challenge, resource, scope);
  return { page, html: await page.text() };
}

describe("assistantForRedirect", () => {
  it("reads the chat from the callback host", () => {
    expect(assistantForRedirect(CLAUDE_REDIRECT)).toBe("claude");
    expect(assistantForRedirect(CHATGPT_REDIRECT)).toBe("chatgpt");
    expect(assistantForRedirect("https://grok.com/connectors/oauth/callback")).toBe("grok");
    expect(assistantForRedirect("not a url")).toBe("grok");
  });
});

describe("redirect hosts on the multi-tenant service", () => {
  it("allows claude.ai and chatgpt.com without extra config", () => {
    const hosts = redirectHostsFromEnv({ CLEANER_CORE_MULTI_TENANT: "1" });
    expect(hosts).toContain("claude.ai");
    expect(hosts).toContain("chatgpt.com");
  });
});

describe("the invite code on the Allow page", () => {
  it("creates no grant for a wrong, used, expired, or disabled-tenant code, each with its own words", async () => {
    const { app, registry, grants } = await multiApp();
    const lane = registry.create({ label: "Lane", twilioNumber: "+15555550150" });
    const used = registry.invite(lane.tenant.id);
    registry.claimInvite(used);
    const expired = new TenantRegistry(app.root, () => new Date(Date.now() - 8 * DAY)).invite(lane.tenant.id);
    const court = registry.create({ label: "Court", twilioNumber: "+15555550151" });
    registry.setDisabled(court.tenant.id, true);
    const clientId = await app.register("Grok");
    const { html } = await pendingRequest(app, clientId);
    const { id, code } = app.pageParts(html);
    for (const [invite, reason] of [["AAAA-AAAA-AAAA", "invalid"], [used, "used"], [expired, "expired"], [court.inviteCode, "disabled"]] as const) {
      const res = await app.approve(id, code, {}, invite);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { message: string; field?: string } }).error).toEqual({ message: INVITE_REFUSALS[reason], field: "invite" });
    }
    // No invite at all is refused too.
    expect((await app.approve(id, code)).status).toBe(403);
    expect(registry.get(lane.tenant.id)!.connections).toHaveLength(0);
    expect(grants().list()).toHaveLength(0);
  });

  it("binds two hosts on one shared Grok client_id to two tenants", async () => {
    const { app, registry, grants } = await multiApp();
    const lane = registry.create({ label: "Lane", twilioNumber: "+15555550150" });
    const court = registry.create({ label: "Court", twilioNumber: "+15555550151" });
    const clientId = await app.register("Grok");
    const a = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: lane.inviteCode });
    const b = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: court.inviteCode });
    const grantA = grants().findByAccessHash(hashSecret(a.access))!;
    const grantB = grants().findByAccessHash(hashSecret(b.access))!;
    expect(grantA).toMatchObject({ tenantId: lane.tenant.id, assistant: "grok" });
    expect(grantB).toMatchObject({ tenantId: court.tenant.id, assistant: "grok" });
    expect(registry.get(lane.tenant.id)!.connections.map((c) => c.grantId)).toEqual([grantA.id]);
    expect(registry.get(court.tenant.id)!.connections.map((c) => c.grantId)).toEqual([grantB.id]);
    expect(grants().get(grantA.id)?.id).toBe(grantA.id);
  });

  it("lets Claude, ChatGPT and Grok all connect to one tenant, each named by its callback host", async () => {
    const { app, registry } = await multiApp();
    const lane = registry.create({ label: "Lane", twilioNumber: "+15555550150" });
    for (const [name, redirect] of [["Claude", CLAUDE_REDIRECT], ["ChatGPT", CHATGPT_REDIRECT], ["Grok", undefined]] as const) {
      const clientId = await app.register(name, redirect);
      const inviteCode = registry.invite(lane.tenant.id);
      await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode, ...(redirect ? { redirect } : {}) });
    }
    const tenant = registry.get(lane.tenant.id) as Tenant;
    expect(tenant.connections.map((c) => c.assistant)).toEqual(["claude", "chatgpt", "grok"]);
    expect(tenant.primaryGrantId).toBe(tenant.connections[0]!.grantId);
  });

  it("uses the invite up on Allow, so a host who closes the tab needs a new one", async () => {
    const { app, registry } = await multiApp();
    const lane = registry.create({ label: "Lane", twilioNumber: "+15555550150" });
    const clientId = await app.register("Grok");
    const { html } = await pendingRequest(app, clientId);
    const { id, code } = app.pageParts(html);
    expect((await app.approve(id, code, {}, lane.inviteCode)).status).toBe(200);
    expect(registry.claimInvite(lane.inviteCode)).toEqual({ refused: "used" });
    expect(registry.get(lane.tenant.id)!.connections).toHaveLength(0);
    const fresh = registry.invite(lane.tenant.id);
    await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: fresh });
    expect(registry.get(lane.tenant.id)!.connections).toHaveLength(1);
  });

  it("asks for the invite on the page, names the chat from the callback, and never says first-connection-owns", async () => {
    const { app } = await multiApp();
    const clientId = await app.register("Claude", CLAUDE_REDIRECT);
    const { challenge } = pkce();
    const html = await (await app.authorize(clientId, challenge, CLEANER_RESOURCE, CLEANER_SCOPE, "s", CLAUDE_REDIRECT)).text();
    expect(html).toContain('id="oauth-invite"');
    expect(html).toContain("Invite code from Saad");
    expect(html).toContain("Connect Claude to Cleaner Core");
    expect(html).not.toContain("owner of this Cleaner Core");
    const plain = consentPage({ requestId: "r", matchCode: "123456", clientName: "Grok", redirectHost: "grok.com", hosted: true, firstClaim: true, label: "Cleaner Core" });
    expect(plain).not.toContain('id="oauth-invite"');
  });

  it("refuses an Allow at the shared /mcp address without an invite code", async () => {
    const { app } = await multiApp();
    const clientId = await app.register("Grok");
    const { html } = await pendingRequest(app, clientId, `${BASE}/mcp`, OPERATOR_SCOPE);
    const { id, code } = app.pageParts(html);
    expect((await app.approve(id, code)).status).not.toBe(200);
  });

  it("takes an invite code at the shared /mcp address too", async () => {
    const { app } = await multiApp();
    const clientId = await app.register("Grok");
    const { page } = await pendingRequest(app, clientId, `${BASE}/mcp`, OPERATOR_SCOPE);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Connect your Grok Bot to Property Core");
    expect(html).toContain("is asking to run cleanings, supplies, or tours at your properties.");
    expect(html).toContain('id="oauth-invite"');
  });

  it("draws the Property Core page from its own stylesheet and font, with nothing inline", async () => {
    const { app } = await multiApp();
    const clientId = await app.register("Grok");
    const { page, html } = await pendingRequest(app, clientId, `${BASE}/mcp`, OPERATOR_SCOPE);
    expect(page.headers["content-security-policy"]).toContain("font-src 'self'");
    expect(html).toContain('<link rel="stylesheet" href="/connect.css" />');
    expect(html).toContain("<h1>Let Grok Bot run the day-to-day. You keep the keys.</h1>");
    expect(html).toContain("After you decide, you'll be sent back to Grok Bot.");
    // The chat shows no connection code, so the page shows none to match. Allow still sends it.
    expect(html).not.toContain("match-code");
    expect(html).not.toContain("Connection code");
    expect(html).toMatch(/id="oauth-allow" data-code="\d{3} \d{3}"/);
    // The card each ending shows waits hidden on the page.
    for (const id of ["oauth-done-approved", "oauth-done-denied", "oauth-done-expired"]) expect(html).toContain(`id="${id}" hidden`);
    expect(html).toContain('In Grok Bot, say &quot;Set up Property Core&quot;.');
    // The CSP allows no inline style or script.
    expect(html).not.toMatch(/\sstyle=|<style|<script>|\son\w+="/);
    const css = await app.http("/connect.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    const font = await app.http("/fonts/plus-jakarta-sans-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(font.bytes().equals(readFileSync("src/web/public/fonts/plus-jakarta-sans-latin.woff2"))).toBe(true);
  });

  it("still shows the code to check when the approval happens on the Cleaner Core computer", () => {
    const html = consentPage({ requestId: "r", matchCode: "123 456", clientName: "Claude", redirectHost: "claude.ai", hosted: false, label: "Cleaner Core", assistant: "claude" });
    expect(html).toContain('<span class="match-code">123 456</span>');
    expect(html).toContain("Check it matches the one on your computer.");
    expect(html).not.toContain('id="oauth-allow"');
  });

    it("shows a problem page in the connect page's style", () => {
    const html = problemPage("This request is finished", "It was already used or it expired.", "wait");
    expect(html).toContain('<link rel="stylesheet" href="/connect.css" />');
    expect(html).toContain('<div class="pc-badge wait">');
    expect(html).toContain("<h1>This request is finished</h1>");
    expect(html).not.toContain("<script");
  });

  it("counts an expired grant as gone, not live", () => {
    const store = new OAuthGrantStore({ get: () => undefined, set: () => undefined } as never, () => 1_000_000);
    const base = { clientId: "c", issuer: BASE, resource: CLEANER_RESOURCE, scopes: [CLEANER_SCOPE], createdAt: 0, accessHash: "a" };
    expect(store.isLive({ ...base, id: "g", retiredRefreshHashes: [], expiresAt: 999_999, accessExpiresAt: 999_999 })).toBe(false);
    expect(store.isLive({ ...base, id: "g", retiredRefreshHashes: [], expiresAt: 2_000_000, accessExpiresAt: 999_999, refreshExpiresAt: 2_000_000 })).toBe(true);
    expect(store.isLive({ ...base, id: "g", retiredRefreshHashes: [], expiresAt: 2_000_000, accessExpiresAt: 999_999 })).toBe(false);
  });

  it("accepts Claude's published identity, keeping only the grant types this server issues", () => {
    // Claude's document as published at its client_id URL on 2026-10-27.
    const claude = {
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      client_name: "Claude",
      client_uri: "https://claude.ai",
      redirect_uris: [CLAUDE_REDIRECT],
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    const client = parseMetadataDocument(claude.client_id, claude, redirectPolicyFor({ CLEANER_CORE_MULTI_TENANT: "1" }, "HOSTED_RAILWAY_P0"));
    expect(client.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(client.redirect_uris).toEqual([CLAUDE_REDIRECT]);
  });

  it("still refuses a client that can't use the authorization code grant", () => {
    const policy = redirectPolicyFor({ CLEANER_CORE_MULTI_TENANT: "1" }, "HOSTED_RAILWAY_P0");
    for (const grant_types of [["urn:ietf:params:oauth:grant-type:jwt-bearer"], ["implicit"], ["refresh_token"]]) {
      expect(() => checkClientMetadata({ redirect_uris: [CLAUDE_REDIRECT], grant_types, token_endpoint_auth_method: "none" }, policy, new Set(["none"])), JSON.stringify(grant_types)).toThrow(/grant_types/);
    }
  });

  it("accepts ChatGPT's published identity as a public client, since it says it supports none", () => {
    // ChatGPT's document as published at its client_id URL on 2026-10-27.
    const chatgpt = {
      client_id: "https://chatgpt.com/oauth/client.json",
      client_uri: "https://chatgpt.com/",
      redirect_uris: [CHATGPT_REDIRECT],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT",
      token_endpoint_auth_signing_alg: "RS256",
      jwks_uri: "https://chatgpt.com/oauth/jwks.json",
    };
    const policy = redirectPolicyFor({ CLEANER_CORE_MULTI_TENANT: "1" }, "HOSTED_RAILWAY_P0");
    const client = parseMetadataDocument(chatgpt.client_id, chatgpt, policy);
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.redirect_uris).toEqual([CHATGPT_REDIRECT]);
    const keyOnly = { ...chatgpt, token_endpoint_auth_methods_supported: ["private_key_jwt"] };
    expect(() => parseMetadataDocument(chatgpt.client_id, keyOnly, policy)).toThrow(/token_endpoint_auth_method/);
    const { token_endpoint_auth_methods_supported: _supported, ...declaredOnly } = chatgpt;
    expect(() => parseMetadataDocument(chatgpt.client_id, declaredOnly, policy)).toThrow(/token_endpoint_auth_method/);
  });
});
