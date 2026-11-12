// Renders the Fixer Core trailer from index.html, frame by frame.
//
//   node render.mjs stills <outDir> 3 12.5 40      one PNG per time, in seconds
//   node render.mjs video <out.mp4> [music]         every frame at 30 fps, music optional
//
// Needs Playwright with Chromium and ffmpeg.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Playwright is often installed globally, which an ES import doesn't find; require() does.
const { chromium } = createRequire(import.meta.url)("playwright");
const [mode, out, ...rest] = process.argv.slice(2);
if (!mode || !out) { console.error("usage: node render.mjs stills <dir> <t...> | video <out.mp4> [music]"); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "index.html")).href + "?render");
await page.evaluate(() => window.ready);
const { duration, fps } = await page.evaluate(() => ({ duration: window.DURATION, fps: window.FPS }));

if (mode === "stills") {
  mkdirSync(out, { recursive: true });
  for (const t of rest.map(Number)) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: join(out, `t${String(t.toFixed(1)).padStart(5, "0")}.png`) });
  }
} else {
  const [music] = rest;
  const frames = Math.round(duration * fps);
  const args = ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-"];
  // A shorter track is slowed to fit (pitch kept) rather than left to end early.
  const musicLength = music ? Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", music]).toString()) : 0;
  const tempo = musicLength && musicLength < duration ? `atempo=${(musicLength / duration).toFixed(4)},` : "";
  if (music) args.push("-i", music, "-filter_complex", `[1:a]${tempo}apad,atrim=0:${duration},afade=t=out:st=${duration - 3}:d=3[a]`, "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  args.push("-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", String(duration), out);
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), i / fps);
    const buf = await page.screenshot({ type: "jpeg", quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 150 === 0) console.log(`frame ${i}/${frames}`);
  }
  ff.stdin.end();
  await done;
}
await browser.close();
