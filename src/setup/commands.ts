import { z } from "zod";
import { TourHoursSchema, validateConfig } from "../config/tourCoreConfig";
import {
  addDoor,
  addTourableSpace,
  removeDoor,
  removeUnit,
  renameDoor,
  renameUnit,
  setAlertContact,
  setPropertyDetails,
  setRoute,
  setServices,
  setTourHours,
  setUnitDetails,
  setUnitProfile,
  setVerificationPolicy,
  SetupInputError,
  type SetupDraft,
} from "./setupActions";
import { reuseDaysRefusal } from "../config/validateConfig";
import { NO_FORM_QUESTION } from "./verification";
import type { ProfileField } from "../config/unitProfile";

/**
 * Every draft edit a setup surface can make, with a typed input schema.
 * The browser calls these by name; a Grok Bot tool list can be generated
 * from the same table. Each command is a thin wrapper over a setup action.
 */

const Text = z.string();
const Facts = z.array(z.string());

function command<S extends z.ZodType>(input: S, run: (draft: SetupDraft, input: z.infer<S>) => SetupDraft) {
  return { input, run };
}

export const SETUP_COMMANDS = {
  setPropertyDetails: command(
    z.object({
      name: Text.optional(),
      address: Text.optional(),
      propertyType: Text.optional(),
      timezone: Text.optional(),
      facts: Facts.optional(),
      city: Text.optional(),
      state: Text.optional(),
      street: Text.optional(),
      postalCode: Text.optional(),
      confirmAddress: z.boolean().optional(),
      buildingAccess: Text.optional(),
      entryInstructions: Text.optional(),
      skipEntryInstructions: z.boolean().optional(),
    }),
    (d, i) => setPropertyDetails(d, i),
  ),
  setAlertContact: command(
    z.object({
      name: Text.optional(),
      contact: Text.optional(),
      visitorContact: Text.optional(),
      skipVisitorHelp: z.boolean().optional(),
    }),
    (d, i) => setAlertContact(d, i),
  ),
  /** Adds a unit together with its own door (named "<unit> Door" unless given). A single-family home's one space uses the home's entrance. */
  addUnit: command(z.object({ name: Text.optional(), summary: Text.optional(), facts: Facts.optional(), doorName: Text.optional() }), (d, i) => addTourableSpace(d, i)),
  renameUnit: command(z.object({ unitId: Text, name: Text, alsoRenameDoor: z.boolean().optional() }), (d, i) =>
    renameUnit(d, i.unitId, i.name, { alsoRenameDoor: i.alsoRenameDoor }),
  ),
  setUnitDetails: command(z.object({ unitId: Text, summary: Text.optional(), facts: Facts.optional() }), (d, i) =>
    setUnitDetails(d, i.unitId, { summary: i.summary, facts: i.facts }),
  ),
  /** Unit details in the operator's words: bedrooms, bathrooms, monthlyRent, availability, squareFeet, floor, parking, laundry, pets, utilities, furnished, features. */
  setUnitProfile: command(z.object({ unitId: Text, values: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])) }), (d, i) =>
    setUnitProfile(d, i.unitId, i.values as Partial<Record<ProfileField, string | number | boolean>>),
  ),
  removeUnit: command(z.object({ unitId: Text }), (d, i) => removeUnit(d, i.unitId)),
  addDoor: command(z.object({ name: Text, kind: z.enum(["ENTRANCE", "COMMON", "UNIT"]), unitId: Text.optional() }), (d, i) => addDoor(d, i).draft),
  renameDoor: command(z.object({ doorId: Text, name: Text }), (d, i) => renameDoor(d, i.doorId, i.name)),
  removeDoor: command(z.object({ doorId: Text }), (d, i) => {
    const door = d.doors.find((x) => x.id === i.doorId);
    if (door?.kind === "UNIT") throw new SetupInputError("UNIT_DOOR_LOCKED", "A unit's own door can't be removed. Remove the unit instead.");
    return removeDoor(d, i.doorId);
  }),
  /** With onlyIfValid, a route with problems is rejected (not saved) so nothing invalid is ever saved silently. */
  setRoute: command(z.object({ unitId: Text, doorIds: z.array(Text), directions: Text.optional(), onlyIfValid: z.boolean().optional() }), (d, i) => {
    const next = setRoute(d, i.unitId, i.doorIds, { directions: i.directions });
    if (i.onlyIfValid) {
      const problem = validateConfig(next).find((issue) => issue.section === "routes" && issue.unitId === i.unitId);
      if (problem) throw new SetupInputError("ROUTE_NOT_VALID", problem.message);
    }
    return next;
  }),
  setTourHours: command(TourHoursSchema.partial().extend({ merge: z.boolean().optional() }), (d, i) => setTourHours(d, i)),
  setVerificationPolicy: command(
    z.object({
      mode: z.enum(["basic-form", "none"]).optional(),
      reuseForDays: z.number().int().optional(),
      confirm: z.boolean().optional(),
    }),
    (d, i) => {
      if (i.mode === "none" && i.confirm !== true) throw new SetupInputError("NO_FORM_UNCONFIRMED", NO_FORM_QUESTION);
      const reuse = reuseDaysRefusal(i.reuseForDays);
      if (reuse) throw new SetupInputError("VERIFICATION_REUSE_INVALID", reuse);
      return setVerificationPolicy(d, { mode: i.mode, reuseForDays: i.reuseForDays });
    },
  ),
  setServices: command(
    z.object({
      messagingMode: z.preprocess((v) => (v === "sendblue" ? "live" : v), z.enum(["demo", "live"])).optional(),
      messagingProvider: z.enum(["local"]).optional(),
      storageMode: z.enum(["memory", "google-drive"]).optional(),
      accessMode: z.enum(["durin-mock", "durin"]).optional(),
    }),
    (d, i) => setServices(d, i),
  ),
};

export type SetupCommandName = keyof typeof SETUP_COMMANDS;

/** Server-owned facts. Clients cannot set these through the command input. */
export type SetupCommandContext = { everPublished?: boolean };

export function applySetupCommand(draft: SetupDraft, name: string, input: unknown, context?: SetupCommandContext): SetupDraft {
  const cmd = (SETUP_COMMANDS as Record<string, (typeof SETUP_COMMANDS)[SetupCommandName]>)[name];
  if (!cmd) throw new SetupInputError("UNKNOWN_ACTION", "That action isn't available.");
  const parsed = cmd.input.safeParse(input ?? {});
  if (!parsed.success) throw new SetupInputError("INPUT_INVALID", "Some of that information is missing or doesn't look right.");
  if (name === "setPropertyDetails") return setPropertyDetails(draft, parsed.data as Parameters<typeof setPropertyDetails>[1], context);
  return (cmd.run as (d: SetupDraft, i: unknown) => SetupDraft)(draft, parsed.data);
}
