import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportBundleSchema } from "../src/export/exportBundle";
import { mcpToolList } from "../src/mcp/mcpBridge";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { VisitorDenialCopy } from "../src/core/TourCore";
import { ConfirmationBook } from "../src/operator/confirmations";
import { OPERATOR_TOOLS, redactSecrets } from "../src/operator/tools";
import { OperatorTeamCopy, PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { sendblueEnv } from "./fakeSendblue";
import { tourRef } from "../src/operator/tours";
import { at, DENIAL_9AM, DENIAL_10AM, GRANT_9AM, GRANT_10AM, grokHarness, type GrokHarness } from "./grokHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function app(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

/** Every file under a folder, for "nothing else changed" checks. */
function snapshotFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(dir.length)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("operator tool contract: boundary", () => {
  it("has no tool that opens a door, mints access or writes records directly", () => {
    const names = OPERATOR_TOOLS.map((t) => t.name);
    for (const name of names) expect(name).not.toMatch(/unlock|open|grant|mint|request_access|credential|raw|write_record|file/);
    for (const t of mcpToolList()) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props).not.toContain("doorId");
      expect(props).not.toContain("grantRef");
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("refuses tools that don't exist, such as a direct unlock", async () => {
    const h = app();
    const reply = await h.mcp("tools/call", { name: "unlock_door", arguments: { door: "Unit 102 Door" } });
    expect(reply.body).toMatchObject({ error: { code: -32602 } });
    await expect(h.call("request_access", { doorId: "unit_102_door" })).rejects.toThrow(/no Tour Core tool/);
  });

  it("validates input and rejects anything extra, so no hidden access fields slip through", async () => {
    const h = app();
    await h.setUpAlfredWay();
    expect(await h.fails("add_door", { name: "Side Door", kind: "entrance", doorId: "side" })).toMatch(/unexpected doorId.*Nothing was changed/);
    expect(await h.fails("add_door", { name: "Side Door", kind: "garage" })).toMatch(/kind/);
    expect(await h.fails("set_route", { unit: "Unit 101" })).toMatch(/doors/);
    expect(await h.fails("revoke_tour_access", { tourRef: "prop_100_alfred_way~x", reason: "x", doorId: "unit_101_door" })).toMatch(/unexpected doorId/);
    expect(h.workspace.load("prop_100_alfred_way").config.doors.map((d) => d.name)).toEqual(["Lobby Entrance", "Unit 101 Door", "Unit 102 Door"]);
  });

  it("never returns configured credentials", async () => {
    const secrets = { SENDBLUE_API_API_KEY: "sb-key-SENTINEL-111", SENDBLUE_API_API_SECRET: "sb-secret-SENTINEL-222", SENDBLUE_WEBHOOK_SECRET: "hook-SENTINEL-333", TOURCORE_OPERATOR_TOKEN: "op-token-SENTINEL-444" };
    const before = { ...process.env };
    Object.assign(process.env, secrets);
    cleanups.push(() => {
      for (const k of Object.keys(secrets)) delete process.env[k];
      Object.assign(process.env, before);
    });
    cleanups.push(setSendblueRuntime({ env: () => sendblueEnv({ apiKey: secrets.SENDBLUE_API_API_KEY, apiSecret: secrets.SENDBLUE_API_API_SECRET, webhookSecret: secrets.SENDBLUE_WEBHOOK_SECRET }) }));
    const h = app();
    await h.setUpAlfredWay();
    await h.ok("set_services", { messaging: "sendblue" });
    const outputs = [];
    for (const t of OPERATOR_TOOLS.filter((t) => t.kind === "read" && !t.input.shape.tourRef && !t.input.shape.exceptionId && !t.input.shape.unit && !t.input.shape.tourTimeRequestId)) outputs.push(await h.call(t.name, {}));
    outputs.push(await h.call("get_route", { unit: "101" }));
    outputs.push(await h.mcp("tools/list"));
    const text = JSON.stringify(outputs);
    for (const s of Object.values(secrets)) expect(text).not.toContain(s);
    expect(redactSecrets({ leaked: `x ${secrets.TOURCORE_OPERATOR_TOKEN} y` })).toEqual({ leaked: "x [hidden] y" });
  });
});

describe("setup through the tools", () => {
  it("builds the same canonical setup the browser would, saved by Tour Core, not held by the agent", async () => {
    const h = app();
    const id = await h.setUpAlfredWay();
    const { config, state } = h.workspace.load(id);
    expect(config.property).toMatchObject({ name: "100 Alfred Way", timezone: "America/New_York" });
    expect(config.routes.map((r) => r.stops.map((s) => s.doorId))).toEqual([["lobby_entrance", "unit_101_door"], ["lobby_entrance", "unit_102_door"]]);
    expect(config.tourHours).toMatchObject({ days: ["MON", "TUE", "WED", "THU", "FRI"], start: "09:00", end: "17:00" });
    expect(state.status).toBe("DRAFT");

    const review = await h.ok("review_property_setup");
    expect(review.lines).toEqual(
      expect.arrayContaining([
        "100 Alfred Way, Brooklyn, NY",
        "Called: 100 Alfred Way",
        "Apartment building",
        "Unit 101",
        "  1 bed \u00b7 1 bath \u00b7 $1,950/month \u00b7 available now",
        "  Route: Lobby Entrance \u2192 Unit 101 Door",
        "Verification: Basic identity form (recommended)",
        "Visitor texting: Practice only (nobody is texted)",
        "Door access: Demo",
        "Visitors can call: not set",
      ]),
    );
    expect(review.lines.join("\n")).not.toMatch(/https?:|\/mcp|localhost/);
    expect(review.canSave).toBe(true);
  });

  it("saves a visitor help number without exposing the operator alert line", async () => {
    const h = app();
    const id = await h.setUpAlfredWay();
    const before = h.workspace.load(id).config.operator.contact;
    const saved = await h.ok("update_property_details", { visitorContact: "(555) 010-7777" });
    expect(saved.setup.visitorHelpNumber).toBe("(555) 010-7777");
    expect(saved.setup.alertsGoTo).toBe("property team");
    expect(JSON.stringify(saved)).not.toContain(before);
    expect(h.workspace.load(id).config.operator).toMatchObject({ contact: before, visitorContact: "+15550107777" });
    expect(await h.fails("update_property_details", { visitorContact: "12" })).toMatch(/full phone number/);
    await h.ok("update_property_details", { visitorContact: "" });
    expect(h.workspace.load(id).config.operator.visitorContact).toBeUndefined();
    expect((await h.ok("get_property_setup")).setup.visitorHelpNumber).toBeUndefined();
  });

  it("describes the alert name as a team name that reads naturally after \"the\"", () => {
    const tool = mcpToolList().find((t) => t.name === "update_property_details");
    const alertName = (tool?.inputSchema as { properties?: { alertName?: { description?: string } } }).properties?.alertName?.description;
    expect(alertName).toContain(OperatorTeamCopy.hint());
    expect(alertName).toContain("Rendered exactly as entered");
    expect(alertName).not.toMatch(/your own name/i);
  });

  it("saves a visitor help number and records an explicit skip of the optional help step", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY 11201", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await h.ok("update_property_details", { confirmAddress: true });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_unit", { name: "Unit 101" });
    await h.ok("set_unit_details", { details: "101 is 1 bed 1 bath for $1,950, available now." });
    await h.ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Unit 101 Door"] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await h.ok("set_verification_policy", { level: "basic-form" });

    const asked = await h.ok("review_property_setup");
    expect(asked.nextQuestion).toBe("What number can stuck visitors call? Pick one someone answers during tour hours.");
    expect(asked.lines).toEqual(expect.arrayContaining(["Visitors can call: not set"]));
    expect(asked.lines.join("\n")).not.toMatch(/Support email|supportEmail/);

    const saved = await h.ok("update_property_details", { visitorContact: "(555) 010-3333" });
    expect(saved.setup.visitorHelpNumber).toBe("(555) 010-3333");
    expect(saved.setup.supportEmail).toBeUndefined();
    expect(saved.nextQuestion).toBeUndefined();
    expect((await h.ok("review_property_setup")).lines).toEqual(expect.arrayContaining(["Visitors can call: (555) 010-3333"]));

    const other = grokHarness();
    cleanups.push(other.cleanup);
    await other.ok("create_property_setup", { address: "200 Other St, Brooklyn, NY 11201", name: "200 Other St", propertyType: "APARTMENT_BUILDING" });
    await other.ok("update_property_details", { confirmAddress: true });
    await other.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await other.ok("add_unit", { name: "Unit 1" });
    await other.ok("set_unit_details", { details: "1 is 1 bed 1 bath for $1,800, available now." });
    await other.ok("set_route", { unit: "Unit 1", doors: ["Lobby Entrance", "Unit 1 Door"] });
    await other.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await other.ok("set_verification_policy", { level: "basic-form" });
    const skipped = await other.ok("update_property_details", { skipVisitorHelp: true });
    expect(skipped.nextQuestion).toBeUndefined();
    expect(other.workspace.load(skipped.setup.propertyId).config.operator.visitorHelpDecided).toBe(true);
    expect((await other.ok("get_property_setup")).nextQuestion).toBeUndefined();
  });

  it("doesn't create a second property when the same address is sent again", async () => {
    const h = app();
    await h.setUpAlfredWay();
    const again = await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY" });
    expect(again.status).toBe("already-exists");
    expect(h.workspace.propertyIds()).toHaveLength(1);
  });

  it("maps routes from the operator's words but only saves exact, known doors", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_door", { name: "Garden Entrance", kind: "entrance" });
    await h.ok("add_unit", { name: "Unit 101" });

    const inferred = await h.ok("preview_route", { unit: "101", doors: ["the lobby", "unit door"] });
    expect(inferred).toMatchObject({ status: "ok", route: ["Lobby Entrance", "Unit 101 Door"], summary: "I have: Lobby Entrance \u2192 Unit 101 Door. Is that right?" });

    const ambiguous = await h.ok("preview_route", { unit: "Unit 101", doors: ["entrance", "unit door"] });
    expect(ambiguous).toMatchObject({ status: "needs-clarification", summary: '"entrance" could be Garden Entrance or Lobby Entrance. Which one?' });

    const unknown = await h.ok("preview_route", { unit: "Unit 101", doors: ["side door", "unit door"] });
    expect(unknown.status).toBe("unknown-doors");
    expect(unknown.summary).toContain("I don't have \"side door\" on file");

    const before = readFileSync(join(h.root, "properties", "prop_100_alfred_way", "draft.json"), "utf8");
    expect(await h.fails("set_route", { unit: "Unit 101", doors: ["lobby", "Unit 101 Door"] })).toBe('"lobby" isn\'t a door on file. Did you mean Lobby Entrance? Nothing was saved.');
    expect(await h.fails("set_route", { unit: "Unit 101", doors: ["Side Door", "Unit 101 Door"] })).toMatch(/isn't a door on file.*Nothing was saved/);
    expect(await h.fails("set_route", { unit: "Unit 101", doors: ["Unit 101 Door"] })).toBe("Unit 101's route needs to start at an entrance.");
    expect(readFileSync(join(h.root, "properties", "prop_100_alfred_way", "draft.json"), "utf8")).toBe(before);

    const saved = await h.ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Unit 101 Door"], directions: "Straight past the mailboxes" });
    expect(saved.summary).toBe("Saved Unit 101: Lobby Entrance \u2192 Unit 101 Door.");
    expect(h.workspace.list()).toHaveLength(1);
  });

  it("reads tour hours in everyday words and explains what it didn't understand", async () => {
    const h = app();
    await h.setUpAlfredWay();
    const hours = await h.ok("set_tour_hours", { days: "Mon-Sat", start: "10am", end: "6 PM", tourLength: "30 minutes", newTourEvery: "an hour" });
    expect(hours.summary).toBe("Monday-Saturday, 10:00 AM-6:00 PM. That's up to 8 tours a day.");
    expect(await h.fails("set_tour_hours", { days: "most days" })).toBe('I didn\'t understand the days "most days". Try "weekdays", "every day" or "Mon-Sat".');
  });

  it("offers messaging and records choices in plain words and won't pretend Google Drive works", async () => {
    const h = app();
    await h.setUpAlfredWay();
    const services = await h.ok("get_services");
    expect(services.messaging.choices[0]).toMatchObject({ choice: "live", recommended: true });
    expect(services.records.choices.find((c: { choice: string }) => c.choice === "google-drive")).toMatchObject({ available: false });
    expect(await h.fails("set_services", { records: "google-drive" })).toMatch(/Google Drive isn't available yet/);
    expect(await h.fails("set_services", { access: "durin" })).toMatch(/unexpected access/);
  });
});

describe("readiness, practice tour and publish", () => {
  it("surfaces a real readiness failure in plain language", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_unit", { name: "Unit 101" });
    await h.ok("add_unit", { name: "Unit 102" });
    await h.ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Unit 101 Door"] });
    const readiness = await h.ok("run_readiness_check");
    expect(readiness.passed).toBe(false);
    expect(readiness.lines).toContain("\u2717 Unit routes: Unit 102 does not have a complete route.");
    expect(readiness.lines).toContain("\u2713 Door access");
  });

  it("runs the real readiness check and practice tour and reports the proof points", async () => {
    const previous = process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    delete process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    const h = app();
    await h.setUpAlfredWay();
    const readiness = await h.ok("run_readiness_check");
    expect(readiness.lines).toEqual([
      "\u2713 Property details",
      "\u2713 Unit information",
      "\u2713 Tour hours",
      "\u2713 Unit routes",
      "\u2713 Verification",
      "\u2713 Messaging",
      "\u2713 Records",
      "\u2713 Door access",
      "\u2713 Audit/export",
      "No visitor help number is set, so stuck visitors can only text back.",
    ]);
    expect(readiness.passed).toBe(true);
    expect(readiness.advisories).toEqual(["No visitor help number is set, so stuck visitors can only text back."]);
    if (previous === undefined) delete process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    else process.env.TOURCORE_PUBLIC_CONTACT_EMAIL = previous;
    const practice = await h.ok("run_dry_tour");
    expect(practice.passed).toBe(true);
    expect(practice.proofPoints).toEqual([
      "\u2713 Booking worked",
      "\u2713 Consent to texts and tour records was recorded",
      "\u2713 Verification worked",
      "\u2713 Early arrival was denied",
      "\u2713 Entrance access was allowed at the right time",
      "\u2713 A repeated request didn't create a second access grant",
      "\u2713 Unit 101 access was allowed",
      "\u2713 Unit 102 Door (not on the route) was turned away before any door was unlocked",
      "\u2713 The 15-minutes-left questions text was sent",
      "\u2713 The 5-minute extra-time offer was sent",
      "\u2713 A one-time 10-minute extension was granted",
      "\u2713 Tour completed",
      "\u2713 Every door was locked again afterwards",
      "\u2713 Follow-up worked",
      "\u2713 The tour-end text was sent (no extra time taken)",
      "\u2713 The 5-minutes-after check-in was sent",
      "\u2713 The tour was closed 15 minutes after the end",
      "\u2713 Tour records were saved",
    ]);
  });

  it("won't publish without readiness and a practice tour, and only after an explicit yes for this exact setup", async () => {
    const h = app();
    const id = await h.setUpAlfredWay();
    const blocked = await h.ok("publish_demo_property");
    expect(blocked).toMatchObject({ published: false, status: "blocked", blockers: ["Run the readiness check first.", "Run a practice tour first."] });
    expect(blocked.confirmation).toBeUndefined();

    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    const asked = await h.ok("publish_demo_property");
    expect(asked).toMatchObject({ status: "needs-confirmation", summary: "Everything passed. Do you want me to publish 100 Alfred Way for demo?" });
    expect(h.workspace.load(id).state.status).toBe("DRAFT");

    expect(await h.fails("publish_demo_property", { confirmationCode: "ZZZZZZ" })).toMatch(/expired or was already used/);
    // A structural change after the question: the old yes no longer counts, and the gates apply again.
    const again = await h.ok("publish_demo_property");
    await h.ok("set_tour_hours", { end: "6pm" });
    const stale = await h.ok("publish_demo_property", { confirmationCode: again.confirmation.code });
    expect(stale.status).toBe("blocked");
    expect(h.workspace.load(id).state.status).toBe("DRAFT");

    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    const { done } = await h.approve("publish_demo_property", {});
    expect(done).toMatchObject({ published: true, status: "published" });
    expect(h.workspace.load(id).state.status).toBe("PUBLISHED_FOR_DEMO");
  });

  it("keeps canonical state in Tour Core: a fresh agent context sees the same setup, and old approvals don't carry over", async () => {
    const h = app();
    const id = await h.setUpAlfredWay();
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    const asked = await h.ok("publish_demo_property");

    // A brand-new Grok conversation and a restarted Tour Core: new workspace object, new approvals.
    const fresh = grokHarness(h.root);
    const setup = await fresh.ok("get_property_setup");
    expect(setup.setup).toMatchObject({ name: "100 Alfred Way", status: "Ready to publish for demo" });
    expect(setup.setup.units.map((u: { route: string }) => u.route)).toEqual(["Lobby Entrance \u2192 Unit 101 Door", "Lobby Entrance \u2192 Unit 102 Door"]);
    expect(await fresh.fails("publish_demo_property", { confirmationCode: asked.confirmation.code })).toMatch(/expired or was already used/);
    expect(new PropertyWorkspace(h.root).load(id).state.status).toBe("DRAFT");
  });
});

describe("live tours and exceptions", () => {
  it("lists active tours in plain words and inspects one", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    const list = await h.ok("list_active_tours");
    expect(list.tours).toHaveLength(1);
    expect(list.tours[0]).toMatchObject({
      visitorName: "Pat Smith",
      unitName: "Unit 101",
      tourTime: "Monday, Sep 28, 9:00 AM\u20139:45 AM",
      status: "Touring",
      currentStep: "At Unit 101",
      source: "Visitor demo",
      canChange: true,
    });
    expect(JSON.stringify(list)).not.toMatch(/res_|prs_|grt_|DENY_|TOURING/);

    const inspected = await h.ok("inspect_tour", { tourRef: list.tours[0].tourRef });
    expect(inspected.summary).toBe("Pat Smith, Unit 101: Touring. At Unit 101.");
    expect(inspected.tour.latestActivity.at(-1)).toContain("Unit 101 Door access was approved for Pat.");
    expect(inspected.tour.accessGrants).toEqual([
      { doorName: "Lobby Entrance", ...GRANT_9AM, tourRef: list.tours[0].tourRef, unitName: "Unit 101" },
      { doorName: "Unit 101 Door", ...GRANT_9AM, tourRef: list.tours[0].tourRef, unitName: "Unit 101" },
    ]);
    expect(inspected.tour.denials).toEqual([]);
    // Allowed-at is inside the tour window (8:50–9:45); validUntil is the window end.
    // ISO stamps let QA prove allowedAt >= validFrom (no door opened early).
    for (const grant of inspected.tour.accessGrants) {
      expect(grant.allowedAt).toBe("Monday, Sep 28, 9:00 AM");
      expect(grant.validFrom).toBe("Monday, Sep 28, 9:00 AM");
      expect(grant.validUntil).toBe("Monday, Sep 28, 9:45 AM");
      expect(grant.allowedAtIso).toBe("2026-09-28T09:00:00-04:00");
      expect(grant.validFromIso).toBe("2026-09-28T09:00:00-04:00");
      expect(grant.validUntilIso).toBe("2026-09-28T09:45:00-04:00");
      expect(grant.allowedAtIso >= grant.validFromIso).toBe(true);
    }

    await v.act("atStop", { doorId: "unit_102_door" });
    const denied = await h.ok("inspect_tour", { tourRef: list.tours[0].tourRef });
    expect(denied.tour.denials).toEqual([{ doorName: "Unit 102 Door", ...DENIAL_9AM, code: "DENY_WRONG_ROUTE", tourRef: list.tours[0].tourRef, unitName: "Unit 101" }]);
    expect(denied.tour.accessDenials.at(-1)).toContain("Unit 102 Door");
  });

  it("inspects only the named tour when the same visitor has two tours, and export tags each grant and denial with that tour", async () => {
    const h = app();
    const id = await h.publish();
    const first = await h.touringVisitor(id);
    await first.act("atStop", { doorId: "unit_102_door" });
    const firstRef = tourRef(id, first.session.tourId);

    const second = await h.visitor(id, { unitId: "unit_102" });
    const ten = second.session.offeredSlots.find((s) => s.start.getTime() === at(10));
    expect(ten).toBeDefined();
    await second.act("chooseTime", { slotStart: ten!.start.toISOString() });
    await second.act("consent", { agree: true });
    await second.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    h.setClock(at(10));
    await second.act("arrive");
    await second.act("atStop", { doorId: "unit_102_door" });
    await second.act("atStop", { doorId: "unit_101_door" });
    const secondRef = tourRef(id, second.session.tourId);
    expect(secondRef).not.toBe(firstRef);

    const firstInspect = await h.ok("inspect_tour", { tourRef: firstRef });
    expect(firstInspect.tour.accessGrants).toEqual([
      { doorName: "Lobby Entrance", ...GRANT_9AM, tourRef: firstRef, unitName: "Unit 101" },
      { doorName: "Unit 101 Door", ...GRANT_9AM, tourRef: firstRef, unitName: "Unit 101" },
    ]);
    expect(firstInspect.tour.denials).toEqual([{ doorName: "Unit 102 Door", ...DENIAL_9AM, code: "DENY_WRONG_ROUTE", tourRef: firstRef, unitName: "Unit 101" }]);
    expect(firstInspect.tour.accessGrants.map((g: { doorName: string }) => g.doorName)).not.toContain("Unit 102 Door");
    expect(firstInspect.tour.denials.map((d: { doorName: string }) => d.doorName)).not.toContain("Unit 101 Door");

    const secondInspect = await h.ok("inspect_tour", { tourRef: secondRef });
    expect(secondInspect.tour.accessGrants).toEqual([
      { doorName: "Lobby Entrance", ...GRANT_10AM, tourRef: secondRef, unitName: "Unit 102" },
      { doorName: "Unit 102 Door", ...GRANT_10AM, tourRef: secondRef, unitName: "Unit 102" },
    ]);
    expect(secondInspect.tour.denials).toEqual([{ doorName: "Unit 101 Door", ...DENIAL_10AM, code: "DENY_WRONG_ROUTE", tourRef: secondRef, unitName: "Unit 102" }]);
    expect(secondInspect.tour.accessGrants.map((g: { doorName: string }) => g.doorName)).not.toContain("Unit 101 Door");
    expect(secondInspect.tour.denials.map((d: { doorName: string }) => d.doorName)).not.toContain("Unit 102 Door");

    const out = await h.ok("export_audit", { day: "today" });
    const firstGrants = out.accessGrants.filter((g: { tourRef: string }) => g.tourRef === firstRef);
    const secondGrants = out.accessGrants.filter((g: { tourRef: string }) => g.tourRef === secondRef);
    expect(firstGrants).toEqual([
      expect.objectContaining({ doorName: "Lobby Entrance", ...GRANT_9AM, tourRef: firstRef, unitName: "Unit 101" }),
      expect.objectContaining({ doorName: "Unit 101 Door", ...GRANT_9AM, tourRef: firstRef, unitName: "Unit 101" }),
    ]);
    expect(secondGrants).toEqual([
      expect.objectContaining({ doorName: "Lobby Entrance", ...GRANT_10AM, tourRef: secondRef, unitName: "Unit 102" }),
      expect.objectContaining({ doorName: "Unit 102 Door", ...GRANT_10AM, tourRef: secondRef, unitName: "Unit 102" }),
    ]);
    expect(out.denials.filter((d: { tourRef: string }) => d.tourRef === firstRef)).toEqual([
      expect.objectContaining({ doorName: "Unit 102 Door", ...DENIAL_9AM, code: "DENY_WRONG_ROUTE", tourRef: firstRef, unitName: "Unit 101" }),
    ]);
    expect(out.denials.filter((d: { tourRef: string }) => d.tourRef === secondRef)).toEqual([
      expect.objectContaining({ doorName: "Unit 101 Door", ...DENIAL_10AM, code: "DENY_WRONG_ROUTE", tourRef: secondRef, unitName: "Unit 102" }),
    ]);
  });

  it("queues an unknown visitor question, and resolving it changes nothing else", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is parking included?" });
    expect(v.session.conversation.at(-1)?.text).toBe("I'll pass your question to the property team, and they'll reply here as soon as they can.");

    const queue = await h.ok("list_exceptions");
    expect(queue.summary).toBe("1 thing needs attention.");
    expect(queue.exceptions[0]).toMatchObject({ visitorName: "Pat Smith", unitName: "Unit 101", summary: 'They asked: "Is parking included?" There\'s no approved answer yet.', tourStatus: "Tour still active" });

    const opened = await h.ok("inspect_exception", { exceptionId: queue.exceptions[0].exceptionId });
    expect(opened.issue.question).toBe("Is parking included?");
    expect(opened.issue.nextSteps[0]).toMatch(/add it to the approved facts/);

    const before = snapshotFiles(join(h.root, "properties", id));
    const resolved = await h.ok("resolve_exception", { exceptionId: queue.exceptions[0].exceptionId, resolutionNote: "Called Pat about parking." });
    expect(resolved.summary).toBe("Marked handled: Pat Smith, question with no approved answer.");
    const after = snapshotFiles(join(h.root, "properties", id));
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed.map((k) => k.replace(/\\/g, "/"))).toEqual(["/operator/exception-resolutions.json"]);
    expect((await h.ok("list_exceptions")).exceptions).toHaveLength(0);
    expect((await h.ok("list_exceptions", { includeHandled: true })).exceptions[0]).toMatchObject({ status: "resolved", resolution: "Called Pat about parking." });
    expect((await h.ok("resolve_exception", { exceptionId: queue.exceptions[0].exceptionId, resolutionNote: "again" })).summary).toBe("That was already marked handled.");
  });

  it("adds an operator-supplied fact only after an explicit yes, and texts the visitor exactly that", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is parking included?" });
    const [issue] = (await h.ok("list_exceptions")).exceptions;

    const asked = await h.ok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "Parking is included." });
    expect(asked.visitorWillReceive).toBe("Parking is included. Let me know if you have any other questions.");
    expect(asked.summary).toBe('Send this to Pat and save it for anyone who asks the same thing later? "Parking is included. Let me know if you have any other questions."');
    expect(asked.confirmation.question).toBe(asked.summary);
    const quoted = String(asked.summary).slice(String(asked.summary).indexOf('"') + 1, String(asked.summary).lastIndexOf('"'));
    expect(Buffer.from(quoted, "utf8").equals(Buffer.from(asked.visitorWillReceive, "utf8"))).toBe(true);
    expect(h.workspace.load(id).config.property.facts).toEqual([]);
    const threadBefore = v.session.conversation.length;

    const done = await h.ok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "Parking is included.", confirmationCode: asked.confirmation.code });
    expect(done).toMatchObject({ approvedFact: "Parking is included.", visitorAnswered: true, needsRecheck: false, stillPublished: true, setupStatus: "Published for demo" });
    expect(h.workspace.load(id).config.property.facts).toEqual(["Parking is included."]);
    expect(v.session.conversation.slice(threadBefore).map((m) => m.text)).toEqual(["Parking is included. Let me know if you have any other questions."]);
    expect((await h.ok("list_exceptions", { includeHandled: true })).exceptions[0]).toMatchObject({ status: "resolved", approvedFact: "Parking is included." });
    // The saved tour record has the message too (canonical, not just in memory).
    const saved = h.workspace.loadTour(id, v.session.tourId)!.bundle.messages.at(-1)!;
    expect(saved.body).toContain("Parking is included.");
  });

  it("never invents an answer: no fact means no answer, and a fact can't be approved for something else", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is there a gym?" });
    const [issue] = (await h.ok("list_exceptions")).exceptions;
    expect(await h.fails("answer_flagged_question", { exceptionId: issue.exceptionId })).toMatch(/approvedFact/);
    expect(await h.fails("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "   " })).toBe("I need the answer in your own words before I can add it.");
    const asked = await h.ok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    // A different fact than the one the operator approved is refused.
    expect(await h.fails("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym and a pool.", confirmationCode: asked.confirmation.code })).toMatch(/Something changed/);
    expect(h.workspace.load(id).config.property.facts).toEqual([]);

    await v.act("atStop", { doorId: "unit_102_door" });
    const offRoute = (await h.ok("list_exceptions")).exceptions.find((x: { what: string }) => x.what === "Tried a door that isn't on their tour");
    expect(offRoute.summary).toBe("Tried Unit 102 Door, which isn't on their tour. It stayed locked.");
    expect(await h.fails("answer_flagged_question", { exceptionId: offRoute.exceptionId, approvedFact: "Anything" })).toBe("That issue isn't an unanswered question.");
  });

  it("pauses and resumes a tour only with approval; paused doors stay shut and Durin isn't asked", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    const [tour] = (await h.ok("list_active_tours")).tours;

    const { asked, done } = await h.approve("place_operator_hold", { tourRef: tour.tourRef, reason: "Checking the lobby camera" });
    expect(asked.summary).toBe("Pause Pat Smith's tour of Unit 101? Their doors will be switched off until you resume it.");
    expect(done.tour).toMatchObject({ status: "Paused", paused: true });

    const before = v.session.durin.requestCount;
    const denied = await v.session.core.requestAccess({ reservationId: v.session.reservationId!, prospectId: v.session.prospectId!, doorId: "lobby_entrance" });
    expect(denied.decision.code).toBe("DENY_OPERATOR_HOLD");
    expect(v.session.durin.requestCount).toBe(before);
    expect((await h.ok("list_exceptions")).exceptions[0]).toMatchObject({ what: "Tour paused by your team", accessBlocked: true, summary: "Your team paused this tour: Checking the lobby camera." });

    expect(await h.fails("place_operator_hold", { tourRef: tour.tourRef, reason: "again" })).toMatch(/can't be paused/);
    const resumed = await h.approve("clear_operator_hold", { tourRef: tour.tourRef });
    expect(resumed.done.tour).toMatchObject({ status: "Touring", paused: false });
    expect((await h.ok("list_exceptions")).exceptions).toHaveLength(0);
    const allowed = await v.session.core.requestAccess({ reservationId: v.session.reservationId!, prospectId: v.session.prospectId!, doorId: "lobby_entrance" });
    expect(allowed.decision.allowed).toBe(true);
  });

  it("calls off a tour only with approval, tells the visitor, and refuses changes outside the tour's lifecycle", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    const [tour] = (await h.ok("list_active_tours")).tours;

    const asked = await h.ok("revoke_tour_access", { tourRef: tour.tourRef, reason: "Visitor asked to leave" });
    // An approval for one action can't be spent on another.
    expect(await h.fails("place_operator_hold", { tourRef: tour.tourRef, reason: "x", confirmationCode: asked.confirmation.code })).toMatch(/was for something else/);
    const again = await h.ok("revoke_tour_access", { tourRef: tour.tourRef, reason: "Visitor asked to leave" });
    const done = await h.ok("revoke_tour_access", { tourRef: tour.tourRef, reason: "Visitor asked to leave", confirmationCode: again.confirmation.code });
    expect(done.tour).toMatchObject({ status: "Called off", active: false });
    expect(v.session.conversation.at(-1)?.text).toBe(VisitorDenialCopy.calledOff("property team"));
    expect((await v.session.core.listGrants(v.session.reservationId!)).every((g) => g.status === "REVOKED")).toBe(true);
    const afterRevoke = await h.ok("inspect_tour", { tourRef: tour.tourRef });
    expect(afterRevoke.summary).toBe("Pat Smith, Unit 101: Called off.");
    expect(afterRevoke.summary).not.toMatch(/Called off\. Called off\./);
    expect(afterRevoke.tour.accessGrants.every((g: { endedAt?: string; endedAtIso?: string }) => g.endedAt === "Monday, Sep 28, 9:00 AM" && g.endedAtIso === "2026-09-28T09:00:00-04:00")).toBe(true);

    expect(await h.fails("revoke_tour_access", { tourRef: tour.tourRef, reason: "again" })).toMatch(/already called off/);
    expect(await h.fails("clear_operator_hold", { tourRef: tour.tourRef })).toMatch(/isn't paused/);
    expect(await h.fails("place_operator_hold", { tourRef: "prop_100_alfred_way~nope", reason: "x" })).toBe("I couldn't find that tour.");
    expect((await h.ok("list_active_tours")).tours).toHaveLength(0);
  });

  it("exports a validated audit for today with a plain summary", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is parking included?" });
    await v.act("atStop", { doorId: "unit_102_door" });
    await v.act("finish");
    await v.act("followUp", { wantsContact: true });

    const out = await h.ok("export_audit", { day: "today" });
    expect(out.totals).toMatchObject({ day: "Monday, Sep 28", tours: 1, completed: 1, active: 0, stopped: 0, accessDenials: 1, questionsNeedingAttention: 1, practiceTours: 1 });
    expect(out.summary).toBe("Monday, Sep 28: 1 visitor tour (1 completed, 0 active, 0 stopped), 1 access denial, 1 question needing attention, plus 1 practice tour. 2 practice-tour denials.");
    expect(out.files[0].openOnTourCoreComputer).toMatch(/^http:\/\/localhost:4321\/api\/properties\/prop_100_alfred_way\/audit-exports\/2026-09-28_.+\/audit-export\.json$/);
    expect(out.accessGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ doorName: "Lobby Entrance", ...GRANT_9AM, unitName: "Unit 101" }),
        expect.objectContaining({ doorName: "Unit 101 Door", ...GRANT_9AM, unitName: "Unit 101" }),
      ]),
    );
    expect(out.denials).toEqual(expect.arrayContaining([expect.objectContaining({ doorName: "Unit 102 Door", ...DENIAL_9AM, code: "DENY_WRONG_ROUTE", unitName: "Unit 101" })]));
    for (const grant of out.accessGrants.filter((g: { unitName?: string }) => g.unitName === "Unit 101")) {
      expect(grant.allowedAtIso >= grant.validFromIso).toBe(true);
    }
    expect(JSON.stringify(out)).not.toContain(h.root.replace(/\\/g, "\\\\"));

    const dir = join(h.root, "properties", id, "audit-exports");
    const [folder] = readdirSync(dir);
    const doc = JSON.parse(readFileSync(join(dir, folder!, "audit-export.json"), "utf8"));
    for (const t of doc.tours) expect(() => ExportBundleSchema.parse(t.bundle)).not.toThrow();
    expect(readFileSync(join(dir, folder!, "audit.csv"), "utf8").split("\n")[0]).toBe("tour,tourKind,seq,at,type,reservationId,prospectId,doorId,code,statusFrom,statusTo,detail");
    expect(await h.fails("export_audit", { day: "last tuesday" })).toMatch(/Use "today" or a date/);
  });
});

describe("MCP bridge", () => {
  it("speaks MCP: initialize, list tools, call a tool, notifications", async () => {
    const h = app();
    const init = await h.mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok-bot", version: "1" } });
    expect(init.body).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "tour-core" }, capabilities: { tools: {} } } });
    const list = await h.mcp("tools/list");
    expect((list.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(OPERATOR_TOOLS.length);
    const called = await h.mcp("tools/call", { name: "list_properties", arguments: {} });
    expect(called.body).toMatchObject({ result: { isError: false, structuredContent: { summary: "No properties are set up yet." } } });
    const failed = await h.mcp("tools/call", { name: "get_property_setup", arguments: {} });
    expect(failed.body).toMatchObject({ result: { isError: true, content: [{ type: "text", text: "There aren't any properties set up yet." }] } });
    const { handleMcpMessage } = await import("../src/mcp/mcpBridge");
    expect(await handleMcpMessage(h.ctx, { jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({ status: 202 });
  });

  it("is mounted on the existing server, needs the connector token, and is the only operator route open to the public address", async () => {
    const restore = setSendblueRuntime({ env: () => sendblueEnv() });
    cleanups.push(restore);
    const h = app();
    let token: string | undefined = "test-operator-token-123456";
    const server: Server = createSetupServer({ workspace: new PropertyWorkspace(h.root), operatorToken: () => token, now: () => new Date(at(7)) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    expect((await post("/mcp", rpc)).status).toBe(401);
    expect((await post("/mcp", rpc, { Authorization: "Bearer wrong" })).status).toBe(401);
    const good = await post("/mcp", rpc, { Authorization: `Bearer ${token}` });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { result: { tools: unknown[] } }).result.tools.length).toBe(22);

    // Through the public tunnel host: /mcp (with the token) yes, the browser operator API no.
    const viaTunnel = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify(rpc);
        const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: "tour.example", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(body);
      });
    expect(await viaTunnel("/mcp", { Authorization: `Bearer ${token}` })).toBe(200);
    expect(await viaTunnel("/mcp")).toBe(401);
    expect(await viaTunnel("/api/properties")).toBe(404);

    token = undefined;
    expect((await post("/mcp", rpc, { Authorization: "Bearer anything" })).status).toBe(503);
  });

  it("uses the same actions as the browser: a property set up by Grok shows up in the browser API", async () => {
    const h = app();
    await h.setUpAlfredWay();
    const { handleApi } = await import("../src/web/api");
    const res = await handleApi({ workspace: h.workspace, dev: false }, "POST", "/api/properties/prop_100_alfred_way/readiness", {});
    expect((res as { json: { readiness: { passed: boolean } } }).json.readiness.passed).toBe(true);
    expect((await h.ok("get_property_setup")).setup.status).toBe("Draft");
  });
});

describe("confirmations", () => {
  it("expire, are single-use and bound to one action, target and state", () => {
    let now = 0;
    const book = new ConfirmationBook(60_000, () => now);
    const a = book.issue("publish", "p1", "hash1", "Publish?");
    expect(() => book.redeem(a.code, "publish", "p1", "hash1")).not.toThrow();
    expect(() => book.redeem(a.code, "publish", "p1", "hash1")).toThrow(/expired or was already used/);
    const b = book.issue("publish", "p1", "hash1", "Publish?");
    now = 61_000;
    expect(() => book.redeem(b.code, "publish", "p1", "hash1")).toThrow(/expired/);
    const c = book.issue("publish", "p1", "hash1", "Publish?");
    expect(() => book.redeem(c.code, "publish", "p1", "hash2")).toThrow(/Something changed/);
  });
});

