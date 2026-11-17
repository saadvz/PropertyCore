import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGES_FILE, PackagesFileError, readPackages, supplyKey, writePackages } from "../src/package-arrivals/store";

/** #241: the package arrivals record. Made-up order ids only. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "packages-store-"));
  roots.push(root);
  return root;
}

describe("packages.json", () => {
  it("reads as empty when there's no file", () => {
    expect(readPackages(folder())).toEqual({ settings: {}, arrivals: {} });
  });

  it("keeps what was written", () => {
    const root = folder();
    const file = { settings: { bringInHours: 4 }, arrivals: { [supplyKey("ord_abc")]: { seen: { at: "2026-11-17T15:00:00.000Z", how: "host" as const } } } };
    writePackages(root, file);
    expect(readPackages(root)).toEqual(file);
    expect(supplyKey("ord_abc")).toBe("supply:ord_abc");
  });

  it("refuses a broken file and leaves it as it is", () => {
    const root = folder();
    writeFileSync(join(root, PACKAGES_FILE), "[not a record");
    expect(() => readPackages(root)).toThrow(PackagesFileError);
    expect(readFileSync(join(root, PACKAGES_FILE), "utf8")).toBe("[not a record");
  });
});
