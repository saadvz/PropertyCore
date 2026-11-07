import { describe, expect, it } from "vitest";
import { createIntentInterpreter } from "../../src/intent";

/** The eval suite runs under its own config; it must not reach a paid API either. */
describe("the eval suite never calls a paid API", () => {
  it("runs on the rules alone, even when the shell has a model configured", () => {
    expect(process.env.TOURCORE_INTENT_MODEL_KEY).toBeUndefined();
    expect(createIntentInterpreter().description).toBe("rules");
  });

  it("refuses fetch to any host but this computer", async () => {
    await expect(fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", { method: "POST" })).rejects.toThrow(/may not call/);
  });
});
