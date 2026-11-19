import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { counterFromEnv } from "./gemini";

/**
 * `npm run cameras:live-count -- <image.jpg> [more.jpg ...]`
 *
 * A manual live check of the counting model (#239), run by hand on the server or in a session that has
 * CAMERA_COUNTER_GEMINI_KEY in its environment. It sends each given JPEG to the counter and prints the counts. Use
 * only images you may send to Google: your own camera's stills or public sample photos, never a guest's. It never
 * prints the key. No test runs it.
 */

export async function runLiveCount(paths: string[], env: NodeJS.ProcessEnv = process.env, say: (text: string) => void = (text) => console.log(text), fetch?: typeof globalThis.fetch): Promise<number> {
  if (!paths.length) {
    say("Usage: cameras:live-count <image.jpg> [more.jpg ...]");
    return 2;
  }
  const counter = counterFromEnv(env, fetch);
  if (!counter) {
    say("CAMERA_COUNTER_GEMINI_KEY isn't set in this environment, so there's no counter to try.");
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
      const counts = await counter.count(new Uint8Array(readFileSync(path)), { local: "test image" });
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
