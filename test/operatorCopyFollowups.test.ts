import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { LOCAL_TEST_TEXTING, localTestModeSentence, modeSentence } from "../src/setup/setupActions";
import { inspectTourSummary, tourRef } from "../src/operator/tours";
import { STATUS_LABELS } from "../src/visitor/views";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";
import { OPERATOR_MESSAGES, operateMessage } from "../src/install/status";
import { parseBulkUnitDetails } from "../src/config/unitProfile";
import { createPropertySetup, draftView } from "../src/setup";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function app(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
function textingApp(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  const now = new Date(h.now()).toISOString();
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: now, message: "ok", url: TUNNEL });
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  h.inst.files.recordCheck("visitorMessaging", { ok: true, at: now, message: "ok", problems: [], publicBaseUrl: TUNNEL });
  h.services.endpoints = new MessagingEndpoints(h.runtime);
  h.services.messagingLine = () => "+15550109999";
  return h;
}

async function finishSingleFamily(h: InstallHarness, address: string, propertyType: "SINGLE_FAMILY" | "MULTIFAMILY_HOME" | "APARTMENT_OR_CONDO" = "SINGLE_FAMILY") {
  const created = await h.ok("create_property_setup", { address, propertyType });
  const id = created.setup.propertyId as string;
  const at = { property: id };
  if (propertyType === "SINGLE_FAMILY") await h.ok("add_unit", at);
  else if (propertyType === "MULTIFAMILY_HOME") await h.ok("add_unit", { ...at, name: "1A" });
  else {
    await h.ok("add_unit", { ...at, name: "4B" });
    await h.ok("update_property_details", { ...at, buildingAccess: "UNIT_ONLY" });
    await h.ok("update_property_details", { ...at, skipEntryInstructions: true });
  }
  const unit = propertyType === "SINGLE_FAMILY" ? "Main Home" : propertyType === "MULTIFAMILY_HOME" ? "1A" : "Unit 4B";
  await h.ok("set_unit_details", { ...at, units: [{ unit, bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
  await h.ok("set_tour_hours", { ...at, days: "weekdays", start: "9am", end: "5pm" });
  await h.ok("set_verification_policy", { ...at, level: "basic-form" });
  await h.ok("update_property_details", { ...at, skipVisitorHelp: true });
  return id;
}

describe("review_property_setup unit headings", () => {
  it("uses the street line for a single-family home, never Main Home", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "910 QA Gate Rd, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    await h.ok("add_unit", {});
    await h.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    const review = await h.ok("review_property_setup");
    expect(review.lines).toContain("910 QA Gate Road");
    expect(review.lines).not.toContain("Main Home");
    expect(h.workspace.openDraft(h.workspace.propertyIds()[0]!).draft.units[0]!.name).toBe("Main Home");
  });

  it("keeps stored names for multifamily and apartment or condo", async () => {
    const multi = app();
    await multi.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    await multi.ok("add_unit", { name: "1A" });
    expect((await multi.ok("review_property_setup")).lines).toContain("Unit 1A");

    const condo = app();
    await condo.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" });
    await condo.ok("add_unit", { name: "4B" });
    const lines = (await condo.ok("review_property_setup")).lines;
    expect(lines).toContain("Unit 4B");
    expect(lines).not.toContain("Main Home");
  });
});

describe("one touring number covers every property", () => {
  it("a second property's readiness passes on the same number, with no property id", async () => {
    const h = textingApp();
    const scratch = await finishSingleFamily(h, "12 Scratch Lane, Teaneck, NJ 07666");
    const first = await h.ok("run_readiness_check", { property: scratch });
    expect(first.passed).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/prop_/);

    const gate = await finishSingleFamily(h, "910 QA Gate Rd, Tenafly, NJ 07670");
    const second = await h.ok("run_readiness_check", { property: gate });
    expect(second.passed).toBe(true);
    expect(JSON.stringify(second)).not.toMatch(/already used/);
    expect(JSON.stringify(second)).not.toMatch(/prop_/);
    expect(JSON.stringify(second)).not.toContain("Main Home");
    const line = "+15550109999";
    expect(h.services.endpoints?.forProperty(scratch)?.address).toBe(line);
    expect(h.services.endpoints?.forProperty(gate)?.address).toBe(line);
    expect([...(h.services.endpoints?.resolve(line)?.propertyIds ?? [])].sort()).toEqual([gate, scratch].sort());
  });
});

const LOCAL_WITH_DEMO_DOORS =
  "Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on. Door access is still in demo mode, so no physical locks will open.";

describe("local test texting status", () => {
  it("get_services and set_services local pin the test-mode sentence plus the door line", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "12 Scratch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const set = await h.ok("set_services", { messaging: "local" });
    expect(set.summary).toBe(LOCAL_WITH_DEMO_DOORS);
    expect(set.summary).toBe(localTestModeSentence(true));
    expect(set.summary.match(/\blive\b/gi)).toEqual(["live"]);
    expect(set.summary).not.toMatch(/Sendblue|Twilio|Photon|outbox|loopback|provider/i);

    const got = await h.ok("get_services");
    expect(got.summary).toBe(LOCAL_WITH_DEMO_DOORS);
    expect(got.summary.match(/\blive\b/gi)).toEqual(["live"]);
    expect(got.summary).not.toMatch(/Sendblue|Twilio|Photon|outbox|loopback|provider/i);
    expect(got.messaging.current).toBe("test");
    expect(got.messaging.current).not.toBe("live");
    expect(got.messaging.visitorTexting).toBe("test mode");
    expect(got.lines).toContain("Visitor texting: test mode");
    expect(got.lines).not.toContain("Visitor texting: Connected");

    const review = await h.ok("review_property_setup");
    expect(review.lines).toContain("Visitor texting: test mode");
    expect(review.lines).not.toContain("Visitor texting: Connected");
  });

  it("publish on a local property uses the combined wording and omits the touring-number line", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "12 Scratch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    await h.ok("add_unit", {});
    await h.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await h.ok("set_verification_policy", { level: "basic-form" });
    await h.ok("update_property_details", { skipVisitorHelp: true });
    await h.ok("set_services", { messaging: "local" });
    expect((await h.ok("run_readiness_check")).passed).toBe(true);
    expect((await h.ok("run_dry_tour")).passed).toBe(true);
    const { done } = await h.approve("publish_demo_property", {});
    const name = h.workspace.load(h.workspace.propertyIds()[0]!).config.property.name;
    expect(done.summary).toBe(`${name} is published for demo. ${LOCAL_WITH_DEMO_DOORS}`);
    expect(done.summary).not.toContain("Visitors can start a tour by texting your touring number");
    expect(done.modes).toBe(LOCAL_WITH_DEMO_DOORS);
  });

  it("real-provider publish still includes the touring-number line and live wording", async () => {
    const h = textingApp();
    const id = await finishSingleFamily(h, "144 Hillside Ave, Teaneck, NJ 07666");
    expect((await h.ok("run_readiness_check", { property: id })).passed).toBe(true);
    expect((await h.ok("run_dry_tour", { property: id })).passed).toBe(true);
    const { done } = await h.approve("publish_demo_property", { property: id });
    const name = h.workspace.load(id).config.property.name;
    expect(done.summary).toBe(
      `${name} is published for demo. Visitors can start a tour by texting your touring number. Visitor texting is live. Door access is still in demo mode, so no physical locks will open.`,
    );
    expect(done.summary).toContain("Visitors can start a tour by texting your touring number.");
  });
});

describe("set_unit_details single-family auto-select", () => {
  it("uses the only unit on a single-family home when no unit is specified", async () => {
    const details = app();
    await details.ok("create_property_setup", { address: "910 QA Gate Rd, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    await details.ok("add_unit", {});
    const byDetails = await details.ok("set_unit_details", { details: "3 bed 2 bath for $3,400, available now" });
    expect(byDetails.complete).toBe(true);
    expect(byDetails.lines).toEqual(["910 QA Gate Road — 3 bed · 2 bath · $3,400/month · available now"]);

    const fields = app();
    await fields.ok("create_property_setup", { address: "12 Scratch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    await fields.ok("add_unit", {});
    const byFields = await fields.ok("set_unit_details", { units: [{ bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    expect(byFields.complete).toBe(true);
    expect(byFields.lines).toEqual(["12 Scratch Lane — 3 bed · 2 bath · $3,400/month · available now"]);
  });

  it("still requires a unit on a multi-unit property", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    await h.ok("add_unit", { name: "1A" });
    await h.ok("add_unit", { name: "1B" });
    expect(await h.fails("set_unit_details", { details: "2 bed 1 bath for $2,200, available now" })).toMatch(/couldn't match those details to a unit/);
    expect(await h.fails("set_unit_details", { units: [{ bedrooms: "2", bathrooms: "1", monthlyRent: "$2,200", availability: "now" }] })).toMatch(/couldn't match those details to a unit/);
    const named = await h.ok("set_unit_details", { units: [{ unit: "1A", bedrooms: "2", bathrooms: "1", monthlyRent: "$2,200", availability: "now" }] });
    expect(named.lines[0]).toMatch(/^Unit 1A —/);
  });

  it("treats in-unit laundry as an amenity, not a unit, and still auto-picks the single-family home", async () => {
    const phrase = "3 bed 2 bath for $3,400, available now, in-unit laundry";
    expect(parseBulkUnitDetails(phrase, ["Main Home"]).unknownUnits).toEqual([]);
    expect(parseBulkUnitDetails("3 bed 2 bath, in-unit washer", ["Main Home"]).unknownUnits).toEqual([]);
    expect(parseBulkUnitDetails("3 bed 2 bath, in-unit dryer", ["Main Home"]).unknownUnits).toEqual([]);
    expect(parseBulkUnitDetails("3 bed 2 bath, in-unit parking", ["Main Home"]).unknownUnits).toEqual([]);
    const h = app();
    await h.ok("create_property_setup", { address: "910 QA Gate Rd, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    await h.ok("add_unit", {});
    const saved = await h.ok("set_unit_details", { details: phrase });
    expect(saved.complete).toBe(true);
    expect(saved.lines).toEqual(["910 QA Gate Road — 3 bed · 2 bath · $3,400/month · available now"]);
    expect(saved.notOnFile).toBeUndefined();
  });

  it("still errors clearly when in-unit laundry is mentioned on a multi-unit property without a unit", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    await h.ok("add_unit", { name: "1A" });
    await h.ok("add_unit", { name: "1B" });
    expect(await h.fails("set_unit_details", { details: "3 bed 2 bath for $3,400, available now, in-unit laundry" })).toMatch(
      /couldn't match those details to a unit/,
    );
  });

  it("tells the operator to add a unit first on a single-family home with no unit yet", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "910 QA Gate Rd, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    expect(await h.fails("set_unit_details", { details: "3 bed 2 bath for $3,400, available now" })).toBe(
      "Add the house as a unit first, then I'll save these details.",
    );
  });

  it("saves 1A details when the phrase also has W/D, and does not treat ordinary words as units", async () => {
    expect(parseBulkUnitDetails("1A has W/D, 3 bed 2 bath $3,400", ["1A", "W", "Laundry Suite"])).toEqual({
      units: [{ unit: "1A", values: { bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400" } }],
      unknownUnits: [],
    });
    expect(parseBulkUnitDetails("W is 2 bed 1 bath for $2,200", ["1A", "W"])).toEqual({
      units: [{ unit: "W", values: { bedrooms: "2", bathrooms: "1", monthlyRent: "$2,200" } }],
      unknownUnits: [],
    });
    expect(parseBulkUnitDetails("the unit has 3 bed 2 bath", ["Main Home"]).unknownUnits).toEqual([]);
    expect(parseBulkUnitDetails("the unit is 3 bed and the unit with laundry", ["Main Home"]).unknownUnits).toEqual([]);
    const h = app();
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ 07666", propertyType: "APARTMENT_BUILDING" });
    await h.ok("add_unit", { name: "1A" });
    await h.ok("add_unit", { name: "W" });
    await h.ok("add_unit", { name: "Laundry Suite" });
    const saved = await h.ok("set_unit_details", { details: "1A has W/D, 3 bed 2 bath $3,400" });
    expect(saved.lines.join("\n")).toMatch(/Unit 1A — 3 bed · 2 bath · \$3,400\/month/);
    expect(saved.lines.join("\n")).not.toMatch(/^W — 3 bed/m);
    expect(saved.notOnFile).toBeUndefined();
  });
});

describe("operator-facing readiness and practice tour never name Durin", () => {
  it("readiness and dry-tour output contain no Durin", async () => {
    const h = app();
    await h.setUpAlfredWay();
    const readiness = await h.ok("run_readiness_check");
    expect(readiness.passed).toBe(true);
    expect(readiness.lines).toContain("\u2713 Door access");
    expect(JSON.stringify(readiness)).not.toMatch(/Durin/);
    const practice = await h.ok("run_dry_tour");
    expect(practice.passed).toBe(true);
    expect(practice.proofPoints).toContain("\u2713 Unit 102 Door (not on the route) was turned away before any door was unlocked");
    expect(JSON.stringify(practice)).not.toMatch(/Durin/);
  });

  it("web, CLI, grok disconnect, and the wrong-door demo line never name Durin", () => {
    const allowed = /door-demo|createDurin|countDurinCalls|CountingDurin|MockDurin|durinCalled|durinLines|durinRequests|durinHealth|DENY_DOOR_UNHEALTHY|DOOR_DEMO|never name Durin|Never name Durin|before Durin|deps\.durin|this\.durin|src\/durin/i;
    const unexpected = (file: string) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /\bdurin\b/i.test(line) && !allowed.test(line))
        .map((line) => `${file}: ${line.trim()}`);
    expect([
      ...readdirSync("src/web/public").filter((name) => /\.(js|html)$/.test(name)).flatMap((name) => unexpected(`src/web/public/${name}`)),
      ...unexpected("src/cli/setup.ts"),
      ...unexpected("src/cli/prompter.ts"),
      ...unexpected("src/tools/grok.ts"),
    ]).toEqual([]);
    expect(readFileSync("src/web/public/app.js", "utf8")).toContain("No real door system is connected.");
    expect(readFileSync("src/tools/grok.ts", "utf8")).toContain("texting settings, visitor sessions and door access settings are unchanged");
    const session = readFileSync("src/visitor/session.ts", "utf8");
    expect(session).toContain("Demo safety check: Tour Core kept this door locked because it's not on their route.");
    expect(session).not.toMatch(/never contacted Durin/i);
  });

  it("readiness, practice tour, install status, and visitor session copy never name Durin", async () => {
    const h = app();
    await h.setUpAlfredWay();
    const readiness = await h.ok("run_readiness_check");
    expect(JSON.stringify(readiness)).not.toMatch(/\bdurin\b/i);
    const practice = await h.ok("run_dry_tour");
    expect(JSON.stringify(practice)).not.toMatch(/\bdurin\b/i);
    const install = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    cleanups.push(install.cleanup);
    const status = await install.status();
    expect(JSON.stringify({ summary: status.summary, lines: status.lines, components: status.components.map((c) => c.summary) })).not.toMatch(/\bdurin\b/i);
    const session = readFileSync("src/visitor/session.ts", "utf8");
    expect(session).toContain("Demo safety check: Tour Core kept this door locked because it's not on their route.");
    expect(session).not.toMatch(/Demo safety check:.*\bdurin\b/i);
  });
});

describe("local test-mode surfaces reuse the test-mode sentences", () => {
  it("operateMessage uses the local test-mode sentence, not practice-only", () => {
    expect(operateMessage("test-mode", true)).toBe(
      `Your property is published. ${localTestModeSentence(true)} I'll keep you updated on your tours and let you know when something needs your attention.`,
    );
    expect(operateMessage("test-mode", true)).not.toContain("Visitor texts are practice only");
    expect(operateMessage("connected", true)).toBe(OPERATOR_MESSAGES.operate);
    expect(operateMessage("practice", true)).toBe(
      `Your property is published. ${modeSentence(false, true)} I'll keep you updated on your tours and let you know when something needs your attention.`,
    );
  });

  it("readiness on a local property uses Visitor texting: test mode; live Sendblue stays connected", async () => {
    const local = app();
    await local.ok("create_property_setup", { address: "12 Scratch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    await local.ok("add_unit", {});
    await local.ok("set_unit_details", { units: [{ bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await local.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await local.ok("set_verification_policy", { level: "basic-form" });
    await local.ok("update_property_details", { skipVisitorHelp: true });
    await local.ok("set_services", { messaging: "local" });
    const readiness = await local.ok("run_readiness_check");
    expect(readiness.passed).toBe(true);
    expect(readiness.lines).toContain("\u2713 Visitor texting: test mode");
    expect(readiness.lines.join("\n")).not.toMatch(/Visitor messaging connected/);

    const live = textingApp();
    const id = await finishSingleFamily(live, "144 Hillside Ave, Teaneck, NJ 07666");
    const liveReadiness = await live.ok("run_readiness_check", { property: id });
    expect(liveReadiness.passed).toBe(true);
    expect(liveReadiness.lines).toContain("\u2713 Visitor messaging connected");
    expect(liveReadiness.lines.join("\n")).not.toMatch(/Visitor texting: test mode/);
  });

  it("installation local loopback uses the test-mode sentence; live Sendblue stays connected and working", async () => {
    const local = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    cleanups.push(local.cleanup);
    local.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    local.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    await local.ok("choose_messaging_provider", { provider: "local" });
    const tested = await local.ok("test_visitor_messaging");
    expect(tested.ok).toBe(true);
    expect(tested.summary).toBe(LOCAL_TEST_TEXTING);
    const messaging = (await local.status()).components.find((c) => c.component === "VISITOR_MESSAGING");
    expect(messaging).toMatchObject({ state: "READY", summary: LOCAL_TEST_TEXTING });
    const component = await local.ok("get_installation_component", { component: "VISITOR_MESSAGING" });
    expect(component.summary).toBe(`Visitor texting: ${LOCAL_TEST_TEXTING}`);
    expect(component.summary).not.toMatch(/connected and working/);

    const live = textingApp();
    const liveMessaging = (await live.status()).components.find((c) => c.component === "VISITOR_MESSAGING");
    expect(liveMessaging?.state).toBe("READY");
    expect(liveMessaging?.summary).toMatch(/^Visitor texting is connected and working/);
    expect(liveMessaging?.summary).not.toBe(LOCAL_TEST_TEXTING);
    expect(liveMessaging?.summary).not.toMatch(/test mode/);
  });

  it("after a local publish, the operate step uses the test-mode sentence", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", url: TUNNEL });
    h.connectGrok();
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    await h.ok("use_local_demo_storage");
    const id = await finishSingleFamily(h, "12 Scratch Lane, Teaneck, NJ 07666");
    await h.ok("set_services", { property: id, messaging: "local" });
    await h.ok("skip_optional_setup", { component: "OPERATOR_ALERTS" });
    expect((await h.ok("run_readiness_check", { property: id })).passed).toBe(true);
    expect((await h.ok("run_dry_tour", { property: id })).passed).toBe(true);
    await h.approve("publish_demo_property", { property: id });
    const step = await h.ok("get_next_installation_step");
    expect(step.action).toBe("ADD_ANOTHER_PROPERTY");
    expect(step.operatorMessage).toContain(LOCAL_TEST_TEXTING);
    expect(step.operatorMessage).not.toContain("Visitor texts are practice only");
    const publish = (await h.status()).components.find((c) => c.component === "PUBLISH");
    expect(publish?.summary).toMatch(/Visitor texting: test mode/);
  });
});

describe("Critiquito demo-card and real door access copy", () => {
  it("uses the demo-card sentence and Real door access for the live choice", () => {
    const view = draftView(createPropertySetup({ address: "12 Scratch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" }));
    expect(view.services.items.map((item) => item.text)).toContain(
      "Tour Core only asks the door system to unlock a door after its own safety checks pass.",
    );
    expect(readFileSync("src/setup/setupActions.ts", "utf8")).toContain('door: "Real door access"');
  });
});

describe("inspect_tour summary does not repeat terminal status", () => {
  it("dedupes when the step is the same word as the status", () => {
    const who = { visitorName: "Pat Smith", unitName: "Unit 101" };
    expect(inspectTourSummary({ ...who, status: "Cancelled", currentStep: "Cancelled" })).toBe("Pat Smith, Unit 101: Cancelled.");
    expect(inspectTourSummary({ ...who, status: "Called off", currentStep: "Called off" })).toBe("Pat Smith, Unit 101: Called off.");
    expect(inspectTourSummary({ ...who, status: "Identity check didn't pass", currentStep: "Identity check didn't pass" })).toBe(
      "Pat Smith, Unit 101: Identity check didn't pass.",
    );
    expect(inspectTourSummary({ ...who, status: "Tour time ended", currentStep: "Tour time ended" })).toBe("Pat Smith, Unit 101: Tour time ended.");
    expect(inspectTourSummary({ ...who, status: "Finished", currentStep: "Left the property" })).toBe("Pat Smith, Unit 101: Finished. Left the property.");
    expect(inspectTourSummary({ ...who, status: "Touring", currentStep: "At Unit 101" })).toBe("Pat Smith, Unit 101: Touring. At Unit 101.");
    for (const status of ["COMPLETED", "CANCELLED", "VERIFICATION_FAILED", "EXPIRED", "REVOKED"] as const) {
      const label = STATUS_LABELS[status];
      const summary = inspectTourSummary({ ...who, status: label, currentStep: label });
      expect(summary).toBe(`Pat Smith, Unit 101: ${label}.`);
      expect(summary).not.toMatch(new RegExp(`${label}\\. ${label}\\.`));
    }
  });

  it("inspect_tour cancelled and completed summaries name the status once", async () => {
    const h = app();
    const id = await h.publish();
    const booked = await h.visitor(id, { name: "Alex Reed", phone: "(555) 010-2002" });
    await booked.act("chooseTime", { slotStart: booked.slot().toISOString() });
    await booked.act("consent", { agree: true });
    await booked.act("submitIdentity", { firstName: "Alex", lastName: "Reed", email: "alex@example.com", phone: "555-010-2002" });
    const asked = await h.ok("pause_tours", { property: id });
    await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    const cancelled = await h.ok("inspect_tour", { tourRef: tourRef(id, booked.session.tourId) });
    expect(cancelled.summary).toBe("Alex Reed, Unit 101: Cancelled.");
    expect(cancelled.summary).not.toMatch(/Cancelled\. Cancelled\./);

    const finished = app();
    const finishedId = await finished.publish();
    const v = await finished.touringVisitor(finishedId);
    await v.act("finish");
    const done = await finished.ok("inspect_tour", { tourRef: tourRef(finishedId, v.session.tourId) });
    expect(done.summary).toBe("Pat Smith, Unit 101: Finished. Left the property.");
    expect(done.summary).not.toMatch(/Finished\. Finished\./);
  });
});
