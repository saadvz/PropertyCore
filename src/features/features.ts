import { cameraTokenKey } from "../cameras/accounts";

/**
 * Per-account feature switches (saadvz/PropertyCore#236's roadmap features). Each account keeps its own switch per
 * feature in tenants.json, off by default, changed only on /admin. `featureOn` is the one rule every check goes
 * through: the account's switch, the service's emergency off list, and, for locks and cameras, the service's
 * credentials. Nothing an agent calls can change a switch.
 *
 * Background-only recording isn't here: the visit log is always written, because it only records and sends nothing.
 */

export const FEATURES = ["visits", "hours", "stay-check", "guest-messages", "packages", "oversight", "booking-platforms", "locks", "guest-codes", "cameras"] as const;

export type Feature = (typeof FEATURES)[number];

/** What /admin calls each switch, and what it turns on for the account. */
export const FEATURE_INFO: Record<Feature, { title: string; covers: string }> = {
  visits: { title: "Visit records", covers: "The visit tools, the late-cleaner text and the host's visit notes, routine vendor visits, and service notices. The visit log itself is always written." },
  hours: { title: "Hours log", covers: "The hours log tools." },
  "stay-check": { title: "Nightly stay check", covers: "The house rules tools." },
  "guest-messages": { title: "Guest messages", covers: "The guest-message tools, the agent's guest-message instruction, and late checkout." },
  packages: { title: "Package arrivals", covers: "The package tools, and bring-in codes on connected locks." },
  oversight: { title: "Expected visits", covers: "The expected visit tools." },
  "booking-platforms": { title: "Booking platforms", covers: "Booking emails from Vrbo, Booking.com, the host's own site and others, and the setup question." },
  locks: { title: "Connected locks", covers: "The lock tools, the lock partner's events, and per-visit codes. Needs SEAM_API_KEY and SEAM_WEBHOOK_SECRET on the service." },
  "guest-codes": { title: "Guest codes", covers: "Each stay's own code and leases. Needs Connected locks on for this account." },
  cameras: { title: "Cameras", covers: "The Ring camera connection and its tools. Needs CAMERA_TOKEN_KEY and the three RING_* secrets on the service." },
};

export interface FeatureSwitch {
  on: boolean;
  changedAt: string;
  /** Who changed it: "admin" for the /admin page, the only place a switch changes. */
  changedBy: string;
}

export type FeatureSwitches = Partial<Record<Feature, FeatureSwitch>>;

/** Anything that keeps feature switches: an account in tenants.json. */
export interface FeatureAccount {
  features?: FeatureSwitches;
}

/** The emergency off list on the service: features shut off for every account, whatever /admin says. */
export const FEATURES_OFF = "FEATURES_OFF";

/**
 * Carries one account's switches (those it has on, nothing more) into that account's own desk environment, so code
 * that only holds an environment still asks `featureOn`. The process value is never used on the shared service:
 * buildTenantEnv drops it and writes the account's own.
 */
export const ACCOUNT_FEATURES = "PROPERTY_CORE_ACCOUNT_FEATURES";

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/** The names in a comma list that are features; "all" names every one. */
function namesIn(raw: string | undefined): { features: Set<Feature>; unknown: string[] } {
  const features = new Set<Feature>();
  const unknown: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (name === "all") for (const feature of FEATURES) features.add(feature);
    else if (isFeature(name)) features.add(name);
    else unknown.push(name);
  }
  return { features, unknown };
}

/** The features FEATURES_OFF shuts off, and any name in it that isn't a feature (for the startup log). */
export function featuresOff(env: NodeJS.ProcessEnv): { features: Set<Feature>; unknown: string[] } {
  return namesIn(env[FEATURES_OFF]);
}

const set = (value: string | undefined) => Boolean(value?.trim());

/** The lock partner's key and webhook secret are both on the service. */
export function locksConfigured(env: NodeJS.ProcessEnv): boolean {
  return set(env.SEAM_API_KEY) && set(env.SEAM_WEBHOOK_SECRET);
}

/** A valid CAMERA_TOKEN_KEY and Ring's three secrets are on the service. */
export function camerasConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(cameraTokenKey(env)) && set(env.RING_CLIENT_ID) && set(env.RING_CLIENT_SECRET) && set(env.RING_WEBHOOK_SECRET);
}

export type FeatureState = { on: true } | { on: false; why: "no-account" | "switch-off" | "emergency-off" | "no-credentials" | "needs-locks" };

/** Whether a feature is on for an account, and if not, why. `featureOn` is this, as a yes or no. */
export function featureState(account: FeatureAccount | undefined, feature: Feature, env: NodeJS.ProcessEnv): FeatureState {
  if (!account) return { on: false, why: "no-account" };
  if (featuresOff(env).features.has(feature)) return { on: false, why: "emergency-off" };
  if (feature === "locks" && !locksConfigured(env)) return { on: false, why: "no-credentials" };
  if (feature === "cameras" && !camerasConfigured(env)) return { on: false, why: "no-credentials" };
  if (account.features?.[feature]?.on !== true) return { on: false, why: "switch-off" };
  if (feature === "guest-codes" && !featureOn(account, "locks", env)) return { on: false, why: "needs-locks" };
  return { on: true };
}

/**
 * The one rule: a feature is on for an account only when its own switch is on (off by default), the service's
 * FEATURES_OFF doesn't name it, and, for locks and cameras, the service has their credentials. Guest codes also need
 * connected locks on for the same account. One account's switch never reaches another's.
 */
export function featureOn(account: FeatureAccount | undefined, feature: Feature, env: NodeJS.ProcessEnv): boolean {
  return featureState(account, feature, env).on;
}

/** The value buildTenantEnv writes under ACCOUNT_FEATURES: the features this account's own switches have on. */
export function accountFeaturesValue(account: FeatureAccount): string {
  return FEATURES.filter((feature) => account.features?.[feature]?.on === true).join(",");
}

/** The account a desk's environment carries, as `featureOn` reads it. */
export function deskAccount(env: NodeJS.ProcessEnv): FeatureAccount {
  const features: FeatureSwitches = {};
  for (const feature of namesIn(env[ACCOUNT_FEATURES]).features) features[feature] = { on: true, changedAt: "", changedBy: "" };
  return { features };
}

/** `featureOn` for the account whose desk this environment belongs to. */
export function deskFeatureOn(env: NodeJS.ProcessEnv, feature: Feature): boolean {
  return featureOn(deskAccount(env), feature, env);
}

/** The service-wide flags these switches replaced. Nothing reads them; startup only says so if one is still set. */
export const RETIRED_FLAGS = ["VISIT_RECORDS", "HOURS_LOG", "STAY_CHECK", "GUEST_MESSAGES", "PACKAGE_ARRIVALS", "REMOTE_OVERSIGHT", "BOOKING_PLATFORMS", "SMART_LOCKS", "GUEST_CODES", "CAMERAS", "FIXER_CORE"] as const;

/** At startup: what FEATURES_OFF shuts off, any name in it that isn't a feature, and any retired flag still set. Never a value of a secret. */
export function logFeatureSettings(env: NodeJS.ProcessEnv, log: (line: string) => void): void {
  const off = featuresOff(env);
  if (off.features.size > 0) log(`FEATURES_OFF shuts off for every account: ${[...off.features].join(", ")}.`);
  if (off.unknown.length > 0) log(`FEATURES_OFF names no such feature: ${off.unknown.join(", ")}. The features are ${FEATURES.join(", ")}.`);
  const retired = RETIRED_FLAGS.filter((name) => env[name] !== undefined);
  if (retired.length > 0) log(`${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} no longer read: delete ${retired.length === 1 ? "it" : "them"} on Railway. Features are switched per account on /admin.`);
}
