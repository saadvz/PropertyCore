#!/usr/bin/env node
// Check one step E journey's saved smoke JSON. Pins must already be redacted.
// Exit 1 when the owner-visible result is wrong.

import { readFileSync } from "node:fs";

const journey = process.argv[2];
const paths = process.argv.slice(3);
if (!journey || paths.length === 0) {
  process.stderr.write("Usage: assert-step-e.mjs <journey> <stdout.json>...\n");
  process.exit(1);
}

const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
const COURT = "8 Scratch Court, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const COURT_OWNER = "+15555550110";
const COURT_CLEANER = "+15555550111";
const LANE_Q = `Is checkout at ${LANE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
const COURT_MONDAY = `Is checkout at ${COURT} on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.`;
const COURT_WEDNESDAY = `Is checkout at ${COURT} on Wednesday, Oct 21 still 11:00 AM? Reply YES or send the new time.`;
const COURT_CANCEL = `Update: the cleaning at ${COURT} on Monday, Oct 19 is canceled, so no need to come. Reply STOP to opt out.`;
const LANE_OPT = `Hi, this is Scratch's cleaning scheduler for ${LANE}. Reply YES to get cleaning texts, or STOP to opt out.`;
const COURT_OPT = `Hi, this is Scratch's cleaning scheduler for ${COURT}. Reply YES to get cleaning texts, or STOP to opt out.`;
const LANE_CHECKIN = `Is check-in at ${LANE} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
const LANE_OFFER = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const LANE_CONFIRM = `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at ${LANE}.`;
const COURT_OFFER = `Turnover at ${COURT} on Monday, Oct 19. Checkout 11:00 AM. Reply YES to schedule it, or STOP to opt out.`;
const COURT_CONFIRM = `Cleaning is scheduled for Monday, Oct 19 at 11:00 AM at ${COURT}.`;
const LANE_PIN = `Guests have left ${LANE}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`;
const COURT_PIN = `Guests have left ${COURT}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`;
const PIN_NOTICE = "Door code sent to the cleaner.";

const reportPaths = journey === "tenant-isolation" ? paths.slice(0, -1) : paths;
const storePath = journey === "tenant-isolation" ? paths[paths.length - 1] : "";
const reports = reportPaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const blob = paths.map((path) => readFileSync(path, "utf8")).join("\n");
if (blob.includes("4821") || blob.includes("7392")) fail("a door code leaked into the report");
if (/\bready\b/i.test(blob)) fail("a text or status says ready");

function fail(reason) {
  process.stderr.write(`${journey}: ${reason}\n`);
  process.exit(1);
}

function same(actual, expected) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) fail(`expected ${right} but got ${left}`);
}

function recipients(report) {
  return (report.sent ?? []).map((text) => text.to);
}

const first = reports[0];
const last = reports[reports.length - 1];

if (journey === "source-read") {
  same(first.tenant, "scratch-lane");
  same(first.property, LANE);
  same(first.sync, { reason: "read", conversation: "closed", sources: ["google-calendar"], conflicts: [] });
  same(first.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  same(first.jobs.map((job) => ({ id: job.id, checkoutDate: job.checkoutDate, live: job.live })), [
    { id: "google:evt-anita", checkoutDate: "2026-10-18", live: true },
  ]);
  if ((first.transcript ?? []).some((line) => String(line).startsWith("+1"))) fail("a closed read recorded an inbound text");
  if (blob.includes("10:00")) fail("the event clock became the checkout time");
  if (blob.includes(COURT_OWNER) || blob.includes(COURT)) fail("Scratch Court leaked into the lane read");
} else if (journey === "closed-sync") {
  same(first.tenant, "scratch-court");
  same(first.sync.conversation, "closed");
  same(first.sync.sources, ["google-calendar"]);
  same(first.sent, [
    { to: COURT_OWNER, body: COURT_MONDAY, kind: "host-checkout" },
    { to: COURT_OWNER, body: COURT_WEDNESDAY, kind: "host-checkout" },
  ]);
  same(first.jobs.map((job) => ({ id: job.id, checkoutDate: job.checkoutDate, status: job.status, live: job.live })), [
    { id: "google:evt-court", checkoutDate: "2026-10-21", status: "discovered", live: true },
  ]);
  if ((first.transcript ?? []).some((line) => String(line).startsWith("+1"))) fail("the closed sync consumed a reply");
  same(last.sent, []);
  same(last.sync.conversation, "closed");
  same(last.jobs.map((job) => job.id), ["google:evt-court"]);
  same(last.jobs[0].checkoutDate, "2026-10-21");
} else if (journey === "removed") {
  same(first.sent, [
    { to: COURT_OWNER, body: COURT_MONDAY, kind: "host-checkout" },
    { to: COURT_OWNER, body: COURT_CANCEL, kind: "cancel-update" },
  ]);
  same(first.jobs.map((job) => ({ id: job.id, status: job.status, live: job.live })), [
    { id: "google:evt-court", status: "canceled", live: false },
  ]);
  same(first.sync.conversation, "closed");
} else if (journey === "one-job") {
  same(first.property, LANE);
  same(first.sync.sources, ["guesty-lite", "google-calendar"]);
  same(first.sync.conflicts, [{ jobId: "stay-anita@guesty.com", checkoutDate: "2026-10-18", otherCheckoutDate: "2026-10-19" }]);
  same(first.jobs.map((job) => job.id), ["stay-anita@guesty.com", "stay-same-day@guesty.com", "stay-after-gap@guesty.com"]);
  same(first.jobs.filter((job) => job.checkoutDate === "2026-10-18").map((job) => job.id), ["stay-anita@guesty.com"]);
  if (first.jobs.some((job) => String(job.id).startsWith("google:"))) fail("the shared booking became a second job");
  same(first.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  same(recipients(first), [OWNER]);
} else if (journey === "block") {
  same(first.blocks, [{ uid: "google:evt-block", summary: "Owner block", checkInDate: "2026-10-18", checkoutDate: "2026-10-19" }]);
  same(first.jobs.map((job) => ({ id: job.id, checkoutDate: job.checkoutDate })), [{ id: "google:evt-stay", checkoutDate: "2026-10-18" }]);
  if (first.jobs.some((job) => job.id === "google:evt-block" || job.checkoutDate === "2026-10-19")) fail("a block became a departure");
  same(first.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
} else if (journey === "wrong-tenant") {
  same(first.sync.reason, "wrong-tenant");
  same(first.sync.conversation, "closed");
  same(first.sent, []);
  same(first.jobs, []);
  same(first.property, LANE);
  if (blob.includes(COURT) || blob.includes(COURT_OWNER)) fail("the refused calendar was applied");
} else if (journey === "tenant-isolation") {
  const lane = reports[0];
  const court = reports[1];
  const laneLeft = reports[2];
  const courtLeft = reports[3];
  if (!lane || !court || !laneLeft || !courtLeft || !storePath) fail("tenant-isolation needs four smoke reports and the shared store");
  same(lane.tenant, "scratch-lane");
  same(court.tenant, "scratch-court");
  same(lane.property, LANE);
  same(court.property, COURT);
  for (const report of [lane, laneLeft]) {
    if (recipients(report).some((to) => to !== OWNER && to !== CLEANER)) fail(`lane texted ${recipients(report).join(",")}`);
  }
  for (const report of [court, courtLeft]) {
    if (recipients(report).some((to) => to !== COURT_OWNER && to !== COURT_CLEANER)) fail(`court texted ${recipients(report).join(",")}`);
  }
  same(lane.sent, [
    { to: OWNER, body: LANE_Q, kind: "host-checkout" },
    { to: CLEANER, body: LANE_OPT, kind: "opt-in" },
    { to: OWNER, body: LANE_CHECKIN, kind: "host-checkin" },
    { to: CLEANER, body: LANE_OFFER, kind: "offer" },
    { to: CLEANER, body: LANE_CONFIRM, kind: "confirm" },
  ]);
  same(court.sent, [
    { to: COURT_OWNER, body: COURT_MONDAY, kind: "host-checkout" },
    { to: COURT_CLEANER, body: COURT_OPT, kind: "opt-in" },
    { to: COURT_CLEANER, body: COURT_OFFER, kind: "offer" },
    { to: COURT_CLEANER, body: COURT_CONFIRM, kind: "confirm" },
  ]);
  same(lane.jobs.map((job) => ({ id: job.id, status: job.status })), [
    { id: "stay-anita@guesty.com", status: "confirmed" },
    { id: "stay-same-day@guesty.com", status: "discovered" },
    { id: "stay-after-gap@guesty.com", status: "discovered" },
  ]);
  same(court.jobs.map((job) => ({ id: job.id, status: job.status })), [{ id: "google:evt-court", status: "confirmed" }]);
  if (!lane.transcript.includes(`${COURT_CLEANER}: YES`) || !lane.transcript.includes(`${COURT_OWNER}: guests have left`)) {
    fail("the other tenant's reply was dropped from the lane transcript");
  }
  if (!court.transcript.includes(`${CLEANER}: YES`) || !court.transcript.includes(`${OWNER}: guests have left`)) {
    fail("the other tenant's reply was dropped from the court transcript");
  }
  if (lane.transcript.includes(COURT) || court.transcript.includes(LANE)) fail("an address crossed tenants");
  same(lane.pinRecipients, []);
  same(court.pinRecipients, []);
  same(laneLeft.pinRecipients, [CLEANER]);
  same(courtLeft.pinRecipients, [COURT_CLEANER]);
  same(laneLeft.sent, [
    { to: CLEANER, body: LANE_PIN, kind: "pin" },
    { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
  ]);
  same(courtLeft.sent, [
    { to: COURT_CLEANER, body: COURT_PIN, kind: "pin" },
    { to: COURT_OWNER, body: PIN_NOTICE, kind: "pin-notice" },
  ]);
  same(laneLeft.jobs.map((job) => ({ id: job.id, status: job.status })), [
    { id: "stay-anita@guesty.com", status: "cleared" },
    { id: "stay-same-day@guesty.com", status: "discovered" },
    { id: "stay-after-gap@guesty.com", status: "discovered" },
  ]);
  same(courtLeft.jobs.map((job) => ({ id: job.id, status: job.status })), [{ id: "google:evt-court", status: "cleared" }]);
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  const laneSlice = store.tenants?.["scratch-lane"];
  const courtSlice = store.tenants?.["scratch-court"];
  if (!laneSlice || !courtSlice) fail("the shared store dropped a tenant");
  const lanePins = (laneSlice.outbox ?? []).filter((item) => item.kind === "pin" && item.status === "sent");
  const courtPins = (courtSlice.outbox ?? []).filter((item) => item.kind === "pin" && item.status === "sent");
  same(lanePins.map((item) => ({ to: item.to, body: item.body })), [{ to: CLEANER, body: LANE_PIN }]);
  same(courtPins.map((item) => ({ to: item.to, body: item.body })), [{ to: COURT_CLEANER, body: COURT_PIN }]);
  const laneTo = new Set((laneSlice.outbox ?? []).map((item) => item.to));
  const courtTo = new Set((courtSlice.outbox ?? []).map((item) => item.to));
  for (const phone of [COURT_OWNER, COURT_CLEANER, "+15555550119"]) {
    if (laneTo.has(phone)) fail("Scratch Lane's outbox texted Scratch Court");
  }
  for (const phone of [OWNER, CLEANER, "+15555550199"]) {
    if (courtTo.has(phone)) fail("Scratch Court's outbox texted Scratch Lane");
  }
} else {
  fail(`unknown journey ${journey}`);
}
