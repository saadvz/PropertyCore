import { defineRailway, github, project, service, volume } from "railway/iac";

/**
 * Distributor configuration for the one shared Railway service: touring and
 * cleaning for every host, one tenant and one Twilio number each.
 * Landlords do not create a Railway project. This file has no secrets and
 * no generated domain: Railway assigns RAILWAY_PUBLIC_DOMAIN when a public
 * domain is generated. Apply with `railway config plan` then
 * `railway config apply`. GitHub pushes deploy the connected branch; they
 * do not apply this file by themselves.
 *
 * Set in Railway's variables, never here: CLEANER_CORE_ADMIN_PASSWORD,
 * CLEANER_CORE_TWILIO_ACCOUNT_SID, CLEANER_CORE_TWILIO_AUTH_TOKEN,
 * CLEANER_CORE_LIVE_SMS, and CLEANER_CORE_SMS_ALLOWLIST.
 *
 * Config-as-code railway.json is not used. New Railway services cannot opt
 * into it, and it stops being read on 2026-12-01.
 */
export default defineRailway(() => {
  const data = volume("tourcore-data", { sizeMB: 1024 });
  const web = service("tour-core", {
    source: github("saadvz/TourCore", { branch: "master" }),
    build: "npm run build",
    start: "npm start",
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
      TOURCORE_HOME: "/data",
      // One service, many hosts: invite codes, /admin, and a tenant per host.
      CLEANER_CORE_MULTI_TENANT: "1",
      CLEANER_CORE_ENABLED: "1",
      // Touring tenants, each in its own Tour Core process. "0" offers cleaning only.
      TOUR_CORE_TENANTS: "0",
      // Do not set TOURCORE_GROK_LEGACY_OAUTH_COMPAT. HOSTED_RAILWAY_P0
      // accepts the known Grok callbacks unless that variable is false.
      // Do not set an owner-claim secret. The first Allow claims the demo.
      NODE_ENV: "production",
      // Railpack's default is `npm install`. `npm ci` installs this lockfile.
      // NPM_CONFIG_PRODUCTION=false keeps esbuild and the TypeScript toolchain
      // available for `npm run build` even when NODE_ENV is production.
      RAILPACK_NODE_NPM_INSTALL: "npm ci",
      NPM_CONFIG_PRODUCTION: "false",
      // node:sqlite backups need Node 22.13 or newer. Railpack installs this exact version.
      RAILPACK_NODE_VERSION: "22.14.0",
    },
  });
  return project("tour-core", { resources: [web, data] });
});
