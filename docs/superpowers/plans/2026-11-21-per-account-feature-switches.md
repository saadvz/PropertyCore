# Per-account feature switches: plan

Design: `docs/superpowers/specs/2026-11-21-per-account-feature-switches-design.md`.

1. `src/features/features.ts`: the feature list, `featureOn` and `featureState`, `FEATURES_OFF`, the lock and camera
   credential checks, the desk environment's `PROPERTY_CORE_ACCOUNT_FEATURES` and `deskFeatureOn`, and the startup
   log.
2. `tenants.json`: `features` and `featureChanges` on each account; `TenantRegistry.setFeature(id, feature, on, by)`.
3. `buildTenantEnv`: write the account's own switches; drop the process value; keep the service's credentials and
   `FEATURES_OFF` from being replaced by an account's saved secrets.
4. `/admin`: a Features section on each account's page (switch, what `featureOn` makes of it, last change) and
   `POST /admin/tenants/<id>/features`; a "Features on" column on the account list.
5. Every check moves to `featureOn` (hosted code, with the account) or `deskFeatureOn` (desks, with their
   environment): visits, hours, stay check, guest messages, packages, oversight, booking platforms, locks, guest
   codes, cameras. The lock and camera service routes answer once some account has the feature on, and check each
   event against its own account.
6. The visit log is always written; the late text, host notes, Fixer news lines, vendor visits and service notices
   stay behind `visits`.
7. `FIXER_CORE` goes: `set_flows` no longer refuses Fixer Core, voicemail no longer waits on it, and the startup
   voice pass always runs.
8. Old flag helpers and names leave the code; startup logs a retired flag still set.
9. Tests: `test/featureSwitches.test.ts`, `test/featureEnv.ts`, and each feature's tests moved to switches.
10. Docs: `docs/environment-variables.md` (Railway keeps the secrets, the model path and `FEATURES_OFF`),
    `docs/hosted-multitenancy.md`, the safety gates, the bootstraps and templates, and the verify-cleanercore skill.
11. `scripts/ci-check.sh` and the verify-cleanercore proofs.
