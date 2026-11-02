import { afterEach, describe, expect, it } from "vitest";
import { LayeredIntentInterpreter, LLMIntentInterpreter, RuleBasedIntentInterpreter, type LanguageModel } from "../src/intent";
import { liveApp } from "./liveApp";
import { reachedLandlord } from "./visitorScenarioKit";

/**
 * The rules read any question-shaped text they don't recognize as a property question, so the model
 * never got to say it was a reschedule or an open-times ask. Now, when no fact or setup detail answers
 * that question, the model is asked what the text is before it reaches the landlord. Fake models only.
 * Only 555 numbers.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const SLOW = { timeout: 30_000 };

/** A fake model: `intent` for classification, none for fact picks. Counts classification calls. */
function fake(intent: string) {
  const classified: string[] = [];
  const model: LanguageModel = {
    name: "fake",
    complete: async (input) => {
      if (input.system.includes('"fact"')) return '{"fact":null}';
      classified.push((JSON.parse(input.user) as { message: string }).message);
      return `{"intent":"${intent}","confidence":0.92}`;
    },
  };
  return { interpreter: new LayeredIntentInterpreter(new RuleBasedIntentInterpreter(), new LLMIntentInterpreter(model)), classified };
}

describe("the model reads a text the rules filed as a property question", () => {
  it("moves a booked tour for a reschedule the rules missed, without the landlord", SLOW, async () => {
    const { interpreter } = fake("RESCHEDULE_TOUR");
    const app = await liveApp({ cleanups, interpreter });
    await app.book();
    const reply = (await app.text("something came up, any way we could shuffle to later in the week?")).join("\n");
    expect(reply).toMatch(/Reply with the number/);
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("lists open times for an open-times ask the rules missed", SLOW, async () => {
    const { interpreter } = fake("ASK_OPEN_TIMES");
    const app = await liveApp({ cleanups, interpreter });
    await app.book();
    const reply = (await app.text("anything else free besides mine, just curious?")).join("\n");
    expect(reply).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("repeats the booking for a my-tour ask the rules missed", SLOW, async () => {
    const { interpreter } = fake("ASK_MY_TOUR");
    const app = await liveApp({ cleanups, interpreter });
    await app.book();
    expect((await app.text("remind me when I'm coming by?")).join("\n")).toMatch(/2:00 PM/);
    expect(reachedLandlord(app)).toEqual([]);
  });

  it("does not ask the model when a fact or setup detail answers the question", SLOW, async () => {
    const { interpreter, classified } = fake("RESCHEDULE_TOUR");
    const app = await liveApp({ cleanups, interpreter });
    await app.book();
    expect((await app.text("Is there parking?")).join("\n")).toMatch(/Street parking only/);
    expect(classified).not.toContain("Is there parking?");
  });

  it("still sends the question to the landlord when the model also reads a property question", SLOW, async () => {
    const { interpreter } = fake("ASK_PROPERTY_QUESTION");
    const app = await liveApp({ cleanups, interpreter });
    await app.book();
    await app.text("Is there a gym?");
    expect(reachedLandlord(app).length).toBeGreaterThan(0);
  });

  it("never moves a tour for a visitor with no booking", SLOW, async () => {
    const { interpreter } = fake("RESCHEDULE_TOUR");
    const app = await liveApp({ cleanups, interpreter });
    await app.optInSms();
    const reply = (await app.text("can we bump things a couple days")).join("\n");
    expect(reply).not.toMatch(/Reply with the number/);
  });

  it("never sends a fair-housing question to the model to reclassify", SLOW, async () => {
    const { interpreter, classified } = fake("ASK_OPEN_TIMES");
    const app = await liveApp({ cleanups, interpreter });
    await app.optInSms();
    await app.text("Are there a lot of families with kids in the building?");
    expect(classified).toEqual([]);
    expect(reachedLandlord(app).length).toBeGreaterThan(0);
  });
});
