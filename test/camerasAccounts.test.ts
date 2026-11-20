import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CameraLinks, cameraTokenKey, readCameras, sealedTokenStore, writeCameras, routeDevice, type SecretSlot } from "../src/cameras/accounts";

const KEY = randomBytes(32);

function slot(): SecretSlot & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return { values, get: () => ({ ...values }), set: (next) => Object.assign(values, next), clear: (names) => names.forEach((name) => delete values[name]) };
}

describe("sealed tokens", () => {
  it("keeps tokens sealed, never in the clear", () => {
    const secrets = slot();
    const store = sealedTokenStore(secrets, KEY);
    store.save({ access: "access-plain-text", refresh: "refresh-plain-text", expiresAt: 123 });
    expect(JSON.stringify(secrets.values)).not.toContain("plain-text");
    expect(store.get()).toEqual({ access: "access-plain-text", refresh: "refresh-plain-text", expiresAt: 123 });
  });

  it("reads nothing with a different key, and nothing when cleared", () => {
    const secrets = slot();
    sealedTokenStore(secrets, KEY).save({ access: "a", refresh: "r", expiresAt: 1 });
    expect(sealedTokenStore(secrets, randomBytes(32)).get()).toBeUndefined();
    sealedTokenStore(secrets, KEY).clear();
    expect(sealedTokenStore(secrets, KEY).get()).toBeUndefined();
  });

  it("takes the service key only as 32 bytes of base64", () => {
    expect(cameraTokenKey({ CAMERA_TOKEN_KEY: KEY.toString("base64") })?.equals(KEY)).toBe(true);
    expect(cameraTokenKey({ CAMERA_TOKEN_KEY: "short" })).toBeUndefined();
    expect(cameraTokenKey({})).toBeUndefined();
  });
});

describe("one-time connect links", () => {
  it("gives a state that works once, within 30 minutes", () => {
    let now = new Date("2026-11-20T12:00:00Z");
    const links = new CameraLinks(() => now);
    const link = links.start({ tenantId: "t1", propertyId: "p1" });
    expect(link.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(link.codeChallenge).not.toBe(link.codeVerifier);
    expect(links.finish(link.state)).toMatchObject({ tenantId: "t1", propertyId: "p1", codeVerifier: link.codeVerifier });
    expect(links.finish(link.state)).toBeUndefined();
    const late = links.start({ tenantId: "t1", propertyId: "p1" });
    now = new Date("2026-11-20T12:31:00Z");
    expect(links.finish(late.state)).toBeUndefined();
  });
});

describe("the property's cameras", () => {
  it("starts empty and saves picks with mode 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "cams-"));
    expect(readCameras(root)).toEqual({ cameras: [] });
    writeCameras(root, { provider: "ring", consentAt: "2026-11-20T12:00:00.000Z", cameras: [{ deviceId: "dev-aaa", name: "Front door", outdoor: true, pickedAt: "2026-11-20T12:05:00.000Z" }] });
    expect(readCameras(root).cameras).toHaveLength(1);
    expect(statSync(join(root, "cameras.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "cameras.json"), "utf8")).not.toMatch(/token|access|refresh/i);
  });

  it("routes a device to the one property that picked it", () => {
    const places = [
      { tenantId: "t1", propertyId: "lake", cameras: [{ deviceId: "dev-aaa", name: "Front door", outdoor: true as const, pickedAt: "x" }] },
      { tenantId: "t1", propertyId: "city", cameras: [{ deviceId: "dev-bbb", name: "Drive", outdoor: true as const, pickedAt: "x" }] },
    ];
    expect(routeDevice(places, "dev-bbb")).toMatchObject({ tenantId: "t1", propertyId: "city", camera: { name: "Drive" } });
    expect(routeDevice(places, "dev-zzz")).toBeUndefined();
  });
});
