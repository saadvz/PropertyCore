import jpeg from "jpeg-js";
import type { Counter, Counts } from "./counter";

/**
 * The live counter (#239): RF-DETR Medium, an open-source object detector (Apache-2.0, trained on COCO), run on our
 * own server with onnxruntime-node. No image leaves the server and no key is needed. The model file comes from
 * Hugging Face's `onnx-community/rfdetr_medium-ONNX` at a pinned revision (`npm run cameras:get-detector`), and its
 * path is CAMERA_DETECTOR_MODEL.
 *
 * Each still is decoded, resized to the model's 576 x 576 square and scaled 0 to 1 (the export's preprocessor
 * config: no mean/std step). The model gives 300 candidate boxes with a score per COCO class; a box counts when its
 * best class is one we count and its score clears the threshold. The threshold isn't final: the counting week sets it.
 */

export const MODEL_REVISION = "8553cefdd984bbaeb9d9ca8743d6a6a1c3e29dce";
export const MODEL_URL = `https://huggingface.co/onnx-community/rfdetr_medium-ONNX/resolve/${MODEL_REVISION}/onnx/model.onnx`;
export const MODEL_SHA256 = "768928acf337ac86d069c9d55a929e11e563c1e1d272a3ffc9366248d66b2654";
export const INPUT_SIZE = 576;
export const DEFAULT_THRESHOLD = 0.35; // best on the six test photos (19 Nov); the counting week sets the real one
/** A counted box this close above the threshold makes the count low-confidence. */
const LOW_MARGIN = 0.1;
/** Two boxes of the same class overlapping this much are one object. */
const SAME_OBJECT_IOU = 0.7;
const MAX_PIXELS = 4096 * 4096;

/** COCO class ids, as the export's config numbers them. */
const PEOPLE = new Set([1]);
/** Car, motorcycle, bus, truck: what parks in a driveway. Bicycles aren't counted as vehicles. */
const VEHICLES = new Set([3, 4, 6, 8]);
/** Cat, dog: pets. Birds and wildlife would trip a no-pet rule for nothing, so they aren't counted. */
const ANIMALS = new Set([17, 18]);

export interface Image {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

export function decodeJpeg(bytes: Uint8Array): Image {
  try {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1_000_000, maxMemoryUsageInMB: 512 });
    return { width: image.width, height: image.height, data: image.data };
  } catch {
    throw new Error("The snapshot isn't a readable image.");
  }
}

/** The model's input: RGB planes, channels first, resized (bilinear) to size x size, each value 0 to 1. */
export function toPixelValues(image: Image, size = INPUT_SIZE): Float32Array {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  const sx = image.width / size;
  const sy = image.height / size;
  for (let y = 0; y < size; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), image.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const wy = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), image.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const at = (px: number, py: number) => image.data[(py * image.width + px) * 4 + c]!;
        const top = at(x0, y0) * (1 - wx) + at(x1, y0) * wx;
        const bottom = at(x0, y1) * (1 - wx) + at(x1, y1) * wx;
        out[c * plane + y * size + x] = (top * (1 - wy) + bottom * wy) / 255;
      }
    }
  }
  return out;
}

export interface ModelOutputs {
  /** queries x classes, raw scores before the sigmoid. */
  logits: Float32Array;
  /** queries x 4: centre x, centre y, width, height, each 0 to 1. */
  boxes: Float32Array;
  queries: number;
  classes: number;
}

type Box = { cls: number; score: number; x1: number; y1: number; x2: number; y2: number };
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const iou = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = w * h;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
};

/** People, vehicles and pets from the model's boxes. Pure. */
export function countDetections(out: ModelOutputs, threshold = DEFAULT_THRESHOLD): Counts {
  const kept: Box[] = [];
  for (let q = 0; q < out.queries; q++) {
    let cls = 0;
    let best = -Infinity;
    for (let c = 0; c < out.classes; c++) {
      const v = out.logits[q * out.classes + c]!;
      if (v > best) {
        best = v;
        cls = c;
      }
    }
    const score = sigmoid(best);
    if (score < threshold || !(PEOPLE.has(cls) || VEHICLES.has(cls) || ANIMALS.has(cls))) continue;
    const [cx, cy, w, h] = [out.boxes[q * 4]!, out.boxes[q * 4 + 1]!, out.boxes[q * 4 + 2]!, out.boxes[q * 4 + 3]!];
    kept.push({ cls, score, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 });
  }
  kept.sort((a, b) => b.score - a.score);
  const objects: Box[] = [];
  for (const box of kept) {
    const group = (c: number) => (PEOPLE.has(c) ? 0 : VEHICLES.has(c) ? 1 : 2);
    if (!objects.some((o) => group(o.cls) === group(box.cls) && iou(o, box) > SAME_OBJECT_IOU)) objects.push(box);
  }
  const counts: Counts = {
    people: objects.filter((o) => PEOPLE.has(o.cls)).length,
    vehicles: objects.filter((o) => VEHICLES.has(o.cls)).length,
    animals: objects.filter((o) => ANIMALS.has(o.cls)).length,
  };
  return objects.some((o) => o.score < threshold + LOW_MARGIN) ? { ...counts, confidence: "low" } : counts;
}

interface Session {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

/** The detector as a counter. The model loads on the first count and stays loaded. */
export function detectorCounter(options: { modelPath: string; threshold?: number }): Counter {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  let session: Promise<Session> | undefined;
  const load = async (): Promise<Session> => {
    const ort = await import("onnxruntime-node");
    return (await ort.InferenceSession.create(options.modelPath, { graphOptimizationLevel: "all" })) as unknown as Session;
  };
  return {
    name: `rfdetr-medium-t${Math.round(threshold * 100)}-v1`,
    async count(bytes) {
      const pixels = toPixelValues(decodeJpeg(bytes));
      session ??= load().catch((error) => {
        session = undefined;
        throw error;
      });
      const ort = await import("onnxruntime-node");
      const result = await (await session).run({ pixel_values: new ort.Tensor("float32", pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]) });
      const logits = result.logits!;
      const boxes = result.pred_boxes!;
      return countDetections({ logits: logits.data as Float32Array, boxes: boxes.data as Float32Array, queries: logits.dims[1]!, classes: logits.dims[2]! }, threshold);
    },
  };
}

/** The live counter from the service's environment: the detector when its model file is set, else none (counting stays off). */
export function detectorFromEnv(env: NodeJS.ProcessEnv): Counter | undefined {
  const modelPath = env.CAMERA_DETECTOR_MODEL?.trim();
  if (!modelPath) return undefined;
  const asked = Number(env.CAMERA_DETECTOR_THRESHOLD);
  const threshold = Number.isFinite(asked) && asked >= 0.1 && asked <= 0.95 ? Math.round(asked * 100) / 100 : DEFAULT_THRESHOLD;
  return detectorCounter({ modelPath, threshold });
}
