import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../../../../src/cleaner-core/liveDesk";
import { sendLiveGroup, setCleanerGroupFetch, setCleanerTwilioClient } from "../../../../src/cleaner-core/liveSms";
import { CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, fakeSms, FROZEN, HOST, OBSERVER, TEST_PIN_KEY } from "../../../../test/wiringProof";

const outPath = process.argv[2];
if (!outPath) throw new Error("prove-group-desk.ts needs an output path");

const calls: string[] = [];
const groupBodies: string[] = [];
const conversations = new Map<string, { sid: string; address: string }[]>();
let sequence = 0;
setCleanerGroupFetch(async (url, init) => {
  calls.push(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const target = String(url);
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
  const root = "https://conversations.twilio.com/v1/Conversations";
  if (target === root && method === "POST") {
    const sid = `CH${++sequence}`;
    conversations.set(sid, []);
    return reply(201, { sid });
  }
  if (!target.startsWith(`${root}/`)) return reply(500, {});
  const path = target.slice(root.length + 1);
  const [rawSid, ...rest] = path.split("/");
  const sid = decodeURIComponent(rawSid ?? "");
  const tail = rest.join("/").split("?")[0] ?? "";
  const people = conversations.get(sid);
  if (!people) return reply(404, {});
  if (tail === "Messages" && method === "POST") {
    const params = new URLSearchParams(String(init?.body ?? ""));
    groupBodies.push(params.get("Body") ?? "");
    return reply(500, {});
  }
  if (tail === "Participants" && method === "GET") {
    return reply(200, {
      participants: people.map((person) => ({ sid: person.sid, messaging_binding: { address: person.address } })),
      meta: { next_page_url: null },
    });
  }
  if (tail === "Participants" && method === "POST") {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const address = params.get("MessagingBinding.Address") ?? "";
    if (people.some((person) => person.address === address)) return reply(409, {});
    const person = { sid: `MB${++sequence}`, address };
    people.push(person);
    return reply(201, { sid: person.sid });
  }
  if (method === "DELETE" && tail.startsWith("Participants/")) {
    const party = decodeURIComponent(tail.slice("Participants/".length));
    const index = people.findIndex((person) => person.sid === party);
    if (index >= 0) people.splice(index, 1);
    return reply(index >= 0 ? 204 : 404, {});
  }
  return reply(500, {});
});
setCleanerTwilioClient(fakeSms());
setCleanerCalendarFetch(async (url) => ({
  status: url === CALENDAR_URL ? 200 : 404,
  url,
  async text() {
    return url === CALENDAR_URL ? CALENDAR_ICS : "";
  },
}));

const root = mkdtempSync(join(tmpdir(), "cleaner-group-proof-"));
const env: NodeJS.ProcessEnv = {
  CLEANER_CORE_ENABLED: "1",
  CLEANER_CORE_LIVE_SMS: "1",
  CLEANER_CORE_GROUP_CHAT: "1",
  CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}`,
  CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
  CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
  CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
};
const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
await desk.getState("cleaners");
await desk.saveProperty({ business: "Harbor", address: "12 Practice Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
await desk.savePeople({ host: HOST, cleaner: CLEANER, observer: OBSERVER, doorCodeTo: "cleaner" });
await desk.saveCalendarLink({ url: CALENDAR_URL });
await desk.saveDoorCode({ code: DOOR_CODE }, pinKey);
await desk.setUpTexting();
await desk.runChecks();
const missing = await desk.markGuestsLeft({ confirmed: true }, undefined);
await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
const failed = await desk.markGuestsLeft({ confirmed: true }, pinKey);
const again = await desk.markGuestsLeft({ confirmed: true }, pinKey);
const fetchesAfterFailure = calls.length;

setCleanerGroupFetch(async () => {
  throw new Error("group fetched with live texts off");
});
const off = await sendLiveGroup(
  { ...env, CLEANER_CORE_LIVE_SMS: "0" },
  { audience: [HOST, CLEANER], body: "Hello the group" },
);

const nextOf = (reply: { ok: boolean; result?: Record<string, unknown>; error?: string }) =>
  reply.ok ? String(reply.result?.next ?? "") : String(reply.error ?? "");
const record = {
  missing: nextOf(missing),
  sent: nextOf(failed),
  again: nextOf(again),
  fetchesAfterPin: fetchesAfterFailure,
  groupSawCode: groupBodies.some((body) => /door code/i.test(body) || body.includes(DOOR_CODE)),
  liveOff: off === undefined ? "no-fetch" : "fetched",
};
const json = JSON.stringify(record, null, 2);
if (json.includes(DOOR_CODE)) throw new Error("desk proof included the door code");
writeFileSync(outPath, `${json}\n`);
rmSync(root, { recursive: true, force: true });
setCleanerTwilioClient(undefined);
setCleanerGroupFetch(undefined);
setCleanerCalendarFetch(undefined);
resetLiveDesks();
