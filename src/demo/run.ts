import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { auditToCsv, formatAudit } from "../audit/audit";
import { style } from "../cli/prompter";
import { loadConfig } from "../config/tourCoreConfig";
import { SimulatedClock } from "../core/clock";
import { nextTourDay } from "../core/schedule";
import { formatLocalDate, formatTime as formatTimeIn, zonedTimeToUtc } from "../core/timezone";
import type { TourCore } from "../core/TourCore";
import { createTourCore } from "../createTourCore";
import { MockDurinAccessAdapter } from "../durin/MockDurinAccessAdapter";
import { ConsoleMessenger } from "../messaging/Messenger";

const AUTO = process.argv.includes("--auto") || !process.stdin.isTTY;
const { bold, dim, green, red, cyan, yellow } = style;

const rl = AUTO ? undefined : createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt: string, autoAnswer: string): Promise<string> {
  if (!rl) {
    console.log(`${prompt}${autoAnswer}`);
    return autoAnswer;
  }
  const answer = (await rl.question(prompt)).trim();
  return answer || autoAnswer;
}

async function pause(label: string): Promise<void> {
  if (rl) await rl.question(dim(`  (press Enter to ${label})`));
}

const durinLines: string[] = [];
const textLines: string[] = [];
const flush = (lines: string[]) => lines.splice(0).forEach((l) => console.log(l));

function section(title: string): void {
  console.log(`\n${bold(cyan(`== ${title} `.padEnd(64, "=")))}`);
}

const config = loadConfig();
const TZ = config.property.timezone;
const formatTime = (d: Date) => formatTimeIn(d, TZ);

function step(clock: SimulatedClock, text: string): void {
  console.log(`\n${yellow(formatTime(clock.now()).padStart(8))}  ${text}`);
}

async function main(): Promise<void> {
  const tourDay = nextTourDay(config, new Date());
  const clock = new SimulatedClock(zonedTimeToUtc({ ...tourDay, hour: 10, minute: 0 }, TZ));
  const durin = new MockDurinAccessAdapter({
    doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])),
    timeZone: TZ,
    log: (l) => durinLines.push(dim(l)),
    now: () => clock.now(),
  });
  const core = createTourCore(config, { clock, durin, messenger: new ConsoleMessenger((l) => textLines.push(l)) });
  const doorName = (id: string) => config.doors.find((d) => d.id === id)?.name ?? id;

  console.log(bold("\nTOUR CORE DEMO"));
  console.log(dim("Tour Core never unlocks a door. It asks the door system for a scoped grant, and only after its own policy says yes."));
  console.log(dim(`Door access is in demo mode, so no real doors open. Simulated day: ${formatLocalDate(tourDay, TZ)} (${TZ}).`));

  section("Property");
  console.log(`  ${bold(config.property.name)}`);
  console.log(`  Units:  ${config.units.map((u) => u.name).join(", ")}`);
  console.log(`  Doors:  ${config.doors.map((d) => `${d.name} [${d.id}]`).join(", ")}`);
  for (const r of config.routes) {
    console.log(`  Route:  ${config.units.find((u) => u.id === r.unitId)?.name}: ${r.stops.map((s) => doorName(s.doorId)).join(" -> ")}`);
  }

  // 1. Inquiry
  section("1. Inquiry");
  step(clock, `Jane Smith texts the property: ${bold('"Hi! Can I tour Unit 101?"')}`);
  const { prospect, reservation: inquiry } = await core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
  await core.recordInbound(prospect.id, inquiry.id, "Hi! Can I tour Unit 101?");
  flush(textLines);
  console.log(`  Prospect ${prospect.id}, reservation ${inquiry.id}`);
  console.log(`  Allowed route: ${JSON.stringify(inquiry.allowedRoute)}`);

  // 2. Choose a time
  section("2. Choose a time");
  const slots = await core.availableSlots();
  slots.forEach((s, i) => console.log(`  ${i + 1}. ${s.label}`));
  let choice = Number(await ask("  Jane picks > ", "1"));
  if (!Number.isInteger(choice) || choice < 1 || choice > slots.length) choice = 1;
  const slot = slots[choice - 1]!;
  await core.recordInbound(prospect.id, inquiry.id, String(choice));
  let reservation = await core.reserveSlot(inquiry.id, slot.start.toISOString());
  flush(textLines);
  console.log(`  Reservation created for ${slot.label}. Status: ${bold(reservation.status)}`);

  // 3. Consent
  section("3. Consent");
  const consentAnswer = (await ask("  Jane replies (yes/no) > ", "yes")).toLowerCase();
  const granted = consentAnswer.startsWith("y");
  await core.recordInbound(prospect.id, reservation.id, consentAnswer);
  reservation = await core.recordConsent(reservation.id, granted);
  flush(textLines);
  console.log(`  Status: ${bold(reservation.status)}`);
  if (!granted) return finish(core, clock);

  // 4. Verification
  section("4. Basic identity verification");
  const form = {
    responseId: "form_resp_0001",
    submittedAt: clock.now().toISOString(),
    answers: { governmentFirstName: "Jane", governmentLastName: "Smith", email: "jane.smith@example.com", phone: "555-010-1234" },
  };
  console.log(dim("  Simulated Google Form response (no ID images are collected or stored):"));
  for (const [k, v] of Object.entries(form.answers)) console.log(`    ${k.padEnd(20)} ${v}`);
  await pause("submit the form");
  clock.advanceMinutes(3);
  reservation = await core.submitVerification(reservation.id, form);
  flush(textLines);
  console.log(`  Basic identity form completed. Status: ${bold(reservation.status === "READY" ? green("READY") : red(reservation.status))}`);
  if (reservation.status !== "READY") return finish(core, clock);

  const tryDoor = async (doorId: string, who = "Jane requests") => {
    step(clock, `${who}: ${bold(doorName(doorId))}`);
    const out = await core.requestAccess({ reservationId: reservation.id, prospectId: prospect.id, doorId });
    const policy = out.decision.allowed ? green(out.decision.code) : red(out.decision.code);
    console.log(`  Policy:     ${policy}  ${dim(`(${out.decision.reason})`)}`);
    if (out.reusedGrant) console.log(`  Door access: ${yellow("NOT ASKED AGAIN")} ${dim("(grant already active, no duplicate)")}`);
    else if (!out.durinCalled) console.log(`  Door access: ${yellow("NOT ASKED")} ${dim("(policy denied first)")}`);
    else console.log(`  Door access: ${out.grant ? green("ACCESS GRANTED") : red("FAILED")}`);
    flush(durinLines);
    flush(textLines);
    return out;
  };

  // 5. Arrival
  section("5. Arrival");
  const slotStart = new Date(reservation.slotStart!);
  await pause("fast-forward to an early arrival");
  clock.set(new Date(slotStart.getTime() - 40 * 60_000));
  await tryDoor("entrance", "Jane shows up 40 minutes early and requests");

  await pause("fast-forward to the tour time");
  clock.set(new Date(slotStart.getTime() - 3 * 60_000));
  step(clock, `Jane texts: ${bold('"I\'m here"')}`);
  await core.recordInbound(prospect.id, reservation.id, "I'm here");
  await tryDoor("entrance");
  await tryDoor("entrance", "Jane's phone retries the same request");

  // 6. Unit
  section("6. Guided to the unit");
  await pause("walk to Unit 101");
  clock.advanceMinutes(2);
  await tryDoor("unit_101");

  // 7. Wrong door
  section("7. A door outside the reserved route");
  await pause("try the Unit 102 door");
  clock.advanceMinutes(12);
  await tryDoor("unit_102", "Jane wanders and requests");

  // 8. Complete
  section("8. Tour complete + follow-up");
  await pause("finish the tour");
  clock.advanceMinutes(20);
  step(clock, "Jane finishes and heads out");
  reservation = await core.completeTour(reservation.id);
  flush(durinLines);
  flush(textLines);
  console.log(`  Status: ${bold(green(reservation.status))}`);

  clock.advanceMinutes(5);
  await tryDoor("entrance", "Jane comes back for her umbrella and requests");

  await finish(core, clock);
}

async function finish(core: TourCore, clock: SimulatedClock): Promise<void> {
  section("Audit trail");
  console.log(formatAudit(await core.auditTrail(), TZ));

  const bundle = await core.exportRecords();
  mkdirSync("exports", { recursive: true });
  writeFileSync("exports/tour-core-export.json", JSON.stringify(bundle, null, 2));
  writeFileSync("exports/audit.csv", auditToCsv(bundle.auditEvents));
  section("Export");
  console.log(`  exports/tour-core-export.json  (schema v${bundle.schemaVersion}, validated, ${bundle.auditEvents.length} audit events)`);
  console.log(`  exports/audit.csv`);
  console.log(dim(`\n  Demo finished at simulated ${formatTime(clock.now())}.`));
}

main()
  .catch((err) => {
    console.error(red(`\nDemo failed: ${err instanceof Error ? err.stack : String(err)}`));
    process.exitCode = 1;
  })
  .finally(() => rl?.close());
