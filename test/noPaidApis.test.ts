import { describe, expect, it } from "vitest";
import { createIntentInterpreter } from "../src/intent";

describe("tests never call a paid API", () => {
  it("runs on the rules alone, even when the shell has a model configured", () => {
    expect(process.env.TOURCORE_INTENT_MODEL_URL).toBeUndefined();
    expect(process.env.TOURCORE_INTENT_MODEL_KEY).toBeUndefined();
    expect(process.env.TOURCORE_INTENT_MODEL).toBeUndefined();
    expect(createIntentInterpreter().description).toBe("rules");
  });

  it("refuses fetch to any host but this computer", async () => {
    await expect(fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", { method: "POST" })).rejects.toThrow(/may not call/);
    await expect(fetch(new URL("https://api.twilio.com/2010-04-01/Accounts"))).rejects.toThrow(/may not call/);
    await expect(fetch(new Request("https://api.anthropic.com/v1/messages"))).rejects.toThrow(/may not call/);
  });
});
