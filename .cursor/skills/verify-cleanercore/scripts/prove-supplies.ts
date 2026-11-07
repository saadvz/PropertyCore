import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type ToolReply } from "../../../../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../../../../src/cleaner-core/liveSms";
import { supplyDeskFor, type SupplyReply } from "../../../../src/supply-core/desk";
import { readSupply, writeSupply } from "../../../../src/supply-core/store";
import { fakeConversations } from "../../../../test/fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "../../../../test/wiringProof";

/**
 * Drives one Scratch cleaning through Supply Core: one item activated on a cleaning property, DONE
 * with the supplies question, the cleaner's answer, report_low, check_supplies, a go cart, and a
 * made-up order number. Every text goes to a fake; no store is opened and nothing reaches a phone.
 */
const outPath = process.argv[2];
if (!outPath) throw new Error("prove-supplies.ts needs an output path");

const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const SUPPLY_DONE_ASK = "Thanks, cleaning marked done. Anything running low? Reply with what's low, or NONE.";
const SCRATCH = /^\+1(555\d{7}|\d{3}555(01\d\d))$/;

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

function done(reply: SupplyReply): Record<string, unknown> {
  if (reply.isError) throw new Error(reply.text);
  return reply.structured ?? {};
}

const root = mkdtempSync(join(tmpdir(), "prove-supplies-"));
try {
  const sms = fakeSms();
  const groups = fakeConversations();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerAlertFetch(async () => ({ status: 200 }));
  setCleanerCalendarFetch(async (url) => ({ status: url === CALENDAR_URL ? 200 : 404, url, async text() { return url === CALENDAR_URL ? CALENDAR_ICS : ""; } }));
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_GROUP_CHAT: "0",
    CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
    CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
  };
  const now = () => new Date(FROZEN);
  const desk = liveDeskFor(root, () => env, now);
  const supplies = supplyDeskFor(root, { now, cleaningOn: () => true });

  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: "America/New_York", checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door lockbox" }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.savePayments({ on: false }));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));

  done(
    await supplies.saveItem({
      name: "Paper towels",
      qtyPerOrder: 2,
      preferred: { title: "Example paper towels, 12 rolls", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400 },
      storeNote: "Made-up store for the proof.",
      schedule: { kind: "every", days: 365 },
    }),
  );
  done(await supplies.saveItem({ done: true }));
  done(await supplies.saveSettings({ mode: "hands-off", perOrderCapCents: 10000, perMonthCapCents: null, checkTime: "10:00", routineCreated: true }));
  done(await supplies.activate({}));
  desk.refreshSupplyAsk();
  const itemId = readSupply(root).items[0]!.id;
  // Ordered once already, so only the cleaner's report makes it due.
  const towels = readSupply(root);
  towels.items[0]!.lastOrderedAt = new Date(FROZEN).toISOString();
  writeSupply(root, towels);

  const toCleaner = () => sms.sent.filter((text) => text.to === CLEANER).map((text) => text.body);
  await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
  const doneText = toCleaner().at(-1);
  await desk.inbound({ id: "low", from: CLEANER, text: "out of paper towels" });
  const noted = toCleaner().at(-1);
  const messages = (ok(await desk.checkNow()).messages ?? []) as { handled: string; text: string }[];
  const report = messages.find((message) => message.handled === "supply-report");
  const notDueBefore = (done(await supplies.checkSupplies({})).due as unknown[]).length;
  done(await supplies.reportLow({ itemIds: [itemId], source: "cleaner" }));
  const due = done(await supplies.checkSupplies({})).due as { itemId: string; deadline: string }[];
  const cart = done(await supplies.checkCart({ store: "Example Mart", items: [{ itemId, product: "preferred", qty: 2, unitCents: 2400 }], shippingCents: 0, taxCents: 0, totalCents: 4800, deliveryBy: due[0]?.deadline ?? "2026-10-17" }));
  const order = done(await supplies.recordOrder({ cartToken: String(cart.cartToken), orderNumber: "SCRATCH-0001", chargedCents: 4800 }));

  const recipients = [...new Set([...sms.sent.map((text) => text.to), ...groups.posts.flatMap((post) => post.to)].filter(Boolean))];
  const evidence = { doneText, noted, report, notDueBefore, due, verdict: cart.verdict, order, recipients, ordersSaved: readSupply(root).orders.length };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed =
    doneText === SUPPLY_DONE_ASK &&
    noted === "Thanks, noted." &&
    report?.text.includes("paper towels") === true &&
    notDueBefore === 0 &&
    due.length === 1 &&
    cart.verdict === "go" &&
    String(order.line).startsWith("Ordered from Example Mart: Paper towels ×2. $48.00") &&
    recipients.every((to) => SCRATCH.test(to)) &&
    !JSON.stringify(evidence).includes(DOOR_CODE);
  if (!passed) {
    console.error("supplies proof failed", evidence);
    process.exitCode = 1;
  }
} finally {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerAlertFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  rmSync(root, { recursive: true, force: true });
}
