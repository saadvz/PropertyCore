import { afterEach, describe, expect, it } from "vitest";
import { packageDeskFor, resetPackageDesks } from "../src/package-arrivals/desk";
import { readPackages, supplyKey } from "../src/package-arrivals/store";
import { cleanupFolders, order, propertyFolder, writeOrders } from "./packageFixture";

/** #239: a package drop seen on camera marks the expected delivery seen, only when it's clear which one. */

const NOW = new Date("2026-11-18T23:00:00.000Z");
afterEach(() => {
  cleanupFolders();
  resetPackageDesks();
});

const desk = (root: string) => packageDeskFor(root, { now: () => NOW });

describe("a camera package sighting", () => {
  it("marks the one delivery expected that day as seen on camera", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-18" }), order("ord_b", { expectedBy: "2026-11-20" })]);
    const reply = desk(root).cameraSighting({ at: "2026-11-18T19:10:00.000Z" });
    expect(reply).toMatchObject({ isError: false, structured: { matched: "ord_a" } });
    expect(readPackages(root).arrivals[supplyKey("ord_a")]?.seen).toEqual({ at: "2026-11-18T19:10:00.000Z", how: "camera" });
    expect(readPackages(root).arrivals[supplyKey("ord_b")]?.seen).toBeUndefined();
  });

  it("with two expected that day, keeps the sighting for the agent to ask about", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-18" }), order("ord_b", { expectedBy: "2026-11-18" })]);
    expect(desk(root).cameraSighting({ at: "2026-11-18T19:10:00.000Z" })).toMatchObject({ isError: false, structured: { matched: null } });
    expect(readPackages(root).arrivals[supplyKey("ord_a")]?.seen).toBeUndefined();
    const check = desk(root).check();
    expect(check.structured).toMatchObject({ cameraSightings: ["2026-11-18T19:10:00.000Z"] });
    expect(String(check.structured?.next)).toMatch(/seen on camera/);
  });

  it("stops listing a kept sighting once a delivery is marked seen after it", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-18" }), order("ord_b", { expectedBy: "2026-11-18" })]);
    desk(root).cameraSighting({ at: "2026-11-18T19:10:00.000Z" });
    desk(root).markSeen({ orderId: "ord_a", how: "camera", at: "2026-11-18T19:10:00.000Z" });
    expect(desk(root).check().structured?.cameraSightings).toBeUndefined();
  });

  it("with nothing expected, keeps the sighting and marks nothing", () => {
    const { root } = propertyFolder();
    writeOrders(root, []);
    expect(desk(root).cameraSighting({ at: "2026-11-18T19:10:00.000Z" }).structured).toMatchObject({ matched: null });
  });
});

describe("repeat sightings of one drop", () => {
  it("a second and third camera event for the same drop keep nothing and ask the host nothing", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-18" })]);
    desk(root).cameraSighting({ at: "2026-11-18T19:10:00.000Z" });
    expect(desk(root).cameraSighting({ at: "2026-11-18T19:10:40.000Z" }).structured).toMatchObject({ matched: "ord_a", repeat: true });
    expect(readPackages(root).cameraSightings).toBeUndefined();
    expect(desk(root).check().structured?.cameraSightings).toBeUndefined();
  });

  it("a camera sighting replaces the carrier's when it's the day's only delivery", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-18", deliveredAt: "2026-11-18T18:00:00.000Z" })]);
    expect(desk(root).cameraSighting({ at: "2026-11-18T19:10:00.000Z" }).structured).toMatchObject({ matched: "ord_a" });
    expect(readPackages(root).arrivals[supplyKey("ord_a")]?.seen).toEqual({ at: "2026-11-18T19:10:00.000Z", how: "camera" });
  });
});

describe("repeats with two deliveries expected", () => {
  it("an event within 10 minutes of a camera-seen drop is the same drop, not the other package", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-18" }), order("ord_b", { expectedBy: "2026-11-18" })]);
    desk(root).markSeen({ orderId: "ord_a", how: "camera", at: "2026-11-18T19:10:00.000Z" });
    expect(desk(root).cameraSighting({ at: "2026-11-18T19:12:00.000Z" }).structured).toMatchObject({ matched: "ord_a", repeat: true });
    expect(readPackages(root).arrivals[supplyKey("ord_b")]?.seen).toBeUndefined();
    expect(desk(root).cameraSighting({ at: "2026-11-18T21:00:00.000Z" }).structured).toMatchObject({ matched: "ord_b" });
  });
});
