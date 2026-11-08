# Property Core Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The repo, package, plugin marketplace, settings and docs say Property Core (saadvz/TourCore#179), and every existing deployment, saved secret, config file and clone keeps working.

**Architecture:** `TOURCORE_*` settings keep their names (the owner's choice on #179), so deployments, `.env` files and saved secrets need nothing. Stored door-access identifiers are read in both spellings and written in the new one. Wire and storage names that clients or volumes depend on (cookies, headers, Railway service/volume names, hosted URLs, data folder names) are left as they are.

**Tech Stack:** TypeScript, Node 22, zod, vitest.

**Spec:** saadvz/TourCore#179 and its comment adding the stored lock-provider identifiers from #176.

## Global Constraints

- `TOURCORE_*` environment and secret names stay as they are.
- New repository: `https://github.com/saadvz/PropertyCore`. The old URL stays accepted as the origin of existing clones.
- Package name `property-core`; marketplace name `property-core`.
- Door-access values that named the lock provider become `door-demo`, `door`, `DOOR_DEMO`, `DENY_DOOR_UNHEALTHY` and `doorGrantRef`. The old spellings (listed once, in `LEGACY_ACCESS_MODES`, `currentDecisionCode`, `upgradeAccessGrant` and the manifest schema) are read; the new ones are written. Saved fingerprints keep the old access-mode spelling so a published property stays published.
- The parked product keeps its own name "Tour Core" (TourCore class, docs/tour-core, `TOUR_CORE_TENANTS`).
- Untouched on purpose: Railway service, project and volume names, hosted URLs, cookie and header names, `tourcore-data`, `tourcore.config.json`, backup format ids.

## Review Focus

- A clone whose origin is still `github.com/saadvz/TourCore` passes the bootstrap origin check.
- A demo config, manifest or access grant saved with the old lock-provider spellings still loads, and a published property stays published.

---

### Task 1: Door-access stored identifiers

**Files:** `src/config/tourCoreConfig.ts`, `src/setup/commands.ts`, `src/install/manifest.ts`, `src/domain/model.ts`, `src/policy/evaluateAccess.ts`, `src/audit/describe.ts`, `src/operator/exceptions.ts` and their users; `config/demo-property.json`; `test/lockProviderName.test.ts` (empty the allowlist).
**Test:** `test/doorAccessLegacyValues.test.ts`: old values parse to new ones in config, setup command, manifest and grant; describe() still words an old audit code.

### Task 2: Labels, package, marketplace and repository URL

**Files:** `package.json`, `package-lock.json`, `.claude-plugin/marketplace.json`, plugin install commands in templates and docs, `src/web/server.ts` and `src/mcp/oauth/{provider,pages}.ts` (`"Tour Core and Cleaner Core"` → `"Property Core"`), `src/install/repoSource.ts` and `grok-template/template.json` (`formerUrls`), `.railway/railway.ts` source, every `saadvz/TourCore` outside docs/superpowers.
**Test:** `test/repoSource*.test.ts` accepts the former URL; consent page test says Property Core.

### Task 3: Docs

`docs/environment-variables.md` keeps saying `TOURCORE_*` names stay; README, AGENTS, deployment docs say Property Core where they mean the repo.
