#!/usr/bin/env node
// Check one step F journey's saved smoke JSON. Pins must already be redacted.
// Exit 1 when the owner-visible result is wrong.

import { readFileSync } from "node:fs";

const journey = process.argv[2];
const paths = process.argv.slice(3);
if (!journey || paths.length === 0) {
  process.stderr.write("Usage: assert-step-f.mjs <journey> <stdout.json>...\n");
  process.exit(1);
}

const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
const COURT = "8 Scratch Court, Teaneck, NJ 07666";
const ANNEX = "9 Scratch Annex, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const OBSERVER = "+15555550122";
const UNAPPROVED = "+15555550199";
const COURT_OWNER = "+15555550110";
const ANNEX_HOST = "+15555550120";
const ANNEX_CLEANER = "+15555550121";
const LANE_Q = `Is checkout at ${LANE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
const COURT_MONDAY = `Is checkout at ${COURT} on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.`;
const OFFER = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const NOTION_OFFER = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM. Reply YES to schedule it, or STOP to opt out.`;
const CONFIRM = `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at ${LANE}.`;
const REMINDER = `Reminder: checkout at ${LANE} is Sunday, Oct 18 at 11:00 AM. Reply STOP to opt out.`;
const CANCEL = `Update: the cleaning at ${LANE} on Sunday, Oct 18 is canceled, so no need to come. Reply STOP to opt out.`;
const STOP_ACK = "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const HOST_STOP = `You're opted out of cleaning texts for ${LANE}. Reply START to get texts again.`;
const EMERGENCY = "If someone is hurt, call 911 now.";
const HOST_HURT = `The cleaner at ${LANE} says someone is hurt. They've been told to call 911.`;
const OBSERVER_HURT = `An observer at ${LANE} says someone is hurt. They've been told to call 911.`;
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const INJURY_HOLD = `The cleaning at ${LANE} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
const MISSING = "I can't read that Notion database. Permission is missing, so I did not sync bookings and I did not send a cleaning text.";
const GROUP = "Group text: ";
const MIRROR = "Copy of the group text: ";
const OFFER_WAIT = "The cleaner will reply to confirm.";
const WAIT_OFFER = OFFER.replace("Reply YES to schedule it, or STOP to opt out.", OFFER_WAIT);
const CLEANER_REMINDER = `Reminder: cleaning at ${LANE} is Sunday, Oct 18 at 11:00 AM.`;
const HOLD = `The cleaning at ${LANE} is waiting for the cleaner to reply YES.`;
const CHECKIN_Q = `Is check-in at ${LANE} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
const PEOPLE_PROMPT = "Who should get texts? Send the cleaner's phone, then each other person's role and phone. Roles are owner, manager, or observer. I won't text anyone until they reply YES.";
const OPT_IN = `Hi, this is Scratch's cleaning scheduler for ${LANE}. Reply YES to get cleaning texts, or STOP to opt out.`;
const ANNEX_OPT = `Hi, this is Annex's cleaning scheduler for ${ANNEX}. Reply YES to get cleaning texts, or STOP to opt out.`;
const PIN = `Guests have left ${LANE}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`;
const PIN_NOTICE = "Door code sent to the cleaner.";
const ACTIVATED = "Activated Annex. I will text only the numbers that opted in. I will not infer consent, a vacancy, or a lock-code change.";
const NOT_ACTIVATED = "Not activated. The cleaner has not opted in, so I did not send a cleaning text.";
const MIRROR_NOTE = "Group texting isn't available on this number, so I mirrored the cleaner texts instead of starting a group.";

const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const blob = paths.map((path) => readFileSync(path, "utf8")).join("\n");
if (blob.includes("4821") || blob.includes("7392") || blob.includes("2468")) fail("a door code leaked into the report");
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

const first = reports[0];
const last = reports[reports.length - 1];

if (journey === "notion-permission-denied") {
  same(first.sync.reason, "permission-denied");
  same(first.sync.fallback, MISSING);
  same(first.sent, []);
  same(first.jobs, []);
  same(first.pinRecipients, []);
} else if (journey === "notion-source-read") {
  same(first.tenant, "scratch-lane");
  same(first.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  same(first.blocks, [{ uid: "notion:row-block", summary: "Owner block", checkInDate: "2026-10-19", checkoutDate: "2026-10-20" }]);
  same(first.jobs.map((job) => ({ id: job.id, checkoutDate: job.checkoutDate, live: job.live })), [
    { id: "notion:row-anita", checkoutDate: "2026-10-18", live: true },
  ]);
  same(first.sync.freshness, [{ kind: "notion", fetchedAt: "2026-10-14T15:00:00.000Z", stale: false }]);
  same(first.sync.provenance, [{ jobId: "notion:row-anita", sources: [{ kind: "notion", uid: "notion:row-anita" }] }]);
  if (blob.includes("10:00")) fail("the Notion clock became the checkout time");
  if (first.jobs.some((job) => job.id === "notion:row-block")) fail("a block became a departure");
} else if (journey === "notion-sync-repeat") {
  same(first.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  same(first.jobs.map((job) => job.id), ["notion:row-anita"]);
  same(last.sent, []);
  same(last.jobs.map((job) => job.id), ["notion:row-anita"]);
  same(last.outbox.filter((item) => item.kind === "host-checkout").length, 1);
} else if (journey === "notion-removed" || journey === "notion-cleaner-routing") {
  const routed = [
    { to: OWNER, kind: "host-checkout", body: LANE_Q },
    { to: CLEANER, kind: "opt-in", body: OPT_IN },
    { to: CLEANER, kind: "offer", body: NOTION_OFFER },
    { to: CLEANER, kind: "confirm", body: CONFIRM },
  ];
  if (journey === "notion-removed") {
    same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
      ...routed,
      { to: CLEANER, kind: "reminder", body: CLEANER_REMINDER },
      { to: CLEANER, kind: "cancel-update", body: CANCEL },
    ]);
    same(first.jobs[0].status, "canceled");
    same(first.jobs[0].live, false);
    same(first.outbox.filter((item) => item.kind === "reminder" && item.status === "sent").length, 1);
    same(first.outbox.filter((item) => item.kind === "cancel-update" && item.status === "sent").length, 1);
  } else {
    same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), routed);
    same(first.jobs[0].status, "confirmed");
  }
  if (first.sent.some((text) => text.to === OWNER && ["offer", "confirm", "reminder", "cancel-update"].includes(text.kind))) {
    fail("a job text went to the host");
  }
  same(first.pinRecipients, []);
} else if (journey === "multi-source-dedupe") {
  same(first.sync.sources, ["guesty-lite", "notion"]);
  same(first.sync.conflicts, []);
  same(first.jobs.map((job) => job.id), ["stay-anita@guesty.com", "stay-same-day@guesty.com", "stay-after-gap@guesty.com"]);
  same(first.sync.provenance[0], {
    jobId: "stay-anita@guesty.com",
    sources: [
      { kind: "guesty-lite", uid: "stay-anita@guesty.com" },
      { kind: "notion", uid: "notion:row-anita" },
    ],
  });
  if (first.jobs.some((job) => String(job.id).startsWith("notion:"))) fail("the shared booking became a second job");
  same(first.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
} else if (journey === "onboarding-full") {
  same(first.setup.activated, true);
  same(first.setup.tenantId, "annex");
  same(first.setup.sealed, true);
  same(first.setup.prompt, ACTIVATED);
  if (!first.setup.prompts.some((line) => line.startsWith("Preview for Annex: 1 stay, 1 block."))) fail("the preview was not shown");
  if (!first.setup.prompts.includes(PEOPLE_PROMPT)) fail("the people prompt changed");
  if (first.setup.prompts.some((line) => line.includes("Cory is an observer"))) fail("the people prompt still names Cory");
  if (!first.setup.prompts.some((line) => line.includes("This demo cannot rotate, revoke, or control the lock."))) fail("the lock limit was not explained");
  if (!first.setup.prompts.some((line) => line.includes("Old texts are not consent."))) fail("old texts were treated as consent");
  same(first.sent, [
    { to: ANNEX_CLEANER, body: ANNEX_OPT, kind: "opt-in" },
    { to: OBSERVER, body: ANNEX_OPT, kind: "opt-in" },
  ]);
  if (blob.includes(OWNER) || blob.includes(LANE) || blob.includes(COURT)) fail("the new tenant saw another house");
} else if (journey === "onboarding-no-optin") {
  same(first.setup.activated, false);
  same(first.setup.prompt, NOT_ACTIVATED);
  same(first.sent.map((text) => text.kind), ["opt-in", "opt-in"]);
  if (first.sent.some((text) => ["offer", "pin", "reminder", "host-checkout", "confirm"].includes(text.kind))) fail("a cleaning text was sent");
} else if (journey === "group-native-consented") {
  same(first.messaging, { requested: "group", actual: "native", excluded: [], note: "This is a group text." });
  same(first.sent.filter((text) => text.kind === "offer"), [
    { to: CLEANER, body: OFFER, kind: "offer" },
    { to: OWNER, body: `${GROUP}${WAIT_OFFER}`, kind: "offer", channel: "group" },
    { to: OBSERVER, body: `${GROUP}${WAIT_OFFER}`, kind: "offer", channel: "group" },
  ]);
  if (first.sent.some((text) => text.to !== CLEANER && text.kind === "offer" && text.body.includes("Reply YES"))) {
    fail("a group copy asked someone else to reply YES");
  }
  same(first.pinRecipients, []);
} else if (journey === "group-mirrored-fallback") {
  same(first.messaging.actual, "mirrored");
  same(first.messaging.note, MIRROR_NOTE);
  same(first.sent.filter((text) => text.kind === "offer"), [
    { to: CLEANER, body: OFFER, kind: "offer" },
    { to: OWNER, body: `${MIRROR}${WAIT_OFFER}`, kind: "offer", channel: "mirror" },
    { to: OBSERVER, body: `${MIRROR}${WAIT_OFFER}`, kind: "offer", channel: "mirror" },
  ]);
  if (blob.includes("Mirrored copy, not a group reply:")) fail("the old mirror prefix is still in use");
} else if (journey === "group-unconsented-participant") {
  const held = reports.length > 1 ? reports[0] : last;
  same(held.messaging, {
    requested: "group",
    actual: "mirrored",
    excluded: [OBSERVER],
    note: `I left ${OBSERVER} out because that number has not opted in.`,
  });
  if (held.sent.some((text) => text.to === OBSERVER && text.kind === "offer")) fail("the unconsented observer got the offer");
  if (held.sent.filter((text) => text.kind === "offer").some((text) => text.channel === "group")) {
    fail("the group started while a participant had not opted in");
  }
  same(last.sent.filter((text) => text.to === OBSERVER).map((text) => text.kind), ["opt-in", "stop"]);
  same(last.sent.filter((text) => text.to === OBSERVER && text.kind === "stop"), [{ to: OBSERVER, body: STOP_ACK, kind: "stop" }]);
  if (last.sent.some((text) => text.kind === "help")) fail("HELP sent a reply");
  if (last.sent.some((text) => text.to === OBSERVER && text.kind === "offer")) fail("the unconsented observer got the offer");
  if (last.sent.filter((text) => text.kind === "offer").some((text) => text.channel === "group")) {
    fail("the group started while a participant had not opted in");
  }
} else if (journey === "pin-private-only") {
  same(first.pinRecipients, [CLEANER]);
  same(first.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN, kind: "pin" }]);
  same(first.sent.filter((text) => text.kind === "pin-notice"), [{ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" }]);
  if (first.sent.some((text) => text.to === UNAPPROVED || text.to === OBSERVER && text.kind === "pin")) fail("the code left the cleaner");
  if (first.sent.some((text) => (text.channel === "group" || text.channel === "mirror") && (text.body.includes("Door code") || text.body.includes("[redacted]")))) {
    fail("a group or mirror carried the door code");
  }
  if (first.sent.some((text) => text.to === OBSERVER && text.kind === "pin-notice")) fail("the observer got the door-code notice");
} else if (journey === "tenant-isolation") {
  const lane = reports[0];
  const court = reports[1];
  const onboard = reports[2];
  const laneLeft = reports[3];
  same(lane.sent, [{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  same(lane.jobs.map((job) => job.id), ["notion:row-anita"]);
  same(court.sent, [{ to: COURT_OWNER, body: COURT_MONDAY, kind: "host-checkout" }]);
  same(court.jobs.map((job) => job.id), ["notion:row-court"]);
  same(court.property, COURT);
  same(onboard.setup.activated, true);
  same(onboard.setup.tenantId, "annex");
  same(onboard.sent.map((text) => text.to), [ANNEX_CLEANER, OBSERVER]);
  same(laneLeft.sent, []);
  same(laneLeft.jobs.map((job) => job.id), ["notion:row-anita"]);
  if (JSON.stringify(lane.sent).includes(COURT_OWNER) || JSON.stringify(court.sent).includes(OWNER)) fail("a house texted the other house");
  if (JSON.stringify(onboard.sent).includes(OWNER) || JSON.stringify(onboard.sent).includes(COURT_OWNER)) fail("onboarding texted an existing house");
} else if (journey === "group-no-optin") {
  same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
    { to: OWNER, kind: "host-checkout", body: LANE_Q },
    { to: OWNER, kind: "host-checkin", body: CHECKIN_Q },
    { to: OWNER, kind: "held", body: HOLD },
  ]);
  const anita = first.jobs.find((job) => job.id === "stay-anita@guesty.com");
  same(anita?.status, "host_confirmed");
  if (first.sent.some((text) => text.kind === "offer" || text.kind === "confirm" || text.to === CLEANER)) {
    fail("a job was offered or confirmed without an opted-in cleaner");
  }
  if (blob.includes("Mirrored copy") || blob.includes("Copy of the group text:") || blob.includes("Group text:")) {
    fail("a group or mirror copy went out with no opted-in cleaner");
  }
} else if (journey === "observer-injury-solo" || journey === "observer-injury-group") {
  const head = journey === "observer-injury-group"
    ? [
        { to: OWNER, kind: "host-checkout", body: LANE_Q },
        { to: CLEANER, kind: "opt-in", body: OPT_IN },
        { to: OBSERVER, kind: "opt-in", body: OPT_IN },
      ]
    : [{ to: OWNER, kind: "host-checkout", body: LANE_Q }];
  same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
    ...head,
    { to: OWNER, kind: "emergency", body: OBSERVER_HURT },
    { to: OWNER, kind: "emergency", body: INJURY_HOLD },
    { to: OBSERVER, kind: "emergency", body: CLEANER_HURT },
  ]);
  if (first.sent.some((text) => text.kind === "emergency" && text.channel)) fail("the injury reply was a group or mirror text");
  if (first.sent.filter((text) => text.kind === "emergency").length !== 3) fail("the injury reply was repeated or the host was not alerted");
  if (journey === "observer-injury-group") same(first.messaging?.actual, "native");
} else if (journey === "injury-wording") {
  const told = { to: null, kind: "emergency", body: CLEANER_HURT };
  const pair = (alert, phone) => [
    { to: OWNER, kind: "emergency", body: alert },
    { to: OWNER, kind: "emergency", body: INJURY_HOLD },
    { ...told, to: phone },
  ];
  for (const report of reports) {
    const grouped = report.messaging?.actual === "native";
    const head = grouped
      ? [
          { to: OWNER, kind: "host-checkout", body: LANE_Q },
          { to: CLEANER, kind: "opt-in", body: OPT_IN },
          { to: OBSERVER, kind: "opt-in", body: OPT_IN },
        ]
      : [{ to: OWNER, kind: "host-checkout", body: LANE_Q }];
    same(report.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
      ...head,
      ...pair(HOST_HURT, CLEANER),
      ...pair(OBSERVER_HURT, OBSERVER),
    ]);
    if (report.sent.some((text) => text.kind === "emergency" && text.channel)) fail("the injury reply was a group or mirror text");
    if (report.sent.filter((text) => text.kind === "emergency").length !== 6) fail("an injury wording did not alert the host and reply once to each sender");
  }
} else if (journey === "owner-injury") {
  same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
    { to: OWNER, kind: "host-checkout", body: LANE_Q },
    { to: OWNER, kind: "emergency", body: EMERGENCY },
  ]);
  if (first.sent.some((text) => text.body.includes("says someone is hurt") || text.body.includes("I've let the host know"))) {
    fail("the host was alerted about their own injury report");
  }
} else if (journey === "stop-help-injury") {
  const stop = reports[0];
  const help = reports[1];
  const injury = reports[2];
  same(stop.sent, [
    { to: OWNER, body: LANE_Q, kind: "host-checkout" },
    { to: OWNER, body: HOST_STOP, kind: "stop" },
  ]);
  same(stop.jobs[0].textsBlocked, true);
  same(help.sent, [
    { to: OWNER, body: LANE_Q, kind: "host-checkout" },
  ]);
  if (help.sent.some((text) => text.kind === "help")) fail("HELP sent a reply");
  same(injury.sent, [
    { to: OWNER, body: LANE_Q, kind: "host-checkout" },
    { to: OWNER, body: EMERGENCY, kind: "emergency" },
    { to: OWNER, body: HOST_HURT, kind: "emergency" },
    { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
    { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
  ]);
  if (injury.sent.filter((text) => text.body === EMERGENCY).length !== 1) fail("the injury reply was repeated");
} else {
  fail(`unknown journey ${journey}`);
}

if (journey === "group-native-consented" || journey === "pin-private-only") {
  if (first.sent.some((text) => text.kind === "pin" && text.channel)) fail("the door code was labeled as a group or mirror");
}

void OPT_IN;
