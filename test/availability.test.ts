import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bookedTourCalledOffText,
  cannotCancelRunningOfferLater,
  cannotCancelRunningTour,
  pauseConfirmQuestion,
  pausedPropertyOperatorRefuse,
  pausedPropertyVisitorText,
  pausedUnitOperatorRefuse,
  pausedUnitVisitorText,
  PROPERTY_REMOVED_REFUSE,
  REMOVE_REFUSED_LIVE_TOUR,
  removeConfirmQuestion,
  removeSetupConfirmQuestion,
  removedPropertySummary,
  removedPropertyVisitorText,
  removedSetupSummary,
  resumeConfirmQuestion,
  toursAreBackText,
} from "../src/core/availabilityCopy";
import { persistSession } from "../src/operator/services";
import { formatDay, formatTime } from "../src/core/timezone";
import { formatPhone } from "../src/core/phone";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { createTourCore } from "../src/createTourCore";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { localLoopbackNumber } from "../src/messaging/propertyScope";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor/session";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { smsHelpBody, smsStopAck } from "../src/visitor/smsConsent";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { listWaiters } from "../src/setup/pauseWaiters";
import { availabilityEventsPath, readAvailabilityEvents } from "../src/operator/availability";
import { tourRef } from "../src/operator/tours";
import { at, grokHarness, type GrokHarness } from "./grokHarness";
import { operatorFacingPropertyName, SetupInputError } from "../src/setup/setupActions";
import { bookingRefusal } from "../src/setup/availability";
import { operatorUnitName } from "../src/visitor/identity";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { bookTour, setup } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function app(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

/** Single-family add_unit can persist a valid config. Keep the folder as a draft-only setup. */
function keepAsInProgressSetup(h: GrokHarness, propertyId: string): void {
  if (!h.workspace.has(propertyId)) return;
  const config = h.workspace.load(propertyId).config;
  const dir = join(h.root, "properties", propertyId);
  rmSync(join(dir, "tourcore.config.json"), { force: true });
  rmSync(join(dir, "status.json"), { force: true });
  h.workspace.saveDraft(config);
}

function lastFrom(session: VisitorDemoSession, from: "tourcore" | "visitor" = "tourcore"): string {
  return [...session.conversation].reverse().find((item) => item.from === from)?.text ?? "";
}

async function readyVisitor(h: GrokHarness, propertyId: string, options: { name?: string; phone?: string; unitId?: string } = {}) {
  const v = await h.visitor(propertyId, options);
  const [first, last] = (options.name ?? "Pat Smith").split(" ");
  await v.act("chooseTime", { slotStart: v.slot().toISOString() });
  await v.act("consent", { agree: true });
  await v.act("submitIdentity", { firstName: first, lastName: last, email: "pat@example.com", phone: options.phone ?? "555-010-2000" });
  return v;
}

describe("availability copy", () => {
  it("uses the approved paused-property lines, with and without a visitor help number", () => {
    expect(pausedPropertyVisitorText("100 Alfred Way", "leasing team", "+15550109999")).toBe(
      "Tours at 100 Alfred Way are paused right now. The leasing team will text you when they're back, or call (555) 010-9999.",
    );
    expect(pausedPropertyVisitorText("100 Alfred Way", "leasing team")).toBe(
      "Tours at 100 Alfred Way are paused right now. The leasing team will text you when they're back.",
    );
    expect(pausedPropertyVisitorText("100 Alfred Way", "leasing team")).not.toContain("or call");
  });

  it("uses the approved paused-unit line", () => {
    expect(pausedUnitVisitorText("Unit 101")).toBe("Unit 101 isn't open for tours right now.");
  });

  it("paused-unit visitor text uses the short unit label, or the street line for a single-family home", () => {
    const condo = {
      address: "145 Main St, Hoboken, NJ 07030",
      propertyType: "APARTMENT_OR_CONDO" as const,
      canonicalAddress: { street: "145 Main St" },
    };
    const home = {
      address: "12 Oak St, Teaneck, NJ 07666",
      propertyType: "SINGLE_FAMILY" as const,
      canonicalAddress: { street: "12 Oak St" },
    };
    expect(pausedUnitVisitorText(operatorUnitName(condo, "Unit 4B"))).toBe("Unit 4B isn't open for tours right now.");
    expect(pausedUnitVisitorText(operatorUnitName(condo, "Unit 4B"))).not.toContain("145 Main St");
    expect(pausedUnitVisitorText(operatorUnitName(home, "Main Home"))).toBe("12 Oak St isn't open for tours right now.");
    expect(pausedUnitVisitorText(operatorUnitName(home, "Main Home"))).not.toContain("Main Home");

    const { config } = setup();
    const unit = config.units[0]!;
    const other = config.units[1]!;
    expect(
      bookingRefusal({ propertyId: config.property.id, status: "DRAFT", configHash: "", savedAt: "", pausedUnitIds: [unit.id] }, config, unit.id)?.message,
    ).toBe("Unit 101 isn't open for tours right now.");
    const sfConfig = {
      ...config,
      property: {
        ...config.property,
        propertyType: "SINGLE_FAMILY" as const,
        address: home.address,
        name: home.address,
        canonicalAddress: { ...(config.property.canonicalAddress ?? { street: "12 Oak St", city: "Teaneck", state: "NJ", formatted: home.address }), street: "12 Oak St" },
      },
      units: [
        { ...unit, id: "home", name: "Main Home" },
        { ...other, id: "cottage", name: "Cottage" },
      ],
    };
    expect(
      bookingRefusal({ propertyId: sfConfig.property.id, status: "DRAFT", configHash: "", savedAt: "", pausedUnitIds: ["home"] }, sfConfig, "home")?.message,
    ).toBe("12 Oak St isn't open for tours right now.");
  });

  it("uses the approved remove summaries for a published property and an in-progress setup", () => {
    expect(removedPropertySummary("100 Alfred Way")).toBe("100 Alfred Way has been removed. Its records are kept.");
    expect(removedSetupSummary("1 QA Scratch Lane")).toBe("Removed the setup for 1 QA Scratch Lane.");
  });

  it("uses the approved booked-tour cancel lines", () => {
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: false })).toBe(
      "Sorry, the leasing team had to cancel your 9:00 AM tour on Monday, Sep 28 at 100 Alfred Way. Text me anytime to book another.",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true })).toBe(
      "Sorry, the leasing team had to cancel your 9:00 AM tour on Monday, Sep 28 at 100 Alfred Way. They'll text you when tours are back.",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true, removed: true })).toBe(
      "Sorry, the leasing team had to cancel your 9:00 AM tour on Monday, Sep 28 at 100 Alfred Way. 100 Alfred Way isn't offering tours anymore.",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true, removed: true })).not.toContain(
      "when tours are back",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Thursday, Oct 1", time: "2:00 PM", address: "100 Alfred Way", propertyWide: true, touringNow: true })).toBe(
      "Sorry, the leasing team had to cancel your later tour at 2:00 PM on Thursday, Oct 1. Your tour right now isn't affected. They'll text you when tours are back.",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Thursday, Oct 1", time: "2:00 PM", address: "100 Alfred Way", propertyWide: false, touringNow: true })).toBe(
      "Sorry, the leasing team had to cancel your later tour at 2:00 PM on Thursday, Oct 1. Your tour right now isn't affected. Text me anytime to book another.",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Thursday, Oct 1", time: "2:00 PM", address: "100 Alfred Way", propertyWide: true, touringNow: true })).not.toContain(
      "100 Alfred Way",
    );
    expect(cannotCancelRunningTour()).toBe(
      "You can't cancel the tour you're on, but you're free to wrap up whenever you like. Text me anytime if you want to book another tour.",
    );
    expect(cannotCancelRunningTour()).not.toContain("is still working on the problem");
    expect(cannotCancelRunningTour("leasing team")).toBe(
      "You can't cancel the tour you're on, but you're free to wrap up whenever you like. The leasing team is still working on the problem and will text you here. Text me anytime if you want to book another tour.",
    );
    expect(cannotCancelRunningOfferLater("2:00 PM", "Thursday, Oct 1")).toBe(
      "You can't cancel the tour you're on, but you're free to wrap up whenever you like. Your later tour at 2:00 PM on Thursday, Oct 1 is still booked. Want me to cancel that one instead? Reply YES or NO.",
    );
    expect(cannotCancelRunningOfferLater("2:00 PM", "Thursday, Oct 1")).not.toContain("is still working on the problem");
    expect(cannotCancelRunningOfferLater("2:00 PM", "Thursday, Oct 1", "leasing team")).toBe(
      "You can't cancel the tour you're on, but you're free to wrap up whenever you like. The leasing team is still working on the problem and will text you here. Your later tour at 2:00 PM on Thursday, Oct 1 is still booked. Want me to cancel that one instead? Reply YES or NO.",
    );
  });

  it("uses the approved operator refuse when approving or moving a time on a paused property", () => {
    expect(pausedPropertyOperatorRefuse("100 Alfred Way")).toBe("Tours at 100 Alfred Way are paused. Resume them first.");
    expect(pausedUnitOperatorRefuse("Unit 101")).toBe("Tours of Unit 101 are paused. Resume them first.");
    expect(PROPERTY_REMOVED_REFUSE).toBe("That property has been removed.");
  });

  it("uses the approved operator pause and remove questions", () => {
    expect(pauseConfirmQuestion("100 Alfred Way", 2)).toBe(
      "Pause tours at 100 Alfred Way? New bookings stop now. 2 booked tours: keep them or cancel them with a text? Any tour in progress will finish.",
    );
    expect(pauseConfirmQuestion("100 Alfred Way", 1)).toBe(
      "Pause tours at 100 Alfred Way? New bookings stop now. 1 booked tour: keep them or cancel them with a text? Any tour in progress will finish.",
    );
    expect(pauseConfirmQuestion("100 Alfred Way", 0)).toBe(
      "Pause tours at 100 Alfred Way? New bookings stop now. Any tour in progress will finish. Pause it?",
    );
    expect(removeConfirmQuestion("100 Alfred Way", 2)).toBe(
      "Remove 100 Alfred Way? Tours stop, 2 booked visitors get a cancel text, and it leaves your list. Its records are kept. Remove it?",
    );
    expect(removeConfirmQuestion("100 Alfred Way", 1)).toBe(
      "Remove 100 Alfred Way? Tours stop, 1 booked visitor gets a cancel text, and it leaves your list. Its records are kept. Remove it?",
    );
    expect(removeConfirmQuestion("100 Alfred Way", 0)).toBe(
      "Remove 100 Alfred Way? Tours stop. No one is booked, so no cancel texts go out. It leaves your list. Its records are kept. Remove it?",
    );
    expect(removeSetupConfirmQuestion("QA Scratch Lane")).toBe(
      "Remove the setup for QA Scratch Lane? It isn't published yet, so no visitors are affected, but everything entered for it will be deleted for good.",
    );
    expect(removeSetupConfirmQuestion("QA Scratch Lane")).not.toContain("Its records are kept");
    expect(removeSetupConfirmQuestion("QA Scratch Lane")).not.toContain("Remove it?");
    expect(REMOVE_REFUSED_LIVE_TOUR).toBe("Someone is on a tour right now. Try again after it ends.");
    expect(resumeConfirmQuestion("100 Alfred Way")).toBe("Resume tours at 100 Alfred Way? New bookings can start again. Resume it?");
    expect(resumeConfirmQuestion("100 Alfred Way", 0)).toBe("Resume tours at 100 Alfred Way? New bookings can start again. Resume it?");
    expect(resumeConfirmQuestion("100 Alfred Way", 1)).toBe(
      "Resume tours at 100 Alfred Way? New bookings can start again, and 1 person waiting gets a text that tours are back. Resume it?",
    );
    expect(resumeConfirmQuestion("100 Alfred Way", 2)).toBe(
      "Resume tours at 100 Alfred Way? New bookings can start again, and 2 people waiting get a text that tours are back. Resume it?",
    );
  });

  it("uses the approved tours-are-back and removed-property lines", () => {
    expect(toursAreBackText("100 Alfred Way")).toBe("Tours at 100 Alfred Way are back. Text me anytime to book.");
    expect(removedPropertyVisitorText("100 Alfred Way")).toBe("100 Alfred Way isn't offering tours anymore.");
    expect(removedPropertyVisitorText("100 Alfred Way", "+15550109999")).toBe(
      "100 Alfred Way isn't offering tours anymore. Questions? Call (555) 010-9999.",
    );
    expect(removedPropertyVisitorText("100 Alfred Way")).not.toContain("Questions?");
  });

  it("never says archive in visitor or operator copy", () => {
    const lines = [
      pausedPropertyVisitorText("100 Alfred Way", "leasing team", "+15550109999"),
      pausedPropertyVisitorText("100 Alfred Way", "leasing team"),
      pausedUnitVisitorText("Unit 101"),
      bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true }),
      bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: false }),
      bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true, removed: true }),
      pausedPropertyOperatorRefuse("100 Alfred Way"),
      pausedUnitOperatorRefuse("Unit 101"),
      PROPERTY_REMOVED_REFUSE,
      pauseConfirmQuestion("100 Alfred Way", 2),
      pauseConfirmQuestion("100 Alfred Way", 0),
      removeConfirmQuestion("100 Alfred Way", 2),
      removeConfirmQuestion("100 Alfred Way", 1),
      removeConfirmQuestion("100 Alfred Way", 0),
      REMOVE_REFUSED_LIVE_TOUR,
      resumeConfirmQuestion("100 Alfred Way"),
      resumeConfirmQuestion("100 Alfred Way", 1),
      resumeConfirmQuestion("100 Alfred Way", 2),
      toursAreBackText("100 Alfred Way"),
      removedPropertyVisitorText("100 Alfred Way"),
      removedPropertyVisitorText("100 Alfred Way", "+15550109999"),
    ];
    for (const line of lines) expect(line.toLowerCase()).not.toContain("archive");
  });
});

describe("pause and remove", () => {
  it("asks the approved pause question, then stops new bookings", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.summary).toBe(pauseConfirmQuestion(config.property.name, 0));
    await h.ok("pause_tours", { property: id, confirmationCode: asked.confirmation.code });

    const listed = await h.ok("list_properties");
    expect(listed.properties[0].paused).toBe(true);
    const setup = (await h.ok("get_property_setup", { property: id })).setup;
    expect(setup.paused).toBe(true);
    expect(setup.removed).toBe(false);

    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
  });

  it("texts the paused-property line with a visitor help number when one is set", async () => {
    const h = app();
    const id = await h.publish();
    await h.ok("update_property_details", { property: id, visitorContact: "555-010-9999" });
    const { asked } = await h.approve("pause_tours", { property: id });
    expect(asked.summary).toBe(pauseConfirmQuestion(h.workspace.load(id).config.property.name, 0));
    const { config } = h.workspace.load(id);
    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toBe(
      pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact),
    );
    expect(lastFrom(session)).toContain(`or call ${formatPhone(config.operator.visitorContact!)}`);
  });

  it("tells a visitor the unit is paused and offers the other open units", async () => {
    const h = app();
    const id = await h.publish();
    await h.approve("pause_tours", { property: id, unit: "Unit 101" });
    const { config } = h.workspace.load(id);
    const units = (await h.ok("list_units", { property: id })).units as Array<{ name: string; paused?: boolean }>;
    expect(units.find((unit) => unit.name === "Unit 101")?.paused).toBe(true);
    expect(units.find((unit) => unit.name === "Unit 102")?.paused).toBe(false);

    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toContain("Which unit would you like to see?");
    expect(lastFrom(session)).not.toContain("Unit 101 isn't open");
    await session.act("chooseUnit", { unitId: "unit_101" });
    expect(lastFrom(session).split("\n")[0]).toBe(pausedUnitVisitorText("Unit 101"));
    expect(lastFrom(session)).toContain("Which unit would you like to see?");
    expect(session.conversation.some((item) => item.from === "tourcore" && item.text.includes("archive"))).toBe(false);
  });

  it("treats every unit paused as a paused property", async () => {
    const h = app();
    const id = await h.publish();
    await h.approve("pause_tours", { property: id, unit: "Unit 101" });
    await h.approve("pause_tours", { property: id, unit: "Unit 102" });
    const { config } = h.workspace.load(id);
    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
  });

  it("refuses booking on every path while a property is paused", async () => {
    const h = app();
    const id = await h.publish();
    const booked = await readyVisitor(h, id, { phone: "(555) 010-2001" });
    const start = (await booked.session.reservation())!.slotStart!;
    const inquiry = await h.visitor(id, { name: "Jamie Lee", phone: "(555) 010-2003" });
    await h.approve("pause_tours", { property: id, bookedTours: "keep" });

    const { config } = h.workspace.load(id);
    const fresh = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await fresh.act("begin", { name: "Alex Reed", phone: "(555) 010-2002" });
    expect(lastFrom(fresh)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
    await expect(fresh.core.startInquiry({ name: "Alex Reed", phone: "(555) 010-2002", unitId: "unit_101" })).rejects.toMatchObject({ code: "TOURS_PAUSED" });

    await expect(inquiry.session.core.reserveSlot((await inquiry.session.reservation())!.id, inquiry.slot().toISOString())).rejects.toMatchObject({
      code: "TOURS_PAUSED",
    });
    await expect(inquiry.session.core.bookCustomSlot((await inquiry.session.reservation())!.id, inquiry.slot().toISOString())).rejects.toMatchObject({
      code: "TOURS_PAUSED",
    });
    await expect(
      inquiry.session.core.createTourTimeRequest({
        prospectId: inquiry.session.prospectId!,
        reservationId: inquiry.session.reservationId,
        unitId: "unit_101",
        requestedStartsAt: inquiry.slot().toISOString(),
        requestSource: "VISITOR",
      }),
    ).rejects.toMatchObject({ code: "TOURS_PAUSED" });

    const later = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
    await expect(booked.session.core.rescheduleReservation({ reservationId: booked.session.reservationId!, newStartsAt: later, customTime: true })).rejects.toMatchObject({
      code: "TOURS_PAUSED",
    });
  });

  it("refuses approve_tour_time_request and reschedule_tour on a paused property", async () => {
    const h = app();
    const id = await h.publish();
    const booked = await readyVisitor(h, id, { phone: "(555) 010-2001" });
    const start = new Date((await booked.session.reservation())!.slotStart!);
    const later = new Date(start.getTime() + 60 * 60_000);
    await booked.session.requestCustomTime(later);
    await persistSession(h.services, booked.session);
    const listed = await h.ok("list_tour_time_requests");
    const requestId = listed.requests[0].tourTimeRequestId as string;
    await h.approve("pause_tours", { property: id, bookedTours: "keep" });

    const name = h.workspace.load(id).config.property.name;
    const refuse = pausedPropertyOperatorRefuse(name);
    const before = lastFrom(booked.session);
    expect(await h.fails("approve_tour_time_request", { tourTimeRequestId: requestId })).toBe(refuse);
    expect(await h.fails("reschedule_tour", { visitor: "Pat", newStartsAt: "3:15 PM today" })).toBe(refuse);
    expect((await booked.session.reservation())!.slotStart).toBe(start.toISOString());
    expect((await booked.session.reservation())!.status).toBe("READY");
    expect(lastFrom(booked.session)).toBe(before);
    expect(lastFrom(booked.session)).not.toContain("when tours are back");
    expect(JSON.stringify(booked.session.conversation)).not.toMatch(/approve_tour_time_request|reschedule_tour/);
  });

  it("keeps booked tours when asked, and cancels them with the approved text when asked", async () => {
    const h = app();
    const id = await h.publish();
    const kept = await readyVisitor(h, id, { name: "Pat Smith", phone: "(555) 010-2001" });
    const askedKeep = await h.ok("pause_tours", { property: id });
    expect(askedKeep.summary).toBe(pauseConfirmQuestion(h.workspace.load(id).config.property.name, 1));
    await h.ok("pause_tours", { property: id, bookedTours: "keep", confirmationCode: askedKeep.confirmation.code });
    expect((await kept.session.reservation())!.status).toBe("READY");
    expect(kept.session.conversation.map((item) => item.text).join("\n")).not.toContain("had to cancel your");

    await h.approve("resume_tours", { property: id });
    const cancelled = await readyVisitor(h, id, { name: "Alex Reed", phone: "(555) 010-2002" });
    const reservation = (await cancelled.session.reservation())!;
    const { config } = h.workspace.load(id);
    const askedCancel = await h.ok("pause_tours", { property: id });
    await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: askedCancel.confirmation.code });
    expect((await cancelled.session.reservation())!.status).toBe("CANCELLED");
    expect(lastFrom(cancelled.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(new Date(reservation.slotStart!), config.property.timezone),
        time: formatTime(new Date(reservation.slotStart!), config.property.timezone),
        address: config.property.address,
        propertyWide: true,
      }),
    );
  });

  it("lets an in-progress tour finish while the property is paused", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    expect((await v.session.reservation())!.status).toBe("TOURING");
    await h.approve("pause_tours", { property: id, bookedTours: "cancel" });
    expect((await v.session.reservation())!.status).toBe("TOURING");
    await v.act("finish");
    expect((await v.session.reservation())!.status).toBe("COMPLETED");
  });

  it("resumes bookings after a pause", async () => {
    const h = app();
    const id = await h.publish();
    const asked = await h.ok("pause_tours", { property: id });
    await h.ok("pause_tours", { property: id, confirmationCode: asked.confirmation.code });
    const resumeAsked = await h.ok("resume_tours", { property: id });
    expect(resumeAsked.summary).toBe(resumeConfirmQuestion(h.workspace.load(id).config.property.name, 0));
    await h.ok("resume_tours", { property: id, confirmationCode: resumeAsked.confirmation.code });
    const v = await readyVisitor(h, id);
    expect((await v.session.reservation())!.status).toBe("READY");
    expect((await h.ok("list_properties")).properties[0].paused).toBe(false);
  });

  it("removes an in-progress setup that list_properties shows, including units, doors, and routes", async () => {
    const h = app();
    const created = await h.ok("create_property_setup", {
      address: "1 QA Scratch Lane, Tenafly, NJ 07670",
      name: "QA Scratch Lane",
      propertyType: "APARTMENT_BUILDING",
    });
    await h.ok("add_unit", { name: "Unit 1A" });
    await h.ok("add_door", { name: "Lobby", kind: "entrance" });
    const listed = await h.ok("list_properties");
    expect(listed.properties).toEqual([
      expect.objectContaining({
        propertyId: created.setup.propertyId,
        name: "QA Scratch Lane",
        status: "Setup in progress",
      }),
    ]);
    expect(h.workspace.has(created.setup.propertyId)).toBe(false);
    expect(h.workspace.loadDraft(created.setup.propertyId)?.units.length).toBeGreaterThan(0);
    expect(h.workspace.loadDraft(created.setup.propertyId)?.doors.length).toBeGreaterThan(0);

    const asked = await h.ok("remove_property", { property: listed.properties[0].name });
    expect(asked.summary).toBe(removeSetupConfirmQuestion("QA Scratch Lane"));
    expect(asked.summary).not.toMatch(/Tours stop|booked visitors/);
    const done = await h.ok("remove_property", { property: listed.properties[0].name, confirmationCode: asked.confirmation.code });
    expect(done.summary).toBe(removedSetupSummary("QA Scratch Lane"));
    expect((await h.ok("list_properties")).properties).toEqual([]);
    expect(h.workspace.propertyIds()).not.toContain(created.setup.propertyId);
    expect(existsSync(join(h.root, "properties", created.setup.propertyId))).toBe(false);
    expect(await h.fails("get_property_setup", { property: "QA Scratch Lane" })).toMatch(/I couldn't find/);
  });

  it("finds an in-progress setup by address the same way list_properties does", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "27 Oak Ln, Teaneck, NJ 07666" });
    const listed = await h.ok("list_properties");
    expect(listed.properties[0].status).toBe("Setup in progress");
    const { asked, done } = await h.approve("remove_property", { property: listed.properties[0].address });
    expect(listed.properties[0].name).toBe("27 Oak Lane");
    expect(asked.summary).toBe(removeSetupConfirmQuestion("27 Oak Lane"));
    expect(done.summary).toBe(removedSetupSummary("27 Oak Lane"));
    expect((await h.ok("list_properties")).properties).toEqual([]);
  });

  it("releases a local test number claimed by an in-progress setup", async () => {
    const h = app();
    const created = await h.ok("create_property_setup", { address: "1 QA Scratch Lane, Tenafly, NJ 07670", name: "QA Scratch Lane" });
    const id = created.setup.propertyId as string;
    await h.ok("set_services", { property: id, messaging: "local" });
    const endpoints = new MessagingEndpoints(new MemoryRuntimeStore());
    const line = localLoopbackNumber();
    h.services.endpoints = endpoints;
    endpoints.attach({ address: line, provider: "local", propertyId: id });
    expect(endpoints.resolve(line)?.propertyId).toBe(id);

    await h.approve("remove_property", { property: id });
    expect(endpoints.resolve(line)).toBeUndefined();
    expect(endpoints.forProperty(id)).toBeUndefined();

    const next = await h.ok("create_property_setup", { address: "27 Oak Ln, Teaneck, NJ 07666" });
    expect(endpoints.attach({ address: line, provider: "local", propertyId: next.setup.propertyId })).toEqual({ changed: true });
    expect(endpoints.resolve(line)?.propertyId).toBe(next.setup.propertyId);
  });

  it("names an in-progress setup by the operator-given name or street plus unit, never Main Home", async () => {
    expect(
      operatorFacingPropertyName({
        property: { address: "27 Oak Ln, Teaneck, NJ 07666", name: "Main Home", propertyType: "SINGLE_FAMILY" },
        units: [{ name: "Main Home" }],
      }),
    ).toBe("27 Oak Ln");
    expect(
      operatorFacingPropertyName({
        property: { address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO", canonicalAddress: { street: "145 Main St" } },
        units: [{ name: "Unit 4B" }],
      }),
    ).toBe("145 Main St, Unit 4B");
    expect(
      operatorFacingPropertyName({
        property: { address: "500 QA Condo Ave, Tenafly, NJ 07670", propertyType: "APARTMENT_OR_CONDO", canonicalAddress: { street: "500 QA Condo Ave" } },
        units: [{ name: "Unit Loft" }, { name: "Unit 4B" }],
      }),
    ).toBe("500 QA Condo Ave");

    const home = app();
    await home.ok("create_property_setup", { address: "27 Oak Ln, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    expect((await home.ok("add_unit", {})).unit.name).toBe("Main Home");
    const homeId = home.workspace.propertyIds()[0]!;
    keepAsInProgressSetup(home, homeId);
    expect(home.workspace.has(homeId)).toBe(false);
    expect((await home.ok("list_properties")).properties[0].status).toBe("Setup in progress");
    const homeName = operatorFacingPropertyName(home.workspace.openDraft(homeId).draft);
    expect(homeName).not.toMatch(/Main Home/i);
    const removedHome = await home.approve("remove_property", { property: homeId });
    expect(removedHome.asked.summary).toBe(removeSetupConfirmQuestion(homeName));
    expect(removedHome.done.summary).toBe(removedSetupSummary(homeName));
    expect(removedHome.asked.summary).not.toContain("Main Home");
    expect(removedHome.done.summary).not.toContain("Main Home");

    const condo = app();
    await condo.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" });
    await condo.ok("add_unit", { name: "4B" });
    const listed = await condo.ok("list_properties");
    expect(listed.properties[0].status).toBe("Setup in progress");
    const { asked, done } = await condo.approve("remove_property", { property: listed.properties[0].propertyId });
    expect(asked.summary).toBe(removeSetupConfirmQuestion("145 Main Street, Unit 4B"));
    expect(asked.summary).not.toContain("Main Home");
    expect(done.summary).toBe(removedSetupSummary("145 Main Street, Unit 4B"));
    expect(done.summary).not.toContain("Main Home");
  });

  it("names a two-unit in-progress condo by the street alone", async () => {
    const h = app();
    const created = await h.ok("create_property_setup", {
      address: "500 QA Condo Ave, Tenafly, NJ 07670",
      propertyType: "APARTMENT_OR_CONDO",
    });
    const id = created.setup.propertyId as string;
    const draft = h.workspace.openDraft(id).draft;
    h.workspace.saveDraft({
      ...draft,
      units: [
        { id: "unit_loft", name: "Unit Loft", doorId: "", summary: "", facts: [] },
        { id: "unit_4b", name: "Unit 4B", doorId: "", summary: "", facts: [] },
      ],
    });
    expect(h.workspace.has(id)).toBe(false);
    expect(operatorFacingPropertyName(h.workspace.openDraft(id).draft)).toBe("500 QA Condo Avenue");
    const { asked, done } = await h.approve("remove_property", { property: id });
    expect(asked.summary).toBe(removeSetupConfirmQuestion("500 QA Condo Avenue"));
    expect(asked.summary).not.toMatch(/Loft|4B/);
    expect(done.summary).toBe(removedSetupSummary("500 QA Condo Avenue"));
    expect(done.summary).not.toMatch(/Loft|4B/);
  });

  it("uses draft wording for a complete unpublished setup, and names a fresh draft by the street line", async () => {
    const complete = app();
    const created = await complete.ok("create_property_setup", {
      address: "12 Oak St, Teaneck, NJ 07666",
      propertyType: "SINGLE_FAMILY",
    });
    const id = created.setup.propertyId as string;
    expect((await complete.ok("add_unit", {})).unit.name).toBe("Main Home");
    expect(complete.workspace.has(id)).toBe(true);
    expect(complete.workspace.load(id).state.status).toBe("DRAFT");
    expect((await complete.ok("list_properties")).properties[0].status).not.toMatch(/Published/);
    const asked = await complete.ok("remove_property", { property: id });
    expect(asked.summary).toBe(removeSetupConfirmQuestion("12 Oak Street"));
    expect(asked.summary).not.toMatch(/Tours stop|booked visitor|Its records are kept/);
    expect(asked.summary).not.toContain("Main Home");
    const done = await complete.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });
    expect(done.summary).toBe(removedSetupSummary("12 Oak Street"));
    expect(done.summary).not.toContain("Main Home");
    expect((await complete.ok("list_properties")).properties).toEqual([]);
    expect(complete.workspace.has(id)).toBe(false);
    expect(existsSync(join(complete.root, "properties", id))).toBe(false);

    const fresh = app();
    await fresh.ok("create_property_setup", { address: "8 Pine Rd, Tenafly, NJ 07670" });
    expect(operatorFacingPropertyName(fresh.workspace.openDraft(fresh.workspace.propertyIds()[0]!).draft)).toBe("8 Pine Road");
    expect((await fresh.ok("list_properties")).properties[0].name).toBe("8 Pine Road");
    const { asked: freshAsked, done: freshDone } = await fresh.approve("remove_property", {});
    expect(freshAsked.summary).toBe(removeSetupConfirmQuestion("8 Pine Road"));
    expect(freshAsked.summary).not.toContain("Tenafly");
    expect(freshAsked.summary).not.toContain("Main Home");
    expect(freshDone.summary).toBe(removedSetupSummary("8 Pine Road"));
  });

  it("a complete unpublished setup that ran a practice tour still uses draft wording and is deleted", async () => {
    const wording = app();
    const created = await wording.ok("create_property_setup", {
      address: "12 Oak St, Teaneck, NJ 07666",
      propertyType: "SINGLE_FAMILY",
    });
    const id = created.setup.propertyId as string;
    await wording.ok("add_unit", {});
    await wording.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await wording.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await wording.ok("set_verification_policy", { level: "basic-form" });
    await wording.ok("update_property_details", { skipVisitorHelp: true });
    expect((await wording.ok("run_readiness_check")).passed).toBe(true);
    expect((await wording.ok("run_dry_tour")).passed).toBe(true);
    expect(wording.workspace.load(id).state.status).toBe("DRAFT");
    expect(wording.workspace.load(id).state.publishedAt).toBeUndefined();
    expect(wording.workspace.load(id).state.dryTour?.tourId).toBeTruthy();
    expect(wording.workspace.listTours(id).some((tour) => tour.kind === "practice")).toBe(true);
    expect(wording.workspace.hasTourOrReservationRecords(id)).toBe(false);
    expect(wording.workspace.wasEverPublished(id)).toBe(false);
    const asked = await wording.ok("remove_property", { property: id });
    expect(asked.summary).toBe(
      "Remove the setup for 12 Oak Street? It isn't published yet, so no visitors are affected, but everything entered for it will be deleted for good.",
    );
    expect(asked.summary).toBe(removeSetupConfirmQuestion("12 Oak Street"));
    expect(asked.summary).not.toMatch(/Tours stop|Its records are kept/);
    const done = await wording.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });
    expect(done.summary).toBe(removedSetupSummary("12 Oak Street"));
    expect(wording.workspace.has(id)).toBe(false);
    expect(existsSync(join(wording.root, "properties", id))).toBe(false);

    const direct = app();
    await direct.ok("create_property_setup", { address: "14 Oak St, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const directId = direct.workspace.propertyIds()[0]!;
    await direct.ok("add_unit", {});
    await direct.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await direct.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await direct.ok("set_verification_policy", { level: "basic-form" });
    await direct.ok("update_property_details", { skipVisitorHelp: true });
    expect((await direct.ok("run_readiness_check")).passed).toBe(true);
    expect((await direct.ok("run_dry_tour")).passed).toBe(true);
    expect(direct.workspace.hasTourOrReservationRecords(directId)).toBe(false);
    expect(() => direct.workspace.removeInProgressSetup(directId)).not.toThrow();
    expect(direct.workspace.has(directId)).toBe(false);
    expect(existsSync(join(direct.root, "properties", directId))).toBe(false);
  });

  it("legacy draft with a booked tour but no publishedAt keeps records and cancels the visitor", async () => {
    const h = app();
    const id = await h.publish();
    const v = await readyVisitor(h, id);
    const reservation = (await v.session.reservation())!;
    h.workspace.patchState(id, { status: "DRAFT", publishedAt: undefined });
    expect(h.workspace.load(id).state.publishedAt).toBeUndefined();
    expect(h.workspace.load(id).state.status).toBe("DRAFT");
    expect(h.workspace.hasTourOrReservationRecords(id)).toBe(true);

    const name = operatorFacingPropertyName(h.workspace.load(id).config);
    const asked = await h.ok("remove_property", { property: id });
    expect(asked.summary).toBe(removeConfirmQuestion(name, 1));
    expect(asked.summary).toContain("1 booked visitor gets");
    expect(asked.summary).not.toMatch(/isn't published yet/);
    const done = await h.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });
    expect(done.summary).toBe(removedPropertySummary(name));
    expect(h.workspace.has(id)).toBe(true);
    expect(h.workspace.load(id).state.removedAt).toBeTruthy();
    expect(existsSync(join(h.root, "properties", id, "tourcore.config.json"))).toBe(true);
    expect((await v.session.reservation())!.status).toBe("CANCELLED");
    const { config } = h.workspace.load(id);
    expect(lastFrom(v.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(new Date(reservation.slotStart!), config.property.timezone),
        time: formatTime(new Date(reservation.slotStart!), config.property.timezone),
        address: config.property.address,
        propertyWide: true,
        removed: true,
      }),
    );
  });

  it("legacy draft with only a publish audit event keeps records", async () => {
    const h = app();
    const created = await h.ok("create_property_setup", { address: "12 Oak St, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    await h.ok("add_unit", {});
    expect(h.workspace.has(id)).toBe(true);
    expect(h.workspace.load(id).state.publishedAt).toBeUndefined();
    expect(h.workspace.listTours(id)).toEqual([]);
    writeJsonAtomic(availabilityEventsPath(h.root, id), {
      schemaVersion: 1,
      events: [{ id: "aud_legacy_publish", seq: 1, type: "PROPERTY_PUBLISHED", at: new Date(h.now()).toISOString(), detail: "published for demo" }],
    });
    expect(h.workspace.wasEverPublished(id)).toBe(true);

    const asked = await h.ok("remove_property", { property: id });
    expect(asked.summary).toBe(removeConfirmQuestion("12 Oak Street", 0));
    expect(asked.summary).toContain("No one is booked, so no cancel texts go out.");
    expect(asked.summary).not.toMatch(/isn't published yet/);
    const done = await h.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });
    expect(done.summary).toBe(removedPropertySummary("12 Oak Street"));
    expect(h.workspace.has(id)).toBe(true);
    expect(h.workspace.load(id).state.removedAt).toBeTruthy();
    expect(existsSync(join(h.root, "properties", id))).toBe(true);
  });

  it("removeInProgressSetup refuses when visitor tour records exist", async () => {
    const h = app();
    const id = await h.publish();
    await readyVisitor(h, id);
    h.workspace.patchState(id, { status: "DRAFT", publishedAt: undefined });
    expect(h.workspace.load(id).state.status).toBe("DRAFT");
    expect(h.workspace.hasTourOrReservationRecords(id)).toBe(true);
    expect(() => h.workspace.removeInProgressSetup(id)).toThrow(new SetupInputError("PROPERTY_PUBLISHED", "That property is already published."));
    expect(h.workspace.has(id)).toBe(true);
    expect(existsSync(join(h.root, "properties", id, "tourcore.config.json"))).toBe(true);
  });

  it("published confirmation uses singular gets for one booked visitor and no-cancel copy for zero", async () => {
    const empty = app();
    const emptyId = await empty.publish();
    const emptyName = operatorFacingPropertyName(empty.workspace.load(emptyId).config);
    const emptyAsked = await empty.ok("remove_property", { property: emptyId });
    expect(emptyAsked.summary).toBe(removeConfirmQuestion(emptyName, 0));
    expect(emptyAsked.summary).toContain("No one is booked, so no cancel texts go out.");
    expect(emptyAsked.summary).not.toMatch(/0 booked|booked visitors get/);

    const one = app();
    const oneId = await one.publish();
    await readyVisitor(one, oneId);
    const oneName = operatorFacingPropertyName(one.workspace.load(oneId).config);
    const oneAsked = await one.ok("remove_property", { property: oneId });
    expect(oneAsked.summary).toBe(removeConfirmQuestion(oneName, 1));
    expect(oneAsked.summary).toContain("1 booked visitor gets");
    expect(oneAsked.summary).not.toContain("1 booked visitors");
    expect(oneAsked.summary).not.toContain("1 booked visitor get a");
  });

  it("still removes a published property and keeps its records", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    const { asked, done } = await h.approve("remove_property", { property: id });
    expect(asked.summary).toBe(removeConfirmQuestion(config.property.name, 0));
    expect(done.summary).toBe(removedPropertySummary(config.property.name));
    expect((await h.ok("list_properties")).properties).toEqual([]);
    expect(h.workspace.has(id)).toBe(true);
    expect(h.workspace.load(id).state.removedAt).toBeTruthy();
    expect(existsSync(join(h.root, "properties", id, "tourcore.config.json"))).toBe(true);
  });

  it("still says it couldn't find an unknown property", async () => {
    const h = app();
    expect(await h.fails("remove_property", { property: "No Such Place" })).toMatch(/I couldn't find that property|I couldn't find a property called "No Such Place"/);
  });

  it("refuses to remove a property while someone is on a tour", async () => {
    const h = app();
    const id = await h.publish();
    await h.touringVisitor(id);
    expect(await h.fails("remove_property", { property: id })).toBe(REMOVE_REFUSED_LIVE_TOUR);
  });

  it("removes a property: cancels booked tours, texts visitors, revokes pending access, and keeps history", async () => {
    const h = app();
    const id = await h.publish();
    const v = await readyVisitor(h, id);
    const reservation = (await v.session.reservation())!;
    await v.session.store.put("accessGrants", {
      id: "grt_pending",
      reservationId: reservation.id,
      prospectId: reservation.prospectId,
      doorId: reservation.allowedRoute[0]!,
      doorGrantRef: "durin_pending",
      status: "ACTIVE",
      validFrom: reservation.windowStart!,
      validUntil: reservation.windowEnd!,
      createdAt: reservation.createdAt,
    });
    const ref = tourRef(id, v.session.tourId);
    const { config } = h.workspace.load(id);
    const asked = await h.ok("remove_property", { property: id });
    expect(asked.summary).toBe(removeConfirmQuestion(config.property.name, 1));
    await h.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });

    expect((await v.session.reservation())!.status).toBe("CANCELLED");
    expect(lastFrom(v.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(new Date(reservation.slotStart!), config.property.timezone),
        time: formatTime(new Date(reservation.slotStart!), config.property.timezone),
        address: config.property.address,
        propertyWide: true,
        removed: true,
      }),
    );
    expect(lastFrom(v.session)).toContain("isn't offering tours anymore");
    expect(lastFrom(v.session)).not.toContain("when tours are back");
    expect((await v.session.store.get("accessGrants", "grt_pending"))?.status).toBe("REVOKED");
    expect(v.session.durin.revokeCount).toBeGreaterThan(0);
    expect((await h.ok("list_properties")).properties).toEqual([]);
    expect(h.workspace.list().map((saved) => saved.config.property.id)).not.toContain(id);

    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.tourRef).toBe(ref);
    const exported = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    expect(exported.totals.tours).toBeGreaterThan(0);
    const events = readAvailabilityEvents(h.root, id);
    expect(events.some((event) => event.type === "PROPERTY_REMOVED")).toBe(true);
    expect(events.some((event) => event.detail.toLowerCase().includes("archive"))).toBe(false);
    expect(JSON.stringify(v.session.conversation).toLowerCase()).not.toContain("archive");
  });

  async function inboundOn(
    h: GrokHarness,
    id: string,
    from: string,
    text: string,
    sent: string[],
    extras: { now?: () => Date; endpoints?: MessagingEndpoints; consentMode?: "keyword_confirm" | "disabled" } = {},
  ) {
    const endpoints = extras.endpoints ?? h.services.endpoints ?? new MessagingEndpoints(new MemoryRuntimeStore());
    if (!h.services.endpoints) {
      endpoints.attach({ address: "+15550109999", provider: "demo", propertyId: id }, new Date(h.now()));
      h.services.endpoints = endpoints;
    }
    const router = new MessagingConversations({
      workspace: h.workspace,
      registry: h.visitors,
      endpoints,
      transport: () => new DemoMessagingAdapter((line) => sent.push(line), "MESSAGING"),
      links: new VerificationLinks({ baseUrl: () => undefined }),
      realNow: () => h.now(),
      now: extras.now ?? (() => new Date(h.now())),
      ...(extras.consentMode ? { consentMode: () => extras.consentMode! } : {}),
    });
    await router.receive({
      provider: "demo",
      providerMessageId: `msg_${sent.length + 1}`,
      from,
      to: "+15550109999",
      text,
      channel: "SMS",
      receivedAt: new Date(h.now()).toISOString(),
    });
    return router;
  }

  it("texts waiting visitors once on resume, and skips the back text when nobody is waiting", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    await h.approve("pause_tours", { property: id });
    const emptyResume = await h.ok("resume_tours", { property: id });
    expect(emptyResume.summary).toBe(resumeConfirmQuestion(config.property.name, 0));
    await h.ok("resume_tours", { property: id, confirmationCode: emptyResume.confirmation.code });

    await h.approve("pause_tours", { property: id });
    const waiting = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await waiting.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(waiting)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
    expect(listWaiters(h.root, id).map((waiter) => waiter.phone)).toEqual(["+15550102000"]);

    const asked = await h.ok("resume_tours", { property: id });
    expect(asked.summary).toBe(resumeConfirmQuestion(config.property.name, 1));
    await h.ok("resume_tours", { property: id, confirmationCode: asked.confirmation.code });
    expect(lastFrom(waiting)).toBe(toursAreBackText(config.property.address));
    expect(listWaiters(h.root, id)).toEqual([]);
    expect(readAvailabilityEvents(h.root, id).filter((event) => event.type === "TOURS_BACK_NOTIFIED")).toHaveLength(1);

    const booked = await readyVisitor(h, id, { phone: "(555) 010-2044" });
    expect((await booked.session.reservation())!.status).toBe("READY");
  });

  function tenaflyHome(): TourCoreConfig {
    const config = loadConfig();
    return {
      ...config,
      property: {
        ...config.property,
        propertyType: "SINGLE_FAMILY",
        address: "1455 Tenafly Road, Tenafly, NJ 07670",
        displayName: "Tenafly Home",
        name: "Tenafly Home",
      },
      units: [{ ...config.units[0]!, name: "Tenafly Home" }],
    };
  }

  it("after pause then resume, Tour restarts the welcome and day list on a single-family home", async () => {
    const config = tenaflyHome();
    let paused = true;
    const session = new VisitorDemoSession(config.property.id, config, "t", {
      realNow: () => at(7),
      kind: "messaging",
      transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
    });
    session.smsConsentMode = "disabled";
    session.availabilitySource = () => ({
      propertyId: config.property.id,
      status: "PUBLISHED_FOR_DEMO",
      configHash: "test",
      savedAt: new Date(at(7)).toISOString(),
      paused,
    });
    session.rememberPauseWaiter = () => {};

    await handleVisitorText(session, "+15550102000", "Tour");
    expect(lastFrom(session)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
    expect(session.reservationId).toBeUndefined();
    expect(await session.stage()).toBe("choose-unit");

    paused = false;
    await handleVisitorText(session, "+15550102000", "Tour");
    expect(lastFrom(session)).toContain("Hi! Welcome to the self-guided tour for Tenafly Home at 1455 Tenafly Road, Tenafly, NJ 07670.");
    expect(lastFrom(session)).toContain("Which day works for you?");
    expect(lastFrom(session)).not.toContain("didn't catch that");
    expect(lastFrom(session)).not.toContain("Which unit");
    expect(lastFrom(session)).not.toContain("Reply 1 for Tenafly Home");
    expect(await session.stage()).toBe("choose-date");
    expect((await session.reservation())?.status).toBe("INQUIRY");
  });

  async function publishHome(h: GrokHarness): Promise<string> {
    const created = await h.ok("create_property_setup", { address: "1455 Tenafly Road, Tenafly, NJ 07670", name: "Tenafly Home", propertyType: "SINGLE_FAMILY" });
    await h.ok("add_unit", { name: "Tenafly Home" });
    await h.ok("set_unit_details", { units: [{ unit: "Tenafly Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$4,200", availability: "now" }] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await h.ok("set_verification_policy", { level: "basic-form" });
    await h.ok("update_property_details", { skipVisitorHelp: true });
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    return created.setup.propertyId as string;
  }

  it("pause → resume → visitor Tour on a published home restarts days, not the unit picker", async () => {
    const h = app();
    const id = await publishHome(h);
    const { config } = h.workspace.load(id);
    await h.approve("pause_tours", { property: id });

    const paused: string[] = [];
    await inboundOn(h, id, "+15550102000", "Tour", paused, { consentMode: "disabled" });
    expect(paused.join("\n")).toContain(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
    expect(paused.join("\n")).not.toContain("Which unit");

    await h.approve("resume_tours", { property: id });
    const live = h.visitors.latestForPhone(id, "+15550102000", "messaging")!;
    expect(lastFrom(live)).toBe(toursAreBackText(config.property.address));

    await inboundOn(h, id, "+15550102000", "Tour", [], { consentMode: "disabled" });
    expect(lastFrom(live)).toContain("Hi! Welcome to the self-guided tour");
    expect(lastFrom(live)).toContain("Which day works for you?");
    expect(lastFrom(live)).not.toContain("didn't catch that");
    expect(lastFrom(live)).not.toContain("Which unit");
    expect(lastFrom(live)).not.toContain("Reply 1 for Tenafly Home");
    expect(await live.stage()).toBe("choose-date");
  });

  it("texts visitors who got a paused-unit line when that unit is resumed", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    await h.approve("pause_tours", { property: id, unit: "Unit 101" });
    const waiting = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await waiting.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    await waiting.act("chooseUnit", { unitId: "unit_101" });
    expect(lastFrom(waiting).split("\n")[0]).toBe(pausedUnitVisitorText("Unit 101"));

    const asked = await h.ok("resume_tours", { property: id, unit: "Unit 101" });
    expect(asked.summary).toBe(resumeConfirmQuestion("Unit 101", 1));
    await h.ok("resume_tours", { property: id, unit: "Unit 101", confirmationCode: asked.confirmation.code });
    expect(lastFrom(waiting)).toBe(toursAreBackText(config.property.address));
    expect(listWaiters(h.root, id)).toEqual([]);
  });

  it("skips opted-out waiting visitors on resume", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    await h.approve("pause_tours", { property: id });
    const kept = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await kept.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    const stopped = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await stopped.act("begin", { name: "Alex Reed", phone: "(555) 010-2002" });
    await stopped.optOut({ text: "STOP" });
    expect(stopped.optedOut).toBe(true);

    const asked = await h.ok("resume_tours", { property: id });
    expect(asked.summary).toBe(resumeConfirmQuestion(config.property.name, 1));
    await h.ok("resume_tours", { property: id, confirmationCode: asked.confirmation.code });
    expect(lastFrom(kept)).toBe(toursAreBackText(config.property.address));
    expect(lastFrom(stopped)).toBe(smsStopAck());
    expect(readAvailabilityEvents(h.root, id).filter((event) => event.type === "TOURS_BACK_NOTIFIED")).toHaveLength(1);
    expect(listWaiters(h.root, id)).toEqual([]);
  });

  it("does not send the back text when a paused property is removed", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    await h.approve("pause_tours", { property: id });
    const waiting = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await waiting.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    await h.approve("remove_property", { property: id });
    expect(lastFrom(waiting)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
    expect(lastFrom(waiting)).not.toBe(toursAreBackText(config.property.address));
    expect(listWaiters(h.root, id)).toEqual([]);
    expect(readAvailabilityEvents(h.root, id).some((event) => event.type === "TOURS_BACK_NOTIFIED")).toBe(false);
  });

  it("replies that a removed property is not offering tours, with and without a help number, and does not book", async () => {
    const h = app();
    const id = await h.publish();
    const runtime = new MemoryRuntimeStore();
    const endpoints = new MessagingEndpoints(runtime);
    endpoints.attach({ address: "+15550109999", provider: "demo", propertyId: id }, new Date(h.now()));
    h.services.endpoints = endpoints;

    const asked = await h.ok("remove_property", { property: id });
    await h.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });
    expect(endpoints.resolve("+15550109999")?.propertyId).toBe(id);

    const { config } = h.workspace.load(id);
    const sent: string[] = [];
    await inboundOn(h, id, "+15550102000", "Hi", sent);
    expect(sent.join("\n")).toContain(removedPropertyVisitorText(config.property.address, config.operator.visitorContact));
    expect(sent.join("\n")).not.toMatch(/Which unit|I have tours available|archive/i);
    expect(h.visitors.all().filter((session) => session.kind === "messaging")).toHaveLength(0);
    expect(h.workspace.listTours(id).filter((tour) => tour.kind === "messaging")).toHaveLength(0);

    const again: string[] = [];
    await inboundOn(h, id, "+15550102000", "Can I book a tour?", again);
    expect(again.join("\n")).not.toContain("isn't offering tours anymore");
    expect(h.visitors.all().filter((session) => session.kind === "messaging")).toHaveLength(0);
  });

  it("appends the visitor help number on a removed-property reply when one is set", async () => {
    const h = app();
    const id = await h.publish();
    await h.ok("update_property_details", { property: id, visitorContact: "555-010-9999" });
    const runtime = new MemoryRuntimeStore();
    const endpoints = new MessagingEndpoints(runtime);
    endpoints.attach({ address: "+15550109999", provider: "demo", propertyId: id }, new Date(h.now()));
    h.services.endpoints = endpoints;
    await h.approve("remove_property", { property: id });

    const { config } = h.workspace.load(id);
    const sent: string[] = [];
    await inboundOn(h, id, "+15550102000", "Hi", sent);
    expect(sent.join("\n")).toContain(removedPropertyVisitorText(config.property.address, config.operator.visitorContact));
    expect(sent.join("\n")).toContain(`Questions? Call ${formatPhone(config.operator.visitorContact!)}`);
    expect(h.visitors.all().filter((session) => session.kind === "messaging")).toHaveLength(0);
  });

  it("honors STOP and HELP on a removed property and does not text an opted-out number", async () => {
    const h = app();
    const id = await h.publish();
    const runtime = new MemoryRuntimeStore();
    const endpoints = new MessagingEndpoints(runtime);
    endpoints.attach({ address: "+15550109999", provider: "demo", propertyId: id }, new Date(h.now()));
    h.services.endpoints = endpoints;
    await h.approve("remove_property", { property: id });

    const stop: string[] = [];
    await inboundOn(h, id, "+15550102000", "STOP", stop);
    expect(stop.join("\n")).toContain(smsStopAck());

    const afterStop: string[] = [];
    await inboundOn(h, id, "+15550102000", "Hi", afterStop);
    expect(afterStop.join("\n")).not.toContain("isn't offering tours anymore");

    const help: string[] = [];
    await inboundOn(h, id, "+15550102000", "HELP", help);
    expect(help.join("\n")).toContain(smsHelpBody());
    expect(h.visitors.all().filter((session) => session.kind === "messaging")).toHaveLength(0);
  });

  it("writes audit events for pause, resume, remove and each cancellation", async () => {
    const h = app();
    const id = await h.publish();
    const v = await readyVisitor(h, id);
    await h.approve("pause_tours", { property: id, bookedTours: "cancel" });
    await h.approve("resume_tours", { property: id });
    const other = await readyVisitor(h, id, { name: "Alex Reed", phone: "(555) 010-2010" });
    await h.approve("remove_property", { property: id });
    const propertyEvents = readAvailabilityEvents(h.root, id);
    expect(propertyEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["TOURS_PAUSED", "TOURS_RESUMED", "PROPERTY_REMOVED"]));
    const cancelled = [...(await v.session.store.listAudit()), ...(await other.session.store.listAudit())].filter((event) => event.type === "RESERVATION_CANCELLED");
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
  });
});

describe("TourCore booking gates", () => {
  it("refuses every booking method when availability says no", async () => {
    const ctx = setup();
    const message = pausedPropertyVisitorText(ctx.config.property.address, ctx.config.operator.name);
    const core = createTourCore(ctx.config, {
      clock: ctx.clock,
      durin: ctx.durin,
      store: ctx.store,
      availability: () => ({ allowed: false, message }),
    });
    await expect(core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" })).rejects.toMatchObject({
      code: "TOURS_PAUSED",
      message,
    });
  });

  it("still books when availability is unset", async () => {
    const ctx = setup();
    const booked = await bookTour(ctx);
    expect(booked.reservation.status).toBe("READY");
  });
});
