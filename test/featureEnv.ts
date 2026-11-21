import { ACCOUNT_FEATURES, type Feature } from "../src/features/features";
import type { TenantRegistry } from "../src/cleaner-core/hosted/registry";

/**
 * Feature switches for tests. Made-up credentials only: nothing here reaches the lock partner or Ring, and every
 * test that uses them sets the fake adapter or fake provider.
 */

/** Made-up lock partner credentials, so featureOn finds locks configured. */
export const FAKE_LOCK_CREDENTIALS = { SEAM_API_KEY: "test-seam-key-not-real", SEAM_WEBHOOK_SECRET: "test-seam-webhook-not-real" } as const;

/** Made-up Ring credentials; CAMERA_TOKEN_KEY comes from the test, since it must be 32 bytes. */
export const FAKE_RING_CREDENTIALS = { RING_CLIENT_ID: "test-ring-id", RING_CLIENT_SECRET: "test-ring-secret-not-real", RING_WEBHOOK_SECRET: "test-ring-webhook-not-real" } as const;

/** The service credentials the named features need: locks for locks and guest codes, Ring for cameras. */
export function credentialsFor(features: readonly Feature[]): NodeJS.ProcessEnv {
  return {
    ...(features.includes("locks") || features.includes("guest-codes") ? FAKE_LOCK_CREDENTIALS : {}),
    ...(features.includes("cameras") ? FAKE_RING_CREDENTIALS : {}),
  };
}

/**
 * A desk's environment for an account with these switches on, as buildTenantEnv writes it, with the made-up
 * credentials those features need. Guest codes bring locks along, as /admin requires.
 */
export function deskFeatures(...features: Feature[]): NodeJS.ProcessEnv {
  const on = new Set<Feature>(features);
  if (on.has("guest-codes")) on.add("locks");
  return { [ACCOUNT_FEATURES]: [...on].join(","), ...credentialsFor([...on]) };
}

/** Turns these switches on for one account, as /admin does. */
export function switchOn(registry: TenantRegistry, tenantId: string, ...features: Feature[]): void {
  for (const feature of features) registry.setFeature(tenantId, feature, true, "admin");
}
