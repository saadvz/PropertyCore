import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { detectorFromEnv } from "./detector";

/**
 * `CAMERA_DETECTOR_MODEL=<path to model.onnx> npm run cameras:live-count -- <image.jpg> [more.jpg ...]`
 *
 * A manual check of the counting detector (#239) on real images, run by hand. Everything stays on this machine: the
 * detector runs locally and no image is sent anywhere. No test runs it.
 */

export async function runLiveCount(paths: string[], env: NodeJS.ProcessEnv = process.env, say: (text: string) => void = (text) => console.log(text)): Promise<number> {
  if (!paths.length) {
    say("Usage: CAMERA_DETECTOR_MODEL=<model.onnx> cameras:live-count <image.jpg> [more.jpg ...]");
    return 2;
  }
  const counter = detectorFromEnv(env);
  if (!counter) {
    say("CAMERA_DETECTOR_MODEL isn't set. Fetch the model with `npm run cameras:get-detector -- --out <path>` first.");
    return 1;
  }
  say(`Counter: ${counter.name}`);
  let failed = 0;
  for (const path of paths) {
    if (!existsSync(path)) {
      say(`${basename(path)}: no such file`);
      failed += 1;
      continue;
    }
    const started = Date.now();
    try {
      const counts = await counter.count(new Uint8Array(readFileSync(path)), {});
      say(`${basename(path)}: ${JSON.stringify(counts)} (${Date.now() - started} ms)`);
    } catch (error) {
      say(`${basename(path)}: ${error instanceof Error ? error.message : "failed"} (${Date.now() - started} ms)`);
      failed += 1;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && /liveCountCli\.[tj]s$/.test(process.argv[1])) {
  void runLiveCount(process.argv.slice(2)).then((code) => process.exit(code));
}
