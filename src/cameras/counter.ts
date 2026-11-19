import { z } from "zod";

/**
 * Our own count of people, vehicles and animals in one camera snapshot (#239). The provider labels events but never
 * counts. One fixed vision model counts for every host, whatever agent they use, so one counting test vouches for
 * all of them. The model only counts: no description, no guess at who anyone is. Its reply is parsed against a
 * strict schema, and anything else is thrown away.
 */

export interface Counts {
  people: number;
  vehicles: number;
  animals: number;
  confidence?: "low";
}

export interface Counter {
  /** The counter and its version, like "vision-v1". Stored on each count line. */
  readonly name: string;
  count(image: Uint8Array, hint: { label?: string; local?: string }): Promise<Counts>;
}

const Whole = z.number().int().min(0).max(200);
const CountsSchema = z.object({ people: Whole, vehicles: Whole, animals: Whole, confidence: z.enum(["low", "high"]).optional() }).strict();

/** The counts in a model's reply, or undefined. A fenced block is unwrapped; any extra key fails the whole reply. */
export function parseCounts(reply: string): Counts | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const raw = (fenced ? fenced[1]! : reply).trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = CountsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { people, vehicles, animals, confidence } = parsed.data;
  return { people, vehicles, animals, ...(confidence === "low" ? { confidence: "low" as const } : {}) };
}

export const COUNT_PROMPT = `Count what you can see in this still from an outdoor home security camera at a vacation rental.
Count people, vehicles (cars, trucks, vans, motorcycles; parked or moving) and animals (dogs, cats and other pets or wildlife).
Count only what is in this image. Do not describe the scene. Do not identify, name or describe any person.
If the image is too dark or blurry to be sure, give your best count and set "confidence" to "low".
Reply with one JSON object and nothing else: {"people": <whole number>, "vehicles": <whole number>, "animals": <whole number>, "confidence": "high" | "low"}`;

export interface VisionLook {
  (input: { prompt: string; image: Uint8Array; mediaType: "image/jpeg" }): Promise<string>;
}

/** A counter over one vision model. `look` wraps the vendor's API; nothing here knows which. */
export function visionCounter(options: { name: string; look: VisionLook }): Counter {
  return {
    name: options.name,
    async count(image, hint) {
      const context = [hint.label ? `The camera labelled this event "${hint.label}".` : "", hint.local ? `Local time: ${hint.local}.` : ""].filter(Boolean).join(" ");
      const reply = await options.look({ prompt: context ? `${COUNT_PROMPT}\n\n${context}` : COUNT_PROMPT, image, mediaType: "image/jpeg" });
      const counts = parseCounts(reply);
      if (!counts) throw new Error("The counting model gave no counts.");
      return counts;
    },
  };
}

/** A counter for tests: the counts come from the given function. */
export function fakeCounter(counts: (hint: { label?: string }) => Counts, name = "fake-v1"): Counter & { seen: number } {
  const counter = {
    name,
    seen: 0,
    async count(_image: Uint8Array, hint: { label?: string }) {
      counter.seen += 1;
      return counts(hint);
    },
  };
  return counter;
}
