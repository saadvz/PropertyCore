import { afterEach, describe, expect, it } from "vitest";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { buildTouringEnv } from "../src/hosted/touringEnv";
import { LayeredIntentInterpreter, LLMIntentInterpreter, RuleBasedIntentInterpreter, type LanguageModel } from "../src/intent";
import { pickFact, redactForModel } from "../src/intent/factPick";
import type { TourCoreConfig } from "../src/config/tourCoreConfig";
import { hillsideConfig, liveApp } from "./liveApp";
import { reachedLandlord } from "./visitorScenarioKit";

/**
 * The model layer: the new intents through the layered interpreter, picking an approved fact by number
 * (never writing a reply), privacy, and the touring process pass-through. Only fake models, no API calls.
 * Only 555 numbers.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function fakeModel(reply: string | ((input: { system: string; user: string }) => string)) {
  const calls: { system: string; user: string }[] = [];
  const model: LanguageModel = {
    name: "fake-model",
    async complete(input) {
      calls.push(input);
      return typeof reply === "function" ? reply(input) : reply;
    },
  };
  return { model, calls };
}

const ctx = (message: string) => ({
  message,
  step: "ready" as const,
  units: [{ name: "Unit 1A" }],
  timeChoices: [],
  remainingStops: [],
  doors: [],
  hasCancelableTour: true,
});

describe("new intents through the model", () => {
  it("reads a reschedule the rules can't place", async () => {
    const { model } = fakeModel('{"intent":"RESCHEDULE_TOUR","confidence":0.9}');
    const layered = new LayeredIntentInterpreter(new RuleBasedIntentInterpreter(), new LLMIntentInterpreter(model));
    expect((await layered.interpret(ctx("could we push it back a bit"))).intent).toMatchObject({ type: "RESCHEDULE_TOUR" });
  });

  it("accepts the other new intents", async () => {
    for (const type of ["ASK_OPEN_TIMES", "ASK_MY_TOUR", "ASK_DIRECTIONS"]) {
      const out = await new LLMIntentInterpreter(fakeModel(`{"intent":"${type}","confidence":0.9}`).model).interpret(ctx("hmm"));
      expect(out.intent.type).toBe(type);
    }
  });

  it("never sends the model a phone number", async () => {
    const { model, calls } = fakeModel('{"intent":"UNKNOWN","confidence":0.1}');
    await new LLMIntentInterpreter(model).interpret(ctx("call me at (555) 555-0177 about it"));
    expect(calls[0]!.user).toContain("[phone]");
    expect(calls[0]!.user).not.toMatch(/\d[\d\s().-]{6,}\d/);
  });
});

describe("pickFact", () => {
  const facts = ["Bikes go in the basement.", "Quiet hours start at 10 PM.", "The dishwasher is new."];

  it("returns the 0-based index of the model's 1-based pick", async () => {
    expect(await pickFact(fakeModel('{"fact":2}').model, "when does it get quiet", facts)).toBe(1);
  });

  it("treats a number out of range, null, or invalid JSON as none", async () => {
    expect(await pickFact(fakeModel('{"fact":9}').model, "q", facts)).toBeUndefined();
    expect(await pickFact(fakeModel('{"fact":null}').model, "q", facts)).toBeUndefined();
    expect(await pickFact(fakeModel("I think number two").model, "q", facts)).toBeUndefined();
    expect(await pickFact(fakeModel('{"fact":0}').model, "q", facts)).toBeUndefined();
  });

  it("treats a model error as none", async () => {
    const model: LanguageModel = { name: "down", complete: async () => Promise.reject(new Error("503")) };
    expect(await pickFact(model, "q", facts)).toBeUndefined();
  });

  it("numbers the facts for the model and redacts the question", async () => {
    const { model, calls } = fakeModel('{"fact":null}');
    await pickFact(model, "text 555-555-0177 is the dishwasher new?", facts);
    expect(calls[0]!.user).toContain("1. Bikes go in the basement.");
    expect(calls[0]!.user).toContain("3. The dishwasher is new.");
    expect(calls[0]!.user).toContain("[phone]");
  });

  it("redacts phones and a known name", () => {
    expect(redactForModel("I'm Pat Smith, call +1 555-555-0177", "Pat Smith")).toBe("I'm [name], call [phone]");
  });
});

function withFacts(): TourCoreConfig {
  const config = hillsideConfig();
  config.property = { ...config.property, facts: [...config.property.facts, "The dishwasher is new.", "Bikes go in the basement."] };
  return config;
}

describe("picking a fact for a visitor", () => {
  const SLOW = { timeout: 30_000 };
  /** "dishwasher" picks that fact's number; anything else is sent as given. */
  const layered = (reply: string) => {
    const pick = (user: string) => {
      if (reply !== "dishwasher") return reply;
      const facts = (JSON.parse(user) as { facts: string[] }).facts;
      return `{"fact":${facts.findIndex((f) => f.includes("dishwasher")) + 1}}`;
    };
    const { model } = fakeModel((input) => (input.system.includes('"fact"') ? pick(input.user) : '{"intent":"UNKNOWN","confidence":0.1}'));
    return new LayeredIntentInterpreter(new RuleBasedIntentInterpreter(), new LLMIntentInterpreter(model));
  };

  it("sends the picked fact word for word, without the landlord", SLOW, async () => {
    const app = await liveApp({ cleanups, config: withFacts(), interpreter: layered("dishwasher") });
    await app.optInSms();
    const reply = (await app.text("Are the kitchen appliances recent?")).join("\n");
    expect(reply).toContain("The dishwasher is new.");
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("sends the question to the landlord, inventing nothing, when the pick doesn't exist", SLOW, async () => {
    const app = await liveApp({ cleanups, config: withFacts(), interpreter: layered('{"fact":9}') });
    await app.optInSms();
    const reply = (await app.text("Are the kitchen appliances recent?")).join("\n");
    expect(reply).toMatch(/pass your question/);
    expect(reply).not.toMatch(/dishwasher|basement/);
    expect(reachedLandlord(app).length).toBeGreaterThan(0);
  });
});

describe("the touring pass-through", () => {
  it("passes the five model settings into a touring process and still drops other TOURCORE_ values", () => {
    const base: NodeJS.ProcessEnv = {
      TOURCORE_INTENT_MODEL_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
      TOURCORE_INTENT_MODEL_KEY: "not-a-real-key",
      TOURCORE_INTENT_MODEL: "flash-model",
      TOURCORE_INTENT_MODEL_TIMEOUT_MS: "2500",
      TOURCORE_INTENT_MODEL_REASONING_EFFORT: "none",
      TOURCORE_STORAGE_MODEL: "DIRECT_GOOGLE_DRIVE",
    };
    const lane: Tenant = { id: "tnt_lane000001", label: "Lane", twilioNumber: "+15555550150", connections: [], invites: [], service: "touring", properties: [], createdAt: "2026-10-01T00:00:00.000Z" };
    const env = buildTouringEnv({ base, tenant: lane, dataRoot: "/data", origin: "https://s.up.railway.app", key: "k", scratch: false });
    expect(env.TOURCORE_INTENT_MODEL_URL).toBe(base.TOURCORE_INTENT_MODEL_URL);
    expect(env.TOURCORE_INTENT_MODEL_KEY).toBe("not-a-real-key");
    expect(env.TOURCORE_INTENT_MODEL).toBe("flash-model");
    expect(env.TOURCORE_INTENT_MODEL_TIMEOUT_MS).toBe("2500");
    expect(env.TOURCORE_INTENT_MODEL_REASONING_EFFORT).toBe("none");
    expect(env.TOURCORE_STORAGE_MODEL).toBeUndefined();
  });
});
