import { afterEach, describe, expect, it } from "vitest";
import { buildMonth } from "../src/hours-log/month";
import { factsFrom, readRecords, type RowFact } from "../src/hours-log/sources";
import { packageDeskFor, resetPackageDesks } from "../src/package-arrivals/desk";
import { writePackages, supplyKey, type PackagesFile } from "../src/package-arrivals/store";
import { cleanupFolders, order, propertyFolder, writeOrders } from "./packageFixture";

/** #241: the hours log records each delivery's drop and the bring-it-in visit. 555 numbers only. */

afterEach(() => {
  resetPackageDesks();
  cleanupFolders();
});

const ANA = "+15555550111";
const RAY = "+15555550122";

function facts(packages: PackagesFile, extra: Record<string, unknown> = {}): RowFact[] {
  const { root } = propertyFolder();
  writeOrders(root, [order("ord_a", { expectedBy: "2026-11-17", ...extra })]);
  writePackages(root, packages);
  return factsFrom(readRecords(root)).filter((fact) => fact.kind === "package-drop" || fact.kind === "bring-in");
}

const seen = { at: "2026-11-17T14:00:00.000Z", how: "camera" as const };

describe("package rows", () => {
  it("a seen delivery is Property Core's row at the drop, at no hours", () => {
    const [drop] = facts({ settings: {}, arrivals: { [supplyKey("ord_a")]: { seen } } });
    expect(drop).toMatchObject({ kind: "package-drop", actor: "system", log: "property-core", participant: "Property Core", at: seen.at, timing: "system", onSite: false });
    expect(drop!.reference).toBe("Supply Core order ord_a, seen by camera");
    expect(drop!.task).toBe("Package delivered from Example Mart: Paper towels x2");
  });

  it("Supply Core's delivered mark is the drop when nothing else saw it", () => {
    const [drop] = facts({ settings: {}, arrivals: { [supplyKey("ord_a")]: {} } }, { status: "delivered", deliveredAt: "2026-11-17T13:00:00.000Z" });
    expect(drop).toMatchObject({ kind: "package-drop", at: "2026-11-17T13:00:00.000Z" });
    expect(drop!.reference).toBe("Supply Core order ord_a, seen by tracking");
  });

  it("an order package arrivals never listed adds no row, so a confirmed month doesn't change", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { status: "delivered", deliveredAt: "2026-10-17T13:00:00.000Z" })]);
    expect(factsFrom(readRecords(root)).filter((fact) => fact.kind === "package-drop")).toEqual([]);
  });

  it("check_packages registers what it lists, so its drops are logged", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { status: "delivered", deliveredAt: "2026-11-17T13:00:00.000Z" })]);
    packageDeskFor(root, { now: () => new Date("2026-11-17T15:00:00.000Z") }).check();
    expect(factsFrom(readRecords(root)).filter((fact) => fact.kind === "package-drop")).toHaveLength(1);
  });

  it("the cleaner's bring-in is in the cleaner's log, from start to inside, measured", () => {
    const rows = facts({
      settings: { bringInHours: 4 },
      arrivals: { [supplyKey("ord_a")]: { seen, visit: { person: ANA, name: "Ana", role: "cleaner", plannedAt: seen.at }, broughtIn: { at: "2026-11-17T15:10:00.000Z", startedAt: "2026-11-17T15:00:00.000Z" } } },
    });
    const bring = rows.find((fact) => fact.kind === "bring-in");
    expect(bring).toMatchObject({ actor: "cleaner", log: "cleaner", participant: "Ana", at: "2026-11-17T15:00:00.000Z", until: "2026-11-17T15:10:00.000Z", onSite: true, timing: "measured" });
    expect(bring!.task).toBe("Brought in the package from Example Mart: Paper towels x2");
  });

  it("a co-host's bring-in is in a log of their own, with no phone anywhere in it", () => {
    const rows = facts({ settings: {}, arrivals: { [supplyKey("ord_a")]: { seen, visit: { person: RAY, name: "Ray", role: "co-host", plannedAt: seen.at }, broughtIn: { at: "2026-11-17T15:10:00.000Z", startedAt: "2026-11-17T15:00:00.000Z" } } } });
    const bring = rows.find((fact) => fact.kind === "bring-in")!;
    expect(bring).toMatchObject({ actor: "helper", participant: "Ray" });
    expect(bring.log).toMatch(/^helper:[0-9a-f]{10}$/);
    expect(JSON.stringify(bring)).not.toContain("5555550122");
  });

  it("a bring-in with no start time is one moment with a line for the host's review", () => {
    const rows = facts({ settings: {}, arrivals: { [supplyKey("ord_a")]: { seen, visit: { person: ANA, name: "Ana", role: "cleaner", plannedAt: seen.at }, broughtIn: { at: "2026-11-17T15:10:00.000Z" } } } });
    const bring = rows.find((fact) => fact.kind === "bring-in")!;
    expect(bring.until).toBeUndefined();
    expect(bring.at).toBe("2026-11-17T15:10:00.000Z");
    expect(bring.needs).toMatch(/no start time/i);
  });

  it("neither row lands in the owner's log, and the month gives them the Packages codes", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-17" })]);
    writePackages(root, { settings: {}, arrivals: { [supplyKey("ord_a")]: { seen, visit: { person: RAY, name: "Ray", role: "co-host", plannedAt: seen.at }, broughtIn: { at: "2026-11-17T15:10:00.000Z", startedAt: "2026-11-17T15:00:00.000Z" } } } });
    const month = buildMonth(readRecords(root), "2026-11", {});
    const rows = month.logs.flatMap((log) => log.rows).filter((row) => row.kind === "package-drop" || row.kind === "bring-in");
    expect(rows.map((row) => [row.kind, row.code, row.category]).sort()).toEqual([
      ["bring-in", "PKG-2", "Packages"],
      ["package-drop", "PKG-1", "Packages"],
    ]);
    expect(rows.every((row) => row.log !== "owner")).toBe(true);
    expect(rows.find((row) => row.kind === "bring-in")!.hours).toBeCloseTo(0.17, 2);
    expect(month.logs.find((log) => log.log.startsWith("helper:"))!.name).toBe("Ray");
  });
});
