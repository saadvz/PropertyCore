import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { resetLiveDesks } from "../src/cleaner-core/liveDesk";
import { CLEANER_SCOPE, OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { BASE, CLEANER_PRM, CLEANER_RESOURCE, closeHostedApps, hostedApp, hostedEnv, pkce, REDIRECT, tempDir } from "./cleanerOauthHarness";

/**
 * Cleaner Core runs hosted only as the multi-tenant service: on the same OAuth server as Tour Core,
 * but its own protected resource, and a grant names a tenant through its invite code. On a hosted
 * service without CLEANER_CORE_MULTI_TENANT, Cleaner Core is off. Tokens never cross between /mcp
 * and /mcp/cleaner-core. No real phone, no network.
 */

const FIXED_TOKEN = "cleaner-fixed-token-for-tests-only";
afterEach(() => {
  closeHostedApps();
  resetLiveDesks();
});

/** The multi-tenant service with one tenant, and a Grok Bot connected to it. */
async function multiApp() {
  const app = await hostedApp({ CLEANER_CORE_MULTI_TENANT: "1" });
  const registry = new TenantRegistry(app.root, () => new Date());
  const { tenant } = registry.create({ label: "Lane", twilioNumber: "+15555550150" });
  const clientId = await app.register("Grok");
  return { app, registry, tenant, clientId, invite: () => registry.invite(tenant.id) };
}

describe("Cleaner Core on a hosted service without the multi-tenant flag", () => {
  it("is off and unpublished, even for a fixed token", async () => {
    const app = await hostedApp({ CLEANER_CORE_MCP_TOKEN: FIXED_TOKEN });
    expect((await app.rpc("/mcp/cleaner-core", "tools/list")).status).toBe(503);
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", FIXED_TOKEN)).status).toBe(503);
    expect((await app.http("/.well-known/oauth-protected-resource/mcp/cleaner-core")).status).toBe(404);
    const asMeta = (await (await app.http("/.well-known/oauth-authorization-server")).json()) as { scopes_supported: string[] };
    expect(asMeta.scopes_supported).toEqual([OPERATOR_SCOPE]);
    const clientId = await app.register("Grok");
    expect((await app.authorize(clientId, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE)).status).not.toBe(200);
    // Its other public routes are off too, so nothing reaches a desk at the data root.
    expect((await app.http("/webhooks/twilio/cleaner-core", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "To=%2B15555550150" })).status).toBe(404);
    expect((await app.http("/cleaner-core/photos/anything")).status).toBe(404);
  });

  it("a request whose resource is the bare origin stays Tour Core", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const page = await app.authorize(clientId, pkce().challenge, BASE, OPERATOR_SCOPE);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Connect to Tour Core</title>");
    expect(html).not.toContain("Cleaner Core");
  });

  it("Tour Core still exchanges and refreshes with the bare origin", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const tour = await app.connect(clientId, BASE, OPERATOR_SCOPE, BASE);
    expect(tour.scope).toBe(OPERATOR_SCOPE);
    expect((await app.rpc("/mcp", "tools/list", tour.access)).status).toBe(200);
    const refreshed = await app.refresh(clientId, tour.refresh, BASE);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect((await app.rpc("/mcp", "tools/list", next.access_token)).status).toBe(200);
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", next.access_token)).status).toBe(503);
  });

  it("stays off without a fixed token or OAuth", async () => {
    const root = tempDir();
    const app = await hostedApp({}, { root, env: hostedEnv(root) }, "static");
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", "anything")).status).toBe(503);
  });

  it("publishes no cleaner resource when Cleaner Core is off", async () => {
    const root = tempDir();
    const app = await hostedApp({}, { root, env: hostedEnv(root, { CLEANER_CORE_ENABLED: "0", CLEANER_CORE_MULTI_TENANT: "1" }) });
    const asMeta = (await (await app.http("/.well-known/oauth-authorization-server")).json()) as { scopes_supported: string[] };
    expect(asMeta.scopes_supported).toEqual([OPERATOR_SCOPE]);
    expect((await app.http("/.well-known/oauth-protected-resource/mcp/cleaner-core")).status).toBe(404);
    const clientId = await app.register("Grok");
    expect((await app.authorize(clientId, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE)).status).not.toBe(200);
  });
});

describe("Cleaner Core OAuth on the multi-tenant service", () => {
  it("points an unsigned call at Cleaner Core's own metadata", async () => {
    const { app } = await multiApp();
    const first = await app.rpc("/mcp/cleaner-core", "tools/list");
    expect(first.status).toBe(401);
    expect(first.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${CLEANER_PRM}", scope="${CLEANER_SCOPE}"`);
    const prm = await app.http("/.well-known/oauth-protected-resource/mcp/cleaner-core");
    expect(await prm.json()).toEqual({ resource: CLEANER_RESOURCE, authorization_servers: [BASE], scopes_supported: [CLEANER_SCOPE], bearer_methods_supported: ["header"], resource_name: "Cleaner Core" });
  });

  it("refuses an Allow that carries a bearer token: a chat can't approve itself", async () => {
    const { app, clientId, invite } = await multiApp();
    const { id, code } = app.pageParts(await (await app.authorize(clientId, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE)).text());
    expect((await app.approve(id, code, { authorization: "Bearer grok-mcp-token" }, invite())).status).toBe(401);
  });

  it("a cleaner token never opens Tour Core, and logs never hold it", async () => {
    const { app, clientId, invite } = await multiApp();
    const { access, scope, verifier } = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: invite() });
    expect(scope).toBe(CLEANER_SCOPE);
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", access)).status).toBe(200);
    const onTour = await app.rpc("/mcp", "tools/list", access);
    expect([401, 403]).toContain(onTour.status);
    expect(await onTour.text()).not.toContain("tools");
    const log = app.logs.join("\n");
    expect(log).not.toContain(access);
    expect(log).not.toContain(verifier);
  });

  it("a cleaner refresh can't name Tour Core", async () => {
    const { app, clientId, invite } = await multiApp();
    const cleaner = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: invite() });
    for (const resource of [BASE, `${BASE}/mcp`]) {
      const res = await app.refresh(clientId, cleaner.refresh, resource);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("access_token");
    }
  });

  it("a cleaner grant needs the cleaner scope", async () => {
    const { app, clientId, tenant } = await multiApp();
    const store = new OAuthGrantStore(new FileRuntimeStore(join(app.root, "runtime")));
    const t = Date.now();
    for (const [access, scopes] of [["tca_cleaner-no-scope-test", []], ["tca_cleaner-tour-scope-test", [OPERATOR_SCOPE]]] as const) {
      store.addGrant({ clientId, issuer: BASE, resource: CLEANER_RESOURCE, scopes: [...scopes], createdAt: t, expiresAt: t + 3_600_000, accessHash: hashSecret(access), accessExpiresAt: t + 3_600_000, tenantId: tenant.id, assistant: "grok" });
      const res = await app.rpc("/mcp/cleaner-core", "tools/list", access);
      expect(res.status).toBe(403);
      expect(String(res.headers["www-authenticate"])).toContain('error="insufficient_scope"');
      expect(await res.text()).not.toContain("get_state");
    }
  });

  it("a cleaner code can't be redeemed for Tour Core", async () => {
    const { app, clientId, invite } = await multiApp();
    const { verifier, challenge } = pkce();
    const { id, code } = app.pageParts(await (await app.authorize(clientId, challenge, CLEANER_RESOURCE, CLEANER_SCOPE)).text());
    expect((await app.approve(id, code, {}, invite())).status).toBe(200);
    const location = new URL((await app.http(`/oauth/requests/${id}/continue`)).headers.location!);
    for (const resource of [`${BASE}/mcp`, BASE]) {
      const token = await app.http("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource }).toString(),
      });
      expect(token.status).toBe(400);
      expect(await token.text()).not.toContain("access_token");
    }
  });

  it("asks for an invite at the shared /mcp address, and refuses a fixed token", async () => {
    const root = tempDir();
    const app = await hostedApp({}, { root, env: hostedEnv(root, { CLEANER_CORE_MULTI_TENANT: "1", CLEANER_CORE_MCP_TOKEN: FIXED_TOKEN }) });
    const clientId = await app.register("Grok");
    const page = await app.authorize(clientId, pkce().challenge, `${BASE}/mcp`, OPERATOR_SCOPE);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="oauth-invite"');
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", FIXED_TOKEN)).status).toBe(401);
  });
});
