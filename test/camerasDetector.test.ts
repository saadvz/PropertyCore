import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { countDetections, detectorFromEnv, toPixelValues, decodeJpeg } from "../src/cameras/detector";

/** #239: the open-source detector's own steps, on made-up pixels and made-up model outputs. The model itself isn't loaded here. */

const CLASSES = 91;
const QUERIES = 4;
const logit = (p: number) => Math.log(p / (1 - p));

/** Made-up model outputs: one query per entry, a class id, a score and a box (cx, cy, w, h, 0 to 1). */
function outputs(rows: { cls: number; score: number; box?: [number, number, number, number] }[]) {
  const logits = new Float32Array(QUERIES * CLASSES).fill(-10);
  const boxes = new Float32Array(QUERIES * 4);
  rows.forEach((row, q) => {
    logits[q * CLASSES + row.cls] = logit(row.score);
    boxes.set(row.box ?? [0.1 + q * 0.2, 0.5, 0.1, 0.2], q * 4);
  });
  return { logits, boxes, queries: QUERIES, classes: CLASSES };
}

describe("counting the detector's boxes", () => {
  it("counts people, vehicles (cars, trucks, buses, motorbikes) and pets (dogs, cats) over the threshold", () => {
    const counts = countDetections(outputs([{ cls: 1, score: 0.9 }, { cls: 3, score: 0.8 }, { cls: 8, score: 0.7 }, { cls: 18, score: 0.95 }]), 0.5);
    expect(counts).toEqual({ people: 1, vehicles: 2, animals: 1 });
  });

  it("ignores boxes under the threshold and classes we don't count (a bench, a bird)", () => {
    expect(countDetections(outputs([{ cls: 1, score: 0.3 }, { cls: 15, score: 0.9 }, { cls: 16, score: 0.9 }]), 0.5)).toEqual({ people: 0, vehicles: 0, animals: 0 });
  });

  it("counts two boxes on the same spot once", () => {
    const same: [number, number, number, number] = [0.5, 0.5, 0.2, 0.4];
    expect(countDetections(outputs([{ cls: 1, score: 0.9, box: same }, { cls: 1, score: 0.85, box: [0.505, 0.5, 0.2, 0.4] }]), 0.5).people).toBe(1);
  });

  it("marks a count low-confidence when something counted was close to the threshold", () => {
    expect(countDetections(outputs([{ cls: 1, score: 0.55 }]), 0.5)).toEqual({ people: 1, vehicles: 0, animals: 0, confidence: "low" });
  });
});

describe("preparing the image", () => {
  it("decodes a JPEG and resizes it to the model's square, channels first, scaled 0 to 1", () => {
    const width = 4;
    const height = 2;
    const data = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) data[i * 4] = 0; // no red anywhere
    const bytes = jpeg.encode({ data, width, height }, 100).data;
    const image = decodeJpeg(new Uint8Array(bytes));
    expect([image.width, image.height]).toEqual([4, 2]);
    const pixels = toPixelValues(image, 8);
    expect(pixels.length).toBe(3 * 8 * 8);
    expect(pixels[0]).toBeLessThan(0.05); // red plane
    expect(pixels[64]).toBeGreaterThan(0.95); // green plane
    expect(Math.max(...pixels)).toBeLessThanOrEqual(1);
  });

  it("refuses something that isn't a JPEG", () => {
    expect(() => decodeJpeg(new Uint8Array([1, 2, 3]))).toThrow(/image/);
  });
});

describe("choosing the detector from the environment", () => {
  it("is RF-DETR Medium at a 0.35 threshold when the model file is set, and nothing otherwise", () => {
    expect(detectorFromEnv({})).toBeUndefined();
    expect(detectorFromEnv({ CAMERA_DETECTOR_MODEL: "/models/rfdetr_medium.onnx" })?.name).toBe("rfdetr-medium-t35-v1");
    expect(detectorFromEnv({ CAMERA_DETECTOR_MODEL: "/models/rfdetr_medium.onnx", CAMERA_DETECTOR_THRESHOLD: "0.5" })?.name).toBe("rfdetr-medium-t50-v1");
    expect(detectorFromEnv({ CAMERA_DETECTOR_MODEL: "/models/rfdetr_medium.onnx", CAMERA_DETECTOR_THRESHOLD: "7" })?.name).toBe("rfdetr-medium-t35-v1");
  });
});

describe("fetching the model", () => {
  it("throws away a download whose checksum doesn't match, and keeps nothing (stubbed, never the network)", async () => {
    const { getDetector } = await import("../src/cameras/getDetectorCli");
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const out = join(mkdtempSync(join(tmpdir(), "detector-")), "model.onnx");
    const fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof globalThis.fetch;
    const said: string[] = [];
    expect(await getDetector(out, fetch, (t) => said.push(t))).toBe(1);
    expect(said.join(" ")).toMatch(/checksum/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });
});
