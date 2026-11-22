import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks } from "../src/fixer-core/desk";
import { HOST_STEPS_FILE, readHostSteps } from "../src/hours-log/hostSteps";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { LockDesk, type LockDeskDeps, type LockReply } from "../src/locks/desk";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { stayCheckDeskFor } from "../src/stay-check/desk";
import { deskFeatures } from "./featureEnv";

/**
 * #18: each newer feature writes the host's step only after it saved what the host said yes to. A call
 * without the yes, or one refused, writes nothing; no step holds a phone or a code. The fake lock adapter,
 * 555 numbers and made-up codes only.
 */

const NOW = new Date("2026-11-22T15:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  resetHubs();
  resetFixerDesks();
  setLockAdapter(undefined);
  setCalendarFetch(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const steps = (root: string) => readHostSteps(root).map((step) => [step.kind, step.about ?? null]);

describe("the nightly stay check's house rules", () => {
  it("records each save, add, check time, allowance and false flag, and nothing for a refused one", () => {
    const root = folder("steps-rules-");
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { timeZone: "America/New_York" }, calendars: [], stays: [] }));
    const desk = stayCheckDeskFor(root, { now: () => NOW });
    expect(desk.saveRules({ rules: [{ text: `Gate ${["4", "8", "2", "1"].join("")}` }] }).isError).toBe(true);
    expect(desk.saveRules({}).isError).toBe(true);
    expect(existsSync(join(root, HOST_STEPS_FILE))).toBe(false);
    desk.saveRules({ rules: [{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }], checkTime: "22:30" });
    desk.saveRules({ add: { text: "No parties" } });
    desk.allowForStay({ checkIn: "2026-11-27", allow: ["pets"] });
    desk.markFlagFalse({ kind: "vehicles" });
    expect(steps(root)).toEqual([
      ["rules-save", "1"],
      ["check-time", "22:30"],
      ["rules-add", "2"],
      ["stay-allow", "2026-11-27"],
      ["flag-false", "vehicles"],
    ]);
  });
});

describe("Fixer Core upkeep", () => {
  it("records the saved upkeep schedule and its removal, with the host's yes after Activate", async () => {
    const root = folder("steps-upkeep-");
    const now = () => NOW;
    const hub = hubFor(root, { now });
    hub.saveProperty({ nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    setCalendarFetch(async (url) => ({ status: 200, url, async text() { return "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
    const desk = fixerDeskFor(root, { now, env: () => ({ CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") }) });
    // Before Activate, a plain save goes through: the host's own words in setup.
    expect((await desk.saveUpkeep({ trade: "gutters", what: "Clean the gutters", schedule: { kind: "every", days: 180 } })).isError).toBe(false);
    expect(steps(root)).toEqual([["upkeep-save", "Clean the gutters"]]);
  });
});

describe("connected locks and standing codes", () => {
  function world() {
    const root = folder("steps-locks-");
    const env: NodeJS.ProcessEnv = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
    const fake = new FakeLockAdapter();
    setLockAdapter(fake);
    fake.addDevice("acct", { id: "dev-front", name: "Front door" });
    const hub = hubFor(root, { now: () => NOW });
    hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    const deps: LockDeskDeps = {
      now: () => NOW,
      env: () => env,
      customerKey: "acct",
      otherDevices: () => [],
      alertsWorking: async () => true,
      textsAllowed: async () => true,
      stopped: () => false,
      send: async () => true,
      publicBase: () => "https://pc.example/t/acct/p/prp_scratch",
      cleaningOn: () => true,
    };
    return { root, desk: new LockDesk(root, deps) };
  }

  const approved = async (call: (confirmation?: string) => Promise<LockReply>) => {
    const first = await call();
    const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
    return code ? call(code) : first;
  };

  it("writes nothing on the question, then one step on the host's yes, with no phone", async () => {
    const { root, desk } = world();
    await desk.saveLocks({ doors: ["dev-front"] });
    expect(existsSync(join(root, HOST_STEPS_FILE))).toBe(false);
    await approved((confirmation) => desk.saveLocks({ doors: ["dev-front"], ...(confirmation ? { confirmation } : {}) }));
    await approved((confirmation) => desk.settings({ pros: "automatic", ...(confirmation ? { confirmation } : {}) }));
    expect((await desk.saveLocks({ doors: ["dev-front"], confirmation: "NOTREAL" })).isError).toBe(true);
    const added = await approved((confirmation) => desk.addStanding({ name: "Robin", phone: "+1 555 555 0142", role: "co-host", ...(confirmation ? { confirmation } : {}) }));
    const id = String(added.structured?.id ?? JSON.parse(readFileSync(join(root, "door-locks.json"), "utf8")).standing[0].id);
    await approved((confirmation) => desk.removeStanding({ id, ...(confirmation ? { confirmation } : {}) }));
    expect(steps(root)).toEqual([
      ["locks-on", "Front door"],
      ["lock-settings", null],
      ["standing-add", "Robin"],
      ["standing-remove", "Robin"],
    ]);
    expect(readFileSync(join(root, HOST_STEPS_FILE), "utf8")).not.toMatch(/555/);
  });
});
