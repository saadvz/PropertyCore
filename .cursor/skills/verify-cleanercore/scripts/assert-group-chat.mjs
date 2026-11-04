#!/usr/bin/env node
// Assert one group-chat smoke stdout. Digits stay out of this file.

import { readFileSync } from "node:fs";

const [journey, actualPath] = process.argv.slice(2);
if (!journey || !actualPath) {
  process.stderr.write("Usage: assert-group-chat.mjs <journey> <stdout>\n");
  process.exit(1);
}

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const EXTRA = "+15555550122";
const HOLD = `The cleaning at ${ADDRESS} is on hold until the cleaner replies YES.`;
const STOP_HOLD = `The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
const HOST_RESTART = new Set([
  STOP_HOLD,
  `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`,
  `The cleaning at ${ADDRESS} is on hold because you opted out of texts. Tell your Grok Bot to restart it.`,
  `You'll get cleaning texts for ${ADDRESS} again. The cleaning is still on hold. Tell your Grok Bot to restart it.`,
  "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.",
  "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.",
]);
const RESUME = `The cleaning at ${ADDRESS} is back on.`;
/** The automatic time reply Cleaner Core no longer sends. Grok reads a time and tells Cory. */
const REMOVED_TIME_REPLY = "Cory will confirm that time.";
const PRIVATE_LINE = "Maria got the door code privately.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`;
const READY = `The cleaner marked the cleaning at ${ADDRESS} done.`;
/** With only Cory and Maria in the group, the offer and the door code go into the group, addressed to Maria. */
const GROUP_OFFER = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Maria, reply YES to schedule it.`;
/** The group's first text carries the intro, then the offer, in one post, so the two can't arrive out of order. */
const INTRO = `Hi Cory and Maria! This is the cleaning group for ${ADDRESS}. I'm Cory's cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.`;
const OFFER_BODIES = new Set([GROUP_OFFER, `${INTRO}\n\n${GROUP_OFFER}`]);
const GROUP_PIN = `Guests have left ${ADDRESS}. Door code: [redacted]. Maria, reply DONE when the cleaning is finished.`;
const PAIR = JSON.stringify([OWNER, CLEANER]);
const HURT = "If someone is hurt, call 911 now. I've let the host know.";
const HOST_HURT = `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
const INJURY_HOLD = `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;

const report = JSON.parse(readFileSync(actualPath, "utf8"));
const sent = report.sent ?? [];
const groups = sent.filter((text) => text.channel === "group");
const pins = sent.filter((text) => text.kind === "pin");
const clock = (report.jobs ?? []).find((job) => job.checkoutTime === "11:00 AM");

/** A group post that only Cory and Maria see. */
function toPair(text) {
  return text.channel === "group" && JSON.stringify([...(text.audience ?? [])].sort()) === PAIR;
}

/** The door code may sit only in a group of exactly Cory and Maria. */
function codeOnlyInPair() {
  if (groups.some((text) => (text.body.includes("Door code") || text.body.includes("[redacted]")) && !toPair(text))) fail("code in a wider group");
}

function fail(message) {
  process.stderr.write(`${journey}: ${message}\n`);
  process.exit(1);
}

function scratch(phone) {
  return typeof phone === "string" && /^\+1555\d{7}$/.test(phone);
}

for (const text of sent) {
  if (!scratch(text.to)) fail(`recipient ${text.to}`);
  for (const phone of text.audience ?? []) {
    if (!scratch(phone)) fail(`audience ${phone}`);
  }
  if (/twilio|engine|cleaner_core/i.test(text.body)) fail(`named a setting: ${text.kind}`);
  if (/grok bot/i.test(text.body) && !HOST_RESTART.has(text.body)) fail(`named a setting: ${text.kind}`);
}
for (const text of groups) {
  if (/\byou\b/i.test(text.body)) fail(`group text says you: ${text.body}`);
}
for (const match of JSON.stringify(report).matchAll(/\+1\d{10}/g)) {
  if (!scratch(match[0])) fail(`non-scratch ${match[0]}`);
}

const checks = {
  eligible() {
    if (pins.length !== 1) fail(`pin count ${pins.length}`);
    if (!toPair(pins[0]) || pins[0].to !== CLEANER) fail("pin route");
    if (pins[0].body !== GROUP_PIN) fail("pin body");
    codeOnlyInPair();
    if (!clock || clock.status !== "cleared") fail("job");
  },
  private() {
    if (pins.length !== 1 || pins[0].channel || pins[0].body !== PRIVATE_PIN || pins[0].to !== CLEANER) fail("private pin");
    if (sent.some((text) => text.body === PRIVATE_LINE)) fail("private line was sent");
    if (groups.some((text) => text.body === PRIVATE_LINE)) fail("group saw the private line");
    if (groups.some((text) => text.body.includes("[redacted]"))) fail("group saw the code");
    if (sent.filter((text) => text.to === EXTRA).some((text) => text.body.includes("[redacted]"))) fail("extra saw the code");
  },
  held() {
    if (pins.length !== 0) fail("pin sent");
    if (!groups.some((text) => OFFER_BODIES.has(text.body) && toPair(text))) fail("group offer");
    const stop = sent.findIndex((text) => text.kind === "stop");
    if (stop < 0 || sent.slice(stop + 1).some((text) => text.channel === "group")) fail("group text after STOP");
    if (!sent.some((text) => text.to === OWNER && text.body === STOP_HOLD)) fail("stop hold");
    if (sent.some((text) => text.to === CLEANER && text.body.includes("[redacted]"))) fail("cleaner saw the code");
    if (!clock || clock.status === "cleared" || clock.status === "done") fail("job moved");
  },
  "stop-host"() {
    // A time from the cleaner goes to Grok. Cleaner Core sends no time line, and nothing in the group reaches the host after STOP.
    if (sent.some((text) => text.body === REMOVED_TIME_REPLY)) fail("time reply");
    const stop = sent.findIndex((text) => text.kind === "stop" && text.to === OWNER);
    if (stop < 0) fail("host stop");
    if (sent.slice(stop + 1).some((text) => text.to === OWNER || text.audience?.includes(OWNER))) fail("host still in the audience");
  },
  resume() {
    const notes = sent.filter((text) => text.body === RESUME);
    if (notes.length !== 1 || notes[0].to !== OWNER || notes[0].channel) fail("resume");
    if (sent.some((text) => text.to === CLEANER && text.body === RESUME)) fail("resume went to the cleaner");
    if (sent.some((text) => /opted back in/i.test(text.body))) fail("START opted the cleaner back in");
    if (!sent.some((text) => text.to === OWNER && text.body === STOP_HOLD)) fail("stop hold");
  },
  time() {
    if (!clock || clock.checkoutTime !== "11:00 AM") fail("clock moved");
    const offers = groups.filter((text) => OFFER_BODIES.has(text.body));
    if (offers.length !== 1 || !toPair(offers[0])) fail("group offer");
    if (sent.some((text) => text.body === REMOVED_TIME_REPLY)) fail("time reply");
  },
  injury() {
    const emergency = sent.filter((text) => text.kind === "emergency");
    if (emergency.length !== 3) fail("911 count");
    // Both 911 lines go into the group. The restart note names Grok, so it stays one-to-one with Cory.
    if (emergency[0].body !== HOST_HURT || !toPair(emergency[0])) fail("host 911");
    if (emergency[1].to !== OWNER || emergency[1].body !== INJURY_HOLD || emergency[1].channel) fail("injury hold");
    if (emergency[2].body !== HURT || !toPair(emergency[2])) fail("cleaner 911");
    if (sent.some((text) => text.body === REMOVED_TIME_REPLY)) fail("group handling ran first");
  },
  problem() {
    // Only the host pauses a cleaning, through Grok. A problem text holds nothing and opens no review.
    if (sent.some((text) => text.kind === "review" || text.body === HOLD || text.body.includes("is on hold"))) fail("automatic hold");
    if (pins.length !== 0) fail("pin");
  },
  "before-yes"() {
    if (groups.length !== 0) fail("group text before YES");
    if (pins.length !== 0) fail("pin");
  },
  inert() {
    if (groups.length !== 0) fail("group text without the option");
    if (pins.length !== 1 || pins[0].channel || pins[0].body !== PRIVATE_PIN) fail("old pin");
    if (sent.some((text) => /cleaning group/i.test(text.body))) fail("group invite");
  },
  "done-without-start"() {
    const finished = (report.jobs ?? []).find((job) => job.status === "done");
    if (!finished) fail("not done");
    if (sent.some((text) => text.body === "Got it, cleaning started.")) fail("start");
    if (sent.filter((text) => text.to === CLEANER && text.body === "Thanks, cleaning marked done.").length !== 1) fail("done");
    // Cory's ready line is a group post, not a text to Cory.
    const ready = sent.filter((text) => text.body === READY);
    if (ready.length !== 1 || !toPair(ready[0])) fail("ready line");
    const again = sent.filter((text) => text.body === "This cleaning is already marked done.");
    if (again.length !== 1 || again[0].to !== CLEANER) fail("second done");
    codeOnlyInPair();
  },
  done() {
    const finished = (report.jobs ?? []).find((job) => job.status === "done");
    if (!finished) fail("not done");
    if (!sent.some((text) => text.to === CLEANER && text.body === "Got it, cleaning started.")) fail("start");
    if (!sent.some((text) => text.to === CLEANER && text.body === "Thanks, cleaning marked done.")) fail("done");
    const ready = sent.filter((text) => text.body === READY);
    if (ready.length !== 1 || !toPair(ready[0])) fail("ready line");
    codeOnlyInPair();
  },
  twice() {
    if (pins.length !== 1 || pins[0].body !== GROUP_PIN || !toPair(pins[0])) fail("second pin");
    codeOnlyInPair();
  },
  failed() {
    if (pins.length !== 1 || pins[0].to !== CLEANER || pins[0].body !== GROUP_PIN || !toPair(pins[0])) fail("retry");
    codeOnlyInPair();
  },
};

const check = checks[journey];
if (!check) fail("unknown journey");
check();
