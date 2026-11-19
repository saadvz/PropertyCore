import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNight, type NightInput } from "../src/stay-check/check";
import type { StayEvent } from "../src/stay-check/events";
import type { HouseRule } from "../src/stay-check/rules";

/** #239: one night's events against the booking and the host's checkable rules. Sample events only. */

const WINDOW = { from: "2026-11-20T21:00:00.000Z", to: "2026-11-21T04:00:00.000Z" };
const sample = (name: string): StayEvent[] => JSON.parse(readFileSync(join(__dirname, "fixtures", "stay-check", `${name}.json`), "utf8"));

let n = 0;
const camera = (at: string, counts: StayEvent["counts"], extra: Partial<StayEvent> = {}): StayEvent => ({ id: `c${++n}`, at, source: "camera", device: "Front door", counts, ...extra });
const noise = (at: string, extra: Partial<StayEvent>): StayEvent => ({ id: `n${++n}`, at, source: "noise", device: "Living room sensor", ...extra });

const night = (rules: HouseRule[], events: StayEvent[], more: Partial<NightInput> = {}) =>
  checkNight({ label: "Lake House", rules, sightings: {}, allow: [], timeZone: "America/New_York", window: WINDOW, events, ...more });

const MAX6: HouseRule = { text: "No more than 6 guests", check: { kind: "people", max: 6 } };
const BOOKED: HouseRule = { text: "Only the guests on the booking", check: { kind: "people" } };
const PETS: HouseRule = { text: "No pets", check: { kind: "pets" } };
const CARS: HouseRule = { text: "Two cars max", check: { kind: "vehicles", max: 2 } };
const QUIET: HouseRule = { text: "Quiet after 10 PM", check: { kind: "quiet", start: "22:00", end: "07:00" } };

describe("checkNight", () => {
  it("no checkable rule is skipped", () => {
    const result = night([{ text: "No smoking" }], sample("party-night"));
    expect(result.status).toBe("skipped");
  });

  it("a clean night", () => {
    expect(night([MAX6, CARS], [camera("2026-11-21T01:00:00Z", { people: 6 }), ...sample("quiet-night")])).toEqual({ status: "clean", unchecked: [] });
  });

  it("most in one event, not a sum", () => {
    const events = ["2026-11-21T00:00:00Z", "2026-11-21T01:00:00Z", "2026-11-21T02:00:00Z"].map((at) => camera(at, { people: 4 }));
    expect(night([MAX6], events).status).toBe("clean");
  });

  it("more people than booked", () => {
    const result = night([BOOKED], [camera("2026-11-21T02:00:00Z", { people: 8 })], { booking: { guests: 6 } });
    expect(result.status).toBe("flags");
    if (result.status !== "flags") return;
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toMatchObject({ kind: "people", peak: 8, allowed: 6, sightings: 1, rule: BOOKED.text });
  });

  it("smaller of max and booked", () => {
    const result = night([MAX6], [camera("2026-11-21T02:00:00Z", { people: 7 })], { booking: { guests: 8 } });
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ kind: "people", allowed: 6 });
  });

  it("infants add one", () => {
    const booking = { guests: 4, infants: 1 };
    expect(night([BOOKED], [camera("2026-11-21T02:00:00Z", { people: 5 })], { booking }).status).toBe("clean");
    const result = night([BOOKED], [camera("2026-11-21T02:00:00Z", { people: 6 })], { booking });
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ allowed: 5 });
  });

  it("no guest count leaves a booked-only rule unchecked", () => {
    const result = night([BOOKED], [camera("2026-11-21T02:00:00Z", { people: 9 })]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.unchecked).toHaveLength(1);
    expect(result.unchecked[0]?.kind).toBe("people");
    expect(result.unchecked[0]?.why).toBeTypeOf("string");
  });

  it("a stay booked with a pet leaves the pets rule unchecked", () => {
    const rules = [{ text: "No pets", check: { kind: "pets" as const } }];
    const result = night(rules, [camera("2026-11-21T02:00:00Z", { animals: 1 })], { booking: { guests: 2, pets: 1 } });
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.unchecked).toEqual([{ kind: "pets", why: "The stay was booked with a pet." }]);
  });

  it("camera events not yet counted are listed, never guessed", () => {
    const result = night([BOOKED], [camera("2026-11-21T02:00:00Z", { people: 3 }), { ...camera("2026-11-21T02:10:00Z", {}), counts: undefined }], { booking: { guests: 6 } });
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.unchecked).toEqual([{ kind: "people", why: "1 camera event wasn't counted." }]);
  });

  it("an animal on a no-pet stay", () => {
    const result = night([PETS], [camera("2026-11-21T02:00:00Z", { animals: 1 })]);
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ kind: "pets", peak: 1 });
    expect(result.status === "flags" && result.flags[0]?.allowed).toBeUndefined();
  });

  it("cars over the limit", () => {
    const result = night([CARS], [camera("2026-11-21T02:00:00Z", { vehicles: 3 })]);
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ kind: "vehicles", peak: 3, allowed: 2 });
    expect(night([CARS], [camera("2026-11-21T02:00:00Z", { vehicles: 2 })]).status).toBe("clean");
  });

  it("quiet window across midnight in the property's zone", () => {
    const wide = { from: WINDOW.from, to: "2026-11-21T15:00:00Z" };
    const at = (iso: string) => night([QUIET], [noise(iso, { loud: true })], { timeZone: "America/Chicago", window: wide });
    expect(at("2026-11-21T03:30:00Z").status).toBe("clean"); // 9:30 PM in Chicago
    const late = at("2026-11-21T05:00:00Z"); // 11 PM in Chicago
    expect(late.status === "flags" && late.flags[0]).toMatchObject({ kind: "quiet" });
    const early = night([QUIET], [noise("2026-11-21T12:30:00Z", { loud: true })], { timeZone: "America/Chicago", window: wide }); // 6:30 AM
    expect(early.status).toBe("flags");
  });

  it("noise limit", () => {
    const rule: HouseRule = { text: "Quiet after 10 PM", check: { kind: "quiet", start: "22:00", end: "07:00", noiseLimit: 70 } };
    const result = night([rule], [noise("2026-11-21T03:30:00Z", { noiseDb: 65 }), noise("2026-11-21T03:40:00Z", { noiseDb: 75 })]);
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ kind: "quiet", peak: 75, sightings: 1 });
    expect(night([rule], [noise("2026-11-21T03:30:00Z", { noiseDb: 65 })]).status).toBe("clean");
    expect(night([rule], [noise("2026-11-21T01:00:00Z", { noiseDb: 90 })]).status).toBe("clean"); // 8 PM, before quiet hours
  });

  it("a noise limit replaces the sensor's own alert", () => {
    const rule: HouseRule = { text: "Quiet after 10 PM", check: { kind: "quiet", start: "22:00", end: "07:00", noiseLimit: 85 } };
    expect(night([rule], [noise("2026-11-21T03:30:00Z", { loud: true, noiseDb: 70 })]).status).toBe("clean");
    expect(night([rule], [noise("2026-11-21T03:30:00Z", { loud: true })]).status).toBe("clean");
    expect(night([rule], [noise("2026-11-21T03:30:00Z", { loud: true, noiseDb: 90 })]).status).toBe("flags");
  });

  it("no noise events leave quiet unchecked", () => {
    const result = night([QUIET], [camera("2026-11-21T02:00:00Z", { people: 2 })]);
    expect(result).toMatchObject({ status: "clean", unchecked: [{ kind: "quiet" }] });
  });

  it("needed sightings after false flags", () => {
    const over = (at: string) => camera(at, { people: 9 });
    expect(night([MAX6], [over("2026-11-21T02:00:00Z")], { sightings: { people: 2 } }).status).toBe("clean");
    const result = night([MAX6], [over("2026-11-21T02:00:00Z"), over("2026-11-21T03:00:00Z")], { sightings: { people: 2 } });
    expect(result.status === "flags" && result.flags[0]).toMatchObject({ kind: "people", sightings: 2, allowed: 6 });
  });

  it("an allowance skips that kind", () => {
    const result = night([PETS, MAX6], [camera("2026-11-21T02:00:00Z", { animals: 1, people: 2 })], { allow: ["pets"] });
    expect(result).toMatchObject({ status: "clean", unchecked: [{ kind: "pets" }] });
  });

  it("events outside the window are ignored", () => {
    expect(night([MAX6], [camera("2026-11-20T20:59:00Z", { people: 12 }), camera("2026-11-21T04:00:00Z", { people: 12 })]).status).toBe("clean");
  });

  it("ignores camera events without counts", () => {
    const raw: StayEvent = { id: "r1", at: "2026-11-21T02:00:00Z", source: "camera", device: "Front door", label: "human" };
    expect(night([{ text: "Just one", check: { kind: "people", max: 1 } }, PETS, CARS], [raw]).status).toBe("clean");
  });

  it("evidence is the peak event's clip, else its snapshot", () => {
    const clip = { device: "Front door", at: 1, durationMs: 10_000 };
    const snapshot = { device: "Front door", at: 2 };
    const withClip = night([MAX6], [camera("2026-11-21T01:00:00Z", { people: 7 }, { snapshot }), camera("2026-11-21T02:00:00Z", { people: 9 }, { clip, snapshot })]);
    expect(withClip.status === "flags" && withClip.flags[0]?.evidence).toEqual(clip);
    expect(withClip.status === "flags" && withClip.evidence).toEqual(clip);
    const snapOnly = night([MAX6], [camera("2026-11-21T02:00:00Z", { people: 9 }, { snapshot })]);
    expect(snapOnly.status === "flags" && snapOnly.flags[0]?.evidence).toEqual(snapshot);
  });

  it("the alert names every flag in the property's time", () => {
    const result = night([BOOKED, PETS], sample("party-night"), { booking: { guests: 6 } });
    expect(result.status).toBe("flags");
    if (result.status !== "flags") return;
    expect(result.flags.map((flag) => flag.kind)).toEqual(["people", "pets"]);
    expect(result.alert).toBe("Tonight at Lake House: 8 people on camera at 9:14 PM, booked for 6. An animal on camera at 10:02 PM, and the house rules say no pets. Clip: Front door camera, 9:14 PM.");
  });

  it("the alert words cars, noise and a host's own limit", () => {
    const rules: HouseRule[] = [MAX6, CARS, QUIET];
    const events = [camera("2026-11-21T02:00:00Z", { people: 7, vehicles: 4 }, { device: "Driveway camera" }), noise("2026-11-21T03:30:00Z", { loud: true }), camera("2026-11-21T03:45:00Z", { animals: 2 })];
    const result = night([...rules, PETS], events);
    expect(result.status === "flags" && result.alert).toBe(
      "Tonight at Lake House: 7 people on camera at 9:00 PM, and the house rules allow 6. 2 animals on camera at 10:45 PM, and the house rules say no pets. 4 cars on camera at 9:00 PM, and the house rules allow 2. Noise at 10:30 PM during quiet hours (10:00 PM to 7:00 AM).",
    );
  });
});
