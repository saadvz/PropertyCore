#!/usr/bin/env node
// Entry point for `npm run bootstrap:grok`. Plain Node (no TypeScript loader yet) so it can
// install Tour Core's dependencies on a fresh computer before handing off to the real bootstrap.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
// Same check as nodeVersionProblem in src/install/bootstrap.ts (package.json engines: >=22.13.0).
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`  Tour Core needs Node.js 22.13 or newer, and this computer has ${process.versions.node}. Install the LTS version from nodejs.org, then run this again.`);
  process.exit(1);
}

const required = ["tsx", "@modelcontextprotocol/sdk", "express", "sendblue", "zod"];
const missing = required.filter((m) => !existsSync(join(repo, "node_modules", ...m.split("/"))));
if (missing.length) {
  console.log("  Installing Tour Core's dependencies (first run)...");
  const args = existsSync(join(repo, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
  if (npm.status !== 0) {
    console.error(`  Couldn't install dependencies (npm ${args[0]} failed). Check the internet connection and run it again.`);
    process.exit(1);
  }
}

const run = spawnSync(process.execPath, ["--import", "tsx", join("src", "install", "bootstrap.ts"), ...process.argv.slice(2)], { cwd: repo, stdio: "inherit" });
process.exit(run.status ?? 1);
