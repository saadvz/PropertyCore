import { z } from "zod";
import { PROBLEMS_ONLY, RECOMMENDED_UPDATES, UPDATE_KINDS, choosePreferences, describeUpdates, enabledUpdates } from "../alerts/preferences";
import { PROPERTY_TYPES } from "../config/tourCoreConfig";
import { extractValues, parseBulkUnitDetails } from "../config/unitProfile";
import { checkPublicEndpoint, testAccess, testOperatorAlerts, testVisitorMessaging } from "../install/checks";
import { secureSetupLink } from "../install/tools";
import { isTenantWorker } from "../install/deployment";
import { getInstallationStatus, installedMessaging } from "../install/status";
import { readState } from "../install/stateView";
import { toE164 } from "../messaging/Messenger";
import { usesLocalMessaging } from "../messaging/propertyScope";
import { chooseMessagingProvider } from "../messaging/switchProvider";
import { LOCAL_TEST_TEXTING, SetupInputError, createPropertySetup, localTestModeSentence, modeSentence, visitorsTextLine } from "../setup/setupActions";
import { applySetupCommand } from "../setup/commands";
import { canonicalDoor, canonicalUnitName } from "../setup/normalizeDraft";
import { describeTourDays } from "./tourDayWords";
import { applyZoneSwitchAnswer, commitZoneAnswer, fieldsToHold, guessedZoneName, heldZoneFields, holdZoneSwitchFields, mergedZoneDetails, rememberZoneSwitch, switchHoldReply, switchQuestionForOffer, zoneReply, zoneSwitchAnswer, zoneSwitchQuestion } from "./zoneCopy";
import { reuseDaysRefusal } from "../config/validateConfig";
import { addressConfirmQuestion, nextAddressPartQuestion, savedFullAddress } from "../setup/address";
import { parseTourRef } from "./tours";
import { parseDays, parseMinutes, parseTimeOfDay } from "../setup/parse";
import { NO_FORM_QUESTION } from "../setup/verification";
import { publishGuards, publishProperty, readinessForProperty, runPracticeTour, visitorTexting } from "./setupFlow";
import { matchDoor, requireUnit, resolvePropertyId } from "./resolve";
import { defaultMessagingMode, type OperatorServices } from "./services";
import type { OperatorTool, ToolContext, ToolKind } from "./tools";
import type { Door, TourCoreConfig, TourHours, Unit } from "../config/tourCoreConfig";
import { describeTourWindows } from "../setup/setupActions";
import { planTourHours } from "./hoursPlan";

/**
 * Milestone writes. Each one reports done, blocked, or next, plus the same
 * current milestone and next step get_state reports. They do not text visitors.
 */

function tool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<Record<string, unknown>>;
}): OperatorTool {
  return def as unknown as OperatorTool;
}

const Property = z.string().max(200).optional().describe("Which property: its name, address or propertyId. Leave out when there's only one.");
const UnitValue = z.union([z.string().max(300), z.number(), z.boolean()]).optional();
const Duration = z.union([z.number().int(), z.string().max(40)]);
const Facts = z.array(z.string().max(300)).max(30);

function servicesOf(ctx: ToolContext): OperatorServices {
  if (!ctx.installation) return ctx.services;
  return { ...ctx.services, installedMessaging: () => installedMessaging(ctx.installation!) };
}

/** Setup questions belong to one property. An unscoped call must not repeat another property's. */
const PROPERTY_SETUP_STEPS = new Set([
  "property-address",
  "property-confirm",
  "property-type",
  "units-which",
  "units-home",
  "units-details",
  "units-route",
  "hours",
  "hours-help",
  "readiness",
  "practice",
  "publish",
]);

function propertyIdFrom(extra: Record<string, unknown>): string | undefined {
  if (typeof extra.propertyId === "string" && extra.propertyId.trim()) return extra.propertyId.trim();
  if (typeof extra.tourRef === "string") return parseTourRef(extra.tourRef)?.propertyId;
  const tour = extra.tour;
  if (tour && typeof tour === "object" && "tourRef" in tour && typeof (tour as { tourRef?: unknown }).tourRef === "string") {
    return parseTourRef((tour as { tourRef: string }).tourRef)?.propertyId;
  }
  return undefined;
}

/** A touring host on the shared service publishes only once their alert routine is connected. */
export const ALERTS_NEEDED = "Connect the touring alert routine first. Call save_alert_routine.";

export function envelope(
  ctx: ToolContext,
  propertyId: string | undefined,
  status: "done" | "blocked" | "next",
  message: string,
  extra: Record<string, unknown> = {},
  code?: string,
): Record<string, unknown> {
  const about = propertyId ?? propertyIdFrom(extra);
  let picture: Record<string, unknown> | undefined;
  if (ctx.installation) {
    try {
      picture = readState({ installation: ctx.installation, services: servicesOf(ctx), client: ctx.client }, about);
    } catch {
      picture = undefined;
    }
  }
  const milestones = (picture?.milestones as Array<{ status: string; title: string; id: string }> | undefined) ?? [];
  const current = milestones.find((item) => item.status === "next");
  const step = picture?.nextStep as { tool?: string; say?: string } | undefined;
  const playbookStep = (picture?.playbook as { step?: string } | undefined)?.step;
  const pictureProperty = (picture?.setup as { propertyId?: string } | undefined)?.propertyId;
  const foreignSetup = !!playbookStep && PROPERTY_SETUP_STEPS.has(playbookStep) && (!about || (!!pictureProperty && about !== pictureProperty));
  const next = foreignSetup ? "get_state" : (step?.tool ?? "get_state");
  const milestone = foreignSetup ? null : (current?.title ?? "Setup");
  const milestoneId = foreignSetup ? null : (current?.id ?? null);
  return {
    status,
    milestone,
    milestoneId,
    next,
    message,
    ...(status === "blocked" ? { reason: message, code: code ?? "BLOCKED" } : {}),
    nextStep: { tool: next, ...(foreignSetup ? {} : { say: step?.say }), milestone: milestoneId },
    ...extra,
  };
}

function propertyIdOf(ctx: ToolContext, property: string | undefined): string {
  return resolvePropertyId(ctx.services.workspace, property);
}

function open(ctx: ToolContext, property: string | undefined) {
  const id = propertyIdOf(ctx, property);
  return { id, draft: ctx.services.workspace.openDraft(id).draft };
}

const UnitFields = {
  name: z.string().max(100).optional(),
  newName: z.string().max(100).optional(),
  doorName: z.string().max(100).optional(),
  description: z.string().max(300).optional(),
  facts: Facts.optional(),
  bedrooms: UnitValue,
  bathrooms: UnitValue,
  monthlyRent: UnitValue,
  availability: UnitValue,
  squareFeet: UnitValue,
  floor: UnitValue,
  parking: UnitValue,
  laundry: UnitValue,
  pets: UnitValue,
  utilities: UnitValue,
  furnished: UnitValue,
  features: UnitValue,
};

export const MILESTONE_TOOLS: OperatorTool[] = [
  tool({
    name: "set_up_texting",
    title: "Set up texting",
    kind: "change",
    description: "Sets up texting for this install (the provider, the line, and the check) and says whether that step is done, blocked, or still needs an answer.",
    input: z.strictObject({
      provider: z.enum(["sendblue", "twilio", "photon", "local"]).optional(),
      property: Property,
      line: z.string().max(40).optional().describe("One Photon line address Tour Core already listed."),
    }),
    run: async (ctx, i) => {
      const inst = ctx.installation;
      if (!inst) return envelope(ctx, undefined, "blocked", TEXTING_NOT_HERE, {}, "INSTALLATION_UNAVAILABLE");
      const propertyId = i.property ? propertyIdOf(ctx, i.property) : undefined;
      if (i.provider) {
        const chosen = await chooseMessagingProvider(inst, i.provider, { workspace: ctx.services.workspace, propertyId });
        if (chosen.scope === "installation") ctx.resetMessaging?.();
      }
      if (i.line) {
        const wanted = toE164(i.line);
        const known = (inst.files.state().messagingLines ?? []).map((line) => toE164(line.address) ?? line.address);
        if (!wanted || !known.includes(wanted)) {
          return envelope(ctx, propertyId, "blocked", "Pick one of the numbers I listed.", {}, "LINE_NOT_LISTED");
        }
        inst.secrets.set({ TOURCORE_PHOTON_PHONE_NUMBER: wanted }, new Date(inst.now()));
        ctx.resetMessaging?.();
      }
      let messaging = getInstallationStatus(inst, servicesOf(ctx)).components.find((item) => item.component === "VISITOR_MESSAGING");
      const action = messaging?.next?.action;
      if (messaging?.state !== "READY" && (i.provider || action === "TEST_VISITOR_MESSAGING" || action === "RECONNECT_VISITOR_MESSAGING")) {
        const tested = await testVisitorMessaging(inst, { onConnected: ctx.resetMessaging });
        if (tested.needsLineChoice && !i.line) {
          return envelope(ctx, propertyId, "next", "Which of these numbers should people text?", { lines: tested.lines }, "LINE_NEEDED");
        }
        messaging = getInstallationStatus(inst, servicesOf(ctx)).components.find((item) => item.component === "VISITOR_MESSAGING");
      }
      if (messaging?.state === "READY") {
        const message = messaging.provider === "local" ? LOCAL_TEST_TEXTING : "Texting is working.";
        return envelope(ctx, propertyId, "done", message);
      }
      const nextAction = messaging?.next?.action;
      if (!i.provider && (nextAction === "CHOOSE_MESSAGING_PROVIDER" || !nextAction)) {
        return envelope(ctx, propertyId, "next", "How should people text you about a tour?");
      }
      if (nextAction === "CONNECT_VISITOR_MESSAGING" || nextAction === "FIX_VISITOR_MESSAGING") {
        return envelope(ctx, propertyId, "next", "I need the texting login. I'll collect it privately so it never shows in this chat.", {
          secureSetup: secureSetupLink(inst, ctx.localUrl?.(), "visitor-messaging"),
        });
      }
      if (nextAction === "CHOOSE_MESSAGING_LINE") return envelope(ctx, propertyId, "next", "Which of these numbers should people text?");
      if (nextAction === "TEST_VISITOR_MESSAGING" || nextAction === "RECONNECT_VISITOR_MESSAGING") {
        return envelope(ctx, propertyId, "next", "I'm checking that texting works. I won't text anyone.");
      }
      return envelope(ctx, propertyId, "blocked", "Texting isn't working right now. Ask me to check it again, and that check does not text anyone.", {}, "TEXTING_NOT_READY");
    },
  }),
  tool({
    name: "save_property",
    title: "Save the property",
    kind: "change",
    description: "Saves the property address, type, time zone, name, facts, help number, alert contact, building access, and entry instructions. A street with no state or ZIP leaves the time zone unset. Changing the state when a ZIP is already saved runs the ZIP check. On a mismatch, ask \"That ZIP doesn't look like it's in {state}. Which one should I fix, the ZIP or the state?\" and save nothing until they answer. When a state change would move a locked time zone, ask the switch question first, on its own. Do not add the next setup question until they answer. timezone \"yes\" switches to the offered zone. timezone \"no\" keeps the current zone. A named zone such as \"Pacific\" or \"keep Eastern\" is that choice. A ZIP is not a yes and does not switch. A ZIP or other detail sent while that question is open is held, not saved yet. The reply is \"Before I save that, one thing. Tours still run on {current zone} time. Should I switch to {new zone} time?\" Once they answer, what they sent while the question was open is saved. Do not send it again.",
    input: z.strictObject({
      property: Property,
      address: z.string().max(200).optional(),
      name: z.string().max(120).optional(),
      propertyType: z.enum(PROPERTY_TYPES).optional(),
      timezone: z.string().max(60).optional(),
      facts: Facts.optional(),
      street: z.string().max(120).optional(),
      city: z.string().max(80).optional(),
      state: z.string().max(40).optional(),
      postalCode: z.string().max(10).optional(),
      confirmAddress: z.boolean().optional(),
      alertName: z.string().max(120).optional(),
      alertContact: z.string().max(200).optional(),
      visitorContact: z.string().max(30).optional(),
      skipVisitorHelp: z.boolean().optional(),
      buildingAccess: z.enum(["BUILDING_AND_UNIT", "UNIT_ONLY"]).optional(),
      entryInstructions: z.string().max(500).optional(),
      skipEntryInstructions: z.boolean().optional(),
    }),
    run: async (ctx, i) => {
      const ws = ctx.services.workspace;
      let id = i.property ? propertyIdOf(ctx, i.property) : ws.propertyIds().length === 1 ? ws.propertyIds()[0] : undefined;
      let stateBefore = "";
      let timezoneBefore = "";
      let timezone = i.timezone;
      let zoneAnswer: { timezone?: string; answered: boolean } = { answered: false };
      let held = undefined as ReturnType<typeof heldZoneFields>;
      if (id) {
        const before = ws.openDraft(id).draft;
        stateBefore = before.property.canonicalAddress?.state.trim() ?? "";
        timezoneBefore = before.property.timezone;
        const pending = switchQuestionForOffer(before);
        zoneAnswer = zoneSwitchAnswer(before, i.timezone);
        if (pending && !zoneAnswer.answered) {
          const incoming = fieldsToHold(i);
          if (holdZoneSwitchFields(before, incoming)) ws.persistEdit(before, ctx.now());
          return envelope(ctx, id, "next", incoming ? switchHoldReply(pending) : pending, { propertyId: id });
        }
        if (zoneAnswer.answered) timezone = zoneAnswer.timezone;
        held = heldZoneFields(before);
      }
      if (!id) {
        if (!i.address) return envelope(ctx, undefined, "next", "What's the street address?");
        const existing = ws.findByAddress(i.address);
        if (existing) {
          const address = savedFullAddress(ws.openDraft(existing).draft.property);
          return { ...envelope(ctx, existing, "done", `${address} is already set up. I'll keep working on that one.`), status: "already-exists" };
        }
        const messagingMode = defaultMessagingMode(servicesOf(ctx).installedMessaging?.());
        const draft = createPropertySetup({
          address: i.address,
          name: i.name,
          propertyType: i.propertyType,
          timezone,
          existingPropertyIds: ws.propertyIds(),
          messagingMode,
        });
        ws.saveDraft(draft);
        id = draft.property.id;
      }
      const propertyId = id;
      const everPublished = ws.wasEverPublished(propertyId);
      const applyDetails = !!(i.address || i.name !== undefined || i.propertyType || i.timezone || i.facts || i.street !== undefined || i.city !== undefined || i.state !== undefined || i.postalCode !== undefined || i.confirmAddress || i.buildingAccess || i.entryInstructions !== undefined || i.skipEntryInstructions || held);
      const apply = (dropPostal: boolean) => {
        const details = mergedZoneDetails(i, held, timezone, dropPostal);
        let result = ws.openDraft(propertyId).draft;
        if (applyDetails) {
          result = applySetupCommand(result, "setPropertyDetails", {
            name: details.name,
            address: details.address,
            propertyType: details.propertyType,
            timezone: details.timezone,
            facts: details.facts,
            street: details.street,
            city: details.city,
            state: details.state,
            postalCode: details.postalCode,
            confirmAddress: details.confirmAddress,
            buildingAccess: details.buildingAccess,
            entryInstructions: details.entryInstructions,
            skipEntryInstructions: details.skipEntryInstructions,
          }, { everPublished });
        }
        if (details.alertName !== undefined || details.alertContact !== undefined || details.visitorContact !== undefined || details.skipVisitorHelp) {
          result = applySetupCommand(result, "setAlertContact", {
            name: details.alertName,
            contact: details.alertContact,
            visitorContact: details.visitorContact,
            skipVisitorHelp: details.skipVisitorHelp,
          });
        }
        applyZoneSwitchAnswer(result, zoneAnswer);
        rememberZoneSwitch(result, stateBefore, timezone !== undefined);
        ws.persistEdit(result, ctx.now());
        return result;
      };
      if (zoneAnswer.answered) commitZoneAnswer(apply);
      else apply(false);
      const timezoneGiven = timezone !== undefined;
      const saved = ws.openDraft(propertyId).draft;
      const switchQuestion = zoneSwitchQuestion(stateBefore, saved, timezoneGiven);
      const guessed = guessedZoneName(stateBefore, timezoneBefore, saved, timezoneGiven);
      const canonical = saved.property.canonicalAddress;
      const part = nextAddressPartQuestion(canonical, { cityJustSaved: i.city !== undefined || held?.city !== undefined });
      const confirm = canonical && saved.property.addressConfirmed === false ? addressConfirmQuestion(canonical) : undefined;
      const typeQuestion = !saved.property.propertyType ? "Is this a single-family home, a multifamily home, or one apartment or condo?" : undefined;
      const nextQuestion = part ?? confirm ?? typeQuestion;
      if (switchQuestion) {
        const prefix = nextQuestion ? "" : `Saved ${saved.property.name}.`;
        return envelope(ctx, id, nextQuestion ? "next" : "done", zoneReply(prefix, switchQuestion, ""), { propertyId: id });
      }
      if (part) return envelope(ctx, id, "next", zoneReply("", "", guessed, part), { propertyId: id });
      if (confirm) return envelope(ctx, id, "next", zoneReply("", "", guessed, confirm), { propertyId: id, address: savedFullAddress(saved.property) });
      if (typeQuestion) return envelope(ctx, id, "next", zoneReply("", "", guessed, typeQuestion), { propertyId: id });
      return envelope(ctx, id, "done", zoneReply(`Saved ${saved.property.name}.`, "", guessed), { propertyId: id });
    },
  }),
  tool({
    name: "save_units",
    title: "Save units",
    kind: "change",
    description: "Adds, renames, or updates units and their leasing details.",
    input: z.strictObject({
      property: Property,
      details: z.string().max(2000).optional(),
      units: z.array(z.strictObject(UnitFields)).max(50).optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = open(ctx, i.property);
      if (!(i.units?.length || i.details)) return envelope(ctx, id, "next", "Which places can people tour?", { propertyId: id });
      let next = draft;
      for (const entry of i.units ?? []) {
        const wanted = entry.name ? canonicalUnitName(entry.name, next.property.propertyType).toLowerCase() : undefined;
        const existing = wanted ? next.units.find((unit) => unit.name.toLowerCase() === wanted) : undefined;
        if (!existing) {
          if (!entry.name && next.property.propertyType !== "SINGLE_FAMILY") {
            return envelope(ctx, id, "next", "What's the unit called?", { propertyId: id });
          }
          next = applySetupCommand(next, "addUnit", { name: entry.name, summary: entry.description, facts: entry.facts, doorName: entry.doorName });
        } else {
          if (entry.description !== undefined || entry.facts) {
            next = applySetupCommand(next, "setUnitDetails", { unitId: existing.id, summary: entry.description, facts: entry.facts });
          }
          if (entry.newName) next = applySetupCommand(next, "renameUnit", { unitId: existing.id, name: entry.newName, alsoRenameDoor: true });
          if (entry.doorName) {
            const unit = next.units.find((item) => item.id === existing.id);
            if (unit?.doorId) next = applySetupCommand(next, "renameDoor", { doorId: unit.doorId, name: entry.doorName });
          }
        }
        const values = profileValues(entry);
        if (Object.keys(values).length) {
          const unit = requireUnit(next, entry.newName || entry.name || next.units[next.units.length - 1]!.name);
          next = applySetupCommand(next, "setUnitProfile", { unitId: unit.id, values });
        }
      }
      if (i.details) {
        const bulk = parseBulkUnitDetails(i.details, next.units.map((unit) => unit.name));
        if (!bulk.units.length) {
          const only = next.property.propertyType === "SINGLE_FAMILY" && next.units.length === 1 ? next.units[0] : undefined;
          const values = extractValues(i.details);
          if (!only || !Object.keys(values).length) {
            return envelope(ctx, id, "next", "I couldn't match those details to a place yet.", { propertyId: id });
          }
          next = applySetupCommand(next, "setUnitProfile", { unitId: only.id, values });
        }
        for (const entry of bulk.units) {
          const unit = requireUnit(next, entry.unit);
          next = applySetupCommand(next, "setUnitProfile", { unitId: unit.id, values: entry.values });
        }
      }
      ctx.services.workspace.persistEdit(next, ctx.now());
      const saved = ctx.services.workspace.openDraft(id).draft;
      return envelope(ctx, id, "done", savedPlaces(saved.units.map((unit) => unit.name), saved.property.propertyType), { propertyId: id });
    },
  }),
  tool({
    name: "save_doors_and_routes",
    title: "Save doors and routes",
    kind: "change",
    description: "Saves doors and walking routes, or with preview true only shows the matched route.",
    input: z.strictObject({
      property: Property,
      preview: z.boolean().optional().describe("When true, returns the matched route and does not save."),
      doors: z.array(z.strictObject({ name: z.string().min(1).max(100), kind: z.enum(["entrance", "hallway"]) })).max(20).optional(),
      routes: z
        .array(
          z.strictObject({
            unit: z.string().min(1).max(100),
            doors: z.array(z.string().min(1).max(100)).min(1).max(12),
            directions: z.string().max(300).optional(),
          }),
        )
        .max(50)
        .optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = open(ctx, i.property);
      let scratch = draft;
      if (i.doors?.length) {
        for (const door of i.doors) {
          const named = canonicalDoor({
            name: door.name,
            kind: door.kind === "entrance" ? "ENTRANCE" : "COMMON",
            propertyType: scratch.property.propertyType,
          });
          const exists = scratch.doors.some((item) => item.name.toLowerCase() === named.name.toLowerCase());
          if (exists) continue;
          scratch = applySetupCommand(scratch, "addDoor", { name: door.name, kind: door.kind === "entrance" ? "ENTRANCE" : "COMMON" });
        }
      }
      const matched: { unit: string; doors: string[] }[] = [];
      for (const route of i.routes ?? []) {
        const unit = requireUnit(scratch, route.unit);
        const names: string[] = [];
        for (const ref of route.doors) {
          const found = resolveRouteDoor(scratch, ref, unit);
          if (found.question) return envelope(ctx, id, "next", found.question, { propertyId: id });
          if (!found.door) return envelope(ctx, id, "next", `I don't have "${ref}" on file yet.`, { propertyId: id }, "UNKNOWN_DOORS");
          names.push(found.door.name);
        }
        matched.push({ unit: landlordPlace(unit.name, scratch.property.propertyType), doors: names });
        if (!i.preview) {
          const ids = names.map((name) => scratch.doors.find((door) => door.name === name)!.id);
          scratch = applySetupCommand(scratch, "setRoute", { unitId: unit.id, doorIds: ids, directions: route.directions, onlyIfValid: true });
        }
      }
      if (i.preview) {
        return envelope(ctx, id, "next", walkingRouteLine(scratch.property.propertyType, matched, true), { propertyId: id, preview: true, routes: matched });
      }
      if (i.doors?.length || i.routes?.length) ctx.services.workspace.persistEdit(scratch, ctx.now());
      const saved = ctx.services.workspace.openDraft(id).draft;
      if (!saved.routes.length) return envelope(ctx, id, "next", "How does someone walk in, from the front door to the door they tour?", { propertyId: id, routes: matched });
      return envelope(ctx, id, "done", walkingRouteLine(scratch.property.propertyType, matched, false), {
        propertyId: id,
        routes: matched,
      });
    },
  }),
  tool({
    name: "save_hours",
    title: "Save touring hours",
    kind: "change",
    description:
      'Saves touring days and hours from everyday words. Different days can have different hours, like weekdays 9am-5pm and weekends 9am-8pm: one call per set of days. Once hours are saved, new days are added and the days not named keep their hours ("add Saturday and Sunday 9 AM to 8 PM" keeps the weekdays). Pass replace only when the host says to replace all the hours. Tours have to end later the same day. Tours must last 15 minutes to 4 hours, and starts must be 15 minutes to 8 hours apart.',
    input: z.strictObject({
      property: Property,
      days: z.union([z.string().max(80), z.array(z.string().max(20)).max(7)]).optional(),
      start: z.string().max(20).optional(),
      end: z.string().max(20).optional(),
      replace: z.boolean().optional().describe("True only when the host says these hours replace all the saved ones."),
      tourLength: Duration.optional(),
      newTourEvery: Duration.optional(),
      earlyArrival: Duration.optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = open(ctx, i.property);
      const parsed = parseHours(i);
      if (!Object.keys(parsed).length) return envelope(ctx, id, "next", "What days and times can people tour?");
      // The starting weekday default was never the host's choice, so the first save replaces it.
      const merge = !i.replace && hoursAlreadyChosen(ctx, id);
      const plan = planTourHours(draft, parsed, merge);
      if ("blocked" in plan) return envelope(ctx, id, "blocked", plan.blocked, { propertyId: id });
      if ("ask" in plan) return envelope(ctx, id, "next", plan.ask, { propertyId: id });
      ctx.services.workspace.persistEdit(plan.next, ctx.now());
      ctx.services.workspace.noteTourHoursConfirmed(id, ctx.now().toISOString());
      const hours = ctx.services.workspace.openDraft(id).draft.tourHours;
      return envelope(ctx, id, "done", `Tours run ${describeTourWindows(hours)}.`, { propertyId: id });
    },
  }),
  tool({
    name: "save_settings",
    title: "Save optional settings",
    kind: "change",
    description: "Saves the basic identity form (recommended) or no form, plus tour-update choices. No form asks first, because anyone who texts could book and get in without saying who they are.",
    input: z.strictObject({
      property: Property,
      verification: z.enum(["basic-form", "none"]).optional(),
      reuseForDays: z.number().int().optional(),
      preset: z.enum(["recommended", "problems-only"]).optional(),
      updates: z.array(z.enum(UPDATE_KINDS)).max(UPDATE_KINDS.length).optional(),
      skipAlerts: z.boolean().optional(),
      connectAlerts: z.boolean().optional(),
      confirmationCode: z.string().max(20).optional().describe("Only after the operator explicitly said yes to saving no form."),
    }),
    run: async (ctx, i) => {
      const hasProperty = i.property || ctx.services.workspace.propertyIds().length > 0;
      const opened = hasProperty ? open(ctx, i.property) : undefined;
      const modeBefore = opened?.draft.verificationMode;
      if (i.verification === "none" && opened && opened.draft.verificationMode !== "none") {
        const fingerprint = `none|${opened.draft.verificationMode}`;
        if (!i.confirmationCode) {
          const confirmation = ctx.confirmations.issue("no-form", opened.id, fingerprint, NO_FORM_QUESTION);
          return envelope(ctx, opened.id, "next", NO_FORM_QUESTION, { propertyId: opened.id, confirmation });
        }
        ctx.confirmations.redeem(i.confirmationCode, "no-form", opened.id, fingerprint);
      }
      if (i.verification || i.reuseForDays !== undefined) {
        if (!opened) return envelope(ctx, undefined, "next", "Which property should I save that for?");
        const reuse = reuseDaysRefusal(i.reuseForDays);
        if (reuse) return envelope(ctx, opened.id, "blocked", reuse, { propertyId: opened.id });
        const next = applySetupCommand(opened.draft, "setVerificationPolicy", {
          mode: i.verification,
          reuseForDays: i.reuseForDays,
          ...(i.verification === "none" ? { confirm: true } : {}),
        });
        ctx.services.workspace.persistEdit(next, ctx.now());
      }
      const inst = ctx.installation;
      if (i.skipAlerts) {
        if (!inst) return envelope(ctx, opened?.id, "blocked", TOUR_UPDATES_NOT_HERE, {}, "INSTALLATION_UNAVAILABLE");
        const state = inst.files.state();
        inst.files.writeState({ ...state, skipped: { ...state.skipped, OPERATOR_ALERTS: new Date(inst.now()).toISOString() } });
      }
      let posted: string | undefined;
      if ((i.preset || i.updates) && inst) {
        const state = inst.files.state();
        const before = enabledUpdates(state.operatorUpdates);
        const enabled = i.updates ?? (i.preset === "problems-only" ? PROBLEMS_ONLY : RECOMMENDED_UPDATES);
        const prefs = choosePreferences(state.operatorUpdates, enabled, new Date(inst.now()));
        inst.files.writeState({ ...state, operatorUpdates: prefs });
        const changed = before.length !== prefs.enabled.length || before.some((kind) => !prefs.enabled.includes(kind));
        if (changed && !i.skipAlerts) {
          const modeNow = opened ? ctx.services.workspace.openDraft(opened.id).draft.verificationMode : undefined;
          const identityChanged = i.verification !== undefined && modeNow !== modeBefore;
          const chosen = describeUpdates(prefs.enabled);
          const off = prefs.enabled.length === 0;
          const offClause = "tour updates are off, but I'll still tell you when a visitor asks for a different time";
          if (identityChanged) {
            const check = identityClause(modeNow);
            posted = off ? `${check}, and ${offClause}.` : `${check}, and I'll keep you posted on ${chosen}.`;
          } else posted = off ? `Got it. ${offClause.charAt(0).toUpperCase()}${offClause.slice(1)}.` : `Got it. I'll keep you posted on ${chosen}.`;
        }
      }
      if (i.connectAlerts) {
        if (!inst) return envelope(ctx, opened?.id, "blocked", TOUR_UPDATES_NOT_HERE, {}, "INSTALLATION_UNAVAILABLE");
        return envelope(ctx, opened?.id, "next", "Want me to tell you when someone books, starts, or finishes a tour, and when something needs you?", {
          secureSetup: secureSetupLink(inst, ctx.localUrl?.(), "operator-alerts"),
        });
      }
      const mode = opened ? ctx.services.workspace.openDraft(opened.id).draft.verificationMode : undefined;
      return envelope(ctx, opened?.id, "done", posted ?? settingsSentence(mode, !!i.skipAlerts), { propertyId: opened?.id });
    },
  }),
  tool({
    name: "run_checks",
    title: "Run the practice checks",
    kind: "change",
    description: "Runs the readiness check and a practice tour, including the connection, door-access, and alert self-tests.",
    input: z.strictObject({ property: Property, unit: z.string().min(1).max(100).optional() }),
    run: async (ctx, i) => {
      const { id, draft } = open(ctx, i.property);
      if (!draft.units.length || !draft.routes.some((route) => route.stops.length > 0)) {
        return envelope(ctx, id, "blocked", "This place doesn't have a walking route yet, so the practice tour can't run.", { propertyId: id }, "ROUTES_MISSING");
      }
      const services = servicesOf(ctx);
      const selfTest: Record<string, unknown> = {};
      if (ctx.installation) {
        const endpoint = await checkPublicEndpoint(ctx.installation, { attempts: 1, delayMs: 0 });
        const access = await testAccess(ctx.installation);
        const alerts = await testOperatorAlerts(ctx.installation);
        selfTest.endpoint = { ok: endpoint.ok, message: endpoint.message };
        selfTest.access = { ok: access.ok, message: access.message };
        selfTest.alerts = { ok: alerts.ok, message: alerts.message };
        if (!endpoint.ok) return envelope(ctx, id, "blocked", "The connection isn't ready yet. Ask me to run the checks again in a minute.", { propertyId: id, selfTest }, "ENDPOINT_NOT_READY");
        if (!access.ok) return envelope(ctx, id, "blocked", "Door access isn't answering. Ask me to run the checks again.", { propertyId: id, selfTest }, "ACCESS_NOT_READY");
      }
      const readiness = await readinessForProperty(services, id, ctx.now());
      if (!readiness.result.passed) {
        const failed = readiness.result.checks.flatMap((check) =>
          check.codes.map((code, index) => ({ code, message: check.problems[index] ?? "The check found something to fix." })),
        );
        const reason = failed[0]?.message ?? "The check found something to fix.";
        return envelope(ctx, id, "blocked", reason, { propertyId: id, selfTest }, "READINESS_FAILED");
      }
      const unitId = i.unit ? requireUnit(draft, i.unit).id : undefined;
      const outcome = await runPracticeTour(services, id, { unitId, now: ctx.now() });
      if (outcome.kind !== "ran" || !outcome.result.passed) {
        const reason = outcome.kind === "ran" ? (outcome.result.failure ?? "The practice tour didn't pass.") : "The practice tour didn't run.";
        return envelope(ctx, id, "blocked", reason, { propertyId: id, selfTest }, "PRACTICE_FAILED");
      }
      return envelope(ctx, id, "done", "The check passed, and the practice tour passed.", { propertyId: id, selfTest });
    },
  }),
  tool({
    name: "publish",
    title: "Publish for demo",
    kind: "consequential",
    description: "Publishes the property for demo after a yes to the confirmation it returns.",
    input: z.strictObject({
      property: Property,
      confirmationCode: z.string().max(20).optional().describe("Only after the operator explicitly said yes to the exact question this tool returned earlier."),
    }),
    run: async (ctx, i) => {
      // On the shared service a touring host's alerts go through their own routine. Publishing waits for it.
      const inst = ctx.installation;
      if (inst && isTenantWorker(inst.deploymentMode()) && !inst.sink().configured()) {
        return envelope(ctx, undefined, "blocked", ALERTS_NEEDED, { blockers: [ALERTS_NEEDED] }, "ALERTS_NEEDED");
      }
      const ws = ctx.services.workspace;
      const services = servicesOf(ctx);
      const id = propertyIdOf(ctx, i.property);
      const saved = ws.has(id) ? ws.load(id) : undefined;
      const blockers = saved
        ? [...publishGuards(services, id, saved.config.messagingMode), ...(await ws.publishBlockers(id, ctx.now()))]
        : [{ code: "NOT_SAVED", message: "Finish the setup answers first." }];
      if (blockers.length) {
        return envelope(ctx, id, "blocked", blockers[0]!.message, { propertyId: id, blockers: blockers.map((item) => item.message) }, blockers[0]!.code);
      }
      const { config, state } = saved!;
      const texting = visitorTexting(services, id, config.messagingMode);
      const local = usesLocalMessaging(config, services.installedMessaging?.());
      const accessDemo = config.accessMode === "durin-mock";
      const sentence = local ? localTestModeSentence(accessDemo) : modeSentence(texting.state === "connected", accessDemo);
      if (state.status === "PUBLISHED_FOR_DEMO") {
        return envelope(ctx, id, "done", `${config.property.name} is already published for demo. ${sentence}`, { propertyId: id, published: true });
      }
      const fingerprint = `${state.configHash}|${state.readiness?.checkedAt}|${state.dryTour?.ranAt}`;
      const question = `Everything passed. Do you want me to publish ${config.property.name} for demo?`;
      if (!i.confirmationCode) {
        const confirmation = ctx.confirmations.issue("publish", id, fingerprint, question);
        return envelope(ctx, id, "next", question, { propertyId: id, confirmation, published: false });
      }
      ctx.confirmations.redeem(i.confirmationCode, "publish", id, fingerprint);
      const result = await publishProperty(services, id, ctx.now());
      if (!result.published) {
        return envelope(ctx, id, "blocked", result.blockers[0]?.message ?? "It can't be published yet.", { propertyId: id, blockers: result.blockers.map((item) => item.message) }, result.blockers[0]?.code);
      }
      // The host needs the number to hand out; it is the one thing they can't look up anywhere else.
      const line = texting.state === "connected" ? services.messagingLine?.() : undefined;
      const number = line ? ` ${visitorsTextLine(line)}` : "";
      return envelope(ctx, id, "done", `${config.property.name} is published for demo. ${sentence}${number}`, { propertyId: id, published: true, ...(line ? { textingNumber: line } : {}) });
    },
  }),
];

function resolveRouteDoor(draft: TourCoreConfig, ref: string, unit: Unit): { door?: Door; question?: string } {
  const found = matchDoor(draft, ref, unit);
  if (found.kind === "exact" || found.kind === "inferred") return { door: found.item };
  const named = canonicalDoor({ name: ref, kind: "ENTRANCE", unitName: unit.name, propertyType: draft.property.propertyType });
  const hit = draft.doors.find((door) => door.name.toLowerCase() === named.name.toLowerCase());
  if (hit) return { door: hit };
  if (found.kind === "ambiguous") {
    return { question: `"${ref}" could be ${found.candidates.map((door) => door.name).join(" or ")}. Which one?` };
  }
  return {};
}

const TEXTING_NOT_HERE = "I can't set up texting from this chat. Whoever set up Tour Core for you can add it, then ask me to check it.";
const TOUR_UPDATES_NOT_HERE = "I can't change tour updates from this chat. Whoever set up Tour Core for you can turn them on or off on the private setup page.";

export { describeTourDays } from "./tourDayWords";

/** Hours-step sentence from the hours that are actually saved, every window. */
export function hoursStepSay(hours: TourHours): string {
  return `Tours run ${describeTourWindows(hours)}. Want to change that?`;
}

/** The host already picked hours (not just the starting default), so new days add to them. */
export function hoursAlreadyChosen(ctx: ToolContext, id: string): boolean {
  const ws = ctx.services.workspace;
  if (ws.hoursWereConfirmed(id)) return true;
  if (!ws.has(id)) return false;
  const { state } = ws.load(id);
  return state.status === "PUBLISHED_FOR_DEMO" || !!state.readiness?.passed || !!state.dryTour?.passed;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function routeThrough(doors: string[]): string {
  return doors.join(", then ");
}

/** A single-family route has no "the home:" label. A multi-unit route keeps "Unit A: ...". */
function walkingRouteLine(propertyType: string | undefined, matched: { unit: string; doors: string[] }[], preview: boolean): string {
  if (propertyType === "SINGLE_FAMILY") {
    const through = matched.map((route) => routeThrough(route.doors)).filter(Boolean).join(". ");
    if (!through) return preview ? "Nothing was saved." : "Saved the doors and the walking route.";
    return preview ? `The walking route is ${through}. Nothing was saved yet.` : `Saved the walking route: ${through}.`;
  }
  const line = matched.map((route) => `${route.unit}: ${routeThrough(route.doors)}`).join(". ");
  if (preview) return line ? `I have: ${line}. Nothing was saved.` : "Nothing was saved.";
  return line ? `${line}.` : "Saved the doors and the walking route.";
}

function landlordPlace(name: string, propertyType: string | undefined): string {
  if (propertyType === "SINGLE_FAMILY" && name.trim().toLowerCase() === "main home") return "the home";
  return name;
}

function savedPlaces(names: string[], propertyType: string | undefined): string {
  const shown = names.map((name) => landlordPlace(name, propertyType));
  if (!shown.length) return "Saved the places people can tour.";
  return `Saved ${joinList(shown)}.`;
}

function identityClause(mode: string | undefined): string {
  return mode === "none" ? "Visitors won't fill out an identity form" : "Visitors will fill out a basic identity form";
}

export function settingsSentence(mode: string | undefined, updatesOff: boolean): string {
  const updates = updatesOff ? "tour updates are off for now" : "tour updates stay as they are";
  return `${identityClause(mode)}, and ${updates}.`;
}

function profileValues(entry: Record<string, unknown>): Record<string, string | number | boolean> {
  const keys = ["bedrooms", "bathrooms", "monthlyRent", "availability", "squareFeet", "floor", "parking", "laundry", "pets", "utilities", "furnished", "features"];
  return Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key] as string | number | boolean]));
}

function parseHours(input: { days?: string | string[]; start?: string; end?: string; tourLength?: string | number; newTourEvery?: string | number; earlyArrival?: string | number }) {
  const out: Record<string, unknown> = {};
  if (input.days !== undefined) {
    const text = Array.isArray(input.days) ? input.days.join(", ") : input.days;
    const days = parseDays(text);
    if (!days) throw new SetupInputError("TOUR_DAYS_UNREADABLE", `I didn't understand the days "${text}". Try "weekdays", "every day" or "Mon-Sat".`);
    out.days = days;
  }
  for (const key of ["start", "end"] as const) {
    if (input[key] === undefined) continue;
    const parsed = parseTimeOfDay(input[key]!);
    if (!parsed) throw new SetupInputError("TOUR_TIME_UNREADABLE", `I didn't understand the time "${input[key]}". Try something like "9am" or "5:30 PM".`);
    out[key] = parsed;
  }
  const minutes = (value: string | number | undefined, label: string) => {
    if (value === undefined) return undefined;
    const parsed = typeof value === "number" ? value : parseMinutes(value);
    if (parsed === undefined) throw new SetupInputError("TOUR_MINUTES_UNREADABLE", `I didn't understand ${label} "${value}". Try "45 minutes" or "an hour".`);
    return parsed;
  };
  const length = minutes(input.tourLength, "the tour length");
  const spacing = minutes(input.newTourEvery, "how often tours start");
  const early = minutes(input.earlyArrival, "the early-arrival time");
  if (length !== undefined) out.tourLengthMinutes = length;
  if (spacing !== undefined) out.slotEveryMinutes = spacing;
  if (early !== undefined) out.earlyArrivalMinutes = early;
  return out;
}
