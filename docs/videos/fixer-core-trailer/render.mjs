// Renders the Fixer Core trailer from index.html, frame by frame.
//
//   node render.mjs stills <outDir> 3 12.5 40      one PNG per time, in seconds
//   node render.mjs video <out.mp4> [audio]         every frame at 30 fps; audio optional
//   node render.mjs audio <out.wav> voiceover.json  just the audio, to check the mix
//
// audio is one track (it plays as recorded), or a .json list of clips, each cut and placed
// at its time: voiceover.json is the trailer's voiceover.
//
// Needs Playwright with Chromium and ffmpeg.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Playwright is often installed globally, which an ES import doesn't find; require() does.
const { chromium } = createRequire(import.meta.url)("playwright");
const [mode, out, ...rest] = process.argv.slice(2);
if (!mode || !out) { console.error("usage: node render.mjs stills <dir> <t...> | video <out.mp4> [audio] | audio <out.wav> <audio>"); process.exit(1); }

/** ffmpeg inputs and filter for the audio, its inputs numbered from `first`; the result is labelled [a]. */
function audioArgs(audio, first, duration) {
  if (!audio.endsWith(".json")) {
    // One track plays as recorded, so a voiceover stays on its timecodes: a short one is padded with silence.
    return { inputs: ["-i", audio], filter: `[${first}:a]apad,atrim=0:${duration},afade=t=out:st=${duration - 3}:d=3[a]` };
  }
  const base = dirname(audio);
  const { clips } = JSON.parse(readFileSync(audio, "utf8"));
  const inputs = clips.flatMap((c) => ["-i", join(base, "voiceover", c.file)]);
  const parts = clips.map((c, i) => {
    const cut = c.from !== undefined || c.to !== undefined ? `atrim=${c.from ?? 0}${c.to !== undefined ? `:${c.to}` : ""},asetpts=PTS-STARTPTS,` : "";
    // A short fade at each cut keeps it from clicking.
    return `[${first + i}:a]aresample=48000,${cut}afade=t=in:d=0.02,areverse,afade=t=in:d=0.04,areverse,adelay=${Math.round(c.at * 1000)}:all=1[c${i}]`;
  });
  const mix = `${clips.map((_, i) => `[c${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad=whole_dur=${duration},atrim=0:${duration}[a]`;
  return { inputs, filter: [...parts, mix].join(";") };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "index.html")).href + "?render");
await page.evaluate(() => window.ready);
const { duration, fps } = await page.evaluate(() => ({ duration: window.DURATION, fps: window.FPS }));

if (mode === "audio") {
  const { inputs, filter } = audioArgs(rest[0], 0, duration);
  const ff = spawn("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", filter, "-map", "[a]", out], { stdio: "inherit" });
  await new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
} else if (mode === "stills") {
  mkdirSync(out, { recursive: true });
  for (const t of rest.map(Number)) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: join(out, `t${String(t.toFixed(1)).padStart(5, "0")}.png`) });
  }
} else {
  const [audio] = rest;
  const frames = Math.round(duration * fps);
  const args = ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-"];
  if (audio) {
    const { inputs, filter } = audioArgs(audio, 1, duration);
    args.push(...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  }
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
