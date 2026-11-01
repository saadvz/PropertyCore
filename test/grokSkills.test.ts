import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/tourCoreConfig";
import { publicHealth } from "../src/install/checks";
import { handleSecureSetupApi } from "../src/install/secureSetup";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { fakeSendblue } from "./fakeSendblue";
import { at, GRANT_9AM, grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET } from "./installHarness";

/**
 * One deterministic scenario per Grok operator skill. Each follows the
 * skill's own sequence: the operator's words (comments), the tool calls the
 * skill prescribes (through the MCP bridge, as Grok Bot makes them), and what
 * Tour Core returns for Grok to say. No Grok account, network or model involved.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/**
 * A Grok Bot session running one skill through MCP tools/call.
 * The engine scenarios still call older tools here. allowed-tools on the
 * skill is the landlord (or QA) list, checked in grokTemplate.test.ts.
 */
function skillSession(_skill: string, h: GrokHarness = grokHarness()) {
  cleanups.push(h.cleanup);
  const used: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    used.push(name);
    const reply = (await h.mcp("tools/call", { name, arguments: args })).body as { result: { isError: boolean; structuredContent?: unknown; content: Array<{ text: string }> } };
    return reply.result.isError ? { error: reply.result.content[0]!.text } : reply.result.structuredContent;
  };
  const yes = async (name: string, args: Record<string, unknown>) => {
    const asked = await tool(name, args);
    expect(asked.status).toBe("needs-confirmation");
    return { asked, done: await tool(name, { ...args, confirmationCode: asked.confirmation.code }) };
  };
  return { h, tool, yes, used };
}

describe("Grok skill scenarios", () => {
  it("Setup Property: a natural operator conversation creates a valid setup and ends published", async () => {
    const { h, tool, yes } = skillSession("setup-property");
    // "I want to set up my building."  Grok: "Sure. What's the address?"
    expect((await tool("list_properties")).properties).toEqual([]);
    // "100 Alfred Way, Brooklyn NY."
    const created = await tool("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    expect(created.summary).toBe("Started 100 Alfred Way. I'm using Eastern time for tours. You can change that anytime. What ZIP code should I use?");
    expect(created.summary.match(/\?/g) ?? []).toHaveLength(1);
    // "Two units, 101 and 102." / "The lobby entrance." / "No hallway doors."
    await tool("add_unit", { name: "Unit 101", description: "One-bedroom" });
    await tool("add_unit", { name: "Unit 102", description: "Two-bedroom" });
    // "101 is 1 bed 1 bath for $1,950 and 102 is 2 bed 1 bath for $2,400." → only availability is missing.
    const details = await tool("set_unit_details", { details: "101 is 1 bed 1 bath for $1,950 and 102 is 2 bed 1 bath for $2,400." });
    expect(details.nextQuestion).toBe("When are these units available?");
    // "Both now."
    const complete = await tool("set_unit_details", { units: [{ unit: "101", availability: "now" }, { unit: "102", availability: "now" }] });
    expect(complete.lines).toEqual(["Unit 101 — 1 bed · 1 bath · $1,950/month · available now", "Unit 102 — 2 bed · 1 bath · $2,400/month · available now"]);
    await tool("add_door", { name: "Lobby Entrance", kind: "entrance" });
    for (const unit of ["101", "102"]) {
      const preview = await tool("preview_route", { unit, doors: ["lobby entrance", "unit door"] });
      expect(preview.status).toBe("ok");
      // "Yep."
      await tool("set_route", { unit, doors: preview.route });
    }
    // "Weekdays, 9 to 5."
    expect((await tool("set_tour_hours", { days: "weekdays", start: "9", end: "5" })).summary).toBe("Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day.");
    // "Basic form."  "Real texts."  (Sendblue isn't connected in this test, so stay on practice texts.)
    await tool("set_verification_policy", { level: "basic-form" });
    expect((await tool("get_services")).records.choices.map((c: { label: string }) => c.label)).toEqual(["On this computer", "A folder in your Google Drive"]);
    const help = await tool("review_property_setup");
    expect(help.nextQuestion).toBe("What number can stuck visitors call? Pick one someone answers during tour hours.");
    await tool("update_property_details", { skipVisitorHelp: true });

    const review = await tool("review_property_setup");
    expect(review).toMatchObject({ canSave: true, problems: [], saved: "All changes saved" });
    expect(review.lines).toEqual(expect.arrayContaining(["Visitors can call: not set"]));
    expect(review.lines.join("\n")).not.toMatch(/Support email/);
    expect(review.nextQuestion).toBeUndefined();
    expect(validateConfig(h.workspace.load("prop_100_alfred_way").config)).toEqual([]);
    // "Yes." Grok: "Great. I'll check the setup and run a practice tour before publishing."
    expect((await tool("run_readiness_check")).passed).toBe(true);
    expect((await tool("run_dry_tour")).passed).toBe(true);
    const { asked, done } = await yes("publish_demo_property", {});
    expect(asked.summary).toBe("Everything passed. Do you want me to publish 100 Alfred Way for demo?");
    expect(done.published).toBe(true);
  });

  it("Map Route: an ambiguous route gets a question back, and nothing is saved until it's clear", async () => {
    const h = grokHarness();
    const { tool } = skillSession("map-route", h);
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_door", { name: "Garden Entrance", kind: "entrance" });
    await h.ok("add_door", { name: "Second Floor Hallway", kind: "hallway" });
    await h.ok("add_unit", { name: "Unit 201" });

    // "Unit 201 uses the entrance, then the hallway, then the unit door."
    expect((await tool("list_doors")).doors.map((d: { name: string }) => d.name)).toEqual(["Garden Entrance", "Lobby Entrance", "Second Floor Hallway", "Unit 201 Door"]);
    const first = await tool("preview_route", { unit: "201", doors: ["the entrance", "hallway", "unit door"] });
    expect(first.status).toBe("needs-clarification");
    expect(first.summary).toBe('"the entrance" could be Garden Entrance or Lobby Entrance. Which one?');
    expect((await tool("get_route", { unit: "201" })).route).toBeUndefined();

    // "The garden one."
    const second = await tool("preview_route", { unit: "201", doors: ["garden entrance", "hallway", "unit door"] });
    expect(second.summary).toBe("I have: Garden Entrance \u2192 Second Floor Hallway \u2192 Unit 201 Door. Is that right?");
    // "Yes."
    await tool("set_route", { unit: "201", doors: second.route, directions: "Up the stairs on the left" });
    expect(await tool("get_route", { unit: "201" })).toMatchObject({ route: ["Garden Entrance", "Second Floor Hallway", "Unit 201 Door"], directions: "Up the stairs on the left" });
  });

  it("Run Readiness Check: a real failure is surfaced as-is, then passes once fixed", async () => {
    const h = grokHarness();
    const { tool } = skillSession("run-readiness-check", h);
    await h.setUpAlfredWay();
    // Real texts chosen, but this computer has no Sendblue set up: the real messaging check fails.
    await h.ok("set_services", { messaging: "sendblue" });
    const failing = await tool("run_readiness_check");
    expect(failing.passed).toBe(false);
    const messaging = failing.checks.find((c: { check: string }) => c.check === "Visitor messaging");
    expect(messaging.ok).toBe(false);
    expect(messaging.problems.length).toBeGreaterThan(0);
    expect(failing.lines.filter((l: string) => l.startsWith("\u2717"))).toHaveLength(1);
    expect(JSON.stringify(failing)).not.toMatch(/SENDBLUE_|_NOT_|CHECK_FAILED/);

    // Operator: "Use practice texts for now."
    await h.ok("set_services", { messaging: "demo" });
    expect((await tool("run_readiness_check")).passed).toBe(true);
  });

  it("Simulate Tour: a successful practice tour with its proof points, and nobody texted", async () => {
    const h = grokHarness();
    const { tool } = skillSession("simulate-tour", h);
    await h.setUpAlfredWay();
    const result = await tool("run_dry_tour", { unit: "Unit 102" });
    expect(result.passed).toBe(true);
    expect(result.proofPoints).toContain("\u2713 Unit 102 access was allowed");
    expect(result.proofPoints).toContain("\u2713 Unit 101 Door (not on the route) was turned away before any door was unlocked");
    expect(result.proofPoints).toContain("\u2713 The 15-minutes-left questions text was sent");
    expect(result.proofPoints).toContain("\u2713 The 5-minute extra-time offer was sent");
    expect(result.proofPoints).toContain("\u2713 A one-time 10-minute extension was granted");
    expect(result.proofPoints).toContain("\u2713 The tour-end text was sent (no extra time taken)");
    expect(result.proofPoints).toContain("\u2713 The 5-minutes-after check-in was sent");
    expect(result.proofPoints).toContain("\u2713 The tour was closed 15 minutes after the end");
    expect(result.proofPoints.every((p: string) => p.startsWith("\u2713"))).toBe(true);
    expect(h.visitors.all()).toHaveLength(0);
  });

  it("Work Exception: an unknown visitor question shows up in the queue and the operator resolves it", async () => {
    const h = grokHarness();
    const { tool, yes } = skillSession("work-exception", h);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is parking included?" });

    // "Show active tours."
    const [tour] = (await tool("list_active_tours")).tours;
    expect(tour).toMatchObject({ visitorName: "Pat Smith", unitName: "Unit 101", status: "Touring" });
    // "What's happening with Pat's tour?"
    const inspected = await tool("inspect_tour", { tourRef: tour.tourRef });
    expect(inspected.needsAttention).toHaveLength(1);
    expect(inspected.tour.questions.at(-1)).toContain('Pat asked "Is parking included?"');
    expect(inspected.tour.accessGrants).toEqual(
      expect.arrayContaining([
        { doorName: "Lobby Entrance", ...GRANT_9AM, tourRef: tour.tourRef, unitName: "Unit 101" },
        { doorName: "Unit 101 Door", ...GRANT_9AM, tourRef: tour.tourRef, unitName: "Unit 101" },
      ]),
    );

    // "Show me what needs attention."
    const queue = await tool("list_exceptions");
    expect(queue.exceptions.map((x: { visitorName: string; unitName: string; summary: string; tourStatus: string }) => [x.visitorName, x.unitName, x.summary, x.tourStatus])).toEqual([
      ["Pat Smith", "Unit 101", 'They asked: "Is parking included?" There\'s no approved answer yet.', "Tour still active"],
    ]);
    // "Open Pat's issue."
    const opened = await tool("inspect_exception", { exceptionId: queue.exceptions[0].exceptionId });
    expect(opened.issue.recentMessages.at(-1).text).toContain("I'll pass your question to the property team, and they'll reply here as soon as they can.");
    // "Yes, parking is included."  Grok offers; "Yes."
    const { asked, done } = await yes("answer_flagged_question", { exceptionId: opened.issue.exceptionId, approvedFact: "Parking is included." });
    expect(asked.visitorWillReceive).toBe("Parking is included. Let me know if you have any other questions.");
    expect(done.visitorAnswered).toBe(true);
    expect((await tool("list_exceptions")).summary).toBe("Nothing needs attention right now.");
  });

  it("Work Exception: a door-system failure and a tour that couldn't be restored both reach the queue, and access stays blocked", async () => {
    const h = grokHarness();
    h.services.needsAttention = () => [{ visitorPhone: "+15550104444", problem: "The reservation doesn't belong to this visitor.", at: new Date(at(8)).toISOString() }];
    const { tool, yes } = skillSession("work-exception", h);
    const id = await h.publish();
    const v = await h.visitor(id);
    await v.act("chooseTime", { slotStart: v.slot().toISOString() });
    await v.act("consent", { agree: true });
    await v.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    h.setClock(v.slot().getTime());
    v.session.durin.requestAccess = async () => ({ ok: false, reason: "lock offline" });
    await v.act("arrive");

    const queue = await tool("list_exceptions");
    const byWhat = Object.fromEntries(queue.exceptions.map((x: { what: string }) => [x.what, x]));
    expect(byWhat["Door system problem"]).toMatchObject({ summary: "The door system couldn't open Lobby Entrance, so the tour was paused.", accessBlocked: true, tourStatus: "Door system problem. Access is blocked." });
    expect(byWhat["Tour couldn't be restored"]).toMatchObject({ visitorName: "(555) 010-4444", accessBlocked: true });

    // "The lock's back. Resume Pat's tour." "Yes."
    const [tour] = (await tool("list_active_tours")).tours;
    expect(tour.paused).toBe(true);
    await yes("clear_operator_hold", { tourRef: tour.tourRef });
    // "I called the restored-tour visitor." -> mark handled
    await tool("resolve_exception", { exceptionId: byWhat["Tour couldn't be restored"].exceptionId, resolutionNote: "Called them back." });
    // The door-system pause no longer applies once resumed; it stays in the history as cleared.
    expect((await tool("list_exceptions")).exceptions).toEqual([]);
    const history = (await tool("list_exceptions", { includeHandled: true })).exceptions.map((x: { what: string; status: string }) => [x.what, x.status]);
    expect(history).toEqual(expect.arrayContaining([["Door system problem", "cleared"], ["Tour couldn't be restored", "resolved"]]));
  });

  it("Export Audit: a validated audit export with a plain summary", async () => {
    const h = grokHarness();
    const { tool } = skillSession("export-audit", h);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("finish");
    // "Export today's audit."
    const out = await tool("export_audit", { day: "today" });
    expect(out.totals).toMatchObject({ tours: 1, completed: 1, practiceTours: 1, openIssues: 0 });
    expect(out.reference).toMatch(/^Audit export 2026-09-28_.+, saved with 100 Alfred Way's tour records on the Tour Core computer\.$/);
    expect(out.files.map((f: { file: string }) => f.file)).toEqual(["audit-export.json", "audit.csv"]);
    expect(
      out.accessGrants.some(
        (g: { doorName: string; allowedAt: string; allowedAtIso: string; validFrom: string; validFromIso: string; validUntil: string; validUntilIso: string }) =>
          g.doorName === "Lobby Entrance" &&
          g.allowedAt === GRANT_9AM.allowedAt &&
          g.allowedAtIso === GRANT_9AM.allowedAtIso &&
          g.validFrom === GRANT_9AM.validFrom &&
          g.validFromIso === GRANT_9AM.validFromIso &&
          g.validUntil === GRANT_9AM.validUntil &&
          g.validUntilIso === GRANT_9AM.validUntilIso &&
          g.allowedAtIso >= g.validFromIso,
      ),
    ).toBe(true);
    // The same export can be opened from the browser app's API on the Tour Core computer.
    const { handleApi } = await import("../src/web/api");
    const exportId = /^Audit export (\S+),/.exec(out.reference)![1]!;
    const file = await handleApi({ workspace: h.workspace, dev: false }, "GET", `/api/properties/${id}/audit-exports/${exportId}/audit-export.json`, undefined);
    expect("download" in file && JSON.parse(file.download.content).summary.tours).toBe(1);
  });
});

describe("Install Tour Core skill", () => {
  const text = readFileSync(new URL("../.grok/skills/install-tour-core/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const sequence = text.slice(text.indexOf("## Sequence"), text.indexOf("## Validate"));
  const phase = (n: number) => sequence.slice(sequence.indexOf(`### Phase ${n}:`), sequence.indexOf(`### Phase ${n + 1}:`) > 0 ? sequence.indexOf(`### Phase ${n + 1}:`) : undefined);

  it("has the seven phases in order: bootstrap, connect, infrastructure, property, validate, publish, operate", () => {
    const names = ["Bootstrap", "Connect", "Infrastructure", "Property", "Validate", "Publish", "Operate"];
    const positions = names.map((n, i) => sequence.indexOf(`### Phase ${i + 1}: ${n}`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sequence).toMatch(/always forward/);
  });

  it("checks status before installing, and bootstraps only when Tour Core isn't answering", () => {
    const p1 = phase(1);
    expect(p1.indexOf("get_state")).toBeGreaterThan(-1);
    expect(p1.indexOf("get_state")).toBeLessThan(p1.indexOf("npm run bootstrap:grok"));
    expect(p1).toMatch(/don't reinstall a running Tour Core/);
  });

  it("fresh install: the operator only approves the connection, and Grok continues on its own afterwards", () => {
    const p2 = phase(2);
    expect(p2).toMatch(/I need your approval to connect/);
    expect(p2).toMatch(/Check that the codes match and click Allow/);
    expect(p2).toMatch(/As soon as it's approved, without waiting to be asked/);
    expect(p2).toMatch(/I'm checking the rest of the setup/);
    expect(p2).toMatch(/old Tour Core connection left over from\s+before is an exception/);
  });

  it("follows get_next_installation_step while infrastructure is incomplete, never offering alternatives or property setup early", () => {
    const p3 = phase(3);
    expect(p3).toContain("get_state");
    expect(p3).toMatch(/While `infrastructureReady` is false/);
    expect(p3).toMatch(/don't offer other setup, alternatives or shortcuts/);
    expect(p3).toMatch(/don't ask the operator what to do next/);
    expect(p3).toMatch(/don't start property setup/);
    expect(p3).toMatch(/Visitor texting is part of this phase: it's connected and tested before any\s+property/);
    expect(phase(4)).toMatch(/your first property\?/);
    expect(phase(4)).toMatch(/Alerts are not part of this: they come\s+later and are never required/);
    expect(text).not.toMatch(/doesn't depend on|if you'd rather|what (would you like|should we) (to )?do next\?/i);
  });

  it("runs readiness and the practice tour automatically, needs an explicit yes to publish, then talks about operating", () => {
    expect(phase(5)).toMatch(/without asking\s+whether to skip them/);
    expect(phase(6)).toMatch(/Publish only after a clear yes/);
    expect(phase(6)).toMatch(/wait for the result/);
    expect(phase(6)).toMatch(/already published changes\s+nothing/);
    expect(phase(6)).toMatch(/get_state/);
    // The operator hears that door access is still a demo, so no lock opens.
    expect(phase(7)).toMatch(/Door access is still in\s+(?:> )?demo mode/);
    expect(phase(7)).toMatch(/no physical locks will open/);
    const said = text.split("\n").filter((l) => l.startsWith(">")).join(" ");
    expect(said).not.toMatch(/everything (runs|is) in demo mode/i);
  });

  it("keeps infrastructure out of normal conversation and never asks for a secret in chat", () => {
    expect(text).toMatch(/In normal conversation never mention addresses or links/);
    const requests = [
      /\b(paste|send|share|give|tell|type)\b[^.\n]{0,20}\b(me|us|here)\b[^.\n]{0,40}\b(key|secret|token|password|credential)s?\b/i,
      /\bwhat(?:'s| is) your\b[^.\n]{0,30}\b(key|secret|token|password)\b/i,
    ];
    for (const pattern of requests) expect(text).not.toMatch(pattern);
    expect(text).toMatch(/not in chat/);
    expect(text).toMatch(/Prefer Grok's secure secret input/);
    expect(text).toMatch(/they won't be shown to me in chat/);
    expect(text).toMatch(/hand\s+the browser to the operator/i);
    expect(text).not.toMatch(/github\.com\/[\w.-]+\/[\w.-]+/i);
    expect(text).toContain("TOURCORE_REPO_URL");
    expect(text.slice(0, text.indexOf("## Never"))).not.toMatch(/(?<!never )ask (the operator|them) to run/i);
    // Quoted lines are what Grok says to the operator: no technical words.
    const quoted = text.split("\n").filter((l) => l.startsWith(">")).join(" ");
    expect(quoted).not.toMatch(/\/mcp|trycloudflare|https?:\/\/|\bMCP\b|OAuth|tunnel|connector|\bnpm\b|localhost|\btools?\b|webhook/i);
  });

  it("scenario: \"Set up Tour Core\" from blank to published, in Tour Core's order, with the operator acting only where a person must", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    const { tool, used } = skillSession("install-tour-core", h);
    const hooks: Array<{ url: string }> = [];
    const fake = fakeSendblue({ hooks, lines: [{ sendblue_number: "+15550109999", status: "ONLINE" }] });
    const create = fake.client.webhooks.create.bind(fake.client.webhooks);
    fake.client.webhooks.create = async (body) => (hooks.push(...(body.webhooks as Array<{ url: string }>)), create(body));
    cleanups.push(setSendblueRuntime({ env: () => h.inst.sendblueEnv(), client: () => fake.client }));
    h.net.state.health = () => publicHealth(h.inst);
    const operatorFillsIn = async (url: string, body: Record<string, string>) => {
      const token = /#s=([^&]+)/.exec(url)![1]!;
      const route = url.includes("step=operator-alerts") ? "operator-alerts" : "visitor-messaging";
      expect((await handleSecureSetupApi({ installation: h.inst, services: h.services }, "POST", `/api/install/${route}`, { "x-tourcore-setup-session": token }, body)).status).toBe(200);
    };

    const first = await tool("get_installation_status");
    expect(used[0]).toBe("get_installation_status");
    const said: string[] = [];
    const performed: string[] = [];
    let step = first.nextStep;
    for (let i = 0; i < 25 && step.action !== "ADD_ANOTHER_PROPERTY" && step.action !== "DONE"; i++) {
      performed.push(`${step.action}:${step.performedBy}`);
      said.push(step.operatorMessage);
      switch (step.action) {
        case "ESTABLISH_PUBLIC_ENDPOINT": // Grok runs the bootstrap (bootstrap.test.ts); here, its outcome.
          h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
          h.inst.files.setPublicBaseUrl("https://brave-otter-lamp.trycloudflare.com", "CLOUDFLARE_QUICK_TUNNEL");
          break;
        case "CONNECT_GROK":
          h.connectGrok(); // the operator clicks Allow
          break;
        case "CHOOSE_MESSAGING_PROVIDER":
          expect(step.choices?.map((c: { id: string }) => c.id)).toEqual(["sendblue", "twilio", "photon"]);
          expect(step.operatorMessage).toMatch(/How would you like prospects to text/);
          await tool("choose_messaging_provider", { provider: "sendblue" });
          break;
        case "CONNECT_GOOGLE_DRIVE":
          expect(step.operatorMessage).toMatch(/connecting Google Drive/);
          expect(step.operatorMessage).not.toMatch(/password|token|api key/i);
          expect(step.grokInstructions).toMatch(/Google Drive connector/);
          await tool("use_local_demo_storage");
          break;
        case "SET_UP_PROPERTY": // "Yes." → Setup Property skill
          await h.setUpAlfredWay();
          break;
        case "OFFER_OPERATOR_ALERTS": // "Sure, use the defaults." → Grok saves the choice, creates the routine, opens secure setup
          await tool("set_notification_preferences", { preset: "recommended" });
        // falls through
        case "CONNECT_OPERATOR_ALERTS":
        case "CONNECT_VISITOR_MESSAGING": {
          const link = await tool("get_secure_setup_url", { step: step.secureSetupStep });
          await operatorFillsIn(link.url, step.secureSetupStep === "operator-alerts" ? { webhookUrl: ROUTINE_URL, key: ROUTINE_KEY } : { apiKey: SB_KEY, apiSecret: SB_SECRET, fromNumber: "+15550109999" });
          break;
        }
        case "RUN_READINESS":
          expect((await h.ok("run_readiness_check")).passed).toBe(true);
          break;
        case "RUN_PRACTICE_TOUR":
          expect((await h.ok("run_dry_tour")).passed).toBe(true);
          break;
        case "PUBLISH":
          await h.approve("publish_demo_property", {}); // explicit yes
          break;
        default:
          expect(step.performedBy).toBe("GROK");
          expect((await tool(step.tool)).ok).not.toBe(false);
      }
      step = (await tool("get_next_installation_step")) as typeof step;
    }
    expect(performed).toEqual([
      "ESTABLISH_PUBLIC_ENDPOINT:GROK",
      "CHECK_PUBLIC_ENDPOINT:GROK",
      "CONNECT_GROK:OPERATOR",
      "CHOOSE_MESSAGING_PROVIDER:OPERATOR_DECISION",
      "CONNECT_VISITOR_MESSAGING:OPERATOR_IN_SECURE_SETUP",
      "CONNECT_GOOGLE_DRIVE:OPERATOR_DECISION",
      "SET_UP_PROPERTY:OPERATOR_DECISION",
      "OFFER_OPERATOR_ALERTS:OPERATOR_DECISION",
      "RUN_READINESS:GROK",
      "RUN_PRACTICE_TOUR:GROK",
      "PUBLISH:OPERATOR_DECISION",
    ]);
    expect(said).toContain("Everything needed to start is connected and tested. Would you like to add your first property?");
    // The property used the installed texting on its own: nobody was asked how to text people.
    expect(h.workspace.load("prop_100_alfred_way").config.messagingMode).toBe("live");
    expect(step.action).toBe("ADD_ANOTHER_PROPERTY");
    expect(step.phase).toBe("OPERATE");
    expect(step.tool).toBe("create_property_setup");
    expect(step.operatorMessage).toBe(
      "Your property is published. Visitor texting is live. Visitors text +15550109999 to book a tour. Door access is still in demo mode, so no physical locks will open. I'll keep you updated on your tours and let you know when something needs your attention. Would you like to set up another property?",
    );
    const seen = JSON.stringify(await tool("get_installation_status")) + JSON.stringify(first);
    for (const secret of [SB_KEY, SB_SECRET, ROUTINE_URL, ROUTINE_KEY]) expect(seen).not.toContain(secret);
  });
});

