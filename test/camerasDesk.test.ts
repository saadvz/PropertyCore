import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCameras } from "../src/cameras/accounts";
import { CameraDesk } from "../src/cameras/desk";
import { fakeCameraProvider } from "../src/cameras/fake";
import { dueCameraNotes } from "../src/cameras/health";
import { memoryLog, type CameraEventLine, type CameraLine, type StoredLine } from "../src/cameras/lines";
import { stayEventsFrom } from "../src/cameras/night";
import { stayTimeline, timelineText } from "../src/cameras/timeline";
import { writeStayCheck } from "../src/stay-check/store";

/** #239: one property's cameras: the night's events, offline notes, the stay timeline, and pinning a clip. Fake provider only. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TZ = "America/New_York";
const CAM = { deviceId: "dev-aaa", name: "Front door", outdoor: true as const, pickedAt: "2026-11-19T12:00:00.000Z" };
const tokens = { get: () => ({ access: "a", refresh: "r", expiresAt: Number.MAX_SAFE_INTEGER }), save: () => {} };
const motion = (id: string, at: string, label = "human"): CameraEventLine => ({ type: "camera", id, at, device: "Front door", deviceId: "dev-aaa", provider: "fake", kind: "motion", label });
const count = (event: string, at: string, people: number, more: Partial<{ vehicles: number; animals: number }> = {}): CameraLine => ({ type: "camera-count", id: `count:${event}:fake-v1`, at, event, counter: "fake-v1", people, vehicles: more.vehicles ?? 0, animals: more.animals ?? 0 });

function property(now = new Date("2026-11-22T05:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "cams-desk-"));
  roots.push(root);
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Lake House", timeZone: TZ, checkInTime: "15:00", checkoutTime: "10:00" }, calendars: [], stays: [{ checkIn: "2026-11-20", checkout: "2026-11-23", kind: "stay" }] }));
  writeStayCheck(root, { rules: [{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }], sightings: {}, allowances: [] });
  writeCameras(root, { provider: "fake", consentAt: "2026-11-19T12:00:00.000Z", cameras: [CAM] });
  const log = memoryLog(() => now);
  const provider = fakeCameraProvider();
  let clock = now;
  const desk = new CameraDesk(root, { log, provider, account: { tokens }, now: () => clock, label: "Lake House" });
  return { root, log, provider, desk, setNow: (next: Date) => (clock = next) };
}

describe("the night's events from camera lines", () => {
  it("gives the check's shape: counts from the newest count line, media by reference only", () => {
    const lines = [motion("e1", "2026-11-22T02:00:00.000Z"), count("e1", "2026-11-22T02:00:00.000Z", 3)] as unknown as StoredLine[];
    const events = stayEventsFrom(lines, { from: "2026-11-21T20:00:00.000Z", to: "2026-11-22T04:00:00.000Z" });
    expect(events).toEqual([
      {
        id: "e1",
        at: "2026-11-22T02:00:00.000Z",
        source: "camera",
        device: "Front door",
        label: "human",
        counts: { people: 3, vehicles: 0, animals: 0 },
        snapshot: { device: "Front door", at: Date.parse("2026-11-22T02:00:00.000Z") },
        clip: { device: "Front door", at: Date.parse("2026-11-22T01:59:30.000Z"), durationMs: 90_000 },
      },
    ]);
  });

  it("leaves out package drops, doorbells, online and offline, and events outside the window", () => {
    const lines = [
      motion("p", "2026-11-22T02:00:00.000Z", "package_delivery"),
      { ...motion("d", "2026-11-22T02:00:00.000Z"), kind: "ding" },
      { ...motion("o", "2026-11-22T02:00:00.000Z"), kind: "offline" },
      motion("late", "2026-11-22T09:00:00.000Z"),
    ] as unknown as StoredLine[];
    expect(stayEventsFrom(lines, { from: "2026-11-21T20:00:00.000Z", to: "2026-11-22T04:00:00.000Z" })).toEqual([]);
  });
});

describe("the camera desk's night", () => {
  it("runs the night's check on the property's camera events", () => {
    const { log, desk } = property();
    log.append(motion("e1", "2026-11-22T02:00:00.000Z"));
    log.append(count("e1", "2026-11-22T02:00:00.000Z", 8));
    const result = desk.runNight("2026-11-21");
    expect(result).toMatchObject({ status: "flags", flags: [{ kind: "people", peak: 8, allowed: 6, device: "Front door" }] });
  });

  it("reads only the service's own counter when a second counter also counted the night", () => {
    const { root, log } = property();
    log.append(motion("e1", "2026-11-22T02:00:00.000Z"));
    log.append(count("e1", "2026-11-22T02:00:00.000Z", 8));
    log.append({ type: "camera-count", id: "count:e1:detector-v1", at: "2026-11-22T02:00:00.000Z", event: "e1", counter: "detector-v1", people: 2, vehicles: 0, animals: 0 });
    const own = new CameraDesk(root, { log, now: () => new Date("2026-11-22T05:00:00.000Z"), label: "Lake House", counter: "fake-v1" });
    expect(own.runNight("2026-11-21")).toMatchObject({ status: "flags", flags: [{ peak: 8 }] });
  });

  it("knows which events fall in a stay", () => {
    const { desk } = property();
    expect(desk.inStay("2026-11-22T02:00:00.000Z")).toBe(true);
    expect(desk.inStay("2026-11-20T18:00:00.000Z")).toBe(false);
    expect(desk.inStay("2026-11-25T02:00:00.000Z")).toBe(false);
  });
});

describe("camera offline notes", () => {
  const off = (id: string, at: string): StoredLine => ({ ...motion(id, at), kind: "offline", loggedAt: at }) as unknown as StoredLine;
  const on = (id: string, at: string): StoredLine => ({ ...motion(id, at), kind: "online", loggedAt: at }) as unknown as StoredLine;

  it("waits 30 minutes, then one note, then one when it's back", () => {
    const lines = [off("x1", "2026-11-22T19:10:00.000Z")];
    expect(dueCameraNotes(lines, [CAM], new Date("2026-11-22T19:39:00.000Z"), { label: "Lake House", timeZone: TZ, told: [] })).toEqual([]);
    const notes = dueCameraNotes(lines, [CAM], new Date("2026-11-22T19:40:00.000Z"), { label: "Lake House", timeZone: TZ, told: [] });
    expect(notes).toEqual([{ id: "camera-offline:x1", text: "The Front door camera at Lake House has been offline since 2:10 PM." }]);
    expect(dueCameraNotes(lines, [CAM], new Date("2026-11-22T20:00:00.000Z"), { label: "Lake House", timeZone: TZ, told: ["camera-offline:x1"] })).toEqual([]);
    const back = [...lines, on("x2", "2026-11-22T20:30:00.000Z")];
    expect(dueCameraNotes(back, [CAM], new Date("2026-11-22T20:31:00.000Z"), { label: "Lake House", timeZone: TZ, told: ["camera-offline:x1"] })).toEqual([{ id: "camera-online:x2", text: "The Front door camera at Lake House is back online." }]);
  });

  it("says nothing when it came back within 30 minutes", () => {
    const lines = [off("x1", "2026-11-22T19:10:00.000Z"), on("x2", "2026-11-22T19:20:00.000Z")];
    expect(dueCameraNotes(lines, [CAM], new Date("2026-11-22T21:00:00.000Z"), { label: "Lake House", timeZone: TZ, told: [] })).toEqual([]);
  });

  it("the desk gives each note once", () => {
    const { log, desk } = property(new Date("2026-11-22T20:00:00.000Z"));
    log.append({ ...motion("x1", "2026-11-22T19:10:00.000Z"), kind: "offline" });
    expect(desk.takeNotes().map((note) => note.id)).toEqual(["camera-offline:x1"]);
    expect(desk.takeNotes()).toEqual([]);
  });
});

describe("the stay timeline", () => {
  it("lists camera and lock events in the stay, oldest first, in local time", () => {
    const lines = [
      motion("e2", "2026-11-21T01:00:00.000Z", "vehicle"),
      count("e2", "2026-11-21T01:00:00.000Z", 0, { vehicles: 2 }),
      { type: "lock", id: "l1", at: "2026-11-20T20:05:00.000Z", device: "Front door lock", action: "unlock", codeName: "Guest" },
      motion("before", "2026-11-20T10:00:00.000Z"),
    ] as unknown as StoredLine[];
    const timeline = stayTimeline(lines, { from: "2026-11-20T20:00:00.000Z", to: "2026-11-23T15:00:00.000Z" }, TZ);
    expect(timeline.map((entry) => entry.id)).toEqual(["l1", "e2"]);
    expect(timeline[1]).toMatchObject({ source: "camera", what: "vehicle", counts: { people: 0, vehicles: 2, animals: 0 } });
    const text = timelineText("Lake House", timeline, TZ);
    expect(text).toContain("Fri, Nov 20, 3:05 PM: Front door lock unlocked (Guest)");
    expect(text).toContain("Fri, Nov 20, 8:00 PM: Front door camera, vehicle: 2 vehicles");
  });

  it("the desk builds it for a stay by its check-in date", () => {
    const { log, desk } = property();
    log.append(motion("e1", "2026-11-21T02:00:00.000Z"));
    const reply = desk.timeline({ checkIn: "2026-11-20" });
    expect(reply).toMatchObject({ isError: false, structured: { entries: [{ id: "e1" }] } });
    expect(desk.timeline({ checkIn: "2026-11-01" }).isError).toBe(true);
  });
});

describe("pinning a clip", () => {
  it("copies one clip into evidence/ and logs the pin; nothing else is copied", async () => {
    const { root, log, provider, desk } = property();
    log.append(motion("e1", "2026-11-22T02:00:00.000Z"));
    const reply = await desk.pin({ eventId: "e1" });
    expect(reply.isError).toBe(false);
    const file = String(reply.structured?.file);
    expect(file).toMatch(/^evidence\/[A-Za-z0-9._-]+\.mp4$/);
    expect(existsSync(join(root, file))).toBe(true);
    expect(readFileSync(join(root, file)).length).toBeGreaterThan(0);
    expect(log.read().filter((line) => line.type === "camera-pin")).toHaveLength(1);
    expect(provider.calls.filter((call) => call.call === "clip")).toHaveLength(1);
    expect((await desk.pin({ eventId: "nope" })).isError).toBe(true);
  });
});
