import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The hub sits under both flows, and Supply Core stands apart from Cleaner Core. */

const SRC = resolve(__dirname, "../src");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Every relative import of a file, resolved to an absolute path. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
  return specs.filter((spec) => spec.startsWith(".")).map((spec) => resolve(dirname(file), spec));
}

function offenders(dir: string, banned: string[]): string[] {
  return tsFiles(dir).flatMap((file) =>
    importsOf(file)
      .filter((target) => banned.some((b) => target.startsWith(join(SRC, b) + "/") || target === join(SRC, b)))
      .map((target) => `${file.slice(SRC.length + 1)} -> ${target.slice(SRC.length + 1)}`),
  );
}

describe("module boundaries", () => {
  it("src/hub imports neither flow", () => {
    expect(existsSync(join(SRC, "hub", "calendar.ts"))).toBe(true);
    expect(offenders(join(SRC, "hub"), ["cleaner-core", "supply-core"])).toEqual([]);
  });
});
