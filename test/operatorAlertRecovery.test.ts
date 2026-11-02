import { FACT_QUESTIONS, FACT_TOPICS } from "../src/setup/factsSheet";
import { afterEach, describe, expect, it } from "vitest";
import { exceptionCreatedEvent } from "../src/alerts/operatorEvents";
import { describeUpdates, RECOMMENDED_UPDATES } from "../src/alerts/preferences";
import { getInstallationStatus } from "../src/install/status";
import { GROK_ALERTS_SAY } from "../src/playbooks/grok";
import { SHARED_STEPS } from "../src/playbooks/shared";
import { installHarness, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

/**
 * One failed delivery, then a passing test. Landlord get_state, installation
 * status, and runtime health have to name the same alert health both times.
 */

const DEGRADED_SAY = "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through.";
const RECONNECT_SAY = "Tour updates aren't reaching you. I'll send you a secure link to reconnect them. Nothing you type there shows in chat.";
const DEGRADED_SUMMARY = "Some tour updates haven't reached you yet.";
const READY_LINE = `I'll keep you posted on ${describeUpdates(RECOMMENDED_UPDATES)}.`;
const SETUP = /Want me to text you|Want me to tell you when someone books|create the Tour Core Operator Updates|webhook address|secure secret input|I'm setting up your tour updates|get_secure_setup_url/;
const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function harness(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  h.ctx.client = { name: "Grok" };
  return h;
}

function markChecked(h: InstallHarness, what: "endpoint" | "messaging" | "alerts") {
  const at = new Date(h.now()).toISOString();
  const url = h.inst.publicBaseUrl()!;
  if (what === "endpoint") h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at, message: "ok", url });
  if (what === "messaging") h.inst.files.recordCheck("visitorMessaging", { ok: true, at, message: "ok", problems: [], publicBaseUrl: url, webhookUrl: `${url}/webhooks/sendblue` });
  if (what === "alerts") {
    const changed = [h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY")].filter(Boolean).sort().at(-1);
    h.inst.files.recordCheck("operatorAlerts", { ok: true, at, message: "ok", ...(changed ? { credentialsChangedAt: changed } : {}) });
  }
}

function completeInfrastructure(h: InstallHarness) {
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  markChecked(h, "endpoint");
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  markChecked(h, "messaging");
  h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: new Date(h.now()).toISOString() } });
  h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
  markChecked(h, "alerts");
}

async function publishedWithAlerts(h: InstallHarness) {
  completeInfrastructure(h);
  await h.ok("set_notification_preferences", { preset: "recommended" });
  return h.publish();
}

interface AlertComponent {
  component: string;
  state: string;
  summary: string;
  next?: { action: string; operatorMessage: string; tool?: string };
}

function alertsOf(status: { components: AlertComponent[] }): AlertComponent {
  return status.components.find((item) => item.component === "OPERATOR_ALERTS")!;
}

async function views(h: InstallHarness) {
  const readOnly = getInstallationStatus(h.inst, h.services, { readOnly: true, client: h.ctx.client });
  const live = getInstallationStatus(h.inst, h.services, { client: h.ctx.client });
  const state = await h.ok("get_state");
  const status = await h.ok("get_installation_status");
  const component = await h.ok("get_installation_component", { component: "OPERATOR_ALERTS" });
  const next = await h.ok("get_next_installation_step");
  const health = await h.ok("check_runtime_health");
  return { readOnly, live, state, status, component, next, health };
}

function expectSameHealth(
  seen: Awaited<ReturnType<typeof views>>,
  expected: { state: string; summary: string; action: string; failed: number; retrying: number },
) {
  const readOnly = alertsOf(seen.readOnly);
  const live = alertsOf(seen.live);
  const fromStatus = alertsOf(seen.status);
  expect(readOnly).toMatchObject({ state: expected.state, summary: expected.summary });
  expect(live.state).toBe(readOnly.state);
  expect(live.summary).toBe(readOnly.summary);
  expect(live.next?.action).toBe(readOnly.next?.action);
  expect(live.next?.operatorMessage).toBe(readOnly.next?.operatorMessage);
  expect(live.next?.tool).toBe(readOnly.next?.tool);
  expect(fromStatus).toMatchObject({ state: expected.state, summary: expected.summary });
  expect(fromStatus.next?.action).toBe(readOnly.next?.action);
  expect(fromStatus.next?.operatorMessage).toBe(readOnly.next?.operatorMessage);
  expect(fromStatus.next?.tool).toBe(readOnly.next?.tool);
  expect(seen.component).toMatchObject({ state: expected.state, summary: `Tour updates: ${expected.summary}` });
  expect(seen.state.alerts.summary).toBe(expected.summary);
  expect(seen.state.nextStep.action).toBe(expected.action);
  expect(seen.next.action).toBe(expected.action);
  expect(seen.status.nextStep.action).toBe(expected.action);
  const delivery = seen.health.technical.alertDelivery;
  expect(delivery).toMatchObject({ failed: expected.failed, retrying: expected.retrying });
  expect(seen.readOnly.components.find((item) => item.component === "OPERATOR_ALERTS")?.technical).toEqual(
    seen.live.components.find((item) => item.component === "OPERATOR_ALERTS")?.technical,
  );
  expect(expected.state === "DEGRADED").toBe(delivery.failed > 0 || delivery.retrying > 0);
  expect(JSON.stringify(seen.state)).not.toMatch(SETUP);
}

describe("operator alert recovery", () => {
  it("one failed update is degraded on every view, and a passing test makes every view ready", async () => {
    const h = harness();
    const propertyId = await publishedWithAlerts(h);
    expect((await h.ok("get_state")).nextStep.action).toBe("ADD_ANOTHER_PROPERTY");

    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    const event = exceptionCreatedEvent({ propertyId, exceptionId: "exc_0123456789ab", occurredAt: new Date(h.now()).toISOString() });
    h.inst.outbox.enqueue(event);
    await h.inst.outbox.drain();
    expect(h.inst.outbox.get(event.eventId)?.status).toBe("failed");

    const degraded = await views(h);
    expectSameHealth(degraded, { state: "DEGRADED", summary: DEGRADED_SUMMARY, action: "TEST_OPERATOR_ALERTS", failed: 1, retrying: 0 });
    expect(degraded.state.nextStep).toMatchObject({ tool: "test_operator_alerts", say: DEGRADED_SAY });
    expect(degraded.next).toMatchObject({ tool: "test_operator_alerts", operatorMessage: DEGRADED_SAY });
    expect(degraded.readOnly.nextStep).toMatchObject({ tool: "test_operator_alerts", operatorMessage: DEGRADED_SAY });
    expect(alertsOf(degraded.status).next).toMatchObject({ tool: "test_operator_alerts", operatorMessage: DEGRADED_SAY });
    expect(degraded.state.playbook.text).toContain(`Say only this: ${DEGRADED_SAY}`);
    expect(degraded.state.playbook.text).toContain("Do not create a routine");
    expect(degraded.state.playbook.text).not.toContain("Ask one thing");
    expect(degraded.state.playbook.text).not.toContain("Ask only this");
    expect(degraded.state.playbook.step).toBe("alerts-degraded");

    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 202;
    const passed = await h.ok("test_operator_alerts");
    expect(passed.ok).toBe(true);

    const ready = await views(h);
    expectSameHealth(ready, { state: "READY", summary: READY_LINE, action: "ADD_ANOTHER_PROPERTY", failed: 0, retrying: 0 });
    expect(JSON.stringify(ready.state)).not.toMatch(/A tour update didn't reach you/);
  });

  it("a failing test with an address saved reconnects the existing routine, and no address falls back to first-time setup", async () => {
    const h = harness();
    const propertyId = await publishedWithAlerts(h);
    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    h.inst.outbox.enqueue(exceptionCreatedEvent({ propertyId, exceptionId: "exc_abcdefabcdef", occurredAt: new Date(h.now()).toISOString() }));
    await h.inst.outbox.drain();
    h.setClock(h.now() + 60_000);
    const failed = await h.ok("test_operator_alerts");
    expect(failed.ok).toBe(false);
    const component = await h.ok("get_installation_component", { component: "OPERATOR_ALERTS" });
    expect(component).toMatchObject({
      state: "ERROR",
      summary: "Tour updates: Tour updates aren't reaching you.",
      next: {
        action: "FIX_OPERATOR_ALERTS",
        tool: "get_secure_setup_url",
        operatorMessage: RECONNECT_SAY,
      },
    });
    expect(component.next.grokInstructions).toMatch(/overwrites the saved address and key with no history/);
    expect(component.next.grokInstructions).toMatch(/existing routine's address and key/);
    expect(component.next.grokInstructions).toMatch(/Never create a new routine/);
    const state = await h.ok("get_state");
    expect(state.nextStep).toMatchObject({ action: "FIX_OPERATOR_ALERTS", tool: "get_secure_setup_url", say: RECONNECT_SAY });
    expect(state.playbook.step).toBe("alerts-error");
    expect(state.playbook.text).toContain(`Say only this: ${RECONNECT_SAY}`);
    expect(state.playbook.text).not.toContain("Ask one thing");
    expect(state.playbook.text).not.toContain("Ask only this");
    expect(state.playbook.text).not.toContain("Create the Tour Core Operator Updates routine");
    expect(JSON.stringify(state)).not.toMatch(/What ZIP code/);

    h.inst.secrets.delete(["TOURCORE_GROK_ROUTINE_URL"]);
    let fresh = await h.ok("get_state");
    expect(fresh.nextStep.say).not.toBe(RECONNECT_SAY);
    expect(fresh.playbook.text).not.toContain("I'll send you a secure link to reconnect them");
    for (let i = 0; i < 16 && fresh.nextStep.say !== GROK_ALERTS_SAY; i++) {
      const say = String(fresh.nextStep.say);
      const id = (fresh.setup as { propertyId?: string } | undefined)?.propertyId;
      const property = id ? { property: id } : {};
      if (/zip/i.test(say)) await h.ok("save_property", { ...property, postalCode: "11215" });
      else if (/did i get that right/i.test(say)) await h.ok("save_property", { ...property, confirmAddress: true });
      else if (/what state/i.test(say)) await h.ok("save_property", { ...property, state: "NY" });
      else if (/what city/i.test(say)) await h.ok("save_property", { ...property, city: "Brooklyn" });
      else if (FACT_TOPICS.some((t) => FACT_QUESTIONS[t] === say)) await h.ok("save_facts", { ...property, topic: FACT_TOPICS.find((t) => FACT_QUESTIONS[t] === say)!, skip: true });
      else break;
      fresh = await h.ok("get_state");
    }
    expect(fresh.nextStep.say).toBe(GROK_ALERTS_SAY);
    expect(fresh.playbook.step).toBe("alerts");
    expect(fresh.playbook.text).toContain("create the Tour Core Operator Updates routine");
    expect(fresh.nextStep.say).not.toBe(RECONNECT_SAY);
  });

  it("waits to say the degraded line until the endpoint check and the Grok connection are done", async () => {
    const h = harness();
    completeInfrastructure(h);
    await h.ok("set_notification_preferences", { preset: "recommended" });
    const propertyId = await h.setUpAlfredWay();
    await h.ok("save_property", { property: propertyId, postalCode: "11215" });
    const addressed = await h.ok("get_state");
    if (/did i get that right/i.test(String(addressed.nextStep.say))) await h.ok("save_property", { property: propertyId, confirmAddress: true });
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    h.inst.outbox.enqueue(exceptionCreatedEvent({ propertyId, exceptionId: "exc_aa11bb22cc01", occurredAt: new Date(h.now()).toISOString() }));
    await h.inst.outbox.drain();
    const saved = h.inst.files.state();
    delete saved.publicEndpointCheck;
    h.inst.files.writeState(saved);

    const endpoint = await h.ok("get_state");
    expect(endpoint.nextStep).toMatchObject({ action: "CHECK_PUBLIC_ENDPOINT", tool: "get_state", say: SHARED_STEPS.starting.ask });
    expect(endpoint.playbook.step).toBe("starting");
    expect(endpoint.nextStep.say).not.toBe(DEGRADED_SAY);

    markChecked(h, "endpoint");
    h.inst.grants.revokeAll();
    const connect = await h.ok("get_state");
    expect(connect.nextStep).toMatchObject({ action: "CONNECT_GROK", tool: "get_state", say: SHARED_STEPS.connect.ask });
    expect(connect.playbook.step).toBe("connect");
    expect(connect.nextStep.say).not.toBe(DEGRADED_SAY);

    h.connectGrok();
    const degraded = await h.ok("get_state");
    expect(degraded.nextStep).toMatchObject({ action: "TEST_OPERATOR_ALERTS", tool: "test_operator_alerts", say: DEGRADED_SAY });
    expect(degraded.playbook.step).toBe("alerts-degraded");
  });

  it("stays degraded after a later ordinary delivery until a test passes", async () => {
    const h = harness();
    const propertyId = await publishedWithAlerts(h);
    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    h.inst.outbox.enqueue(exceptionCreatedEvent({ propertyId, exceptionId: "exc_aa11bb22cc02", occurredAt: new Date(h.now()).toISOString() }));
    await h.inst.outbox.drain();
    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 202;
    h.inst.outbox.enqueue(exceptionCreatedEvent({ propertyId, exceptionId: "exc_aa11bb22cc03", occurredAt: new Date(h.now()).toISOString() }));
    await h.inst.outbox.drain();

    const still = await views(h);
    expectSameHealth(still, { state: "DEGRADED", summary: DEGRADED_SUMMARY, action: "TEST_OPERATOR_ALERTS", failed: 1, retrying: 0 });

    h.setClock(h.now() + 60_000);
    expect((await h.ok("test_operator_alerts")).ok).toBe(true);
    const ready = await views(h);
    expectSameHealth(ready, { state: "READY", summary: READY_LINE, action: "ADD_ANOTHER_PROPERTY", failed: 0, retrying: 0 });
  });

  it("a passing test clears a failure stamped ahead of the clock, and a newer miss still counts", async () => {
    const h = harness();
    const propertyId = await publishedWithAlerts(h);
    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    const event = exceptionCreatedEvent({ propertyId, exceptionId: "exc_aa11bb22cc04", occurredAt: new Date(h.now()).toISOString() });
    h.inst.outbox.enqueue(event);
    await h.inst.outbox.drain();
    const failed = h.inst.outbox.get(event.eventId)!;
    const skewed = new Date(h.now() + 60 * 60_000).toISOString();
    h.runtime.put("operator-events", event.eventId, { ...failed, lastAttemptAt: skewed });
    h.net.state.routineStatus = 202;
    expect((await h.ok("test_operator_alerts")).ok).toBe(true);
    expect(h.inst.files.state().operatorAlerts?.clearedFailures).toEqual([{ eventId: event.eventId, lastAttemptAt: skewed }]);
    const ready = await views(h);
    expectSameHealth(ready, { state: "READY", summary: READY_LINE, action: "ADD_ANOTHER_PROPERTY", failed: 0, retrying: 0 });

    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    h.inst.outbox.enqueue(exceptionCreatedEvent({ propertyId, exceptionId: "exc_aa11bb22cc05", occurredAt: new Date(h.now()).toISOString() }));
    await h.inst.outbox.drain();
    const again = await views(h);
    expectSameHealth(again, { state: "DEGRADED", summary: DEGRADED_SUMMARY, action: "TEST_OPERATOR_ALERTS", failed: 1, retrying: 0 });
    expect(h.inst.outbox.records().some((record) => record.lastAttemptAt === skewed)).toBe(true);
  });

  it("a fresh install still offers tour updates the first time", async () => {
    const h = harness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    markChecked(h, "endpoint");
    h.connectGrok();
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    markChecked(h, "messaging");
    h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: new Date(h.now()).toISOString() } });
    await h.setUpAlfredWay();
    let state = await h.ok("get_state");
    for (let i = 0; i < 16 && state.nextStep.say !== GROK_ALERTS_SAY; i++) {
      const say = String(state.nextStep.say);
      const propertyId = (state.setup as { propertyId?: string } | undefined)?.propertyId;
      const property = propertyId ? { property: propertyId } : {};
      if (/zip/i.test(say)) await h.ok("save_property", { ...property, postalCode: "11215" });
      else if (/did i get that right/i.test(say)) await h.ok("save_property", { ...property, confirmAddress: true });
      else if (/what state/i.test(say)) await h.ok("save_property", { ...property, state: "NY" });
      else if (/what city/i.test(say)) await h.ok("save_property", { ...property, city: "Brooklyn" });
      else if (FACT_TOPICS.some((t) => FACT_QUESTIONS[t] === say)) await h.ok("save_facts", { ...property, topic: FACT_TOPICS.find((t) => FACT_QUESTIONS[t] === say)!, skip: true });
      else break;
      state = await h.ok("get_state");
    }
    expect(state.nextStep).toMatchObject({ action: "OFFER_OPERATOR_ALERTS", say: GROK_ALERTS_SAY });
    expect(state.playbook.text).toContain("create the Tour Core Operator Updates routine");
    expect(state.playbook.step).toBe("alerts");
  });
});
