import { visionCounter, type Counter, type VisionLook } from "./counter";

/**
 * The counter's model call through Google's Gemini API (#239): Gemini 4 Neon at low thinking by default, the best
 * counter in Roboflow's counting benchmark on 19 Nov 2026 among the models checked. Plain HTTP to the Interactions
 * API, so no new package. Each request asks Google not to store the interaction. The key is an environment secret
 * and never appears in an error or a log; neither does a reply's body.
 *
 * Field names follow aistudio.google.com/docs (thinking, image understanding, structured output) as read on 19 Nov.
 * The docs show the SDK's `output_text` but no REST reply, so `outputText` also reads the `model_output` step. The
 * first live call should confirm it; until then a reply it can't read leaves the event uncounted, never guessed.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
export const DEFAULT_COUNTER_MODEL = "gemini-4-neon";
export const DEFAULT_COUNTER_THINKING = "low";
const THINKING_LEVELS = ["low", "medium", "high", "xhigh"];
const MODEL_NAME = /^gemini-[a-z0-9.-]{1,22}$/; // keeps the counter name within the log's 40 characters
const TIMEOUT_MS = 30_000;
/** CAMERA_COUNTER_GEMINI_KEY=network: the key lives in the environment's network secret for Google's host, never in the process. */
export const NETWORK_KEY = "network";

const COUNT_SCHEMA = {
  type: "object",
  properties: {
    people: { type: "integer", minimum: 0 },
    vehicles: { type: "integer", minimum: 0 },
    animals: { type: "integer", minimum: 0 },
    confidence: { type: "string", enum: ["high", "low"] },
  },
  required: ["people", "vehicles", "animals"],
};

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function textOf(content: unknown): string | undefined {
  const parts = list(content)
    .map((part) => obj(part))
    .filter((part) => (part.type === undefined || part.type === "text") && typeof part.text === "string")
    .map((part) => part.text as string);
  return parts.length ? parts.join("") : typeof content === "string" ? content : undefined;
}

/** The model's text from an interaction, or undefined when it failed or carries none. */
export function outputText(reply: unknown): string | undefined {
  const body = obj(reply);
  if (typeof body.status === "string" && !["completed", "succeeded", "done"].includes(body.status)) return undefined;
  if (typeof body.output_text === "string") return body.output_text;
  const step = list(body.steps).map(obj).filter((entry) => entry.type === "model_output").at(-1);
  if (step) return textOf(step.content) ?? (typeof step.text === "string" ? step.text : undefined);
  return textOf(body.outputs);
}

export function geminiLook(options: { apiKey: string; model?: string; thinkingLevel?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }): VisionLook {
  const fetch = options.fetch ?? globalThis.fetch;
  const model = options.model ?? DEFAULT_COUNTER_MODEL;
  const thinking = options.thinkingLevel ?? DEFAULT_COUNTER_THINKING;
  return async ({ prompt, image, mediaType }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        // "network": the environment's network secret adds the key on its way to Google, so none is sent from here.
        headers: { "content-type": "application/json", ...(options.apiKey === NETWORK_KEY ? {} : { "x-goog-api-key": options.apiKey }), "Api-Revision": API_REVISION },
        body: JSON.stringify({
          model,
          input: [
            { type: "text", text: prompt },
            { type: "image", data: Buffer.from(image).toString("base64"), mime_type: mediaType },
          ],
          generation_config: { thinking_level: thinking },
          response_format: { type: "text", mime_type: "application/json", schema: COUNT_SCHEMA },
          store: false,
        }),
      });
    } catch {
      throw new Error(controller.signal.aborted ? "The counting model didn't answer in time." : "The counting model couldn't be reached.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`The counting model answered ${response.status}.`);
    const text = outputText(await response.json().catch(() => undefined));
    if (text === undefined) throw new Error("The counting model gave no answer.");
    return text;
  };
}

/** The live counter from the service's environment: Gemini when its key is set, else none (counting stays off). */
export function counterFromEnv(env: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch): Counter | undefined {
  const apiKey = env.CAMERA_COUNTER_GEMINI_KEY?.trim();
  if (!apiKey) return undefined;
  const asked = env.CAMERA_COUNTER_MODEL?.trim().toLowerCase();
  const model = asked && MODEL_NAME.test(asked) ? asked : DEFAULT_COUNTER_MODEL;
  const level = env.CAMERA_COUNTER_THINKING?.trim().toLowerCase();
  const thinkingLevel = level && THINKING_LEVELS.includes(level) ? level : DEFAULT_COUNTER_THINKING;
  // The name goes on every count line, so a recount with another model or level is a new line, never an edit.
  return visionCounter({ name: `${model}-${thinkingLevel}-v1`, look: geminiLook({ apiKey, model, thinkingLevel, ...(fetch ? { fetch } : {}) }) });
}
