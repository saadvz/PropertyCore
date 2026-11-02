import { FACT_TOPICS } from "../src/setup/factsSheet";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, validateConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { isFairHousingQuestion } from "../src/core/fairHousing";
import { SimulatedClock } from "../src/core/clock";
import { describeHistory } from "../src/audit/describe";
import { teamTextFailedNotice, UNKNOWN_ANSWER } from "../src/core/TourCore";
import { formatVisitorClock, zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore, createVerificationProvider } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { hoursStepSay } from "../src/operator/milestones";
import { FAIR_HOUSING_REFUSAL, listExceptions } from "../src/operator/exceptions";
import { Installation } from "../src/install/installation";
import type { MessagingAdapter, OutgoingMessage } from "../src/messaging/Messenger";
import { bindMessagingInstallation } from "../src/messaging/registry";
import { sendblueRuntime } from "../src/messaging/sendblue/runtime";
import { localSmsOutbox, resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { claimVisitorSms, listVisitorTemplates, matchVisitorTemplate, renderSms, visitorTeamName, visitorTemplatesMarkdown } from "../src/sms/templates";
import { setTourHours, setVerificationPolicy } from "../src/setup/setupActions";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { InMemoryStore } from "../src/storage/Store";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { handleApi } from "../src/web/api";
import { createSetupServer } from "../src/web/server";
import { at, grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, type InstallHarness } from "./installHarness";
import { hillsideConfig, liveApp, PHONE, publishForVisitors } from "./liveApp";
import { PUBLIC } from "./fakeSendblue";
import { basicForm, TOUR_DAY } from "./helpers";

/**
 * Landlord or model prose reaches a visitor only as an approved answer
 * (`approved-answer` / `approved-answer-closing` from answer_flagged_question,
 * later resolve_issue). A no-draft flag never gets a draft. Profile facts
 * the landlord already saved use `approved-profile-fact`.
 */

const HELD = "Good question for the property team. I've passed it along, and they'll text you back here.";
const DOOR_STUCK = "I can't open the doors for you right now. I've let the property team know, and they'll text you here shortly.";
const SNAG = "Sorry, I hit a snag with that. Could you text me again in a few minutes?";
const NOT_SAVED = "(555) 010-1234 asked a question, but I couldn't save it for you to answer. Please text them back. They're waiting.";
const DOOR_ALERT = "Jane Smith is at Entrance, and I couldn't open it for them. Please text them or let them in.";
const FINISH_STEPS = "We're not quite ready to open doors yet. Finish the steps I sent earlier and you'll be all set.";
const SPACING = "Tours every 15 minutes don't leave room for 40-minute visits. Should tours start every 40 minutes, or should visits be shorter?";
const REUSE = "Pick a number of days from 1 to 365.";
const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
const RAW_SLOT = /\{[A-Za-z][A-Za-z0-9]*\??\}/;
const VENDORS = /Twilio|Railway|Grok|Sendblue|Photon/i;

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((run) => run());
  vi.restoreAllMocks();
});

function harness(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

function hostedInstall(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", url: TUNNEL });
  h.connectGrok();
  return h;
}

function recorder(): { sent: OutgoingMessage[]; messenger: MessagingAdapter } {
  const sent: OutgoingMessage[] = [];
  return {
    sent,
    messenger: {
      provider: "demo",
      presentation: "MESSAGING",
      async send(message) {
        sent.push(message);
        return { provider: "demo", channel: "DEMO", status: "SENT", sentAt: new Date().toISOString() };
      },
    },
  };
}

function engine(mode: "basic-form" | "none") {
  const loaded = loadConfig();
  const config: TourCoreConfig = { ...loaded, verificationMode: mode };
  const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
  const store = new InMemoryStore();
  const tape = recorder();
  const durin = new MockDurinAccessAdapter({
    doorNames: Object.fromEntries(config.doors.map((door) => [door.id, door.name])),
    now: () => clock.now(),
  });
  const core = createTourCore(config, { clock, store, messenger: tape.messenger, durin, verification: createVerificationProvider(config) });
  return { config, clock, store, core, sent: tape.sent, messenger: tape.messenger };
}

async function bookJane(ctx: ReturnType<typeof engine>) {
  const started = await ctx.core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
  const slot = (await ctx.core.availableSlots(TOUR_DAY))[0]!;
  await ctx.core.reserveSlot(started.reservation.id, slot.start.toISOString());
  const reservation = await ctx.core.recordConsent(started.reservation.id, true);
  ctx.clock.set(slot.start);
  return { prospect: started.prospect, reservation, slot };
}

function prospectTexts(sent: OutgoingMessage[]): OutgoingMessage[] {
  return sent.filter((message) => message.audience === "PROSPECT");
}

function operatorTexts(sent: OutgoingMessage[]): string[] {
  return sent.filter((message) => message.audience === "OPERATOR").map((message) => message.body);
}

function failEveryAudit(store: InMemoryStore): void {
  store.appendAudit = async () => {
    throw new Error("disk full");
  };
}

function failOperatorSend(ctx: ReturnType<typeof engine>): void {
  ctx.messenger.send = async (message) => {
    ctx.sent.push(message);
    return {
      provider: "demo",
      channel: "DEMO",
      status: message.audience === "OPERATOR" ? "FAILED" : "SENT",
      sentAt: new Date().toISOString(),
      ...(message.audience === "OPERATOR" ? { error: { code: "SENDBLUE_DOWN", message: "Sendblue rejected the text" } } : {}),
    };
  };
}

function captureErrors(): string[] {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return errors;
}

describe("visitor template registry", () => {
  it("lists every template in the checked-in catalog", () => {
    const catalog = readFileSync(new URL("../docs/visitor-templates.md", import.meta.url), "utf8");
    expect(catalog).toBe(visitorTemplatesMarkdown());
    const messages = listVisitorTemplates().filter((template) => !template.suffix);
    expect(catalog).toContain(`${messages.length} message templates.`);
    expect(messages.length).toBeGreaterThan(40);
    for (const template of listVisitorTemplates()) {
      expect(catalog).toContain(`### ${template.id}`);
      expect(template.text).not.toMatch(VENDORS);
    }
  });

  it("round-trips every fixed template and refuses an unlisted visitor text", () => {
    for (const template of listVisitorTemplates()) {
      if (template.explicitOnly || template.suffix) continue;
      const slots = Object.fromEntries(
        [...template.text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\??\}/g)].map((match) => [
          match[1]!,
          match[1] === "rest" ? "Text me anytime to book another." : `«${match[1]}»`,
        ]),
      );
      const rendered = renderSms(template.id, slots);
      expect(rendered.body).not.toMatch(RAW_SLOT);
      expect(matchVisitorTemplate(rendered.body), template.id).toBe(template.id);
      expect(claimVisitorSms(rendered.body)).toBe(template.id);
    }
    expect(() => claimVisitorSms("This sentence is not a visitor template.")).toThrow(/not in the template registry/);
    expect(claimVisitorSms("The landlord wrote this.", "approved-answer")).toBe("approved-answer");
    expect(claimVisitorSms("Unit 1A has 2 bedrooms.", "approved-profile-fact")).toBe("approved-profile-fact");
  });

  it("uses a team name in visitor texts only when it ends in team", () => {
    expect(visitorTeamName("Acme Realty")).toBe("property team");
    expect(visitorTeamName("leasing team")).toBe("leasing team");
    expect(visitorTeamName("")).toBe("property team");
    expect(visitorTeamName("   ")).toBe("property team");
    const acme = visitorTeamName("Acme Realty");
    const leasing = visitorTeamName("leasing team");
    const blank = visitorTeamName("");
    expect(renderSms("fair-housing-held", { team: acme }).body).toBe("Good question for the property team. I've passed it along, and they'll text you back here.");
    expect(renderSms("door-stuck-no-steps", { team: blank }).body).toBe("I can't open the doors for you right now. I've let the property team know, and they'll text you here shortly.");
    expect(renderSms("operator-scheduled", { team: leasing, address: "144 Hillside Avenue", time: "3:15 PM", day: "Monday" }).body).toBe(
      "Hi, this is the leasing team at 144 Hillside Avenue. We set up a tour for you at 3:15 PM on Monday. Reply YES to confirm, NO to cancel, or STOP to opt out.",
    );
    for (const day of ["today", "tomorrow", "Friday, Oct 9"]) {
      expect(renderSms("cancel-confirm", { time: "3 PM", day }).body).toBe(`Cancel your 3 PM tour on ${day}? Reply YES or NO.`);
    }
  });
});

describe("fair-housing safe reply", () => {
  it("matches neighborhood composition and leaves an innocent kids question alone", () => {
    expect(isFairHousingQuestion("are there many families with kids nearby?")).toBe(true);
    expect(isFairHousingQuestion("is there room for my kids' bikes?")).toBe(false);
    expect(isFairHousingQuestion("Do you rent to families with kids?")).toBe(true);
  });

  it("sends the held reply only after a real detector match is flagged no-draft", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    const replies = await a.text("Do you rent to families with kids?");
    expect(replies[0]).toBe(HELD);
    expect(replies.join("\n")).toContain("Which day works for you?");
    expect(replies.join("\n")).not.toMatch(/fair housing|Fair Housing|discriminat/i);
    const flags = (await a.grok("list_exceptions")).exceptions as Array<{ exceptionId: string; summary: string; proposeDraft?: boolean }>;
    expect(flags).toHaveLength(1);
    expect(flags[0]!.proposeDraft).toBe(false);
    expect(flags[0]!.summary).toContain("Do you rent to families with kids?");
    await expect(a.grok("answer_flagged_question", { exceptionId: flags[0]!.exceptionId, approvedFact: "Yes, families are welcome." })).rejects.toThrow(FAIR_HOUSING_REFUSAL);
  });

  it("sends the held reply for each neighborhood-composition question, one no-draft flag each", async () => {
    const phrases = [
      "are there many families with kids nearby?",
      "what kind of people live in the building?",
      "is the neighborhood safe?",
      "are there a lot of Hispanic families around here?",
      "who lives nearby?",
      "what's the crime rate like?",
    ];
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    for (const phrase of phrases) {
      const replies = await a.text(phrase);
      expect(replies[0], phrase).toBe(HELD);
      expect(replies.join("\n"), phrase).toContain("Which day works for you?");
      expect(replies.join("\n")).not.toMatch(/fair housing|Fair Housing|discriminat/i);
    }
    const flags = (await a.grok("list_exceptions")).exceptions as Array<{ summary: string; proposeDraft?: boolean }>;
    expect(flags).toHaveLength(phrases.length);
    for (const phrase of phrases) {
      const flag = flags.find((item) => item.summary.includes(phrase));
      expect(flag, phrase).toBeTruthy();
      expect(flag!.proposeDraft).toBe(false);
    }
  });

  it("keeps an ordinary flag for kids' bikes", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    const replies = await a.text("is there room for my kids' bikes?");
    expect(replies[0]).toBe(UNKNOWN_ANSWER);
    expect(replies.join("\n")).not.toContain(HELD);
    const flags = (await a.grok("list_exceptions")).exceptions as Array<{ summary: string; proposeDraft?: boolean }>;
    expect(flags).toHaveLength(1);
    expect(flags[0]!.proposeDraft).toBeUndefined();
    expect(flags[0]!.summary).toContain("is there room for my kids' bikes?");
  });

  it("does not send the held reply when the flag cannot be saved", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const ctx = engine("basic-form");
    const append = ctx.store.appendAudit.bind(ctx.store);
    ctx.store.appendAudit = async (event) => {
      if (event.type === "QUESTION_UNANSWERED" && event.code === "FAIR_HOUSING") throw new Error("disk full");
      return append(event);
    };
    await ctx.core.answerPropertyQuestion({ phone: "5550101234", question: "Do you rent to families with kids?" });
    const visitors = prospectTexts(ctx.sent).map((message) => message.body);
    expect(visitors).toEqual([DOOR_STUCK]);
    expect(visitors.join("\n")).not.toContain(HELD);
    expect(prospectTexts(ctx.sent)[0]!.templateId).toBe("door-stuck-no-steps");
    expect(operatorTexts(ctx.sent)).toEqual([NOT_SAVED]);
    expect(ctx.sent.findIndex((message) => message.audience === "OPERATOR")).toBeLessThan(ctx.sent.findIndex((message) => message.body === DOOR_STUCK));
    expect(errors.join("\n")).toContain("Visitor question was not forwarded");
    expect((await ctx.store.listAudit()).some((event) => event.code === "FAIR_HOUSING")).toBe(false);
  });

  it("still texts the team and the stuck line when every audit write fails", async () => {
    const errors = captureErrors();
    const ctx = engine("basic-form");
    failEveryAudit(ctx.store);
    await ctx.core.answerPropertyQuestion({ phone: "5550101234", question: "Do you rent to families with kids?" });
    expect(operatorTexts(ctx.sent)).toEqual([NOT_SAVED]);
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([DOOR_STUCK]);
    expect(ctx.sent.findIndex((message) => message.audience === "OPERATOR")).toBeLessThan(ctx.sent.findIndex((message) => message.body === DOOR_STUCK));
    expect(errors.join("\n")).toContain("Visitor question was not forwarded");
    expect(errors.join("\n")).toContain("Team alert was not recorded");
    expect((await ctx.store.listAudit()).some((event) => event.type === "OPERATOR_NOTIFIED")).toBe(false);
  });

  it("sends the snag line when the team text also fails", async () => {
    captureErrors();
    const ctx = engine("basic-form");
    failEveryAudit(ctx.store);
    failOperatorSend(ctx);
    await ctx.core.answerPropertyQuestion({ phone: "5550101234", question: "Do you rent to families with kids?" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([SNAG]);
    expect(prospectTexts(ctx.sent)[0]!.templateId).toBe("handler-snag-retry");
    expect(ctx.sent.map((message) => message.body).join("\n")).not.toContain(DOOR_STUCK);
    expect(operatorTexts(ctx.sent)).toEqual([NOT_SAVED]);
  });
});

describe("dead-end visitor lines", () => {
  it("keeps the finish-the-steps line only when a form step is left", async () => {
    const ctx = engine("basic-form");
    const booked = await bookJane(ctx);
    if (booked.reservation.status === "AWAITING_VERIFICATION") await ctx.core.submitVerification(booked.reservation.id, basicForm());
    const ready = await ctx.store.get("reservations", booked.reservation.id);
    expect(ready?.status).toBe("READY");
    await ctx.store.put("reservations", { ...ready!, status: "AWAITING_VERIFICATION" });
    ctx.sent.length = 0;
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([FINISH_STEPS]);
    expect(prospectTexts(ctx.sent)[0]!.templateId).toBe("finish-steps");
    expect(operatorTexts(ctx.sent).join("\n")).not.toContain("don't have a step left");
  });

  it("sends the stuck line and a team alert when no step is left", async () => {
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const stored = await ctx.store.get("reservations", booked.reservation.id);
    await ctx.store.put("reservations", { ...stored!, status: "AWAITING_VERIFICATION" });
    ctx.sent.length = 0;
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([DOOR_STUCK]);
    expect(prospectTexts(ctx.sent)[0]!.templateId).toBe("door-stuck-no-steps");
    expect(operatorTexts(ctx.sent)).toEqual([DOOR_ALERT]);
    expect(ctx.sent.findIndex((message) => message.audience === "OPERATOR")).toBeLessThan(ctx.sent.findIndex((message) => message.body === DOOR_STUCK));
  });

  it("texts the team and the stuck line for no step left when every audit write fails", async () => {
    const errors = captureErrors();
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const stored = await ctx.store.get("reservations", booked.reservation.id);
    await ctx.store.put("reservations", { ...stored!, status: "AWAITING_VERIFICATION" });
    ctx.sent.length = 0;
    failEveryAudit(ctx.store);
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(operatorTexts(ctx.sent)).toEqual([DOOR_ALERT]);
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([DOOR_STUCK]);
    expect(errors.join("\n")).toContain("Team alert was not recorded");
    expect((await ctx.store.listAudit()).some((event) => event.type === "OPERATOR_NOTIFIED" && event.detail === DOOR_ALERT)).toBe(false);
  });

  it("records the landlord notice when the team text fails and the visitor is asked to retry", async () => {
    const errors = captureErrors();
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const stored = await ctx.store.get("reservations", booked.reservation.id);
    await ctx.store.put("reservations", { ...stored!, status: "AWAITING_VERIFICATION" });
    ctx.sent.length = 0;
    failOperatorSend(ctx);
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([SNAG]);
    const notice = teamTextFailedNotice("Jane Smith");
    const failed = (await ctx.store.listAudit()).filter((event) => event.type === "MESSAGE_FAILED");
    expect(failed.map((event) => ({ detail: event.detail, code: event.code }))).toEqual([{ detail: notice, code: undefined }]);
    expect(notice).toBe("I couldn't text you about Jane Smith, so I asked them to text me again in a few minutes.");
    expect(errors.join("\n")).toContain("Sendblue rejected the text");
    const bundle = await ctx.core.exportRecords();
    const history = describeHistory(bundle.auditEvents, bundle, ctx.config.property.timezone).map((entry) => entry.text);
    expect(history).toContain(notice);
    expect(history.join("\n")).not.toMatch(/Sendblue|SENDBLUE|rejected/);
    const root = mkdtempSync(join(tmpdir(), "tourcore-team-text-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    ws.save(ctx.config);
    ws.recordVisitorDemo(ctx.config.property.id, {
      schemaVersion: 1,
      tourId: "2026-09-28T14-00-00-000Z_team-text",
      kind: "visitor-demo",
      ranAt: ctx.clock.now().toISOString(),
      updatedAt: ctx.clock.now().toISOString(),
      outcome: "in-progress",
    }, bundle);
    const issues = await listExceptions({ workspace: ws, now: () => ctx.clock.now() });
    const missed = issues.filter((issue) => issue.kind === "message-failed");
    expect(missed.map((issue) => ({ title: issue.title, summary: issue.summary }))).toEqual([
      { title: "A text to you didn't go out", summary: notice },
    ]);
    expect(JSON.stringify(missed)).not.toMatch(/Sendblue|SENDBLUE|rejected/);
  });

  it("sends the snag line for no step left when the team text also fails", async () => {
    captureErrors();
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const stored = await ctx.store.get("reservations", booked.reservation.id);
    await ctx.store.put("reservations", { ...stored!, status: "AWAITING_VERIFICATION" });
    ctx.sent.length = 0;
    failEveryAudit(ctx.store);
    failOperatorSend(ctx);
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([SNAG]);
    expect(ctx.sent.map((message) => message.body).join("\n")).not.toContain(DOOR_STUCK);
    expect(operatorTexts(ctx.sent)).toEqual([DOOR_ALERT]);
  });

  it("sends the stuck line for a stale denial on a no-form property", async () => {
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const verification = await ctx.store.get("verifications", booked.reservation.verificationId!);
    await ctx.store.put("verifications", {
      ...verification!,
      method: "basic-form",
      validUntil: new Date(ctx.clock.now().getTime() - 60_000).toISOString(),
    });
    ctx.sent.length = 0;
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([DOOR_STUCK]);
    expect(prospectTexts(ctx.sent)[0]!.templateId).toBe("door-stuck-no-steps");
    expect(operatorTexts(ctx.sent)).toEqual([DOOR_ALERT]);
  });

  it("texts the team and the stuck line for a stale no-form denial when every audit write fails", async () => {
    captureErrors();
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const verification = await ctx.store.get("verifications", booked.reservation.verificationId!);
    await ctx.store.put("verifications", {
      ...verification!,
      method: "basic-form",
      validUntil: new Date(ctx.clock.now().getTime() - 60_000).toISOString(),
    });
    ctx.sent.length = 0;
    failEveryAudit(ctx.store);
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(operatorTexts(ctx.sent)).toEqual([DOOR_ALERT]);
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([DOOR_STUCK]);
  });

  it("sends the snag line for a stale no-form denial when the team text also fails", async () => {
    captureErrors();
    const ctx = engine("none");
    const booked = await bookJane(ctx);
    const verification = await ctx.store.get("verifications", booked.reservation.verificationId!);
    await ctx.store.put("verifications", {
      ...verification!,
      method: "basic-form",
      validUntil: new Date(ctx.clock.now().getTime() - 60_000).toISOString(),
    });
    ctx.sent.length = 0;
    failEveryAudit(ctx.store);
    failOperatorSend(ctx);
    await ctx.core.requestAccess({ reservationId: booked.reservation.id, prospectId: booked.prospect.id, doorId: "entrance" });
    expect(prospectTexts(ctx.sent).map((message) => message.body)).toEqual([SNAG]);
    expect(ctx.sent.map((message) => message.body).join("\n")).not.toContain(DOOR_STUCK);
  });

  it("replaces the already-open line after the window ends and does not open a door", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    expect((await a.text("I'm here")).join("\n")).toContain("open for you now");
    expect((await a.text("at unit 1a")).join("\n")).toContain("open for you now");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const open = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.accessGrants.length;
    a.clock.t = at(14, 0);
    const during = await a.text("I'm here");
    expect(during.join("\n")).toContain("Every door on your tour is already open for you.");
    a.clock.t = at(14, 45);
    const ended = await a.text("I'm here");
    const windowEnd = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.windowEnd!;
    const time = formatVisitorClock(new Date(windowEnd), "America/New_York");
    expect(time).toBe("2:45 PM");
    expect(ended.join("\n")).toContain(`Your tour time ended at ${time}, so the doors are locked now. Want to come back another time? Just reply with a day that works.`);
    expect(ended.join("\n")).not.toContain("already open");
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.accessGrants).toHaveLength(open);
    const stored = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.messages.filter((message) => message.audience === "PROSPECT" && message.direction === "OUTBOUND");
    expect(stored.some((message) => message.templateId === "tour-window-ended" && message.body.startsWith("Your tour time ended at"))).toBe(true);
  });

  it("alerts the team when a help problem follows the all-doors-open line", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1a");
    a.clock.t = at(14, 0);
    const open = await a.text("I'm here");
    expect(open.join("\n")).toContain("Every door on your tour is already open for you.");
    const help = await a.text("I need help");
    expect(help.join("\n")).toContain("I've let the property team know");
    expect(help.join("\n")).not.toContain("Reply STOP");
    const flagged = (await a.grok("list_exceptions")).exceptions as Array<{ what?: string; summary: string }>;
    expect(flagged.some((item) => /help/i.test(`${item.what ?? ""} ${item.summary}`))).toBe(true);
  });

  it("alerts the team when a help problem follows a tour window that has ended", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1a");
    a.clock.t = at(14, 46);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.status).toBe("TOURING");
    const help = await a.text("I need help");
    expect(help.join("\n")).toContain("I've let the property team know");
    expect(help.join("\n")).not.toContain("Reply STOP");
    const flagged = (await a.grok("list_exceptions")).exceptions as Array<{ what?: string; summary: string }>;
    expect(flagged.some((item) => /help/i.test(`${item.what ?? ""} ${item.summary}`))).toBe(true);
  });

  it("says still booked, not still confirmed, while the identity form is pending", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.text("1");
    const booked = await a.text("YES");
    expect(booked.join("\n")).toMatch(/identity form/i);
    expect(booked.join("\n")).not.toContain("still confirmed");
    const pending = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", pending.tourId)!.bundle.reservations[0]!.status).toBe("AWAITING_VERIFICATION");
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const declined = await a.grok("decline_tour_time_request", { tourTimeRequestId: id });
    expect(declined.summary).toContain("still booked");
    expect(declined.summary).not.toContain("still confirmed");
    const last = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(last).toBe("The property team couldn't approve 3:15 PM on Monday, Sep 28. You're still booked for 2:00 PM on Monday, Sep 28.");
    expect(last).not.toContain("still confirmed");
  });
});

describe("setup step guidance", () => {
  it("asks for unit names, then routes, then save_units for the missing profile", async () => {
    const h = hostedInstall();
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    await h.ok("use_local_demo_storage");
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue, Teaneck, NJ 07666" });
    const id = created.setup.propertyId as string;
    await h.ok("save_property", { property: id, confirmAddress: true, propertyType: "MULTIFAMILY_HOME" });
    const units = await h.ok("get_state", { propertyId: id });
    expect(units.nextStep.tool).toBe("save_units");
    expect(units.nextStep.say).toBe("What are the units called? For example, Unit A and Unit B.");
    expect(units.nextStep.say).not.toMatch(RAW_SLOT);
    await h.ok("save_units", { property: id, units: [{ name: "Unit A" }, { name: "Unit B" }] });
    const routes = await h.ok("get_state", { propertyId: id });
    expect(routes.nextStep.tool).toBe("save_doors_and_routes");
    expect(routes.nextStep.say).not.toBe("");
    await h.ok("save_doors_and_routes", {
      property: id,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [
        { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
        { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
      ],
    });
    const after = await h.ok("get_state", { propertyId: id });
    expect(after.nextStep.tool).toBe("save_units");
    expect(after.nextStep.say).toBe("How many bedrooms do these units have?");
    expect(String(after.nextStep.say)).not.toMatch(RAW_SLOT);
  });

  it("builds the hours line from the hours that are saved", async () => {
    const h = hostedInstall();
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    await h.ok("use_local_demo_storage");
    const created = await h.ok("create_property_setup", { address: "16 Oak Avenue, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    const id = created.setup.propertyId as string;
    await h.ok("save_property", { property: id, confirmAddress: true, skipVisitorHelp: true });
    await h.ok("save_units", { property: id, units: [{ name: "Unit A" }, { name: "Unit B" }] });
    await h.ok("save_doors_and_routes", {
      property: id,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [
        { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
        { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
      ],
    });
    await h.ok("set_unit_details", {
      property: id,
      details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available now.",
    });
    const saved = await h.ok("save_hours", { property: id, days: "every day", start: "4 AM", end: "11 PM" });
    expect(saved.message).toContain("Tours run every day, 4 AM to 11 PM.");
    // An out-of-range reuse day is not a unit issue, so the hours step stays next. The sentence still describes the hours that were saved.
    h.workspace.saveDraft(setVerificationPolicy(h.workspace.openDraft(id).draft, { reuseForDays: 0 }));
    const state = await h.ok("get_state", { propertyId: id });
    expect(state.nextStep.tool).toBe("save_hours");
    expect(state.nextStep.say).toBe("Tours run every day, 4 AM to 11 PM. Want to change that?");
    expect(state.nextStep.say).not.toContain("Weekdays from 9:00 AM to 5:00 PM are already saved.");
  });

  it("offers the saved hours after routes instead of skipping to checks", async () => {
    const h = hostedInstall();
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    await h.ok("use_local_demo_storage");
    const created = await h.ok("create_property_setup", { address: "20 Oak Avenue, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    const id = created.setup.propertyId as string;
    await h.ok("save_property", { property: id, confirmAddress: true, skipVisitorHelp: true });
    await h.ok("save_units", { property: id, units: [{ name: "Unit A" }] });
    await h.ok("save_doors_and_routes", {
      property: id,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [{ unit: "Unit A", doors: ["Front Door", "Unit A Door"] }],
    });
    const profile = await h.ok("get_state", { propertyId: id });
    expect(profile.nextStep.tool).toBe("save_units");
    expect(profile.nextStep.say).toBe("How many bedrooms does Unit A have?");
    await h.ok("set_unit_details", { property: id, details: "Unit A is 1 bed 1 bath for $1,800, available now." });
    const hours = await h.ok("get_state", { propertyId: id });
    expect(hours.nextStep.tool).toBe("save_hours");
    expect(hours.nextStep.say).toBe("Tours run Monday to Friday, 9 AM to 5 PM. Want to change that?");
    expect(hours.currentMilestone).toBe("hours");
    await h.ok("save_hours", { property: id, days: "weekdays", start: "9am", end: "5pm" });
    const afterHours = await h.ok("get_state", { propertyId: id });
    expect(afterHours.nextStep.tool).not.toBe("save_hours");
    // The facts sheet comes after hours, inside the same milestone. Skipping it moves setup on.
    expect(afterHours.nextStep.tool).toBe("save_facts");
    for (const topic of FACT_TOPICS) await h.ok("save_facts", { property: id, topic, skip: true });
    expect((await h.ok("get_state", { propertyId: id })).currentMilestone).not.toBe("hours");
  });

  it("refuses a 5 minute tour length and 5 minute spacing without saving", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "22 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    const before = { ...h.workspace.openDraft(id).draft.tourHours };
    const length = await h.ok("save_hours", { property: id, tourLength: "5 minutes" });
    expect(length.status).toBe("blocked");
    expect(length.message).toBe("Each tour should last between 15 minutes and 4 hours. How long should each tour be?");
    expect(h.workspace.openDraft(id).draft.tourHours).toMatchObject(before);
    const spacing = await h.ok("set_tour_hours", { property: id, newTourEvery: "5 minutes" });
    expect(spacing.status).toBe("blocked");
    expect(spacing.summary).toBe("New tours should start between 15 minutes and 8 hours apart. How often should a new tour start?");
    expect(h.workspace.openDraft(id).draft.tourHours).toMatchObject(before);
  });

  it("refuses tour spacing at save_hours and saves nothing", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "18 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    const before = { ...h.workspace.openDraft(id).draft.tourHours };
    const refused = await h.ok("save_hours", { property: id, newTourEvery: "15 minutes", tourLength: "30 minutes", earlyArrival: "10 minutes" });
    expect(refused.status).toBe("blocked");
    expect(refused.message).toBe(SPACING);
    expect(h.workspace.openDraft(id).draft.tourHours).toMatchObject(before);
    const tool = await h.ok("set_tour_hours", { property: id, newTourEvery: "15 minutes", tourLength: "30 minutes", earlyArrival: "10 minutes" });
    expect(tool.status).toBe("blocked");
    expect(tool.summary).toBe(SPACING);
    expect(h.workspace.openDraft(id).draft.tourHours).toMatchObject(before);
    const overlap = validateConfig(setTourHours(h.workspace.openDraft(id).draft, { slotEveryMinutes: 15, tourLengthMinutes: 30, earlyArrivalMinutes: 10 }));
    expect(overlap.map((issue) => issue.message)).toContain(
      "Tours start every 15 minutes, but each visit (including 10 minutes early) takes 40 minutes, so visitors would overlap. Space tours at least 40 minutes apart.",
    );
  });

  it("reads an existing property back as the saved full address", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "144 hillside ave, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const again = await h.ok("create_property_setup", { address: "144 HILLSIDE AVE, Teaneck, NJ 07666" });
    expect(again.status).toBe("already-exists");
    expect(again.summary).toBe("144 Hillside Avenue, Teaneck, NJ 07666 is already set up. I'll keep working on that one.");
    expect(again.summary).not.toContain("hillside ave");
  });

  it("fills the property confirmation and never leaves a raw slot in that line", async () => {
    const h = hostedInstall();
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    await h.ok("use_local_demo_storage");
    const created = await h.ok("create_property_setup", { address: "144 hillside ave, Teaneck, NJ 07666" });
    const id = created.setup.propertyId as string;
    const state = await h.ok("get_state", { propertyId: id });
    expect(state.nextStep.say).toBe("Did I get that right: 144 Hillside Avenue, Teaneck, NJ 07666?");
    expect(String(state.nextStep.say)).not.toMatch(/hillside ave\b/i);
    expect(String(state.nextStep.say)).not.toMatch(RAW_SLOT);
    expect(String(state.playbook.text)).not.toContain("{address}");
  });

  it("ends a saved multi-unit route with a period", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "20 Oak Avenue, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    const id = created.setup.propertyId as string;
    await h.ok("save_units", { property: id, units: [{ name: "Unit A" }, { name: "Unit B" }] });
    const saved = await h.ok("save_doors_and_routes", {
      property: id,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [
        { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
        { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
      ],
    });
    expect(saved.message).toBe("Unit A: Front Door, then Unit A Door. Unit B: Front Door, then Unit B Door.");
  });

  it("rejects reuse days of 0 and 366 and does not save them", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "22 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.verificationValidForDays).toBe(30);
    for (const days of [0, 366]) {
      expect(await h.fails("set_verification_policy", { property: id, reuseForDays: days })).toBe(REUSE);
      const settings = await h.ok("save_settings", { property: id, verification: "basic-form", reuseForDays: days });
      expect(settings.status).toBe("blocked");
      expect(settings.message).toBe(REUSE);
      expect(h.workspace.openDraft(id).draft.verificationValidForDays).toBe(30);
      const api = await handleApi(
        { ...h.services, workspace: h.workspace, dev: true, now: () => new Date(h.now()) },
        "POST",
        `/api/properties/${id}/commands/setVerificationPolicy`,
        { input: { reuseForDays: days } },
      );
      expect(api.status).toBe(400);
      expect("json" in api ? api.json : {}).toMatchObject({ error: { message: REUSE } });
      expect(h.workspace.openDraft(id).draft.verificationValidForDays).toBe(30);
    }
    const policy = await h.ok("get_verification_policy", { property: id });
    expect(String(policy.summary)).not.toMatch(/for 0 days|for 366 days/);
    expect(policy.reuseForDays).toBe(30);
  });

  it("skips the no-form confirmation on the setup page when nothing changes", () => {
    const web = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
    const step = web.slice(web.indexOf("function verificationStep"), web.indexOf("// Records and messages"));
    expect(step).toContain('if (view.verification.mode === "none")');
    expect(step).toContain("go(nextHref(id, \"verification\"))");
    expect(step).toContain("confirmCard.hidden = false");
  });
});

describe("inject_local_sms property pin", () => {
  it("routes a pinned property to that conversation instead of the phone's other one", async () => {
    const app = await startTwoLocalProperties();
    const marker = "zebra question about the mailbox";
    await app.grok("inject_local_sms", { from: "+15555550199", text: "TOUR", property: app.first });
    await app.grok("inject_local_sms", { from: "+15555550199", text: "YES", property: app.first });
    const pinned = await app.grok("inject_local_sms", { from: "+15555550199", text: marker, property: app.second });
    const pinnedBubbles = pinned.bubbles as Array<{ body: string }>;
    expect(pinnedBubbles.map((bubble) => bubble.body).join("\n")).not.toMatch(/aren't available right now/);
    const firstTour = app.ws.listTours(app.first).find((item) => item.kind === "messaging");
    const secondTour = app.ws.listTours(app.second).find((item) => item.kind === "messaging");
    expect(secondTour).toBeTruthy();
    const secondText = app.ws.loadTour(app.second, secondTour!.tourId)!.bundle.messages.map((message) => message.body).join("\n");
    expect(secondText).toContain(marker);
    const firstText = firstTour ? app.ws.loadTour(app.first, firstTour.tourId)!.bundle.messages.map((message) => message.body).join("\n") : "";
    expect(firstText).not.toContain(marker);
    const bubbles = localSmsOutbox().forVisitor("+15555550199");
    const ids = new Set(listVisitorTemplates().map((template) => template.id));
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles.filter((bubble) => !bubble.templateId || !ids.has(bubble.templateId)).map((bubble) => bubble.body)).toEqual([]);
  });
});

async function startTwoLocalProperties() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-phase3-pin-"));
  cleanups.push(resetLocalSmsOutbox());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = Date.parse("2026-09-28T11:00:00.000Z");
  const ws = new PropertyWorkspace(root);
  const firstSaved = ws.save(hillsideConfig());
  const secondConfig: TourCoreConfig = {
    ...hillsideConfig(),
    property: { ...hillsideConfig().property, id: "prop_200_scratch_way", name: "200 Scratch Way", address: "200 Scratch Way, Teaneck, NJ" },
  };
  const secondSaved = ws.save(secondConfig);
  const now = new Date(clock);
  ws.recordReadiness(firstSaved.config.property.id, await runReadinessCheck(firstSaved.config, { now }));
  ws.recordReadiness(secondSaved.config.property.id, await runReadinessCheck(secondSaved.config, { now }));
  publishForVisitors(ws, firstSaved.config.property.id, now);
  publishForVisitors(ws, secondSaved.config.property.id, now);
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const env: NodeJS.ProcessEnv = { TOURCORE_MESSAGING_PROVIDER: "local", PUBLIC_BASE_URL: PUBLIC, TOURCORE_SMS_CONSENT_MODE: "keyword_confirm" };
  cleanups.push(bindMessagingInstallation(() => ({ env, sendblue: sendblueRuntime.env(), choice: "local", manifestProvider: "LOCAL" })));
  const installation = new Installation({ root, runtime, env: () => env, now: () => clock });
  installation.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
  installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
  installation.files.writeState({
    ...installation.files.state(),
    messagingProviderChoice: "local",
    visitorMessaging: { ok: true, at: now.toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "local" },
  });
  installation.files.update({ messagingProvider: "LOCAL" });
  const server = createSetupServer({
    toolSurface: "all", workspace: ws, installation, now: () => now, realNow: () => clock, operatorToken: () => "test-operator-token-abcdef", log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  let rpc = 0;
  const grok = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-operator-token-abcdef" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown>; content: Array<{ text: string }> } };
    if (body.result.isError) throw new Error(body.result.content[0]!.text);
    return body.result.structuredContent;
  };
  await grok("run_readiness_check", { property: firstSaved.config.property.id });
  await grok("run_readiness_check", { property: secondSaved.config.property.id });
  return { grok, ws, first: firstSaved.config.property.id, second: secondSaved.config.property.id };
}
