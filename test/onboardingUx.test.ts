import { afterEach, describe, expect, it } from "vitest";
import { getInstallationStatus, OPERATOR_MESSAGES } from "../src/install/status";
import { GROK_ALERTS_SAY } from "../src/playbooks/grok";
import { SHARED_STEPS } from "../src/playbooks/shared";
import { installHarness, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

/**
 * The onboarding behaviors a real fresh-Grok run exposed: Tour Core, not the
 * model, owns the order; operator-facing text is plain; and each phase hands
 * over to the next with the right words. No live Grok involved.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
const TUNNEL_2 = "https://quiet-heron-glass.trycloudflare.com";
/** Words a landlord shouldn't see in normal conversation. */
const JARGON = /\/mcp|trycloudflare|https?:\/\/|\bMCP\b|OAuth|\btunnel|connector|\btools?\b|\bnpm\b|localhost|:\d{4}\b|PUBLIC_BASE_URL|TOURCORE_|cloudflared|webhook|routine|\bpid\b|adapter|endpoint/i;
const SEQUENCING_QUESTION = /what (would you like|should we|do you want) (to )?do next|if you'd rather|doesn't depend on|which (would you like|should we do) first/i;

function harness(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  return h;
}

const at = (h: InstallHarness) => new Date(h.now()).toISOString();
const endpointReady = (h: InstallHarness, url = TUNNEL) => {
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(url, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: at(h), message: "ok", url });
};
const messagingReady = (h: InstallHarness) => {
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  h.inst.files.recordCheck("visitorMessaging", { ok: true, at: at(h), message: "ok", problems: [], publicBaseUrl: h.inst.publicBaseUrl()! });
};
const alertsReady = (h: InstallHarness) => {
  h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
  const changed = [h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY")].sort().at(-1)!;
  h.inst.files.recordCheck("operatorAlerts", { ok: true, at: at(h), message: "ok", credentialsChangedAt: changed });
};
const infraReady = (h: InstallHarness) => {
  endpointReady(h);
  h.connectGrok();
  messagingReady(h);
  h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: at(h) } });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const next = (h: InstallHarness): Promise<any> => h.ok("get_next_installation_step");
/** The message after publishing names the number visitors text. */
const withNumber = (message: string) => message.replace("Visitor texting is live.", "Visitor texting is live. Visitors text +15550109999 to book a tour.");

/** Everything the tools present as safe to say to the operator. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function operatorText(status: any, step: any): string[] {
  return [status.summary, ...status.lines, ...status.components.map((c: { summary: string }) => c.summary), status.nextStep.operatorMessage, step.operatorMessage, step.summary];
}

describe("Tour Core owns the onboarding order", () => {
  it("while infrastructure is incomplete, the next step is infrastructure: property setup isn't offered, even if a property already exists", async () => {
    const h = harness();
    await h.setUpAlfredWay(); // e.g. created from the browser app before texting was connected
    endpointReady(h);
    h.connectGrok();
    const step = await next(h);
    expect(step).toMatchObject({ component: "VISITOR_MESSAGING", action: "CHOOSE_MESSAGING_PROVIDER", phase: "INFRASTRUCTURE", infrastructureReady: false });
    expect(step.rule).toMatch(/Tour Core decides the order\. Do this step now\. Don't offer other setup, don't ask the operator what to do next, and don't start property setup/);
    const property = await h.component("PROPERTY");
    expect(property.next).toBeUndefined();
    expect((await h.component("OPERATOR_ALERTS")).next).toBeUndefined();
    expect((await h.component("READINESS")).next).toBeUndefined();
  });

  it("a fresh install needs only the connection approval from the operator before texting; Grok does the rest", async () => {
    const h = harness();
    const people: string[] = [];
    for (let i = 0; i < 6; i++) {
      const step = await next(h);
      if (step.component === "VISITOR_MESSAGING") break;
      if (step.performedBy !== "GROK") people.push(`${step.action}:${step.performedBy}`);
      if (step.action === "ESTABLISH_PUBLIC_ENDPOINT") {
        h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
        h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
      } else if (step.action === "CHECK_PUBLIC_ENDPOINT") h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: at(h), message: "ok", url: TUNNEL });
      else if (step.action === "CONNECT_GROK") {
        expect(step.operatorMessage).toBe("Tour Core is installed and running. I need your approval to connect to it. I've opened the approval screen. Check that the codes match and click Allow.");
        // Grok continues on its own after approval.
        expect(step.grokInstructions).toMatch(/After approval, say "Connected\. I'm checking the rest of the setup now\." and call get_installation_status without waiting to be asked\./);
        expect(step.grokInstructions).toContain(`${TUNNEL}/mcp`);
        h.connectGrok();
      }
    }
    expect(people).toEqual(["CONNECT_GROK:OPERATOR"]);
  });

  it("after texting is connected, Tour Core recommends Google Drive before the first property", async () => {
    const h = harness();
    endpointReady(h);
    h.connectGrok();
    messagingReady(h);
    const step = await next(h);
    expect(step).toMatchObject({
      component: "STORAGE",
      action: "CONNECT_GOOGLE_DRIVE",
      performedBy: "OPERATOR_DECISION",
      operatorMessage: "Visitor texting is working. Next I recommend connecting Google Drive so your property and tour records stay with you even if this Tour Core computer changes.",
    });
    expect(step.operatorMessage).not.toMatch(JARGON);
    expect(step.grokInstructions).toMatch(/built-in Google Drive connector/);
    expect(step.grokInstructions).toMatch(/does not document|no documented/i);
    expect(step.operatorMessage).not.toMatch(/password|token|api key/i);
    await h.ok("use_local_demo_storage");
    expect((await h.ok("use_local_demo_storage")).summary).toMatch(/won't be portable/);
  });

  it("after texting is connected and tested, Tour Core offers the first property, in plain words", async () => {
    const h = harness();
    infraReady(h);
    const status = await h.status();
    expect(status.infrastructureReady).toBe(true);
    expect(status.nextStep).toMatchObject({ action: "SET_UP_PROPERTY", phase: "PROPERTY", performedBy: "OPERATOR_DECISION", skill: "setup-property", operatorMessage: OPERATOR_MESSAGES.firstProperty });
    expect(OPERATOR_MESSAGES.firstProperty).toBe("Everything needed to start is connected and tested. Would you like to add your first property?");
  });

  it("asks for a visitor help number as one optional step before the property is ready", async () => {
    const h = harness();
    infraReady(h);
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_unit", { name: "Unit 101" });
    await h.ok("set_unit_details", { details: "101 is 1 bed 1 bath for $1,950, available now." });
    await h.ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Unit 101 Door"] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await h.ok("set_verification_policy", { level: "basic-form" });
    const step = await next(h);
    expect(step).toMatchObject({
      component: "PROPERTY",
      action: "FINISH_PROPERTY_SETUP",
      performedBy: "OPERATOR_DECISION",
      tool: "update_property_details",
      operatorMessage: "What number can stuck visitors call? Pick one someone answers during tour hours.",
    });
    await h.ok("update_property_details", { skipVisitorHelp: true });
    expect((await next(h)).action).toBe("OFFER_OPERATOR_ALERTS");
  });

  it("alerts are offered only after the property is saved, as a recommended option Tour Core marks optional", async () => {
    const h = harness();
    infraReady(h);
    expect((await h.component("OPERATOR_ALERTS")).state).toBe("NOT_CONFIGURED");
    await h.setUpAlfredWay();
    const offer = await next(h);
    expect(offer).toMatchObject({ component: "OPERATOR_ALERTS", action: "OFFER_OPERATOR_ALERTS", performedBy: "OPERATOR_DECISION", optional: true, phase: "PROPERTY", operatorMessage: OPERATOR_MESSAGES.offerAlerts });
    expect(offer.operatorMessage).toBe("Your property is configured. Would you like me to keep you updated when someone books, starts or finishes a tour, and alert you if something needs your input?");
    expect(offer.grokInstructions).toMatch(/Create the Tour Core Operator Updates routine yourself/);
    expect(offer.grokInstructions).toMatch(/set_notification_preferences \(preset recommended/);
    expect(offer.grokInstructions).toContain(OPERATOR_MESSAGES.recommendUpdates);
    expect(offer.grokInstructions).toMatch(/If they say no: call skip_optional_setup with component OPERATOR_ALERTS/);
    // Moving the routine's details: only values that stay hidden on screen may be moved by Grok itself.
    expect(offer.grokInstructions).toMatch(/Prefer Grok's secure secret input/);
    expect(offer.grokInstructions).toMatch(/Hand the browser to the operator only when secure fill isn't available/);
    expect((await h.component("OPERATOR_ALERTS")).requirement).toBe("RECOMMENDED");
  });

  it("uses the client's spoken alerts question, and keeps the pinned line when no client is known", async () => {
    const h = harness();
    infraReady(h);
    await h.setUpAlfredWay();
    const grok = getInstallationStatus(h.inst, h.services, { client: { name: "Grok" } });
    expect(grok.nextStep.operatorMessage).toBe(GROK_ALERTS_SAY);
    const claude = getInstallationStatus(h.inst, h.services, { client: { name: "claude-ai", capabilities: { sampling: {} } } });
    expect(claude.nextStep.operatorMessage).toBe(SHARED_STEPS.alerts.ask);
    const chatgpt = getInstallationStatus(h.inst, h.services, { client: { name: "ChatGPT" } });
    expect(chatgpt.nextStep.operatorMessage).toBe(SHARED_STEPS.alerts.ask);
    const none = getInstallationStatus(h.inst, h.services);
    expect(none.nextStep.operatorMessage).toBe(OPERATOR_MESSAGES.offerAlerts);
  });

  it("declining alerts moves straight on to the automatic readiness check; required components can't be skipped", async () => {
    const h = harness();
    infraReady(h);
    await h.setUpAlfredWay();
    expect(await h.fails("skip_optional_setup", { component: "VISITOR_MESSAGING" })).toContain("doesn't fit skip_optional_setup");
    const skipped = await h.ok("skip_optional_setup", { component: "OPERATOR_ALERTS" });
    expect(skipped.summary).toBe("No problem, that's off for now. You can turn it on any time.");
    expect(skipped.nextStep).toMatchObject({ action: "RUN_READINESS", performedBy: "GROK", phase: "VALIDATE", operatorMessage: OPERATOR_MESSAGES.validate });
    expect(OPERATOR_MESSAGES.validate).toMatch(/Prospects can text your touring number to ask questions, choose a day and time, verify their details, and complete the self-guided tour in the same conversation\. I'll run a readiness check and a practice tour before we turn it on\./);
    const alerts = await h.component("OPERATOR_ALERTS");
    expect(alerts).toMatchObject({ state: "NOT_CONFIGURED", summary: "Tour updates are off. You can turn them on any time." });
  });

  it("property ready → readiness → practice tour run automatically; publish still needs an explicit yes; then operating language", async () => {
    const h = harness();
    infraReady(h);
    await h.setUpAlfredWay();
    alertsReady(h);
    expect(await next(h)).toMatchObject({ action: "RUN_READINESS", performedBy: "GROK" });
    await h.ok("run_readiness_check");
    expect(await next(h)).toMatchObject({ action: "RUN_PRACTICE_TOUR", performedBy: "GROK", phase: "VALIDATE" });
    await h.ok("run_dry_tour");
    const publish = await next(h);
    expect(publish).toMatchObject({ action: "PUBLISH", performedBy: "OPERATOR_DECISION", phase: "PUBLISH", tool: "publish_demo_property", operatorMessage: "Everything passed. Would you like me to publish 100 Alfred Way for demo?" });
    // The tool itself refuses to act without the confirmation that follows the operator's yes.
    const asked = await h.ok("publish_demo_property", {});
    expect(asked.status).toBe("needs-confirmation");
    expect(h.workspace.load("prop_100_alfred_way").state.status).not.toBe("PUBLISHED_FOR_DEMO");
    await h.ok("publish_demo_property", { confirmationCode: asked.confirmation.code });
    const done = await h.status();
    expect(done.phase).toBe("OPERATE");
    expect(done.nextStep).toMatchObject({
      action: "ADD_ANOTHER_PROPERTY",
      phase: "OPERATE",
      performedBy: "OPERATOR_DECISION",
      tool: "create_property_setup",
      skill: "setup-property",
      operatorMessage: `${withNumber(OPERATOR_MESSAGES.operate)} ${OPERATOR_MESSAGES.anotherProperty}`,
    });
    expect(done.summary).toBe("Your property is published.");
    expect(JSON.stringify(done.nextStep)).not.toMatch(/everything (runs|is) in demo/i);
    const publishedAt = h.workspace.load("prop_100_alfred_way").state.publishedAt;
    const again = await h.ok("publish_demo_property", {});
    expect(again).toMatchObject({ published: true, status: "already-published" });
    expect(again.instructions).toMatch(/already published/i);
    expect(`${again.summary} ${again.instructions}`).not.toMatch(/still needs a yes|Would you like me to publish/i);
    expect(h.workspace.load("prop_100_alfred_way").state.publishedAt).toBe(publishedAt);
    expect(h.workspace.load("prop_100_alfred_way").state.status).toBe("PUBLISHED_FOR_DEMO");
    const after = await next(h);
    expect(after.action).toBe("ADD_ANOTHER_PROPERTY");
    expect(after.operatorMessage).not.toMatch(/Would you like me to publish|still needs a yes/i);
    expect([done.summary, after.operatorMessage, after.summary].join(" ")).not.toMatch(/connect|install|setup|secure/i);
  });

  it("published without alerts: no promise to watch tours, just how to ask", async () => {
    const h = harness();
    infraReady(h);
    await h.setUpAlfredWay();
    await h.ok("skip_optional_setup", { component: "OPERATOR_ALERTS" });
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    expect((await next(h)).operatorMessage).toBe(`${withNumber(OPERATOR_MESSAGES.operateWithoutAlerts)} ${OPERATOR_MESSAGES.anotherProperty}`);
  });

  it("with one property already published, the next step starts another property and leaves the first published", async () => {
    const h = harness();
    infraReady(h);
    await h.setUpAlfredWay();
    alertsReady(h);
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    const step = await next(h);
    expect((await h.status()).phase).toBe("OPERATE");
    expect(step).toMatchObject({
      action: "ADD_ANOTHER_PROPERTY",
      phase: "OPERATE",
      tool: "create_property_setup",
      skill: "setup-property",
      operatorMessage: `${withNumber(OPERATOR_MESSAGES.operate)} ${OPERATOR_MESSAGES.anotherProperty}`,
    });
    const started = await h.ok("create_property_setup", { address: "145 Tenafly Road, Tenafly, NJ 07670", name: "145 Tenafly Road" });
    expect(started.status).toBe("created");
    const follow = await next(h);
    expect(follow.action).toBe("FINISH_PROPERTY_SETUP");
    expect(follow.component).toBe("PROPERTY");
    expect(follow.operatorMessage).toMatch(/145 Tenafly Road/);
    expect(h.workspace.load("prop_100_alfred_way").state.status).toBe("PUBLISHED_FOR_DEMO");
  });
});

describe("operator-facing text is plain", () => {
  it("in every onboarding state: no /mcp, tunnel addresses, tool counts, protocols, commands or ports; no sequencing questions", async () => {
    const h = harness();
    const seen: string[] = [];
    const snapshot = async (label: string) => {
      const status = await h.ok("get_installation_status");
      const step = await next(h);
      for (const text of operatorText(status, step)) seen.push(`${label}: ${text}`);
      // Technical values stay available to Grok, separately.
      if (h.inst.publicBaseUrl()) expect(status.technical).toMatchObject({ connectorUrl: `${new URL(h.inst.publicBaseUrl()!).origin}/mcp`, note: expect.stringMatching(/Never show these to the operator/) });
    };
    await snapshot("blank");
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    await snapshot("unchecked address");
    h.inst.files.recordCheck("publicEndpointCheck", { ok: false, at: at(h), message: "Tour Core's public address didn't answer.", url: TUNNEL });
    await snapshot("address down");
    h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: at(h), message: "ok", url: TUNNEL });
    await snapshot("needs approval");
    h.connectGrok();
    await snapshot("texting");
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    await snapshot("texting untested");
    messagingReady(h);
    await snapshot("infra ready");
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await snapshot("property in progress");
    await h.setUpAlfredWay();
    await snapshot("alerts offer");
    h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
    h.inst.files.recordCheck("operatorAlerts", { ok: false, at: at(h), message: "The Grok Routine refused the connection details.", credentialsChangedAt: h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY") });
    await snapshot("alerts failing");
    alertsReady(h);
    await snapshot("validate");
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await snapshot("publish");
    await h.approve("publish_demo_property", {});
    await snapshot("operate");
    // The address changed later: reconnecting is still plain.
    h.inst.files.setPublicBaseUrl(TUNNEL_2, "CLOUDFLARE_QUICK_TUNNEL");
    await snapshot("address changed");
    h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: at(h), message: "ok", url: TUNNEL_2 });
    await snapshot("reconnect");

    for (const line of seen) {
      expect(line, line).not.toMatch(JARGON);
      expect(line, line).not.toMatch(SEQUENCING_QUESTION);
    }
    expect(seen.some((l) => l.includes("I need your approval to reconnect"))).toBe(true);
  });

  it("test and check tools summarize plainly and keep details under technical", async () => {
    const h = harness();
    endpointReady(h);
    h.net.state.health = { ok: true, service: "tour-core" };
    const summaries = [];
    for (const name of ["check_runtime_health", "check_public_endpoint", "test_storage", "test_access", "test_operator_alerts", "get_secure_setup_url"]) {
      const out = await h.ok(name);
      summaries.push(out.summary as string);
    }
    for (const s of summaries) expect(s, s).not.toMatch(JARGON);
    const link = await h.ok("get_secure_setup_url", { step: "visitor-messaging" });
    expect(link.instructions).toMatch(/Do not show the link/);
    expect(link.instructions).toMatch(/secure secret input/);
  });
});
