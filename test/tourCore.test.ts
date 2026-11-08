import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { VisitorDenialCopy } from "../src/core/TourCore";
import { ExportBundleSchema } from "../src/export/exportBundle";
import { basicForm, bookTour, minutesFrom, setup } from "./helpers";

describe("Tour Core journey", () => {
  it("happy path: Entrance -> Unit 101 succeeds and calls Durin for each door", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    expect(tour.reservation.status).toBe("READY");
    ctx.clock.set(minutesFrom(tour.slotStart, -3));

    const entrance = await tour.request("entrance");
    const unit = await tour.request("unit_101");

    expect(entrance).toMatchObject({ durinCalled: true, decision: { code: "ALLOW" } });
    expect(unit).toMatchObject({ durinCalled: true, decision: { code: "ALLOW" } });
    expect(ctx.durin.calls.requestAccess.map((c) => c.doorId)).toEqual(["entrance", "unit_101"]);
    expect((await ctx.core.getReservation(tour.reservation.id))?.status).toBe("TOURING");

    const done = await ctx.core.completeTour(tour.reservation.id);
    expect(done.status).toBe("COMPLETED");
    expect(ctx.durin.calls.revokeAccess).toHaveLength(2);

    const types = (await ctx.core.auditTrail()).map((e) => e.type);
    for (const t of ["PROSPECT_CREATED", "RESERVATION_CREATED", "CONSENT_RECORDED", "VERIFICATION_COMPLETED", "TOUR_READY", "ACCESS_REQUESTED", "ACCESS_ALLOWED", "TOUR_STARTED", "TOUR_COMPLETED", "FOLLOW_UP_SENT"] as const) {
      expect(types).toContain(t);
    }
    const bundle = ExportBundleSchema.parse(JSON.parse(JSON.stringify(await ctx.core.exportRecords())));
    expect(bundle.accessGrants.every((g) => g.status === "REVOKED")).toBe(true);
  });

  it("wrong route: Unit 102 is denied and Durin is not called", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    await tour.request("entrance");

    const out = await tour.request("unit_102");
    expect(out).toMatchObject({ durinCalled: false, decision: { allowed: false, code: "DENY_WRONG_ROUTE" } });
    expect(ctx.durin.calls.requestAccess.map((c) => c.doorId)).toEqual(["entrance"]);
  });

  it("too early and expired are denied without calling Durin", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);

    ctx.clock.set(minutesFrom(tour.slotStart, -30));
    expect((await tour.request("entrance")).decision.code).toBe("DENY_TOO_EARLY");

    ctx.clock.set(minutesFrom(tour.slotStart, 60));
    expect((await tour.request("entrance")).decision.code).toBe("DENY_EXPIRED");
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);
  });

  it("revoked reservation is denied and its grants are revoked in Durin", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    await tour.request("entrance");

    await ctx.core.revokeReservation(tour.reservation.id, "operator cancelled");
    expect(ctx.durin.calls.revokeAccess).toHaveLength(1);
    expect((await tour.request("unit_101")).decision.code).toBe("DENY_REVOKED");
    expect(ctx.durin.calls.requestAccess).toHaveLength(1);
  });

  it("verification incomplete is denied", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx, "awaiting-verification");
    ctx.clock.set(tour.slotStart);
    expect((await tour.request("entrance")).decision.code).toBe("DENY_VERIFICATION_INCOMPLETE");
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);
    const incomplete = (await ctx.core.exportRecords()).messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body).pop();
    expect(incomplete).toContain("please fill out this short form");
    expect(incomplete).toContain("https://forms.example/tour-core-basic-id");
    expect(incomplete).not.toContain("Finish the steps I sent earlier");
  });

  it("form with a different phone number fails verification", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx, "awaiting-verification");
    const r = await ctx.core.submitVerification(tour.reservation.id, basicForm("555-999-0000"));
    expect(r.status).toBe("VERIFICATION_FAILED");
  });

  it("failed ID, hold, and door-outage texts share a next-step line and never show the operator alert number", async () => {
    const privateLine = loadConfig().operator.contact;
    const team = "property team";
    const atDoorUnset = VisitorDenialCopy.atDoor(team);
    const atDoorSet = VisitorDenialCopy.atDoor(team, "+15550109999");
    const atDoorNamedUnset = VisitorDenialCopy.atDoor(team, undefined, { teamJustNamed: true });
    const atDoorNamedSet = VisitorDenialCopy.atDoor(team, "+15550109999", { teamJustNamed: true });
    const failedFollowUpUnset = VisitorDenialCopy.followUp(team);
    const failedFollowUpSet = VisitorDenialCopy.followUp(team, "+15550109999");
    const failedBooking = "Thanks for filling that out. I couldn't confirm your details, so I can't open doors for this tour.";
    const failedDoor = "I couldn't confirm your details, so I can't open doors for this tour.";
    const failedEnded = "I couldn't confirm your details, so your tour has ended. Please head out the way you came in.";
    const doors = `Sorry, the doors aren't responding right now. I've let the ${team} know.`;

    const prospectTexts = async (ctx: ReturnType<typeof setup>) =>
      (await ctx.core.exportRecords()).messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body);

    const failedTexts = async (visitorContact?: string) => {
      const ctx = setup(visitorContact ? { visitorContact } : {});
      const tour = await bookTour(ctx, "awaiting-verification");
      await ctx.core.submitVerification(tour.reservation.id, basicForm("555-999-0000"));
      ctx.clock.set(tour.slotStart);
      await tour.request("entrance");
      return prospectTexts(ctx);
    };
    const holdTexts = async (visitorContact?: string) => {
      const ctx = setup(visitorContact ? { visitorContact } : {});
      const tour = await bookTour(ctx);
      ctx.clock.set(tour.slotStart);
      await ctx.core.placeOperatorHold(tour.reservation.id, "checking something");
      await tour.request("entrance");
      return prospectTexts(ctx);
    };
    const doorTexts = async (visitorContact?: string) => {
      const ctx = setup(visitorContact ? { visitorContact } : {});
      const tour = await bookTour(ctx);
      ctx.clock.set(tour.slotStart);
      ctx.durin.setHealthy(false, "controller offline");
      await tour.request("entrance");
      return prospectTexts(ctx);
    };
    const helpTexts = async (visitorContact?: string) => {
      const ctx = setup(visitorContact ? { visitorContact } : {});
      const tour = await bookTour(ctx);
      await ctx.core.requestHelp(tour.reservation.id, "lobby");
      return prospectTexts(ctx);
    };
    const endedTexts = async (visitorContact?: string) => {
      const ctx = setup(visitorContact ? { visitorContact } : {});
      const tour = await bookTour(ctx);
      ctx.clock.set(tour.slotStart);
      await tour.request("entrance");
      await tour.request("unit_101");
      const check = (await ctx.store.list("verifications"))[0]!;
      await ctx.store.put("verifications", { ...check, validUntil: minutesFrom(tour.slotStart, -1).toISOString() });
      await ctx.core.submitVerification(tour.reservation.id, basicForm("555-999-0000"));
      return prospectTexts(ctx);
    };

    const failedUnset = await failedTexts();
    const failedSet = await failedTexts("+15550109999");
    const endedUnset = await endedTexts();
    const endedSet = await endedTexts("+15550109999");
    const holdUnset = await holdTexts();
    const holdSet = await holdTexts("+15550109999");
    const doorUnset = await doorTexts();
    const doorSet = await doorTexts("+15550109999");
    const helpUnset = await helpTexts();
    const helpSet = await helpTexts("+15550109999");
    const failedIdBodies = [
      ...failedUnset.filter((b) => b.includes("I couldn't confirm your details")),
      ...failedSet.filter((b) => b.includes("I couldn't confirm your details")),
      ...endedUnset.filter((b) => b.includes("I couldn't confirm your details")),
      ...endedSet.filter((b) => b.includes("I couldn't confirm your details")),
    ];

    expect(failedUnset.filter((b) => b.startsWith("Thanks for filling that out"))).toEqual([`${failedBooking} ${failedFollowUpUnset}`]);
    expect(failedSet.filter((b) => b.startsWith("Thanks for filling that out"))).toEqual([`${failedBooking} ${failedFollowUpSet}`]);
    expect(failedUnset.filter((b) => b === `${failedDoor} ${failedFollowUpUnset}`)).toEqual([`${failedDoor} ${failedFollowUpUnset}`]);
    expect(failedSet.filter((b) => b === `${failedDoor} ${failedFollowUpSet}`)).toEqual([`${failedDoor} ${failedFollowUpSet}`]);
    expect(endedUnset.filter((b) => b.startsWith("I couldn't confirm your details, so your tour has ended"))).toEqual([
      `${failedEnded} ${failedFollowUpUnset}`,
    ]);
    expect(endedSet.filter((b) => b.startsWith("I couldn't confirm your details, so your tour has ended"))).toEqual([
      `${failedEnded} ${failedFollowUpSet}`,
    ]);
    expect(failedUnset.find((b) => b.startsWith("Thanks for filling that out"))).not.toMatch(/Stay where you are|I can't open doors yet|on hold/);
    expect(holdUnset.filter((b) => b === VisitorDenialCopy.operatorHold(team))).toEqual([VisitorDenialCopy.operatorHold(team)]);
    expect(holdSet.filter((b) => b === VisitorDenialCopy.operatorHold(team, "+15550109999"))).toEqual([
      VisitorDenialCopy.operatorHold(team, "+15550109999"),
    ]);
    expect(VisitorDenialCopy.operatorHold(team)).not.toMatch(/window|counting down|rebook/i);
    expect(doorUnset.some((b) => b.startsWith(doors) && b.endsWith(atDoorNamedUnset))).toBe(true);
    expect(doorSet.some((b) => b.startsWith(doors) && b.endsWith(atDoorNamedSet))).toBe(true);
    expect(helpUnset.filter((b) => b === VisitorDenialCopy.helpAckRemote(team))).toEqual([VisitorDenialCopy.helpAckRemote(team)]);
    expect(helpSet.filter((b) => b === VisitorDenialCopy.helpAckRemote(team, "+15550109999"))).toEqual([
      VisitorDenialCopy.helpAckRemote(team, "+15550109999"),
    ]);
    expect(helpUnset.join("\n")).not.toContain("Stay where you are");
    expect(atDoorUnset).toBe(`Stay where you are and reply here. The ${team} will reply as soon as they can.`);
    expect(atDoorSet).toBe(`Stay where you are. The ${team} will reply as soon as they can, or call (555) 010-9999.`);
    expect(atDoorNamedUnset).toBe("Stay where you are and reply here. They'll reply as soon as they can.");
    expect(atDoorNamedSet).toBe("Stay where you are. They'll reply as soon as they can, or call (555) 010-9999.");
    expect(VisitorDenialCopy.remote(team)).toBe(`The ${team} will reply here as soon as they can.`);
    expect(VisitorDenialCopy.remote(team, "+15550109999")).toBe(`The ${team} will reply here as soon as they can, or call (555) 010-9999.`);
    expect(VisitorDenialCopy.remote(team, undefined, { teamJustNamed: true })).toBe("They'll reply here as soon as they can.");
    expect(VisitorDenialCopy.remote(team, "+15550109999", { teamJustNamed: true })).toBe(
      "They'll reply here as soon as they can, or call (555) 010-9999.",
    );
    expect(VisitorDenialCopy.helpAck(team)).toBe(`I've let the ${team} know. ${atDoorNamedUnset}`);
    expect(VisitorDenialCopy.helpAck(team, "+15550109999")).toBe(`I've let the ${team} know. ${atDoorNamedSet}`);
    expect(VisitorDenialCopy.helpAckRemote(team)).toBe(`I've let the ${team} know. ${VisitorDenialCopy.remote(team, undefined, { teamJustNamed: true })}`);
    expect(VisitorDenialCopy.helpAckRemote(team, "+15550109999")).toBe(
      `I've let the ${team} know. ${VisitorDenialCopy.remote(team, "+15550109999", { teamJustNamed: true })}`,
    );
    for (const body of [...holdUnset, ...holdSet, ...doorUnset, ...doorSet, ...helpUnset, ...helpSet].filter(
      (b) => b.includes("I've let the") || b.includes("on hold"),
    )) {
      expect(body.match(/property team/gi)).toHaveLength(1);
      expect(body).toContain("They'll reply");
    }
    for (const body of failedIdBodies) {
      expect(body.match(/The property team/g)).toHaveLength(1);
      expect(body).not.toMatch(/on hold|yet|Stay where you are/);
    }
    for (const body of [...failedUnset, ...failedSet, ...endedUnset, ...endedSet, ...holdUnset, ...holdSet, ...doorUnset, ...doorSet, ...helpUnset, ...helpSet]) {
      expect(body).not.toContain(privateLine);
      expect(body).not.toContain("5550100000");
      expect(body).not.toMatch(/someone will reach out shortly/i);
      expect(body).not.toMatch(/usually replies within 15 minutes/i);
    }
  });

  it("lapsed verification and missing consent each get their own text", async () => {
    const ctx = setup();
    const stale = await bookTour(ctx);
    const check = (await ctx.store.list("verifications"))[0]!;
    await ctx.store.put("verifications", { ...check, validUntil: minutesFrom(stale.slotStart, -1).toISOString() });
    ctx.clock.set(stale.slotStart);
    expect((await stale.request("entrance")).decision.code).toBe("DENY_VERIFICATION_STALE");

    const pending = await ctx.core.startInquiry({ name: "Pat Lee", phone: "(555) 010-4321", unitId: "apt_101" });
    const slot = (await ctx.core.availableSlots())[0]!;
    const booked = await ctx.core.reserveSlot(pending.reservation.id, slot.start.toISOString());
    await ctx.store.put("reservations", { ...booked, status: "AWAITING_CONSENT", consentId: undefined });
    ctx.clock.set(slot.start);
    expect(
      (await ctx.core.requestAccess({ reservationId: pending.reservation.id, prospectId: pending.prospect.id, doorId: "entrance" })).decision.code,
    ).toBe("DENY_CONSENT_MISSING");

    const bodies = (await ctx.core.exportRecords()).messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body);
    const staleText = bodies.find((b) => b.includes("fill it out again"));
    const consentText = bodies.find((b) => b.includes("Before I can open doors"));
    expect(staleText).toContain("It's been a while since you filled out the identity form, so I'll need you to fill it out again before I can open doors.");
    expect(staleText).toContain("https://forms.example/tour-core-basic-id");
    expect(consentText).toBe("Before I can open doors, text me back and I'll finish setting up your tour.");
    expect(consentText).not.toContain("Is it OK if I text you");
    expect(consentText).not.toContain("Reply YES or NO.");
    expect(bodies.filter((b) => b.includes("Finish the steps I sent earlier"))).toEqual([]);
    expect(bodies.join("\n")).not.toContain(ctx.config.operator.contact);
  });

  it("visitor texts keep the configured team name, include the tour date when early, and reuse the shared next-step line", async () => {
    const prospectTexts = async (ctx: ReturnType<typeof setup>) =>
      (await ctx.core.exportRecords()).messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body);

    const team = "property team";
    const maple = "Maple Leasing team";
    const earlyToday = VisitorDenialCopy.tooEarly("1:50 PM", "today at 1:50 PM");
    const earlyLater = VisitorDenialCopy.tooEarly("1:50 PM", "on Wednesday, Sep 30 at 1:50 PM");
    const expired = "Your tour time has ended, so I can't open doors anymore. Want me to find you another time?";
    const wrong = (name: string) =>
      `That door isn't part of your tour, so I can't open it. You're here to see Unit 101. I've let the ${name} know in case you need a hand.`;

    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(minutesFrom(tour.slotStart, -30));
    expect((await tour.request("entrance")).decision.code).toBe("DENY_TOO_EARLY");
    ctx.clock.set(minutesFrom(tour.slotStart, 60));
    expect((await tour.request("entrance")).decision.code).toBe("DENY_EXPIRED");
    ctx.clock.set(tour.slotStart);
    expect((await tour.request("unit_102")).decision.code).toBe("DENY_WRONG_ROUTE");
    await ctx.core.requestHelp(tour.reservation.id, "lobby");
    const bodies = await prospectTexts(ctx);
    expect(earlyToday).toBe("You're a little early! I can open the doors from 1:50 PM today. Text me again at 1:50 PM.");
    expect(bodies.filter((b) => b === earlyToday)).toEqual([earlyToday]);
    expect(bodies.filter((b) => b === expired)).toEqual([expired]);
    expect(bodies.filter((b) => b === wrong(team))).toEqual([wrong(team)]);
    expect(bodies.filter((b) => b === VisitorDenialCopy.helpAck(team))).toEqual([VisitorDenialCopy.helpAck(team)]);
    expect(bodies.join("\n")).toContain("the property team");

    const laterCtx = setup();
    const laterTour = await bookTour(laterCtx, "ready", { year: 2026, month: 9, day: 30 });
    expect((await laterTour.request("entrance")).decision.code).toBe("DENY_TOO_EARLY");
    expect(await prospectTexts(laterCtx)).toContain(earlyLater);
    expect(earlyLater).toBe("You're a little early! I can open the doors from 1:50 PM on Wednesday, Sep 30. Text me again then.");

    const doneCtx = setup();
    const done = await bookTour(doneCtx);
    doneCtx.clock.set(done.slotStart);
    await done.request("entrance");
    await doneCtx.core.completeTour(done.reservation.id);
    await doneCtx.core.recordFollowUpResponse(done.reservation.id, true);
    expect(await prospectTexts(doneCtx)).toContain(VisitorDenialCopy.followUpYes(team));

    const calledUnset = setup();
    const calledTour = await bookTour(calledUnset);
    await calledUnset.core.revokeReservation(calledTour.reservation.id, "operator cancelled");
    expect(await prospectTexts(calledUnset)).toContain(VisitorDenialCopy.calledOff(team));

    const calledSet = setup({ visitorContact: "+15550109999" });
    const calledSetTour = await bookTour(calledSet);
    await calledSet.core.revokeReservation(calledSetTour.reservation.id, "operator cancelled");
    expect(await prospectTexts(calledSet)).toContain(VisitorDenialCopy.calledOff(team, "+15550109999"));

    const mapleCtx = setup({ operatorName: maple });
    const mapleTour = await bookTour(mapleCtx);
    mapleCtx.clock.set(mapleTour.slotStart);
    await mapleTour.request("unit_102");
    await mapleCtx.core.revokeReservation(mapleTour.reservation.id, "operator cancelled");
    const mapleBodies = await prospectTexts(mapleCtx);
    expect(mapleBodies).toContain(wrong(maple));
    expect(mapleBodies).toContain(VisitorDenialCopy.calledOff(maple));
    expect(mapleBodies.join("\n")).toContain("Maple Leasing team");
    expect(mapleBodies.join("\n")).not.toContain("maple leasing team");

    expect(VisitorDenialCopy.noOpenTimes(maple)).toBe("There are no open tour times right now. The Maple Leasing team will reach out.");
    expect(VisitorDenialCopy.followUpYes(maple)).toBe("Great. Someone from the Maple Leasing team will be in touch soon.");
    expect(VisitorDenialCopy.operatorHold(maple)).toBe(
      `Your tour is on hold, and your tour time keeps running while the ${maple} sorts this out. ${VisitorDenialCopy.atDoor(maple, undefined, { teamJustNamed: true })}`,
    );
    expect(VisitorDenialCopy.operatorHold(maple, "+15550109999")).toBe(
      `Your tour is on hold, and your tour time keeps running while the ${maple} sorts this out. ${VisitorDenialCopy.atDoor(maple, "+15550109999", { teamJustNamed: true })}`,
    );
    expect(VisitorDenialCopy.calledOff(maple, "+15550109999")).toBe(
      `Your tour has been called off, so the doors won't open for it. ${VisitorDenialCopy.remote(maple, "+15550109999")}`,
    );
    expect(VisitorDenialCopy.calledOff(maple, "+15550109999")).toContain(`The ${maple} will reply here`);
    expect(VisitorDenialCopy.operatorHold(maple)).toContain("They'll reply as soon as they can.");
    expect(VisitorDenialCopy.operatorHold(maple)).not.toMatch(new RegExp(`The ${maple} will reply`));
  });

  it("a stale ID re-check goes through submitVerification and then opens the door", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    const check = (await ctx.store.list("verifications"))[0]!;
    await ctx.store.put("verifications", { ...check, validUntil: minutesFrom(tour.slotStart, -1).toISOString() });
    ctx.clock.set(tour.slotStart);
    expect((await tour.request("entrance")).decision.code).toBe("DENY_VERIFICATION_STALE");
    const again = await ctx.core.submitVerification(tour.reservation.id, basicForm());
    expect(again.status).toBe("READY");
    expect(again.verificationId).not.toBe(tour.reservation.verificationId);
    expect((await tour.request("entrance")).decision.code).toBe("ALLOW");
  });

  it("a failed stale re-check ends the tour the same way a first-time failed ID check does", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    const check = (await ctx.store.list("verifications"))[0]!;
    await ctx.store.put("verifications", { ...check, validUntil: minutesFrom(tour.slotStart, -1).toISOString() });
    ctx.clock.set(tour.slotStart);
    expect((await tour.request("entrance")).decision.code).toBe("DENY_VERIFICATION_STALE");

    const failed = await ctx.core.submitVerification(tour.reservation.id, basicForm("555-999-0000"));
    expect(failed.status).toBe("VERIFICATION_FAILED");
    const retry = await ctx.core.submitVerification(tour.reservation.id, basicForm());
    expect(retry.status).toBe("VERIFICATION_FAILED");
    expect(retry.verificationId).toBe(tour.reservation.verificationId);
    expect((await tour.request("entrance")).decision).toMatchObject({ allowed: false, code: "DENY_VERIFICATION_FAILED" });
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);

    const bodies = (await ctx.core.exportRecords()).messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body);
    expect(bodies.filter((b) => b.startsWith("Thanks for filling that out"))).toEqual([
      VisitorDenialCopy.failedIdAtBooking("property team"),
    ]);
    expect(bodies.filter((b) => b === VisitorDenialCopy.failedIdAtDoor("property team"))).toEqual([
      VisitorDenialCopy.failedIdAtDoor("property team"),
    ]);
    for (const body of bodies.filter((b) => b.includes("I couldn't confirm your details"))) {
      expect(body.match(/The property team/g)).toHaveLength(1);
      expect(body).not.toMatch(/on hold|yet|Stay where you are/);
    }
  });

  it("a failed mid-tour re-check revokes every grant and later door tries stay denied", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    expect((await tour.request("entrance")).decision.code).toBe("ALLOW");
    expect((await tour.request("unit_101")).decision.code).toBe("ALLOW");
    expect((await ctx.core.getReservation(tour.reservation.id))?.status).toBe("TOURING");
    expect((await ctx.core.listGrants(tour.reservation.id)).map((g) => [g.doorId, g.status])).toEqual([
      ["entrance", "ACTIVE"],
      ["unit_101", "ACTIVE"],
    ]);

    const check = (await ctx.store.list("verifications"))[0]!;
    await ctx.store.put("verifications", { ...check, validUntil: minutesFrom(tour.slotStart, -1).toISOString() });
    const failed = await ctx.core.submitVerification(tour.reservation.id, basicForm("555-999-0000"));
    expect(failed.status).toBe("VERIFICATION_FAILED");
    expect((await ctx.core.listGrants(tour.reservation.id)).every((g) => g.status === "REVOKED")).toBe(true);
    expect(ctx.durin.calls.revokeAccess.map((c) => c.doorId)).toEqual(["entrance", "unit_101"]);
    expect((await ctx.core.auditTrail()).filter((e) => e.type === "ACCESS_REVOKED")).toHaveLength(2);
    expect((await ctx.core.auditTrail()).filter((e) => e.type === "ACCESS_REVOKED").every((e) => e.detail?.includes("identity check failed"))).toBe(
      true,
    );

    expect((await tour.request("entrance")).decision).toMatchObject({ allowed: false, code: "DENY_VERIFICATION_FAILED" });
    expect((await tour.request("unit_101")).decision).toMatchObject({ allowed: false, code: "DENY_VERIFICATION_FAILED" });
    expect(ctx.durin.calls.requestAccess).toHaveLength(2);

    const bodies = (await ctx.core.exportRecords()).messages.filter((m) => m.audience === "PROSPECT").map((m) => m.body);
    expect(bodies.filter((b) => b.includes("your tour has ended"))).toEqual([
      "I couldn't confirm your details, so your tour has ended. Please head out the way you came in. The property team will follow up here.",
    ]);
    const doorFail = "I couldn't confirm your details, so I can't open doors for this tour. The property team will follow up here.";
    expect(bodies.filter((b) => b === doorFail)).toEqual([doorFail, doorFail]);
    for (const body of bodies.filter((b) => b.includes("I couldn't confirm your details"))) {
      expect(body.match(/The property team/g)).toHaveLength(1);
      expect(body).not.toMatch(/on hold|yet|Stay where you are|Thanks for filling that out/);
    }
  });

  it("operator hold is denied, and resuming restores access", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);

    await ctx.core.placeOperatorHold(tour.reservation.id, "checking something");
    expect((await tour.request("entrance")).decision.code).toBe("DENY_OPERATOR_HOLD");
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);

    await ctx.core.resumeReservation(tour.reservation.id);
    expect((await tour.request("entrance")).decision.code).toBe("ALLOW");
  });

  it("Durin unhealthy fails closed without sending a request", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    ctx.durin.setHealthy(false, "controller offline");

    const out = await tour.request("entrance");
    expect(out).toMatchObject({ durinCalled: false, decision: { allowed: false, code: "DENY_DOOR_UNHEALTHY" } });
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);
  });

  it("Durin failure becomes a safe denial and pauses the tour", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    ctx.durin.failNextRequest("door controller timeout");

    expect((await tour.request("entrance")).decision.code).toBe("DENY_PROVIDER_FAILURE");
    expect((await ctx.core.getReservation(tour.reservation.id))?.status).toBe("PROVIDER_FAILURE");
    expect((await tour.request("entrance")).durinCalled).toBe(false);
  });

  it("duplicate access requests create one grant and one Durin call", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);

    const [a, b, c] = await Promise.all([tour.request("entrance"), tour.request("entrance"), tour.request("entrance")]);
    const again = await tour.request("entrance");

    expect([a, b, c, again].every((o) => o.decision.allowed)).toBe(true);
    expect(again.reusedGrant).toBe(true);
    expect(ctx.durin.calls.requestAccess).toHaveLength(1);
    expect(await ctx.core.listGrants(tour.reservation.id)).toHaveLength(1);
  });

  it("duplicate booking replies create no second reservation", async () => {
    const ctx = setup();
    const first = await ctx.core.startInquiry({ name: "Jane Smith", phone: "5550101234", unitId: "apt_101" });
    const second = await ctx.core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
    expect(second.reservation.id).toBe(first.reservation.id);

    const slot = (await ctx.core.availableSlots())[0]!;
    const booked = await ctx.core.reserveSlot(first.reservation.id, slot.start.toISOString());
    expect(booked.status).toBe("AWAITING_VERIFICATION");
    expect(booked.consentId).toBeTruthy();
    await expect(ctx.core.reserveSlot(first.reservation.id, slot.start.toISOString())).rejects.toMatchObject({
      code: "SLOT_UNCHANGED",
    });
    expect((await ctx.core.getReservation(first.reservation.id))!.status).toBe("AWAITING_VERIFICATION");
    expect((await ctx.core.auditTrail()).filter((e) => e.type === "RESERVATION_CREATED")).toHaveLength(1);
  });

  it("repeat tour on another day reuses the prospect and prior verification", async () => {
    const ctx = setup();
    const first = await bookTour(ctx);
    ctx.clock.set(first.slotStart);
    await first.request("entrance");
    await ctx.core.completeTour(first.reservation.id);

    const second = await bookTour(ctx, "awaiting-verification", { year: 2026, month: 9, day: 29 });
    expect(second.prospect.id).toBe(first.prospect.id);
    expect(second.reservation.status).toBe("READY");
    expect(second.reservation.verificationId).toBe(first.reservation.verificationId);
  });
});
