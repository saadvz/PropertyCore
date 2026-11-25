import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CameraLinks, cameraTokenKey, maskEmail, maskLabel, readCameras, sealedTokenStore, shownWord, WaitingTokens, writeCameras, routeDevice, type SecretSlot } from "../src/cameras/accounts";

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
    expect(links.peek(link.state)).toEqual({ tenantId: "t1", propertyId: "p1", agreed: false });
    expect(links.finish(link.state)).toEqual({ tenantId: "t1", propertyId: "p1" });
    expect(links.finish(link.state)).toBeUndefined();
    const late = links.start({ tenantId: "t1", propertyId: "p1" });
    now = new Date("2026-11-20T12:31:00Z");
    expect(links.finish(late.state)).toBeUndefined();
  });

  it("names the host by the browser's mark or the pairing word, only after they agree and only for 30 minutes", () => {
    let now = new Date("2026-11-20T12:00:00Z");
    const links = new CameraLinks(() => now);
    const link = links.start({ tenantId: "t1", propertyId: "p1" });
    const other = links.start({ tenantId: "t2", propertyId: "p2" });
    const agreed = links.agree(link.state)!;
    expect(links.agree(link.state)).toEqual(agreed);
    expect(agreed.word).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(shownWord(agreed.word)).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(agreed.mark).not.toBe(link.state);
    expect(links.byMark(agreed.mark)).toEqual({ state: link.state, tenantId: "t1", propertyId: "p1" });
    expect(links.byWord(` ${shownWord(agreed.word).toLowerCase()} `)).toEqual({ state: link.state, tenantId: "t1", propertyId: "p1" });
    expect(links.byWord("BCDF")).toBeUndefined();
    expect(links.byMark(other.state)).toBeUndefined();
    // A link nobody agreed on has no mark and its word names nobody yet.
    const otherAgreed = links.agree(other.state)!;
    links.finish(link.state);
    expect(links.byMark(agreed.mark)).toBeUndefined();
    expect(links.byWord(agreed.word)).toBeUndefined();
    expect(links.byWord(otherAgreed.word)?.tenantId).toBe("t2");
    now = new Date("2026-11-20T12:31:00Z");
    expect(links.byWord(otherAgreed.word)).toBeUndefined();
    expect(links.agree(other.state)).toBeUndefined();
  });
});

describe("tokens waiting for their host", () => {
  const key = randomBytes(32);
  const tokens = { access: "at-1", refresh: "rt-1", expiresAt: 1 };
  const nonceFor = (time: string, accountId: string) => createHmac("sha256", "made-up-key").update(`${time}:${accountId}`).digest("base64url");

  it("are found only by the nonce signed for their account, within 10 minutes of its time", () => {
    let now = new Date("2026-11-20T12:00:00Z");
    const pool = new WaitingTokens(key, () => now);
    pool.hold({ accountId: "acct-a", email: "a@example.com", tokens });
    pool.hold({ accountId: "acct-b", tokens: { ...tokens, access: "at-2" } });
    const time = String(now.getTime());
    expect(pool.match(nonceFor(time, "acct-a"), time, nonceFor)).toEqual({ accountId: "acct-a", email: "a@example.com", tokens });
    expect(pool.match(nonceFor(time, "acct-b"), time, nonceFor)?.tokens.access).toBe("at-2");
    expect(pool.match(nonceFor(time, "acct-c"), time, nonceFor)).toBeUndefined();
    expect(pool.match(nonceFor(time, "acct-a"), String(now.getTime() - 1), nonceFor)).toBeUndefined();
    expect(pool.match("", time, nonceFor)).toBeUndefined();
    expect(pool.match(nonceFor("soon", "acct-a"), "soon", nonceFor)).toBeUndefined();
    const stale = String(now.getTime() - 600_001);
    expect(pool.match(nonceFor(stale, "acct-a"), stale, nonceFor)).toBeUndefined();
    const edge = String(now.getTime() - 600_000);
    expect(pool.match(nonceFor(edge, "acct-a"), edge, nonceFor)).toBeDefined();
    const ahead = String(now.getTime() + 30_001);
    expect(pool.match(nonceFor(ahead, "acct-a"), ahead, nonceFor)).toBeUndefined();
    now = new Date("2026-11-20T12:15:01Z");
    const later = String(now.getTime());
    expect(pool.match(nonceFor(later, "acct-a"), later, nonceFor)).toBeUndefined();
    expect(pool.size).toBe(0);
  });

  it("keep the newest pair for an account, and are dropped after five wrong pairing words", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const pool = new WaitingTokens(key, () => now);
    pool.hold({ accountId: "acct-a", tokens });
    pool.hold({ accountId: "acct-a", tokens: { ...tokens, access: "at-new" } });
    const time = String(now.getTime());
    expect(pool.size).toBe(1);
    expect(pool.match(nonceFor(time, "acct-a"), time, nonceFor)?.tokens.access).toBe("at-new");
    for (let i = 0; i < 4; i += 1) expect(pool.wrongWord("acct-a")).toBe(false);
    expect(pool.wrongWord("acct-a")).toBe(true);
    expect(pool.match(nonceFor(time, "acct-a"), time, nonceFor)).toBeUndefined();
  });

  it("hides the middle of an email and of a name", () => {
    expect(maskEmail("jane.host@example.com")).toBe("j***t@example.com");
    expect(maskEmail("jo@example.com")).toBe("j***@example.com");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskLabel("Lane")).toBe("L***e");
    expect(maskLabel("Al")).toBe("***");
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
