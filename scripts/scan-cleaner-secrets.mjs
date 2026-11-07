#!/usr/bin/env node
// Fail when a configured Cleaner Core secret appears outside the historical allowlist.
// Secrets are read from the tenant store and the Annex lock fixture. This file does not repeat them.

import { execFileSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TEST_SEAL_KEY } from "./cleaner-seal-test-key.mjs";
import { scratchSecrets } from "./scratch-pin-pattern.mjs";

const root = process.cwd();
const allow = new Set([
  "src/cleaner-core/fixtures/annex-lock.txt",
  "src/cleaner-core/fixtures/google-lane-read.json",
  "test/cleanerCore.test.ts",
  ".cursor/skills/verify-cleanercore/features/no-pin.md",
  ".cursor/skills/verify-cleanercore/features/tenant-isolation.md",
  ".cursor/skills/verify-cleanercore/scripts/assert-report.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-d.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-e.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-f.mjs",
]);

const skipDirs = new Set(["node_modules", ".git", "dist", "coverage"]);

function trackedPaths() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function bannedTracked(rel) {
  const base = rel.split("/").pop() ?? rel;
  return /\.db$/i.test(base) || /\.sqlite/i.test(base) || /\.bak$/i.test(base);
}

function openSeal(sealed) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", TEST_SEAL_KEY, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const pin = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    return /^\d{4,8}$/.test(pin) ? pin : undefined;
  } catch {
    return undefined;
  }
}

function collectSeals(value, propertyId, into) {
  if (!value || typeof value !== "object") return;
  const nextId = typeof value.propertyId === "string" ? value.propertyId : propertyId;
  if (value.pinSeal) {
    const pin = openSeal(value.pinSeal);
    if (pin) into.add(pin);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSeals(item, nextId, into);
    return;
  }
  for (const child of Object.values(value)) collectSeals(child, nextId, into);
}

/** Plaintext door-code fields and sealed codes saved with a property id. */
function savedDoorCodes(text) {
  const found = new Set();
  for (const match of text.matchAll(/"(?:pin|doorCode|door_code)"\s*:\s*"(\d{4,8})"/g)) found.add(match[1]);
  if (text.includes("pinSeal")) {
    try {
      collectSeals(JSON.parse(text), undefined, found);
    } catch {
      // Not JSON. The plaintext field scan above still applies.
    }
  }
  return [...found];
}

function walk(dir, out) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out);
    else if (st.isFile() && st.size > 0 && st.size < 5_000_000) out.push(path);
  }
}

// Node prints warnings as "(node:<pid>) ...". A random pid can contain a code by chance,
// so only that prefix is blanked. A code anywhere else in the text still counts.
function withoutNodePid(text) {
  return text.replace(/\(node:\d+\)/g, "(node:pid)");
}

function leak(path, values) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return false;
  }
  const text = withoutNodePid(buf.toString(buf.includes(0) ? "latin1" : "utf8"));
  return values.some((value) => text.includes(value));
}

let scratch;
try {
  scratch = scratchSecrets(root);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : "secret scan could not load the configured scratch values"}\n`);
  process.exit(1);
}
const trackedOnly = process.argv.includes("--tracked");
const files = [];
if (trackedOnly) {
  const banned = trackedPaths().filter((rel) => bannedTracked(rel));
  if (banned.length > 0) {
    const sample = banned.slice(0, 20).join("\n");
    process.stderr.write(`tracked scan found a database file (${banned.length}):\n${sample}\n`);
    process.exit(1);
  }
  for (const rel of trackedPaths()) files.push(join(root, rel));
} else {
  walk(root, files);
}
for (const extra of process.argv.slice(2).filter((arg) => arg !== "--tracked")) {
  const path = resolve(extra);
  let st;
  try {
    st = statSync(path);
  } catch {
    process.stderr.write(`secret scan missing path ${extra}\n`);
    process.exit(1);
  }
  if (st.isDirectory()) walk(path, files);
  else files.push(path);
}

// Each code may live in the historical scratch allowlist, or in the file that saved it.
const allowedIn = new Map(scratch.map((value) => [value, new Set(allow)]));
for (const path of files) {
  const rel = relative(root, path);
  let text;
  try {
    const buf = readFileSync(path);
    if (buf.includes(0)) continue;
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  for (const code of savedDoorCodes(text)) {
    if (!allowedIn.has(code)) allowedIn.set(code, new Set());
    allowedIn.get(code).add(rel);
  }
}

const secretSource = "src/cleaner-core/tenants.ts";
const hits = [];
const seen = new Set();
for (const path of files) {
  const rel = relative(root, path);
  if (rel === secretSource) continue;
  if (seen.has(path)) continue;
  seen.add(path);
  const leaked = [];
  for (const [code, sources] of allowedIn) {
    if (sources.has(rel)) continue;
    if (leak(path, [code])) leaked.push(code);
  }
  if (leaked.length > 0) hits.push(rel.startsWith("..") ? path : rel);
}

if (hits.length > 0) {
  process.stderr.write(`secret scan found a saved door code in:\n${hits.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`secret scan clean (${allowedIn.size} configured values, ${seen.size} files)\n`);
