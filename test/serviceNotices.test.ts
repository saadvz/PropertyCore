import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps, type FixerReply } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { noticeDates, readServiceNotices, SERVICE_NOTICES_FILE } from "../src/fixer-core/serviceNotices";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { buildVisits } from "../src/visits/derive";
import { resetVisitLogCache, visitLogFor } from "../src/visits/store";

/**
 * Completed-service notices (#237): the host's agent passes a vendor's email as received; it is kept append-only as
 * evidence, linked to the visit, and never sets a time. Made-up codes, 555 numbers, example.com addresses.
 */

const NOW = new Date("2027-01-10T20:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const SAVED = ["7", "3", "0", "6"].join("");
const HOST = "+15555550100";
const BUGS = "+15555550177";
const PROPERTY_ID = "prop_scratch";
const VISIT = { from: "2027-01-10T14:00:00.000Z", until: "2027-01-10T16:00:00.000Z" };

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  resetVisitLogCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const codeOf = (reply: FixerReply): string | undefined => (reply.structured?.confirmation as { code: string } | undefined)?.code;
async function approved(call: (confirmation?: string) => Promise<FixerReply>): Promise<FixerReply> {
  const first = await call();
  const code = codeOf(first);
  return code ? call(code) : first;
}

async function setup(options: { notices?: boolean; visitRecords?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "notice-"));
  const account = mkdtempSync(join(tmpdir(), "notice-acct-"));
  dirs.push(root, account);
  const clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64"), FIXER_CORE: "1", ...(options.visitRecords === false ? {} : { VISIT_RECORDS: "1" }) };
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  hub.doorAccess(() => env).save(SAVED, undefined, undefined);
  const people = () => peopleFor(account, { now });
  people().savePropertyPeople(PROPERTY_ID, HOST, []);
  const deps: FixerDeps = { now, env: () => env, propertyId: PROPERTY_ID, people, publicBase: () => "https://fixer.example.com", photoKey: () => randomBytes(32), textsAllowed: async () => true, send: async () => true, notifyHost: async () => undefined };
  const desk = () => fixerDeskFor(root, deps);
  await desk().savePro({ name: "Bug Busters", trades: ["pest-control"], reach: { phone: BUGS, email: "office@bugbusters.example.com" }, prefersText: true, preferredFor: [{ trade: "pest-control", rank: 1 }] });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  if (options.notices !== false) expect((await approved((confirmation) => desk().saveSettings({ serviceNotices: true, ...(confirmation ? { confirmation } : {}) } as never))).isError).toBe(false);
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));
  await desk().checkFixes({});
  // A done pest visit on Sun 10 Jan, written straight into the record.
  const file = readFixer(root);
  const proId = file.pros[0]!.id;
  file.jobs.push({ id: "job_pestvisit", trade: "pest-control", what: "Pest control", source: "upkeep", photos: [], urgency: "by-date", state: "done", hostGo: { at: NOW.toISOString() }, candidates: [], picked: [], contacts: [], news: [], createdAt: "2027-01-03T13:00:00.000Z", booking: { proId, ...VISIT, access: "code", hostYes: { at: NOW.toISOString() }, fingerprint: "x" }, done: { at: "2027-01-10T15:40:00.000Z", by: "pro-text" } });
  const { writeFixer } = await import("../src/fixer-core/store");
  writeFixer(root, file);
  resetFixerDesks();
  const email = (over: Record<string, string> = {}) => ({ from: "Bug Busters <office@bugbusters.example.com>", subject: "Service report for 12 Scratch Lane", body: `Thank you! Service completed on January 10, 2027.\nTechnician: Sam\nGate code used: ${SAVED}\nAccount 48213377\nTime in 9:05 AM, time out 9:52 AM.`, messageId: "<abc@bugbusters.example.com>", receivedAt: "2027-01-10T19:00:00.000Z", ...over });
  const log = () => visitLogFor(root, now);
  return { root, desk, email, log, at: () => clock };
}

describe("completed-service notices", () => {
  it("reads only the service date, in the usual written forms", () => {
    expect(noticeDates("Service completed on January 10, 2027", "2027-01-10T19:00:00.000Z", "America/New_York")).toEqual(["2027-01-10"]);
    expect(noticeDates("Date of service: 1/10/2027", "2027-01-10T19:00:00.000Z", "America/New_York")).toEqual(["2027-01-10"]);
    expect(noticeDates("Serviced 2027-01-09 and Jan 10", "2027-01-10T19:00:00.000Z", "America/New_York")).toEqual(["2027-01-09", "2027-01-10"]);
    expect(noticeDates("no date here", "2027-01-10T19:00:00.000Z", "America/New_York")).toEqual([]);
  });

  it("stores the email as received, with the door code and digit runs out, append-only, and links it to the visit", async () => {
    const w = await setup();
    const reply = await w.desk().saveServiceNotice({ email: w.email() });
    expect(reply.isError).toBe(false);
    expect(reply.structured).toMatchObject({ saved: true, jobId: "job_pestvisit", serviceDate: "2027-01-10" });
    expect(JSON.stringify(reply.structured).includes(SAVED)).toBe(false);
    const raw = readFileSync(join(w.root, SERVICE_NOTICES_FILE), "utf8");
    expect(raw.includes(SAVED)).toBe(false);
    expect(raw.includes("48213377")).toBe(false);
    expect(raw).toContain("Technician: Sam");
    expect(statSync(join(w.root, SERVICE_NOTICES_FILE)).mode & 0o777).toBe(0o600);
    const line = w.log().read().find((e) => e.type === "service-notice");
    expect(line).toMatchObject({ type: "service-notice", visit: "repair:job_pestvisit", serviceDate: "2027-01-10" });
  });

  it("never sets the visit's times: the record reads the same with and without the notice", async () => {
    const w = await setup();
    const before = buildVisits(w.log().read(), { timeZone: PROPERTY.timeZone, codeNames: {}, now: w.at() }).visits.map(({ arrival, departure, minutes }) => ({ arrival, departure, minutes }));
    await w.desk().saveServiceNotice({ email: w.email() });
    const after = buildVisits(w.log().read(), { timeZone: PROPERTY.timeZone, codeNames: {}, now: w.at() }).visits.map(({ arrival, departure, minutes }) => ({ arrival, departure, minutes }));
    expect(after).toEqual(before);
  });

  it("keeps a second copy once", async () => {
    const w = await setup();
    await w.desk().saveServiceNotice({ email: w.email() });
    const again = await w.desk().saveServiceNotice({ email: w.email() });
    expect(again.structured).toMatchObject({ duplicate: true });
    expect(readServiceNotices(w.root).filter((n) => n.outcome !== "duplicate")).toHaveLength(1);
    expect(w.log().read().filter((e) => e.type === "service-notice")).toHaveLength(1);
  });

  it("stores one it can't match with no visit, and says so", async () => {
    const w = await setup();
    const reply = await w.desk().saveServiceNotice({ email: w.email({ from: "someone@else.example.com", body: "Service done March 3.", messageId: "<other@else.example.com>" }) });
    expect(reply.structured).toMatchObject({ saved: true, matched: false });
    expect(w.log().read().filter((e) => e.type === "service-notice")).toHaveLength(0);
  });

  it("is refused until the host turned notices on, and with visit records off", async () => {
    const off = await setup({ notices: false });
    expect((await off.desk().saveServiceNotice({ email: off.email() })).isError).toBe(true);
    const noRecords = await setup({ notices: false, visitRecords: false });
    expect((await noRecords.desk().saveServiceNotice({ email: noRecords.email() })).isError).toBe(true);
  });
});
