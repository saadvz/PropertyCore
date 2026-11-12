import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeLine, lineWebhookUrl, openAccount, pointVoiceOnce, releasePooled, repointLine, topUp } from "../src/cleaner-core/hosted/lines";
import { NumberPool, POOL_LOW_AT, REST_MS, poolRestMs } from "../src/cleaner-core/hosted/numberPool";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { setTwilioNumbersFetch } from "../src/cleaner-core/hosted/twilioNumbers";
import { setCleanerGroupFetch } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";

/** saadvz/PropertyCore#163: the pool of registered numbers each account takes its line from. Only 555 numbers. */

const ORIGIN = "https://cleaner-pool.example.test";
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const A = "+15555550181";
const B = "+15555550182";
const C = "+15555550183";

interface TwilioCall {
  method: string;
  url: string;
  body?: string;
}

/** A fake Twilio REST API that owns `owned` (number → sid). `refuse` makes it turn down that verb. */
function fakeTwilio(owned: Record<string, string>, refuse: { webhook?: boolean; release?: boolean } = {}) {
  const calls: TwilioCall[] = [];
  setTwilioNumbersFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (method === "GET") {
      const number = new URL(url).searchParams.get("PhoneNumber") ?? "";
      const sid = owned[number];
      return new Response(JSON.stringify({ incoming_phone_numbers: sid ? [{ sid, phone_number: number }] : [] }), { status: 200 });
    }
    if (method === "DELETE") {
      if (refuse.release) return new Response("{}", { status: 500 });
      const sid = decodeURIComponent(/IncomingPhoneNumbers\/([^/]+)\.json$/.exec(url)?.[1] ?? "");
      for (const [number, owner] of Object.entries(owned)) if (owner === sid) delete owned[number];
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: refuse.webhook ? 500 : 200 });
  });
  return calls;
}

let dir: string;
let now: number;
let logs: string[];
let h: HostedCleaner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "number-pool-"));
  now = T0;
  logs = [];
  const clock = () => new Date(now);
  h = {
    registry: new TenantRegistry(dir, clock),
    secrets: new TenantSecrets(dir),
    dataRoot: dir,
    origin: () => ORIGIN,
    baseEnv: () => ({ CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACpooltest", CLEANER_CORE_TWILIO_AUTH_TOKEN: "pool-test-token", FIXER_CORE: "1" }),
    grantLive: () => false,
    now: clock,
    log: (line) => void logs.push(line),
  };
});

afterEach(() => {
  setTwilioNumbersFetch(undefined);
  setCleanerGroupFetch(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const pool = () => new NumberPool(dir, () => new Date(now));
/** One call points (or, with "", clears) both webhooks, and clears a TwiML App so the voice webhook takes calls. */
const point = (sid: string, url: string) => ({
  method: "POST",
  url: `https://api.twilio.com/2010-04-01/Accounts/ACpooltest/IncomingPhoneNumbers/${sid}.json`,
  body: new URLSearchParams({ SmsUrl: url, SmsMethod: "POST", VoiceUrl: url ? `${ORIGIN}/webhooks/twilio/voice` : "", VoiceMethod: "POST", VoiceApplicationSid: "" }).toString(),
});

describe("the number pool", () => {
  it("tops up only with numbers on the Twilio account that no account holds", async () => {
    fakeTwilio({ [A]: "PNa", [B]: "PNb" });
    h.registry.create({ label: "Court", twilioNumber: B });
    const result = await topUp(h, ["(555) 555-0181", A, B, "+15555550199", "12"]);
    expect(result.added).toEqual([A]);
    expect(result.refused).toEqual([
      { raw: A, reason: "already-pooled" },
      { raw: B, reason: "in-use" },
      { raw: "+15555550199", reason: "not-on-twilio" },
      { raw: "12", reason: "bad-number" },
    ]);
    expect(pool().list()).toEqual([{ number: A, sid: "PNa", addedAt: new Date(T0).toISOString() }]);
  });

  it("sign-up attaches the ready number that has waited longest, points its webhook, and records it", async () => {
    const calls = fakeTwilio({ [A]: "PNa", [B]: "PNb" });
    await topUp(h, [A]);
    now += 60_000;
    await topUp(h, [B]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    expect(opened).toMatchObject({ number: A, webhookOk: true, tenant: { label: "Lane", twilioNumber: A } });
    expect(h.registry.byNumber(A)?.id).toBe(opened.tenant.id);
    expect(calls.at(-1)).toEqual(point("PNa", `${ORIGIN}/webhooks/twilio/cleaner-core`));
    expect(lineWebhookUrl(h)).toBe(`${ORIGIN}/webhooks/twilio/cleaner-core`);
    expect(pool().get(A)).toMatchObject({ tenantId: opened.tenant.id, webhookOk: true });
    expect(pool().summary()).toEqual({ ready: 1, resting: 0, inUse: 1, low: true });
    // The next sign-up gets the other line, never the same one.
    const second = await openAccount(h, { label: "Court" });
    expect(second).toMatchObject({ number: B });
  });

  it("two sign-ups at once get different lines", async () => {
    fakeTwilio({ [A]: "PNa", [B]: "PNb" });
    await topUp(h, [A, B]);
    const [one, two] = await Promise.all([openAccount(h, { label: "Lane" }), openAccount(h, { label: "Court" })]);
    expect(new Set([one, two].map((o) => ("number" in o ? o.number : o.refused)))).toEqual(new Set([A, B]));
  });

  it("refuses sign-up when no number is ready, and tells the operator", async () => {
    fakeTwilio({ [A]: "PNa" });
    expect(await openAccount(h, { label: "Lane" })).toEqual({ refused: "no-line" });
    expect(await openAccount(h, { label: " " })).toEqual({ refused: "bad-label" });
    expect(h.registry.list()).toEqual([]);
    expect(logs).toContain("Sign-up found no ready number in the pool. Add registered numbers on /admin.");
  });

  it("alerts once the ready numbers are at or below the low mark", async () => {
    const owned: Record<string, string> = {};
    const numbers = Array.from({ length: POOL_LOW_AT + 2 }, (_, i) => `+1555555019${i}`);
    numbers.forEach((n, i) => (owned[n] = `PN${i}`));
    fakeTwilio(owned);
    await topUp(h, numbers);
    await openAccount(h, { label: "Lane" });
    expect(logs.some((line) => line.startsWith("The number pool is low"))).toBe(false);
    await openAccount(h, { label: "Court" });
    expect(logs).toContain(`The number pool is low: ${POOL_LOW_AT} ready (alert at ${POOL_LOW_AT} or fewer). Add registered numbers on /admin.`);
  });

  it("keeps the account when Twilio refuses the webhook, records it, and can point it again", async () => {
    fakeTwilio({ [A]: "PNa" }, { webhook: true });
    await topUp(h, [A]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    expect(opened.webhookOk).toBe(false);
    expect(pool().get(A)?.webhookOk).toBe(false);
    expect(logs).toContain("Twilio didn't take a line's webhooks. Point it again from the number pool on /admin.");
    fakeTwilio({ [A]: "PNa" });
    expect(await repointLine(h, opened.tenant)).toBe(true);
    expect(pool().get(A)?.webhookOk).toBe(true);
  });

  it("a closed account's line clears its webhook and rests 30 days before anyone else gets it", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    await closeLine(h, opened.tenant, "return");
    h.registry.remove(opened.tenant.id);
    expect(calls.at(-1)).toEqual(point("PNa", ""));
    expect(pool().stateOf(pool().get(A)!)).toBe("resting");
    expect(pool().readyAt(pool().get(A)!)).toBe(new Date(T0 + REST_MS).toISOString());
    expect(await openAccount(h, { label: "Court" })).toEqual({ refused: "no-line" });
    now = T0 + REST_MS;
    expect(await openAccount(h, { label: "Court" })).toMatchObject({ number: A });
  });

  it("a closed account's line loses its group texts before it goes back to the pool, so the next account can start its own", async () => {
    fakeTwilio({ [A]: "PNa" });
    const groups = fakeConversations();
    setCleanerGroupFetch(groups.impl);
    const base = h.baseEnv;
    h = { ...h, baseEnv: () => ({ ...base(), CLEANER_CORE_LIVE_SMS: "1" }) };
    await topUp(h, [A]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    const old = groups.seedGroup([B, C], A, `${ORIGIN}/t/${opened.tenant.id}/webhooks/twilio/cleaner-core/conversation`);
    const elsewhere = groups.seedGroup([B, C], "+15555550188", `${ORIGIN}/t/tnt_other/webhooks/twilio/cleaner-core/conversation`);
    expect(await closeLine(h, opened.tenant, "return")).toBe("returned");
    expect(groups.removed).toEqual([old]);
    expect(groups.people(elsewhere)).toHaveLength(3);
    expect(logs).toContain(`Removed 1 group text from ${opened.tenant.id}'s line.`);
  });

  it("releases a closed account's line from Twilio when asked, and keeps it resting if Twilio refuses", async () => {
    const owned = { [A]: "PNa", [B]: "PNb" };
    const calls = fakeTwilio(owned);
    await topUp(h, [A]);
    const lane = await openAccount(h, { label: "Lane" });
    if ("refused" in lane) throw new Error(lane.refused);
    await closeLine(h, lane.tenant, "release");
    expect(calls.at(-1)).toEqual({ method: "DELETE", url: "https://api.twilio.com/2010-04-01/Accounts/ACpooltest/IncomingPhoneNumbers/PNa.json" });
    expect(pool().get(A)).toBeUndefined();

    fakeTwilio({ [B]: "PNb" }, { release: true });
    await topUp(h, [B]);
    const court = await openAccount(h, { label: "Court" });
    if ("refused" in court) throw new Error(court.refused);
    await closeLine(h, court.tenant, "release");
    expect(pool().stateOf(pool().get(B)!)).toBe("resting");
    expect(logs.at(-1)).toBe(`Twilio didn't release ${court.tenant.id}'s line. It rests in the pool; release it from there.`);
  });

  it("returns a line an account had before the pool existed", async () => {
    fakeTwilio({ [C]: "PNc" });
    const { tenant } = h.registry.create({ label: "Mill", twilioNumber: C });
    await closeLine(h, tenant, "return");
    expect(pool().get(C)).toMatchObject({ sid: "PNc", returnedAt: new Date(T0).toISOString() });
  });

  it("releases a pooled number no account holds, and never an account's line", async () => {
    fakeTwilio({ [A]: "PNa", [B]: "PNb" });
    await topUp(h, [A, B]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    expect(await releasePooled(h, opened.number)).toEqual({ refused: "in-use" });
    expect(await releasePooled(h, C)).toEqual({ refused: "not-pooled" });
    const other = opened.number === A ? B : A;
    expect(await releasePooled(h, other)).toEqual({ released: other });
    expect(pool().get(other)).toBeUndefined();
  });

  it("a release under way never hands its number to a sign-up", async () => {
    let finish: (res: Response) => void = () => {};
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    // Twilio holds the DELETE until the sign-up has run.
    setTwilioNumbersFetch(async (input, init) => {
      if ((init?.method ?? "GET") === "DELETE") return new Promise<Response>((resolve) => (finish = resolve));
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response("{}", { status: 200 });
    });
    const releasing = releasePooled(h, A);
    expect(await openAccount(h, { label: "Lane" })).toEqual({ refused: "no-line" });
    finish(new Response(null, { status: 204 }));
    expect(await releasing).toEqual({ released: A });
    expect(pool().get(A)).toBeUndefined();
  });

  it("puts a number back as it was when Twilio refuses its release", async () => {
    fakeTwilio({ [A]: "PNa" }, { release: true });
    await topUp(h, [A]);
    const before = pool().get(A);
    expect(await releasePooled(h, A)).toEqual({ refused: "twilio" });
    expect(pool().get(A)).toEqual(before);
  });

  it("refuses to pool one of the service's other numbers", async () => {
    fakeTwilio({ [A]: "PNa" });
    const base = h.baseEnv();
    h.baseEnv = () => ({ ...base, TOURCORE_TWILIO_PHONE_NUMBER: A });
    expect((await topUp(h, [A])).refused).toEqual([{ raw: A, reason: "in-use" }]);
  });

  it("keeps an account's texts working when the pool file can't be read", async () => {
    const { tenant } = h.registry.create({ label: "Lane", twilioNumber: A });
    const property = h.registry.addProperty(tenant.id, "12 Scratch Lane");
    writeFileSync(join(dir, "number-pool.json"), "{ not json");
    expect(propertyContext(h, h.registry.get(tenant.id)!, property).env().CLEANER_CORE_SERVICE_LINES).toBe(A);
  });

  it("records and skips a ready number an account already holds", async () => {
    fakeTwilio({ [A]: "PNa", [B]: "PNb" });
    await topUp(h, [A, B]);
    // An account made outside the pool with a pooled number.
    const mill = h.registry.create({ label: "Mill", twilioNumber: A }).tenant;
    expect(await openAccount(h, { label: "Lane" })).toMatchObject({ number: B });
    expect(pool().get(A)?.tenantId).toBe(mill.id);
  });

  it("counts every pooled number as the service's own, so none is texted as a person", async () => {
    fakeTwilio({ [A]: "PNa", [B]: "PNb" });
    await topUp(h, [A, B]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    const property = h.registry.addProperty(opened.tenant.id, "12 Scratch Lane");
    const lines = propertyContext(h, h.registry.get(opened.tenant.id)!, property).env().CLEANER_CORE_SERVICE_LINES?.split(",");
    expect(new Set(lines)).toEqual(new Set([A, B]));
  });
});

describe("the rest before a returned line is handed out again (CLEANER_CORE_POOL_REST_DAYS)", () => {
  it("is 30 days unless the setting is a whole number of days, and 0 turns it off", () => {
    expect(poolRestMs({})).toBe(REST_MS);
    expect(poolRestMs({ CLEANER_CORE_POOL_REST_DAYS: "" })).toBe(REST_MS);
    expect(poolRestMs({ CLEANER_CORE_POOL_REST_DAYS: "0" })).toBe(0);
    expect(poolRestMs({ CLEANER_CORE_POOL_REST_DAYS: " 7 " })).toBe(7 * 24 * 60 * 60_000);
    for (const bad of ["-1", "1.5", "abc", "7d"]) expect(poolRestMs({ CLEANER_CORE_POOL_REST_DAYS: bad })).toBe(REST_MS);
  });

  it("with 0, a closed account's line is ready for the next sign-up at once", async () => {
    fakeTwilio({ [A]: "PNa" });
    const base = h.baseEnv;
    h = { ...h, baseEnv: () => ({ ...base(), CLEANER_CORE_POOL_REST_DAYS: "0" }) };
    await topUp(h, [A]);
    const lane = await openAccount(h, { label: "Lane" });
    if ("refused" in lane) throw new Error(lane.refused);
    await closeLine(h, lane.tenant, "return");
    h.registry.remove(lane.tenant.id);
    expect(pool().stateOf(pool().get(A)!)).toBe("resting");
    expect(new NumberPool(dir, () => new Date(now), 0).stateOf(pool().get(A)!)).toBe("ready");
    expect(await openAccount(h, { label: "Court" })).toMatchObject({ number: A });
  });
});

describe("the line's voice webhook", () => {
  it("points SMS and voice in one call and clears a TwiML App", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    const posted = new URLSearchParams(calls.at(-1)!.body);
    expect(posted.get("SmsUrl")).toBe(`${ORIGIN}/webhooks/twilio/cleaner-core`);
    expect(posted.get("VoiceUrl")).toBe(`${ORIGIN}/webhooks/twilio/voice`);
    expect(posted.get("VoiceApplicationSid")).toBe("");
    expect(pool().get(A)).toMatchObject({ webhookOk: true, voiceOk: true });
  });

  it("closing a line clears both webhooks", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    await closeLine(h, opened.tenant, "return");
    const posted = new URLSearchParams(calls.at(-1)!.body);
    expect(posted.get("SmsUrl")).toBe("");
    expect(posted.get("VoiceUrl")).toBe("");
  });

  it("points an SMS-only line's voice once at startup, and not again", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    const opened = await openAccount(h, { label: "Lane" });
    if ("refused" in opened) throw new Error(opened.refused);
    // A line pointed before voice: SMS only, no voice mark.
    const file = join(dir, "number-pool.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.numbers[0].voiceOk;
    writeFileSync(file, JSON.stringify(doc));
    const before = calls.length;
    await pointVoiceOnce(h);
    await pointVoiceOnce(h);
    const posts = calls.slice(before).filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0]!.body).get("VoiceUrl")).toBe(`${ORIGIN}/webhooks/twilio/voice`);
    expect(pool().get(A)?.voiceOk).toBe(true);
  });

  it("points no voice webhook at startup while FIXER_CORE is off", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    await openAccount(h, { label: "Lane" });
    const file = join(dir, "number-pool.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.numbers[0].voiceOk;
    writeFileSync(file, JSON.stringify(doc));
    const base = h.baseEnv;
    h = { ...h, baseEnv: () => ({ ...base(), FIXER_CORE: "" }) };
    const before = calls.length;
    await pointVoiceOnce(h);
    expect(calls.slice(before).filter((c) => c.method === "POST")).toEqual([]);
  });

  it("points the voice webhook of an account made before the pool, at startup", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    h.registry.create({ label: "Old", twilioNumber: A });
    await pointVoiceOnce(h);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0]!.body).get("VoiceUrl")).toBe(`${ORIGIN}/webhooks/twilio/voice`);
  });

  it("points nothing while the public address isn't known", async () => {
    const calls = fakeTwilio({ [A]: "PNa" });
    await topUp(h, [A]);
    await openAccount(h, { label: "Lane" });
    const file = join(dir, "number-pool.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.numbers[0].voiceOk;
    writeFileSync(file, JSON.stringify(doc));
    h = { ...h, origin: () => undefined };
    const before = calls.length;
    await pointVoiceOnce(h);
    expect(calls.slice(before).filter((c) => c.method === "POST")).toEqual([]);
    expect(pool().get(A)?.voiceOk).toBeUndefined();
  });

  it("logs a refused voice pointing without the number", async () => {
    fakeTwilio({ [A]: "PNa" }, { webhook: true });
    await topUp(h, [A]);
    await openAccount(h, { label: "Lane" });
    const file = join(dir, "number-pool.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.numbers[0].voiceOk;
    writeFileSync(file, JSON.stringify(doc));
    const before = logs.length;
    await pointVoiceOnce(h);
    expect(logs.slice(before).filter((l) => l.startsWith("Twilio didn't take"))).toEqual(["Twilio didn't take a line's webhooks. Point it again from the number pool on /admin."]);
    expect(logs.join("\n")).not.toContain("+1555");
    expect(pool().get(A)?.voiceOk).toBe(false);
  });
});
