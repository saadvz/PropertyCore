import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL_SHA256, MODEL_URL } from "./detector";

/**
 * `npm run cameras:get-detector -- --out <path to model.onnx>`
 *
 * Downloads the counting detector's model (RF-DETR Medium, Apache-2.0, ~121 MB) from Hugging Face at a pinned
 * revision, checks its SHA-256, and only then puts it in place. Run once on the server; point CAMERA_DETECTOR_MODEL at it.
 */

export function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function getDetector(out: string, fetch: typeof globalThis.fetch = globalThis.fetch, say: (text: string) => void = (text) => console.log(text)): Promise<number> {
  if (existsSync(out) && sha256Of(out) === MODEL_SHA256) {
    say(`Already in place and checked: ${out}`);
    return 0;
  }
  const partial = `${out}.partial`;
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    say(`The download answered ${response.status}.`);
    return 1;
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
  const sum = sha256Of(partial);
  if (sum !== MODEL_SHA256) {
    rmSync(partial, { force: true });
    say("The download's checksum didn't match, so it was thrown away.");
    return 1;
  }
  renameSync(partial, out);
  say(`Saved and checked: ${out}. Set CAMERA_DETECTOR_MODEL=${out}.`);
  return 0;
}

if (process.argv[1] && /getDetectorCli\.[tj]s$/.test(process.argv[1])) {
  const at = process.argv.indexOf("--out");
  const out = at >= 0 ? process.argv[at + 1] : undefined;
  if (!out) {
    console.log("Usage: cameras:get-detector -- --out <path to model.onnx>");
    process.exit(2);
  }
  void getDetector(out).then((code) => process.exit(code));
}
