# Grok Bot Live Test Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude session started with "Run the Grok tests for #N" drives the Grok Bot desktop app through a feature's test script and reports pass or fail per step.

**Architecture:** A repo skill holds the session's rules. Test scripts are Markdown files in `docs/grok-tests/`, kept well-formed by a small parser and a vitest check. A separate, small server change stops Scratch test texts from being handed to Twilio. No model call, API key or new dependency is added.

**Tech Stack:** Markdown, TypeScript, vitest (already in the repo). At run time: Claude computer use for the Grok Bot app, Claude in Chrome for Seam, Railway and Property Core's own pages.

**Spec:** `docs/superpowers/specs/2026-11-22-grok-live-test-design.md` (approved 2026-11-22).

## Global Constraints

- `AGENTS.md` safety rules apply to every file: 555 numbers only, made-up door codes only, no secrets, nothing sent to a real phone. `AGENTS.md` itself is not edited.
- No door code digits in any tracked file, test script, evidence file or report. `scripts/scan-cleaner-secrets.mjs --tracked` must stay green.
- Texts in test runs go only to Scratch numbers. Scratch Lane is `+15555550100` (host) and `+15555550101` (cleaner).
- Two properties exist on the test account. **12 Scratch Lane** (Cleaner Core only, 555 numbers) is for text steps. **Adélie Cottage** (Seam sandbox lock) is for lock, guest code and visit steps.
- No purchases. A Supply Core cart is never approved in a run.
- Copy is plain words, no em dashes, matching the repo's existing docs.
- Two pull requests: Tasks 1 to 4 are PR A (skill, scripts, script check). Task 5 is PR B (server change). They don't depend on each other.
- PR bodies start with the project's two attribution lines and end with the Claude Code footer.

## Review Focus

1. Grok's reply is still streaming when the step is judged. Expected: a step is judged only after two screenshots 5 seconds apart show the same last message and no "Typing" line, with a 2 minute ceiling, then "stuck".
2. The Grok Bot window moved, was resized, or shows another chat. Expected: every step starts from a fresh screenshot and re-finds the Property Core chat and message box. Coordinates are never reused across steps.
3. Grok acts on the wrong property. Expected: every Say line for a Scratch step starts with "On 12 Scratch Lane only:", and a step whose reply names the other property fails.
4. A routine or an unrelated card posts into the chat mid-step. Expected: it is recorded in the report as an observation and not answered.
5. A door code shows in the chat or a checked page. Expected: the step fails, the screenshot is not saved, and the report says a code was shown without the digits.

Items 1 to 5 are rules in the skill (Task 2) and are exercised by the live acceptance run (Task 4). The script check (Task 3) pins item 3 and the code and phone rules for the scripts themselves.

---

### Task 1: Spec and plan into the repo

**Files:**
- Create: `docs/superpowers/specs/2026-11-22-grok-live-test-design.md`
- Create: `docs/superpowers/plans/2026-11-22-grok-live-test.md`

- [ ] **Step 1:** Branch `grok-live-test` from `master`.
- [ ] **Step 2:** Export the design doc as Markdown into the spec path. Copy this plan into the plan path.
- [ ] **Step 3:** Run `node scripts/scan-cleaner-secrets.mjs --tracked`. Expected: exit 0.
- [ ] **Step 4:** Commit: `Add the Grok live test design and plan`.

### Task 2: The skill

**Files:**
- Create: `.claude/skills/grok-live-test/SKILL.md`

**Interfaces:**
- Consumes: the script format from Task 3 (`docs/grok-tests/README.md`).
- Produces: the skill name `grok-live-test`, which a thread loads when asked to "run the Grok tests for #N".

- [ ] **Step 1: Write `SKILL.md`** with this frontmatter and these sections, in this order.

```
---
name: grok-live-test
description: "Run a feature's live test in the real Grok Bot desktop app on the test account. Use when asked to run the Grok tests, a Grok retest, or a live test for an issue or pull request number. Drives Grok Bot with computer use, checks Seam, Railway and Property Core pages in Chrome, and reports pass or fail per step. Texts go only to 555 Scratch numbers."
---
```

Sections and what each must say:

1. **What you need.** The person's computer linked to the thread with Computer use on; access to the app named exactly `Grok Bot`; Claude in Chrome for Seam (`console.seam.co`, workspace "Saad's Sandbox"), Railway and Property Core pages.
2. **Find the script.** `docs/grok-tests/<number>-*.md`. If none exists, write one in the README's format from the pull request description and the issue's "still to test" list, save it under `/mnt/project-files/grok-tests/<number>/`, post it in the thread, and run it without waiting.
3. **Preflight.** The four checks from the spec's "How a session works", step 3. Stop with a reason if any fails.
4. **Driving the app.** Open `Grok Bot`, take a screenshot, click the chat named "Property Core", click the box labelled "Message Property Core" (or "Type your answer…" when a card is open), type the Say line, press Return. Batch click, type, Return, wait and screenshot in one call. Apply Review Focus items 1, 2 and 4 word for word. A card option is pressed only when the script says so, or when it asks for a made-up value on 12 Scratch Lane.
5. **Test texts.** Phrases that work: "On 12 Scratch Lane only: send a test text as the cleaner (+1 555 555 0101) that says YES.", "…read the test texts in and out and list each line exactly as the tools returned them.", "…add a test turnover with checkout 10:00 AM and next check-in 4:00 PM.", "…reset Scratch." Until Task 5 ships, an outbox line may read "failed"; say "…record that text as delivered" and continue, and note it in the report.
6. **Checks outside the chat.** Seam console for codes (name, doors, hours, never the digits), `/admin` for switches, visit pages and private links opened in Chrome, Railway deploy and error logs. Never open Railway's variables page or Seam's API keys page.
7. **Waits.** Up to 2 minutes: wait in place. Longer: release the desktop, schedule a check-in for the due time, resume from the script's next step. A calendar-day step becomes its own dated check-in and the report says the run is open.
8. **Safety rules.** The seven bullets from the spec's "Safety rules for a run", verbatim, plus Review Focus items 3 and 5.
9. **Cleanup.** Reset Scratch at the start and the end of text steps. On Adélie Cottage, undo only what this run created, then confirm in chat and in Seam. List anything left.
10. **Report.** One reply: a table with columns Step, Result (pass, fail, could not check), What Grok said, Evidence. Screenshots saved to `/mnt/project-files/grok-tests/<number>/<YYYY-MM-DD>/step-<n>.jpg`. Draft a GitHub comment only if asked. Release the desktop at the end of every turn.
11. **Known limits.** Tool calls are not visible; after a server redeploy that changes tools, Grok needs its Property Core connector reconnected, which is the person's step; clock waits are real time.

- [ ] **Step 2:** Run `node scripts/scan-cleaner-secrets.mjs --tracked`. Expected: exit 0.
- [ ] **Step 3:** Commit: `Add the grok-live-test skill`.

### Task 3: Script format, parser and check

**Files:**
- Create: `docs/grok-tests/README.md`
- Create: `docs/grok-tests/000-scratch-texts-smoke.md`
- Create: `docs/grok-tests/280-locks-who-comes-in.md`
- Create: `src/grok-tests/script.ts`
- Test: `test/grokTestScripts.test.ts`

**Interfaces:**
- Produces, in `src/grok-tests/script.ts`:

```ts
export type GrokTestProperty = "12 Scratch Lane" | "Adélie Cottage";
export interface GrokTestStep { number: number; title: string; say: string; expect: string; check: string; wait: string }
export interface GrokTestScript { title: string; property: GrokTestProperty | undefined; steps: GrokTestStep[] }
export function parseGrokTestScript(markdown: string): GrokTestScript;
/** One plain sentence per problem. Empty when the script is fine. */
export function grokTestScriptProblems(script: GrokTestScript): string[];
```

Script format the parser reads: a `# Title` line; a `Property: <name>` line; then steps headed `## <n>. <title>`, each with four lines starting `Say:`, `Expect:`, `Check:`, `Wait:`. `Check:` may be `none`. `Wait:` is `none`, a duration (`15 minutes`) or a clock time (`5:15 PM`). `Say:` may be a quoted host line or `press <letter> on the card`.

- [ ] **Step 1: Write the failing tests** in `test/grokTestScripts.test.ts`:

```ts
const GOOD = `# Smoke\nProperty: 12 Scratch Lane\n\n## 1. Outbox\nSay: "On 12 Scratch Lane only: read the test texts out."\nExpect: Grok lists the outbox lines.\nCheck: none\nWait: none\n`;

it("parses a script", () => {
  const script = parseGrokTestScript(GOOD);
  expect(script.property).toBe("12 Scratch Lane");
  expect(script.steps).toHaveLength(1);
  expect(script.steps[0]).toMatchObject({ number: 1, title: "Outbox", check: "none", wait: "none" });
  expect(grokTestScriptProblems(script)).toEqual([]);
});
it("reports a step with a missing part", () => {
  expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("Wait: none\n", "")))).toEqual(["Step 1 has no Wait line."]);
});
it("reports a phone number that is not a 555 test number", () => {
  expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("read the test texts out", "text +1 201 867 5309")))).toEqual(["Step 1 uses a phone number that is not a 555 test number."]);
});
it("reports door code digits", () => {
  expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("read the test texts out", "set the door code to 9073")))).toEqual(["Step 1 has door code digits. Scripts never hold a code."]);
});
it("reports a Scratch step that does not name the property", () => {
  expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("On 12 Scratch Lane only: ", "")))).toEqual(['Step 1 must start its Say line with "On 12 Scratch Lane only:".']);
});
it("reports a missing or unknown property", () => {
  expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("12 Scratch Lane\n", "Somewhere Else\n")))).toContain("The Property line must be 12 Scratch Lane or Adélie Cottage.");
});
it("every script in docs/grok-tests is well formed", () => {
  // read each docs/grok-tests/*.md except README.md; expect grokTestScriptProblems to be [] and steps.length > 0
});
```

- [ ] **Step 2:** Run `npx vitest run test/grokTestScripts.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/grok-tests/script.ts`.** Phone check reuses `isScratchTestNumber` from `src/cleaner-core/scratch.ts` on every `+1…` or 10-digit number found. Door code rule: the word "code" followed within 20 characters by 4 or more digits, in any of the four lines. The "On 12 Scratch Lane only:" rule applies only when `property` is 12 Scratch Lane and the Say line is a quoted host line.
- [ ] **Step 4: Write `docs/grok-tests/README.md`:** what the folder is, the format above with one example step, how to start a run ("Run the Grok tests for #N"), and a pointer to the skill.
- [ ] **Step 5: Write `000-scratch-texts-smoke.md`** (Property: 12 Scratch Lane), five steps: reset Scratch; add a test turnover (10:00 AM, 4:00 PM); read the outbox and expect one opt-in line to the cleaner; send YES as the cleaner and expect "The test text went through"; read both boxes and expect "Text from the cleaner: YES."
- [ ] **Step 6: Write `280-locks-who-comes-in.md`** (Property: Adélie Cottage) by converting `locks-who-comes-in-280/grok-retest.md` sections 1, 3 and 4 from the project files, with made-up visitors on 555 numbers. Leave out section 2 (texts the host's real phone) and section 5 (disconnects the lock account); name both in a "Still by hand" note at the end of the file.
- [ ] **Step 7:** Run `npx vitest run test/grokTestScripts.test.ts`, then `npm run typecheck`. Expected: all pass.
- [ ] **Step 8:** Commit: `Add Grok test scripts and their check`.

### Task 4: Live acceptance run and PR A

**Files:**
- Evidence only: `/mnt/project-files/grok-tests/000/<date>/`

- [ ] **Step 1:** In the thread, follow the skill exactly as written to run `000-scratch-texts-smoke.md`. Fix the skill wherever following it literally went wrong, and commit each fix.
- [ ] **Step 2:** Confirm the five Review Focus behaviours held during the run. For item 2, move the Grok Bot window between two steps.
- [ ] **Step 3:** Post the report in the thread in the skill's table shape, with screenshots.
- [ ] **Step 4:** Run `bash scripts/ci-check.sh`. Expected: every stage ok.
- [ ] **Step 5:** Open PR A, "Grok live test sessions: skill, scripts and script check", linking the spec. Note that the copy is operator-facing docs only and no product copy changed.

### Task 5: Scratch texts never reach Twilio (PR B)

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts` (the `sink.send` function near line 4243, and the keyword reply near line 3696 for reference)
- Modify: `docs/environment-variables.md` (the `CLEANER_CORE_SCRATCH_TOOLS` row)
- Test: `test/cleanerScratchTools.test.ts`

**Interfaces:**
- Consumes: `scratchCapture()` and `noteLocal(...)`, both already private methods on the live desk.

- [ ] **Step 1: Write the failing test** in `test/cleanerScratchTools.test.ts`, using that file's existing wiring: with `CLEANER_CORE_LIVE_SMS=1` and `CLEANER_CORE_SCRATCH_TOOLS=1` on a Scratch Lane property with only 555 numbers, add a test turnover, then assert the fake Twilio sender was called 0 times and `read_outbox` lists the opt-in text to the cleaner with a status other than "failed". Name it "with live texts on, a Scratch property's texts stay in the outbox and never call Twilio".
- [ ] **Step 2:** Run `npx vitest run test/cleanerScratchTools.test.ts -t "never call Twilio"`. Expected: FAIL, the sender was called once.
- [ ] **Step 3: Implement.** In `sink.send`, when `this.scratchCapture()` is true, record the text locally the way the keyword reply path does and return before `sendLiveGroup` or `sendLiveSms`. Keep the existing `pin` and `group` notes that the live-texts-off branch makes.
- [ ] **Step 4:** Update the `CLEANER_CORE_SCRATCH_TOOLS` row: replace "When live texts are on, those texts also go to the allowlisted 555 numbers." with "A Scratch property's texts are kept in the outbox and are never handed to Twilio, whether live texts are on or off."
- [ ] **Step 5:** Run `npx vitest run test/cleanerScratchTools.test.ts test/cleanerLiveSmsAllowlist.test.ts test/cleanerLiveFail.test.ts`. Expected: all pass. Fix any test that asserted the old behaviour only if it tested a Scratch property with all 555 numbers.
- [ ] **Step 6:** Run `bash scripts/ci-check.sh`. Expected: every stage ok.
- [ ] **Step 7:** Commit `Keep Scratch test texts out of Twilio` and open PR B. After it deploys, remove the "record that text as delivered" workaround from the skill's section 5 in a follow-up commit.

## Not in this plan

- A tool-call line in the server log, so runs can confirm which tools Grok called.
- A dedicated test machine.
- A test clock for clock-driven steps.
