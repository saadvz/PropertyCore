import { describe, expect, it } from "vitest";
import { counterFromEnv, geminiLook, outputText } from "../src/cameras/gemini";

/** #239: the Gemini counter. The model's API is stubbed; no test reaches Google. Made-up key. */

const KEY = "made-up-gemini-key";
type Call = { url: string; init: RequestInit };

function stub(reply: () => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the Gemini request", () => {
  it("sends the image and prompt to Gemini 4 Neon at low thinking, asks for JSON, and asks Google not to store it", async () => {
    const { calls, fetch } = stub(() => json({ output_text: '{"people": 2, "vehicles": 1, "animals": 0}' }));
    const look = geminiLook({ apiKey: KEY, fetch });
    const reply = await look({ prompt: "Count.", image: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" });
    expect(reply).toBe('{"people": 2, "vehicles": 1, "animals": 0}');
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: "gemini-4-neon", store: false, generation_config: { thinking_level: "low" }, response_format: { type: "text", mime_type: "application/json" } });
    expect(body.input).toEqual([
      { type: "text", text: "Count." },
      { type: "image", data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"), mime_type: "image/jpeg" },
    ]);
    expect(body.response_format.schema.required).toEqual(["people", "vehicles", "animals"]);
  });

  it("says plainly when Google refuses, never with the key or the reply's body", async () => {
    const { fetch } = stub(() => json({ error: { message: `bad key ${KEY}` } }, 403));
    const look = geminiLook({ apiKey: KEY, fetch });
    const error = await look({ prompt: "Count.", image: new Uint8Array([1]), mediaType: "image/jpeg" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/403/);
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("gives up after its timeout", async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof globalThis.fetch;
    const look = geminiLook({ apiKey: KEY, fetch, timeoutMs: 10 });
    await expect(look({ prompt: "Count.", image: new Uint8Array([1]), mediaType: "image/jpeg" })).rejects.toThrow(/didn't answer/);
  });
});

describe("reading the reply", () => {
  it("takes output_text, or the model_output step's text, and nothing from a failed interaction", () => {
    expect(outputText({ output_text: "{}" })).toBe("{}");
    expect(outputText({ steps: [{ type: "thought", content: [{ type: "text", text: "hmm" }] }, { type: "model_output", content: [{ type: "text", text: '{"people":1}' }] }] })).toBe('{"people":1}');
    expect(outputText({ outputs: [{ type: "text", text: "{}" }] })).toBe("{}");
    expect(outputText({ status: "failed", output_text: "{}" })).toBeUndefined();
    expect(outputText({})).toBeUndefined();
  });
});

describe("choosing the counter from the environment", () => {
  it("is Gemini 4 Neon at low thinking when its key is set, and nothing otherwise", () => {
    expect(counterFromEnv({})).toBeUndefined();
    const counter = counterFromEnv({ CAMERA_COUNTER_GEMINI_KEY: KEY });
    expect(counter?.name).toBe("gemini-4-neon-low-v1");
    expect(counterFromEnv({ CAMERA_COUNTER_GEMINI_KEY: KEY, CAMERA_COUNTER_MODEL: "gemini-4-carbon", CAMERA_COUNTER_THINKING: "medium" })?.name).toBe("gemini-4-carbon-medium-v1");
    expect(counterFromEnv({ CAMERA_COUNTER_GEMINI_KEY: KEY, CAMERA_COUNTER_THINKING: "extreme" })?.name).toBe("gemini-4-neon-low-v1");
    expect(counterFromEnv({ CAMERA_COUNTER_GEMINI_KEY: KEY, CAMERA_COUNTER_MODEL: "../../evil" })?.name).toBe("gemini-4-neon-low-v1");
  });
});
