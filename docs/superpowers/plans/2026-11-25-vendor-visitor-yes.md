# Vendors and visitors can say yes any way: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A routine vendor's or an expected visitor's yes can come by text, email, a call, or the host arranging it, and only then is their door code made.

**Architecture:** Vendors reuse #243's `confirm_visit` and `booking.confirmed`. Expected visits get their own `confirmed` record, a `confirm_expected_visit` tool, `confirmedVia` on `add_expected_visit`, a per-visit code gate in `wantedVisitCodes`, a host-only single-use code page (`visit_code_link`, served like `pro_code_link`), and one "no yes" host note.

**Tech Stack:** TypeScript, vitest, the existing hub/locks fakes.

**Spec:** `docs/superpowers/specs/2026-11-25-vendor-visitor-yes-design.md`

## Global Constraints

- Behind FIXER_CORE / SMART_LOCKS / the account's "oversight" switch, as today; nothing new is on by default.
- No code digits in chat, tool results, logs, or the visit record. Only a link token's hash is kept.
- Tests: fakes and 555 numbers only, made-up codes that no assertion prints.
- Texting consent is unchanged: nobody gets a text without their own YES on the line.
- A host-passed visitor yes covers that one visit only. A visitor's text YES stays once ever.
- STOP means no texts, not no entry: a host yes can make a STOP'd visitor's code, and it reaches them only through the host's page (approved 25 Nov).
- The "no yes" visitor note: once, at the later of 2 hours before the code window and 30 minutes after the save, capped at the window's start.

## Review Focus

1. A visitor who replies YES after a host yes: the code is texted once, the same code; the host page still works once.
2. A host-confirmed visit cancelled after the link was given: the page answers "gone", and the code comes off the lock.
3. A host yes for one visit never opens another visit for the same phone.
4. A vendor visit already confirmed by text: `confirm_visit` answers "already", records nothing new.
5. A visit whose window is over: `confirm_expected_visit` and `visit_code_link` refuse.

---

### Task 1: Vendors through confirm_visit

**Files:** Modify `src/fixer-core/desk.ts` (`confirmVisit`), `src/fixer-core/texts.ts` (`vendorNoAnswerNews`), `src/fixer-core/tools.ts` (description). Test: `test/vendorVisits.test.ts`.

- [ ] Tests: `confirm_visit` on a proposed vendor visit takes the two-call yes, sets `vendor.confirmedAt`, `booking.confirmed = { by: "host", via: "call" }` and `codeYes`, and the code is wanted on the lock. A vendor's text YES afterwards sends nothing new and leaves `confirmed.by` as "host". A vendor visit already confirmed answers `already: true`. The 48-hour note's text ends "If they told you yes another way, tell me and I'll make their code."
- [ ] Run, see them fail. Implement: drop the vendor refusal. For a vendor visit, `visitConfirmed` already counts `vendor.confirmedAt`, so "already" holds. On go, call `confirmVendor(booking)` and then `confirmByHost`.
- [ ] Run vendor and #243 suites green, commit.

### Task 2: The visitor's yes on record and the per-visit gate

**Files:** Modify `src/oversight/visits.ts` (`ExpectedVisit.confirmed?: { at: string; by: "host"; via: "email" | "call" | "host-arranged" }`, `hostLink?: { hash; expiresAt; at; usedAt? }`), `src/oversight/store.ts` (unchanged shape check), `src/oversight/visitCodes.ts` (`mayHaveCode(visit: ExpectedVisit): boolean`), `src/oversight/visitCodeDesk.ts` (`mayHaveCode(file, visit)`: host yes, or the phone's text YES / opted-in without STOP; the host phone is never), `src/oversight/desk.ts` (`codeState`). Tests: `test/expectedVisitCodesWanted.test.ts`, `test/expectedVisitCodesLive.test.ts`.

- [ ] Tests: a host-confirmed visit is wanted with no text YES, and a STOP'd phone with a host yes is wanted too; a second visit for the same phone without its own yes is not wanted; `release` sends no text to a visitor without a text YES and gives the host one note naming `visit_code_link`; a visitor with both gets one code text.
- [ ] Implement, run, commit.

### Task 3: confirm_expected_visit and confirmedVia

**Files:** `src/oversight/desk.ts` (`confirmVisit({ id, via, confirmation })`, `addVisit` takes `confirmedVia`), `src/oversight/tools.ts` (new tool, new property), `src/hosted/oversight.ts` (nothing new to wire). Test: `test/expectedVisitCodesDesk.test.ts`.

- [ ] Tests: two calls; refused without `via`, for a visit with no phone, cancelled, already over, or off connected locks; the record names host and via; `already` for a confirmed visit or a phone with a text YES. `addVisit` with `confirmedVia` puts it in the one question ("... with their own door code? They confirmed by call.") and saves `confirmed`; a STOP'd phone is accepted only with `confirmedVia`.
- [ ] Implement, run, commit.

### Task 4: The host's visit code page and the "no yes" note

**Files:** `src/oversight/desk.ts` (`codeLink({ id, confirmation })`, dep `publicBase`), `src/oversight/visitCodeDesk.ts` (`pageOpen(token)`, `showHostCode(token)`, the "no-yes" note in `sync`), `src/oversight/visitCodeTexts.ts`, `src/oversight/tools.ts` (`visit_code_link`), `src/hosted/locks.ts` (`serveVisitCodePage`, `isVisitCodePath`, prefix `/oversight/visit-code/`), `src/hosted/oversight.ts` (publicBase), `src/cleaner-core/hosted/router.ts` (route). Tests: `test/expectedVisitCodesLive.test.ts`, `test/expectedVisitCodesHosted.test.ts`.

- [ ] Tests: the link is refused before a yes, for a visitor who gets the code by text, and after the visit; it opens once, only once the code is set on the lock, ends with a cancel; the token's hash only is kept. The "no yes" note comes once at the timing above and never for a visit with a yes.
- [ ] Implement, run, commit.

### Task 5: Docs and gates

**Files:** `docs/fixer-core-safety-gates.md`, `docs/cleaner-core-safety-gates.md` (visit-code rows), `FIXER_CORE_BOOTSTRAP.md`, `muse-template/skills/fixer-core/SKILL.md`, oversight tool descriptions.

- [ ] Rows name the new tests. Full `npm test` and `npx tsc --noEmit` green, commit.
