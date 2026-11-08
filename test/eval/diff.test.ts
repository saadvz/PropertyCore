import { describe, expect, it } from "vitest";
import type { TourCoreConfig } from "../../src/config/tourCoreConfig";
import { diffNormalized } from "../../src/eval/diffConfig";
import { normalizeStoredConfig } from "../../src/eval/normalize";

function config(name: string, doorId = "door_a"): TourCoreConfig {
  return {
    schemaVersion: 1,
    property: { id: "prop_1", name, address: name, timezone: "America/New_York", facts: [] },
    operator: { name: "Owner", contact: "" },
    doors: [
      { id: "door_front", name: "Front Door", kind: "ENTRANCE" },
      { id: doorId, name: "Unit A Door", kind: "UNIT" },
    ],
    units: [{ id: "unit_a", name: "Unit A", doorId, summary: "", facts: [], profile: { bedrooms: { status: "PROVIDED", value: 2, updatedAt: "2026-09-28T11:00:00.000Z" } } }],
    routes: [{ id: "route_a", unitId: "unit_a", stops: [{ doorId: "door_front", guidance: "In." }, { doorId, guidance: "Unit." }] }],
    tourHours: { days: ["MON"], start: "09:00", end: "17:00", slotEveryMinutes: 60, tourLengthMinutes: 45, earlyArrivalMinutes: 10 },
    verificationMode: "basic-form",
    verificationValidForDays: 180,
    messagingMode: "live",
    storageMode: "memory",
    accessMode: "door-demo",
  };
}

describe("config diff", () => {
  it("strips ids and timestamps and keeps door names", () => {
    const normalized = normalizeStoredConfig(config("18 Maple Street")) as { units: Array<{ id?: string; doorId: string; profile: { bedrooms: { updatedAt?: string } } }>; routes: Array<{ unitId: string }> };
    expect(normalized.units[0]?.id).toBeUndefined();
    expect(normalized.units[0]?.doorId).toBe("Unit A Door");
    expect(normalized.units[0]?.profile.bedrooms.updatedAt).toBeUndefined();
    expect(normalized.routes[0]?.unitId).toBe("Unit A");
  });

  it("lists fields that differ and ignores id-only changes", () => {
    const same = diffNormalized(["a", "b"], [normalizeStoredConfig(config("18 Maple Street", "door_a")), normalizeStoredConfig(config("18 Maple Street", "door_other"))]);
    expect(same.differingFieldCount).toBe(0);
    const different = diffNormalized(["a", "b"], [normalizeStoredConfig(config("18 Maple Street")), normalizeStoredConfig(config("18 MAPLE STREET"))]);
    expect(different.differingFieldCount).toBeGreaterThan(0);
    expect(different.fields.some((field) => field.path === "property.name")).toBe(true);
  });
});
