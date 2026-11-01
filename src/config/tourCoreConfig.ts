import { readFileSync } from "node:fs";
import { z } from "zod";
import { WEEKDAYS } from "../core/timezone";
import { UnitProfileSchema } from "./unitProfile";
import { semanticIssues, type ConfigIssue, type ConfigSection } from "./validateConfig";

const Id = z.string().regex(/^[a-z0-9_]+$/, "ids use lowercase letters, digits and underscores");
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM");

export const DEMO_VERIFICATION_FORM_URL = "https://forms.example/tour-core-basic-id";

export const DoorSchema = z.object({
  id: Id,
  name: z.string(),
  /** COMMON = hallway, stairwell or other shared door a route can pass through. */
  kind: z.enum(["ENTRANCE", "UNIT", "COMMON"]),
});

/**
 * Operator-approved facts only. Tour Core never invents or generates these;
 * tour guidance may only repeat what is stored here.
 */
const ApprovedFacts = z.array(z.string()).default([]);

export const UnitSchema = z.object({
  id: Id,
  name: z.string(),
  /** Empty until the unit's door is added during setup. */
  doorId: z.string(),
  /** Short operator-written description, e.g. "One-bedroom on the first floor." */
  summary: z.string().default(""),
  facts: ApprovedFacts,
  /** Minimum leasing information (bedrooms, bathrooms, rent, availability, ...). Absent until asked. */
  profile: UnitProfileSchema.optional(),
  /**
   * Landlord-set lobby / wayfinding instructions for an apartment or condo unit.
   * Absent when skipped. Never stored as a blank string.
   */
  entryInstructions: z.string().min(1).optional(),
});

export const RouteSchema = z.object({
  id: Id,
  unitId: z.string(),
  /** Operator's own words for getting from the entrance to the unit. */
  directions: z.string().optional(),
  stops: z.array(z.object({ doorId: z.string(), guidance: z.string() })),
});

export const PROPERTY_TYPES = ["SINGLE_FAMILY", "MULTIFAMILY_HOME", "APARTMENT_OR_CONDO", "APARTMENT_BUILDING", "OTHER"] as const;
export const PropertyTypeSchema = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof PropertyTypeSchema>;

/** Types offered during setup. Whole-building apartments and "Other" stay readable on older files. */
export const SETUP_PROPERTY_TYPES = ["SINGLE_FAMILY", "MULTIFAMILY_HOME", "APARTMENT_OR_CONDO"] as const;
export type SetupPropertyType = (typeof SETUP_PROPERTY_TYPES)[number];

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  SINGLE_FAMILY: "Single-family home",
  MULTIFAMILY_HOME: "Multifamily (duplex / small building you own)",
  APARTMENT_OR_CONDO: "Apartment or condo (one unit)",
  APARTMENT_BUILDING: "Apartment building",
  OTHER: "Other",
};

export const BUILDING_ACCESS = ["BUILDING_AND_UNIT", "UNIT_ONLY"] as const;
export const BuildingAccessSchema = z.enum(BUILDING_ACCESS);
export type BuildingAccess = z.infer<typeof BuildingAccessSchema>;

export const BUILDING_ACCESS_LABELS: Record<BuildingAccess, string> = {
  BUILDING_AND_UNIT: "I control the building entrance",
  UNIT_ONLY: "I only control the unit door",
};

export const PropertySchema = z.object({
  id: Id,
  /**
   * How visitors and the operator hear the property named: the operator's own
   * displayName when they gave one, otherwise the canonical address. Kept in
   * step with those two by the setup actions; never an invented nickname.
   */
  name: z.string(),
  /** The canonical physical address. Authoritative for the property's identity. */
  address: z.string(),
  /**
   * Street, city, state and ZIP kept apart from any internal label. Absent on
   * setups saved before this was recorded. A missing ZIP means the address
   * isn't finished.
   */
  canonicalAddress: z
    .object({
      street: z.string(),
      city: z.string(),
      state: z.string(),
      unit: z.string().optional(),
      postalCode: z.string().optional(),
      formatted: z.string(),
    })
    .optional(),
  /** The operator confirmed the read-back. Absent means an older setup, which is already in use. */
  addressConfirmed: z.boolean().optional(),
  /** A property or building name the operator said themselves. Absent means "use the address". */
  displayName: z.string().optional(),
  /** Asked right after the address, never inferred from it. Shapes which setup questions are asked. */
  propertyType: PropertyTypeSchema.optional(),
  /**
   * Apartment or condo only: whether the landlord can open the building
   * entrance as well as the unit door. Absent until asked.
   */
  buildingAccess: BuildingAccessSchema.optional(),
  /**
   * The optional apartment/condo entry-instructions question was answered
   * (with instructions or an explicit skip). Absent on older setups.
   */
  entryInstructionsDecided: z.boolean().optional(),
  /**
   * IANA zone, e.g. America/New_York. All tour hours are read in this zone.
   * A file with the field missing is the same as an empty zone: tours stay off
   * until one is set. The file is not rewritten just to fill this in.
   */
  timezone: z.string().default(""),
  /**
   * The operator set this time zone, or confirming the address locked it.
   * Absent while a never-published setup still has an unconfirmed address,
   * so a later state can replace that guess. Never stored as false.
   * A published property keeps its zone even when this is absent.
   */
  timezoneConfirmed: z.boolean().optional(),
  /**
   * An unanswered "should I switch" question. A string is an older offer:
   * just the IANA zone, with no held fields. The object form names that zone
   * and may hold address fields that arrived while the question was open.
   * Absent once the operator answers. A ZIP is not an answer.
   */
  zoneSwitchOffer: z
    .union([
      z.string(),
      z.object({
        zone: z.string(),
        held: z
          .object({
            name: z.string().optional(),
            address: z.string().optional(),
            propertyType: z.string().optional(),
            street: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            postalCode: z.string().optional(),
            confirmAddress: z.boolean().optional(),
            facts: z.array(z.string()).optional(),
            buildingAccess: z.string().optional(),
            entryInstructions: z.string().optional(),
            skipEntryInstructions: z.boolean().optional(),
            alertName: z.string().optional(),
            alertContact: z.string().optional(),
            visitorContact: z.string().optional(),
            skipVisitorHelp: z.boolean().optional(),
          })
          .optional(),
      }),
    ])
    .optional(),
  facts: ApprovedFacts,
});

/** One set of days that share the same touring hours, like weekdays 9-5. */
export const TourWindowSchema = z.object({
  days: z.array(z.enum(WEEKDAYS)),
  start: TimeOfDay,
  end: TimeOfDay,
});

export const TourHoursSchema = z.object({
  /** Every day with tours. With `windows`, this is all of their days together. */
  days: z.array(z.enum(WEEKDAYS)),
  /** The first window's hours. Older files hold only this one window. */
  start: TimeOfDay,
  end: TimeOfDay,
  /**
   * Different hours on different days, like weekdays 9-5 and weekends 9-8.
   * Absent (or one entry) means one window: `days` from `start` to `end`.
   * A day sits in at most one window. Read it with `tourWindows`.
   */
  windows: z.array(TourWindowSchema).optional(),
  slotEveryMinutes: z.number().int(),
  tourLengthMinutes: z.number().int(),
  earlyArrivalMinutes: z.number().int(),
});

/**
 * The single configuration object for a Tour Core install. The setup flow
 * (terminal today, Grok Bot later) produces exactly this. Shape only; meaning
 * is checked by validateConfig so problems come back in plain language.
 */
export const TourCoreConfigShape = z.object({
  schemaVersion: z.literal(1),
  property: PropertySchema,
  operator: z.object({
    name: z.string(),
    /** Private alert line. Never shown to visitors. */
    contact: z.string(),
    /**
     * Optional number visitors see and call when they're stuck. Someone
     * should answer it during tour hours. Separate from `contact` on
     * purpose: that line is for the team, not prospects.
     */
    visitorContact: z.string().optional(),
    /**
     * The operator answered the optional visitor-help-number step
     * (with a number or an explicit skip). Absent on older setups.
     */
    visitorHelpDecided: z.boolean().optional(),
  }),
  doors: z.array(DoorSchema),
  units: z.array(UnitSchema),
  routes: z.array(RouteSchema),
  tourHours: TourHoursSchema,
  /**
   * `basic-form` and `none` are the choices a setup can save.
   * `mock` and `document-check` remain so older files still parse; readers
   * treat both as `basic-form` and writers do not store them again.
   */
  verificationMode: z.enum(["basic-form", "none", "mock", "document-check"]),
  verificationFormUrl: z.url().optional(),
  /** How many days before a visitor who already filled out the form is asked again. No form does not expire. */
  verificationValidForDays: z.number().int(),
  /**
   * "demo" prints messages. "live" texts real phones through the installation's
   * messaging provider (Sendblue, Twilio, or Photon), unless this property
   * opts into local loopback via `messagingProvider`. Older files say
   * "sendblue" for this same live mode.
   */
  messagingMode: z.preprocess((v) => (v === "console" ? "demo" : v === "sendblue" ? "live" : v), z.enum(["demo", "live"])),
  /**
   * Optional override for this property. `"local"` uses the QA loopback
   * (inject / outbox) while the installation's primary provider stays in
   * place for other buildings. Absent means inherit the installation.
   * Per-property live carriers are a later slice.
   */
  messagingProvider: z.enum(["local"]).optional(),
  storageMode: z.enum(["memory", "google-drive"]),
  accessMode: z.enum(["durin-mock", "durin"]),
});

export type TourCoreConfig = z.infer<typeof TourCoreConfigShape>;
export type Door = z.infer<typeof DoorSchema>;
export type Unit = z.infer<typeof UnitSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Property = z.infer<typeof PropertySchema>;
export type TourHours = z.infer<typeof TourHoursSchema>;
export type TourWindow = z.infer<typeof TourWindowSchema>;

/** Real visitor texting, including property files saved before the mode was renamed from "sendblue". */
export function isLiveMessaging(mode: string | undefined): boolean {
  return mode === "live" || mode === "sendblue";
}

/** Shape + meaning. Anything that parses with this is safe to run tours on. */
export const TourCoreConfigSchema = TourCoreConfigShape.superRefine((cfg, ctx) => {
  for (const issue of semanticIssues(cfg)) ctx.addIssue({ code: "custom", message: issue.message, path: [issue.section], params: { code: issue.code } });
});

const SECTION_BY_KEY: Record<string, ConfigSection> = {
  schemaVersion: "property",
  property: "property",
  operator: "property",
  doors: "units",
  units: "units",
  routes: "routes",
  tourHours: "hours",
  verificationMode: "verification",
  verificationFormUrl: "verification",
  verificationValidForDays: "verification",
  messagingMode: "services",
  messagingProvider: "services",
  storageMode: "services",
  accessMode: "services",
};

const SHAPE_MESSAGE: Record<ConfigSection, string> = {
  property: "Some property details are missing or unreadable.",
  units: "Some unit or door details are missing or unreadable.",
  routes: "Some route details are missing or unreadable.",
  hours: "The tour hours aren't filled in correctly.",
  verification: "The visitor check settings aren't filled in correctly.",
  services: "The records, messages or door settings aren't filled in correctly.",
};

/** Every problem with a config, in plain language, with a machine-readable code. Empty = valid. */
export function validateConfig(input: unknown): ConfigIssue[] {
  const shape = TourCoreConfigShape.safeParse(input);
  if (shape.success) return semanticIssues(shape.data);
  const bySection = new Map<ConfigSection, ConfigIssue>();
  for (const issue of shape.error.issues) {
    const section = SECTION_BY_KEY[String(issue.path[0])] ?? "property";
    const detail = `${issue.path.join(".")}: ${issue.message}`;
    const existing = bySection.get(section);
    if (existing) existing.detail = `${existing.detail}; ${detail}`;
    else bySection.set(section, { code: "SHAPE_INVALID", section, message: SHAPE_MESSAGE[section], detail });
  }
  return [...bySection.values()];
}

export const DEMO_CONFIG_PATH = new URL("../../config/demo-property.json", import.meta.url);

export function loadConfig(path: string | URL = DEMO_CONFIG_PATH): TourCoreConfig {
  return TourCoreConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
