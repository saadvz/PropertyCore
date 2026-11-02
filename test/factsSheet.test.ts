import { afterEach, describe, expect, it } from "vitest";
import { isFairHousingStatement } from "../src/core/fairHousing";
import { FACT_QUESTIONS, FACT_TOPICS, factFor, nextFactTopic, splitFreeText } from "../src/setup/factsSheet";
import { SB_KEY, SB_SECRET, installHarness, type InstallHarness } from "./installHarness";

/**
 * The property facts sheet: one setup question at a time, each skippable, each answer stored word for
 * word as an approved fact with its topic label. A line that says who should live there is refused.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
const REFUSAL = "That says who should live there, which fair housing rules don't allow, so I didn't save it. Say what the place offers instead.";

function readyInstall(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  const now = new Date(h.now()).toISOString();
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: now, message: "ok", url: TUNNEL });
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  h.inst.files.recordCheck("visitorMessaging", { ok: true, at: now, message: "ok", problems: [], publicBaseUrl: TUNNEL });
  h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: now } });
  return h;
}

/** The harness property, with a ZIP and a confirmed address so setup reaches hours. */
async function alfredWay(h: InstallHarness): Promise<string> {
  const id = await h.setUpAlfredWay();
  await h.ok("save_property", { property: id, postalCode: "11201" });
  await h.ok("save_property", { property: id, confirmAddress: true });
  return id;
}

const property = (h: InstallHarness, id: string) => h.workspace.openDraft(id).draft.property;

describe("the facts sheet helpers", () => {
  it("labels each answer with its topic, and leaves other unlabeled", () => {
    expect(factFor("apply", "Apply online at apply.example.com.")).toBe("How to apply: Apply online at apply.example.com.");
    expect(factFor("guests", "Yes, bring anyone you like.")).toBe("Bringing someone: Yes, bring anyone you like.");
    expect(factFor("other", "Quiet hours start at 10 PM.")).toBe("Quiet hours start at 10 PM.");
  });

  it("asks the topics in order, skipping the ones already asked", () => {
    expect(FACT_TOPICS).toEqual(["apply", "fees", "lease", "move_in", "guests", "rules", "area", "other"]);
    expect(nextFactTopic({ factsAsked: [] })).toBe("apply");
    expect(nextFactTopic({ factsAsked: ["apply", "fees"] })).toBe("lease");
    expect(nextFactTopic({ factsAsked: [...FACT_TOPICS] })).toBeUndefined();
    expect(FACT_QUESTIONS.apply).toBe("How do people apply?");
  });

  it("splits free text into lines, then sentences", () => {
    expect(splitFreeText("Quiet hours start at 10 PM.\nNo smoking anywhere. Bikes go in the basement.\n\n")).toEqual([
      "Quiet hours start at 10 PM.",
      "No smoking anywhere.",
      "Bikes go in the basement.",
    ]);
  });

  it("reads a line that says who should live there as fair housing, and a plain fact as fine", () => {
    expect(isFairHousingStatement("Great for families")).toBe(true);
    expect(isFairHousingStatement("Ideal for a young professional")).toBe(true);
    expect(isFairHousingStatement("No kids please")).toBe(true);
    expect(isFairHousingStatement("Apply online at apply.example.com.")).toBe(false);
    expect(isFairHousingStatement("12-month leases only.")).toBe(false);
  });
});

describe("save_facts", () => {
  it("stores an answer word for word with its label, and marks the topic asked", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    const out = await h.ok("save_facts", { property: id, topic: "apply", text: "Apply online at apply.example.com." });
    expect(out.status).toBe("done");
    expect(property(h, id).facts).toContain("How to apply: Apply online at apply.example.com.");
    expect(property(h, id).factsAsked).toEqual(["apply"]);
    expect(out.nextQuestion).toBe(FACT_QUESTIONS.fees);
  });

  it("replaces a topic's answer instead of adding a second one", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    await h.ok("save_facts", { property: id, topic: "lease", text: "12 months." });
    await h.ok("save_facts", { property: id, topic: "lease", text: "6 or 12 months." });
    expect(property(h, id).facts.filter((f) => f.startsWith("Lease length:"))).toEqual(["Lease length: 6 or 12 months."]);
  });

  it("records a skip without a fact", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    const before = property(h, id).facts.length;
    await h.ok("save_facts", { property: id, topic: "apply", skip: true });
    expect(property(h, id).factsAsked).toEqual(["apply"]);
    expect(property(h, id).facts.length).toBe(before);
  });

  it("removes a topic's fact", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    await h.ok("save_facts", { property: id, topic: "fees", text: "$500 deposit." });
    await h.ok("save_facts", { property: id, topic: "fees", remove: true });
    expect(property(h, id).facts.some((f) => f.startsWith("Fees and deposit:"))).toBe(false);
  });

  it("stores each line of other as its own fact", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    await h.ok("save_facts", { property: id, topic: "other", text: "Quiet hours start at 10 PM.\nNo smoking anywhere.\nBikes go in the basement." });
    expect(property(h, id).facts).toEqual(expect.arrayContaining(["Quiet hours start at 10 PM.", "No smoking anywhere.", "Bikes go in the basement."]));
  });

  it("saves the neutral lines of other and refuses the one that says who should live there", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    const out = await h.ok("save_facts", { property: id, topic: "other", text: "Great for families.\nQuiet hours start at 10 PM.\nBikes go in the basement." });
    const facts = property(h, id).facts;
    expect(facts).toEqual(expect.arrayContaining(["Quiet hours start at 10 PM.", "Bikes go in the basement."]));
    expect(facts.join(" ")).not.toMatch(/families/i);
    expect(JSON.stringify(out)).toContain(REFUSAL);
  });

  it("refuses an answer that says who should live there, and stores nothing", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    const before = [...property(h, id).facts];
    const out = await h.ok("save_facts", { property: id, topic: "apply", text: "Ideal for a young professional." });
    expect(out.status).toBe("blocked");
    expect(out.message).toBe(REFUSAL);
    expect(property(h, id).facts).toEqual(before);
    expect(property(h, id).factsAsked ?? []).not.toContain("apply");
  });
});

describe("the setup step", () => {
  it("asks the first facts question once hours are confirmed", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    const state = await h.ok("get_state", { propertyId: id });
    expect(state.nextStep).toMatchObject({ tool: "save_facts", say: FACT_QUESTIONS.apply });
    expect(state.currentMilestone).toBe("hours");
  });

  it("moves on to the next question, then past the step once every topic is asked", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    await h.ok("save_facts", { property: id, topic: "apply", text: "Apply online." });
    expect((await h.ok("get_state", { propertyId: id })).nextStep.say).toBe(FACT_QUESTIONS.fees);
    for (const topic of FACT_TOPICS.slice(1)) await h.ok("save_facts", { property: id, topic, skip: true });
    const state = await h.ok("get_state", { propertyId: id });
    expect(state.nextStep.tool).not.toBe("save_facts");
    expect(state.setup.facts).toEqual(["How to apply: Apply online."]);
  });

  it("never blocks a published property, and offers the facts step as optional", async () => {
    const h = readyInstall();
    const id = await alfredWay(h);
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    const state = await h.ok("get_state", { propertyId: id });
    expect(state.nextStep.tool).not.toBe("save_facts");
    expect(state.milestones.find((m: { id: string }) => m.id === "hours").status).toBe("done");
    expect(state.optionalActions).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "save_facts", say: FACT_QUESTIONS.apply })]));
  });
});
