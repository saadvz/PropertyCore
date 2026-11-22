# Plan: one house rules list, facts learned as guests ask, the host's own steps in the hours log (#15, #16, #18)

Design: [2026-11-22-house-rules-facts-hours-design.md](../specs/2026-11-22-house-rules-facts-hours-design.md).

## #15: one list

1. `src/house-rules/merge.ts`:
   - `splitRuleText` splits a facts rules text into rules.
   - `mergeGuestRules` moves the older rules fact. It writes the list first and takes the fact out second. It's idempotent, and it keeps the fact when the fact can't move whole.
   - `rulesForGuests` returns the list, plus a fact that didn't move.
2. `stay-check/store.ts`: add `rulesMergedAt`.
3. `stay-check/desk.ts`:
   - `saveRules` takes `add`.
   - Add the `checks` and `guestReplies` deps, and `rulesAsk`.
   - Merge on `getRules` and `saveRules`.
4. `stay-check/tools.ts`: add the `add` property, and new descriptions for `get_house_rules` and `save_house_rules`.
5. `guest-messages/facts.ts`:
   - Add `SAVE_TOPICS` (without `rules`).
   - Widen the rules words.
   - `matchFacts` matches a rule by topic, or by a shared word.
6. `guest-messages/store.ts`: add the facts `history`, kept by `writeGuestFacts`.
7. `guest-messages/desk.ts`:
   - `getFacts` returns `houseRules`.
   - `saveFact` refuses `rules`.
   - `readMessage` drafts from every house rule.
8. `hosted/stayCheck.ts`: list the house rules tools under either switch, and keep the check's own tools under Nightly stay check.
9. Tests: `test/houseRulesOneList.test.ts`.

## #16: learned as guests ask

1. `guest-messages/desk.ts`:
   - `LEARN_FACTS` replaces `ASK_FOR_FACTS`.
   - Add `learnStep`, the `learn` field, and `messageId` on `saveFact`, kept as `learnedFrom`.
2. `guest-messages/tools.ts`: add the `messageId` property, drop the `rules` topic, and new descriptions.
3. `hosted/guestMessages.ts`: change the `initialize` line.
4. Instructions:
   - `CLEANER_CORE_BOOTSTRAP.md`;
   - the Property Core Muse skill;
   - the Claude skill;
   - the Grok bot profile.
5. Tests:
   - `test/guestFactsLearned.test.ts`;
   - `test/guestMessagesDesk.test.ts` ("doesn't ask the host for facts up front").

## #18: the host's own steps

1. `src/hours-log/hostSteps.ts`: `recordHostStep` and `readHostSteps`, for `host-steps.jsonl`.
2. Append a step after the save in:
   - locks (`saveLocks` on and off, `settings`, `addStanding`, `newLink`, `removeStanding`);
   - guest codes (`setMode`, `makeCode`, `newLink`, the leases);
   - the stay check (`saveRules`, `allowForStay`, `markFlagFalse`);
   - Fixer Core upkeep (`saveUpkeep`, `removeUpkeep`);
   - Cleaner Core's first `activate`.
3. `src/hours-log/hostSources.ts`: `readHostRecords`, `hostStepRows` and `hostRecordRows`.
4. `codes.ts`: twelve row kinds, `V1_ROW_KINDS`, `ROW_KIND_SET`, `rowKindsFor`, eight codes.
5. `ownerRules.ts`: the new owner kinds, and `KINDS_OFF` (setup).
6. `sources.ts`:
   - `hostRows` goes in `DEFAULT_SOURCES`;
   - `readRecords` reads `host`;
   - `rawFacts` drops `KINDS_OFF` and the kinds a month wasn't confirmed with.
7. `month.ts`: add the `kinds` option.
8. `store.ts` and `desk.ts`: add `MonthMark.kindSet`. A pre-#18 mark builds with V1 kinds.
9. Tests:
   - `test/hoursHostSteps.test.ts`: rows, system-made records, the October fingerprint, the guard on a confirmed month.
   - `test/hostStepsRecorded.test.ts`: the desks write steps only after the yes.
   - `test/hoursDesk.test.ts`: the empty month moves to July, because August holds the fixture's Activate.

## Close-out

- Update the safety-gates rows: Guest messages, Nightly stay check, Hours log.
- Run `scripts/ci-check.sh` and the verify-cleanercore skill.
- Check the other sessions' branches: setup wording, Cleaner Core declines, and standing codes.
- Commit and push to `claude/house-rules-facts-hours-15-16-18`. Ask Saad before opening a pull request.
