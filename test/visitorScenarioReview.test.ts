import { afterEach, describe, expect, it } from "vitest";
import { isFairHousingStatement } from "../src/core/fairHousing";
import { resolveQuestion } from "../src/core/questions";
import { LLMIntentInterpreter, RuleBasedIntentInterpreter, type LanguageModel } from "../src/intent";
import { redactForModel } from "../src/intent/factPick";
import { isOpenTimesAsk, isRescheduleAsk } from "../src/intent/ruleBased";
import { at, hillsideConfig, liveApp, type LiveApp } from "./liveApp";
import { reachedLandlord, visitorSession } from "./visitorScenarioKit";

/**
 * Fixes from the final review of the visitor scenarios work: rules that took over other questions,
 * unrecorded visitor texts, the after-tour suffix on built-in answers, loose logistics matching, the
 * fair-housing statement check, name redaction, a pending identity form, and rescheduling on a tour.
 * Only 555 numbers.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const SLOW = { timeout: 30_000 };

describe("the open-times rule leaves other questions alone", () => {
  it("does not read time-of-day and property questions as open tour times", () => {
    for (const text of [
      "How much time do I have left?",
      "What time do I need to be out?",
      "What time does the gym open?",
      "What time is trash pickup?",
      "Is there free parking at any time?",
      "Do you have time for a question?",
      "yes, any time works",
      "What times is the gym open?",
    ]) expect(isOpenTimesAsk(text), text).toBe(false);
    for (const text of ["What times do you have?", "ok what times are available?", "any openings tuesday?", "Any open slots this week?"]) expect(isOpenTimesAsk(text), text).toBe(true);
  });

  it("is never read during a running tour", async () => {
    const rules = new RuleBasedIntentInterpreter();
    const out = await rules.interpret({ message: "What times are open?", step: "touring", units: [{ name: "Unit 1A" }], timeChoices: [], remainingStops: [], doors: [], hasRunningTour: true });
    expect(out.intent.type).not.toBe("ASK_OPEN_TIMES");
  });
});

describe("the reschedule rule leaves move-in, lease, and rent questions alone", () => {
  it("does not read them as moving the tour", () => {
    for (const text of [
      "Can I move in early? Is it available June 1?",
      "When can I move in? Is it ready?",
      "Will the rent change next year? Is it fixed?",
      "Can I switch it to a 12 month lease?",
      "What's the earliest move-in time?",
      "Can I get the 2 bedroom instead? What day is it available?",
    ]) expect(isRescheduleAsk(text), text).toBe(false);
    for (const text of ["Can I change the time for the tour?", "can I change the time?", "Can we do Thursday instead?", "could we push it back a bit", "can we move it to friday", "I need to reschedule"]) expect(isRescheduleAsk(text), text).toBe(true);
  });
});

describe("tour length and ID match only those questions", () => {
  const config = hillsideConfig();
  const builtIn = (q: string) => {
    const r = resolveQuestion(config, q);
    return r.kind === "answer" && r.facts.some((f) => f.templateId) ? r.facts[0]!.templateId : undefined;
  };

  it("leaves other how-long and license questions to facts or the landlord", () => {
    expect(builtIn("How long is the lease? I'd also like to know about the tour.")).toBeUndefined();
    expect(builtIn("How many minutes to the subway?")).toBeUndefined();
    expect(builtIn("How long can my guests visit?")).toBeUndefined();
    expect(builtIn("Do you have parking? Is the license plate needed?")).toBeUndefined();
  });

  it("still answers the tour-length and ID questions", () => {
    expect(builtIn("How long does the tour take?")).toBe("tour-length");
    expect(builtIn("How many minutes is the tour?")).toBe("tour-length");
    expect(builtIn("Do I need ID?")).toBe("tour-id-form");
    expect(builtIn("Should I bring my driver's license?")).toBe("tour-id-form");
  });
});

describe("the fair-housing statement check", () => {
  it("allows inclusive and accessibility facts", () => {
    for (const text of [
      "Yes, kids are welcome on the tour.",
      "Yes, bring your family.",
      "Yes, you can bring your partner or children.",
      "Elevator building, wheelchair accessible.",
      "Assistance animals are always allowed.",
      "We accept housing vouchers.",
      "Only white walls, no nails.",
      "12-month leases only.",
    ]) expect(isFairHousingStatement(text), text).toBe(false);
  });

  it("refuses a preference or limit about who lives there", () => {
    for (const text of ["Great for families", "Ideal for a young professional", "No kids please", "Mature tenants preferred.", "English speakers only.", "Perfect for a bachelor.", "Adults only."]) {
      expect(isFairHousingStatement(text), text).toBe(true);
    }
  });
});

describe("what the model sees", () => {
  it("never sees the visitor's name when classifying", async () => {
    const calls: string[] = [];
    const model: LanguageModel = { name: "fake", complete: async (input) => (calls.push(input.user), '{"intent":"UNKNOWN","confidence":0.1}') };
    await new LLMIntentInterpreter(model).interpret({ message: "Hi this is Pat Smith, any chance to swap?", step: "ready", units: [], timeChoices: [], remainingStops: [], doors: [], visitorName: "Pat Smith" });
    expect(calls[0]).not.toMatch(/Pat|Smith/);
    expect(calls[0]).toContain("[name]");
  });

  it("replaces only whole-word name matches", () => {
    expect(redactForModel("What time is it?", "Tim")).toBe("What time is it?");
    expect(redactForModel("I need it.", "Ed")).toBe("I need it.");
    expect(redactForModel("This is Tim.", "Tim")).toBe("This is [name].");
  });
});

async function booked(): Promise<LiveApp> {
  const app = await liveApp({ cleanups });
  await app.book();
  return app;
}

const inbound = async (app: LiveApp) => (await visitorSession(app).store.list("messages")).filter((m) => m.direction === "INBOUND").map((m) => m.body);

describe("the new handlers", () => {
  it("record what the visitor texted", SLOW, async () => {
    const app = await booked();
    await app.text("Can I change the time?");
    await app.text("When is my tour?");
    await app.text("What's the address?");
    await app.text("What times do you have?");
    const got = await inbound(app);
    for (const text of ["Can I change the time?", "When is my tour?", "What's the address?", "What times do you have?"]) expect(got.filter((body) => body === text), text).toHaveLength(1);
  });

  it("answer a visitor whose identity form is still pending, without the landlord", SLOW, async () => {
    const app = await liveApp({ cleanups });
    await app.optInSms();
    await app.text("1");
    await app.text("1");
    await app.text("1");
    await app.text("YES");
    expect((await app.text("When is my tour?")).join("\n")).toMatch(/2:00 PM/);
    const offered = (await app.text("Can I change the time?")).join("\n");
    expect(offered).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(reachedLandlord(app)).toEqual([]);
  });
});

describe("after a tour", () => {
  it("answers tour length and ID with the tour-again line, without a snag", SLOW, async () => {
    const app = await booked();
    app.clock.t = at(13, 55);
    await app.text("I'm here");
    await app.text("DONE");
    await app.text("YES");
    const before = reachedLandlord(app).length;
    const reply = (await app.text("How long does the tour take?")).join("\n");
    expect(reply).toContain("Tours are about 45 minutes.");
    expect(reply).not.toMatch(/snag/i);
    expect((await app.text("Do I need ID?")).join("\n")).toContain("No ID is needed at the door.");
    expect(reachedLandlord(app).length).toBe(before);
  });
});

describe("on a running tour", () => {
  it("never offers to move the tour, even when the model reads a reschedule", SLOW, async () => {
    const model: LanguageModel = { name: "fake", complete: async () => '{"intent":"RESCHEDULE_TOUR","confidence":0.99}' };
    const { LayeredIntentInterpreter } = await import("../src/intent");
    const app = await liveApp({ cleanups, interpreter: new LayeredIntentInterpreter(new RuleBasedIntentInterpreter(), new LLMIntentInterpreter(model)) });
    await app.book();
    app.clock.t = at(13, 55);
    await app.text("I'm here");
    const before = (await visitorSession(app).reservation())?.slotStart;
    const reply = (await app.text("could we kinda shuffle things")).join("\n");
    expect(reply).not.toMatch(/Reply with the number/);
    expect((await visitorSession(app).reservation())?.slotStart).toBe(before);
  });
});
