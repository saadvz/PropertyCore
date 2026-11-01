import { BASELINE_FLAGGED, BASELINE_KEYS, BASELINE_TOOLS } from "./baseline";
import { CHATGPT_FLAGGED, CHATGPT_KEYS, CHATGPT_TOOLS } from "./chatgpt";
import { CLAUDE_FLAGGED, CLAUDE_FULL, CLAUDE_KEYS, CLAUDE_TOOLS } from "./claude";
import { GROK_ALERTS, GROK_ALERTS_SAY, GROK_ALERTS_SHARED, GROK_BACKUPS_FULL, GROK_BACKUPS_TOOLS, GROK_FLAGGED, GROK_FULL, GROK_KEYS_FULL, GROK_KEYS_TOOLS, GROK_TOOLS, GROK_WAKE } from "./grok";
import { selectPlaybook, type PlaybookSelection, type ReportedClient } from "./select";
import { milestoneToolFor } from "./milestoneTool";
import { RECONNECT_INSTRUCTIONS, SHARED_AFTER_PUBLISH, SHARED_FLAGGED_RULES, SHARED_IRREVERSIBLE, SHARED_STEPS, SHARED_VOICE, STEP_TITLES, stepAside, type StepId } from "./shared";

export interface PlaybookText {
  id: PlaybookSelection["id"];
  version: string;
  mode: PlaybookSelection["mode"];
  step: StepId;
  text: string;
}

function profileIntro(selection: PlaybookSelection): string {
  if (selection.id === "grok") return selection.mode === "full" ? GROK_FULL : GROK_TOOLS;
  if (selection.id === "claude") return selection.mode === "full" ? CLAUDE_FULL : CLAUDE_TOOLS;
  if (selection.id === "chatgpt") return CHATGPT_TOOLS;
  return BASELINE_TOOLS;
}

/** Where the playbook is read. A touring host on the shared service connects tour updates through it. */
export interface PlaybookPlace {
  sharedService?: boolean;
}

function profileStep(selection: PlaybookSelection, step: StepId, place: PlaybookPlace): string | undefined {
  if (step === "texting-keys") {
    if (selection.id === "grok") return selection.mode === "full" ? GROK_KEYS_FULL : GROK_KEYS_TOOLS;
    if (selection.id === "claude") return CLAUDE_KEYS;
    if (selection.id === "chatgpt") return CHATGPT_KEYS;
    return BASELINE_KEYS;
  }
  if (step === "alerts-degraded") {
    return "For you, not out loud: send the test this step names. Do not set up tour updates again. Do not create a routine. Do not ask for an address or a key. Do not ask whether they want tour updates.";
  }
  if (step === "alerts-error") return RECONNECT_INSTRUCTIONS;
  if (step === "backups" && selection.id === "grok") return selection.mode === "full" ? GROK_BACKUPS_FULL : GROK_BACKUPS_TOOLS;
  if (step === "alerts" && selection.id === "grok") return place.sharedService ? GROK_ALERTS_SHARED : GROK_ALERTS;
  return undefined;
}

function statesTheLine(step: StepId): boolean {
  return step === "alerts-degraded" || step === "alerts-error";
}

function profileWake(selection: PlaybookSelection): string | undefined {
  return selection.id === "grok" ? GROK_WAKE : undefined;
}

function profileFlagged(selection: PlaybookSelection): string {
  if (selection.id === "grok") return GROK_FLAGGED;
  if (selection.id === "claude") return CLAUDE_FLAGGED;
  if (selection.id === "chatgpt") return CHATGPT_FLAGGED;
  return BASELINE_FLAGGED;
}

/** Agent-only. Names the milestone tool for this step. Not something to say out loud. */
function milestoneHint(step: StepId): string | undefined {
  if (step === "backups") {
    return "For you, not out loud: call backup_records for this step. Declining stays possible. Do not say that name out loud.";
  }
  if (step === "operate" || step === "another") {
    return "For you, not out loud: day-to-day work uses get_tours, schedule_tour, cancel_tour, hold_tour, pause_tours, get_inbox, reply_to_time_request, resolve_issue, export_records, backup_records, and restore_records. Do not say those names out loud.";
  }
  const tool = milestoneToolFor(step);
  if (tool === "get_state") return undefined;
  return `For you, not out loud: call ${tool} for this step. Do not say that name out loud.`;
}

/** The one line that can be said out loud for this step. Empty when there is no fixed question. */
export function spokenAsk(client: ReportedClient | undefined, step: StepId, ask?: string): string {
  if (ask !== undefined) return ask;
  const selection = selectPlaybook(client);
  if (selection.id === "grok" && step === "alerts") return GROK_ALERTS_SAY;
  return SHARED_STEPS[step].ask;
}

export function renderPlaybook(client: ReportedClient | undefined, step: StepId, askOverride?: string, place: PlaybookPlace = {}): PlaybookText {
  const selection = selectPlaybook(client);
  const copy = SHARED_STEPS[step];
  const extra = profileStep(selection, step, place);
  const ask = spokenAsk(client, step, askOverride);
  const text = [
    SHARED_VOICE,
    SHARED_IRREVERSIBLE,
    profileIntro(selection),
    statesTheLine(step) ? `${STEP_TITLES[step]}.` : `${STEP_TITLES[step]}. Ask one thing.`,
    step === "another" ? SHARED_AFTER_PUBLISH : undefined,
    ask ? (statesTheLine(step) ? `Say only this: ${ask}` : `Ask only this: ${ask}`) : undefined,
    stepAside(step),
    milestoneHint(step),
    `Done looks like: ${copy.done}`,
    `If it fails: ${copy.ifItFails}`,
    extra,
    SHARED_FLAGGED_RULES,
    profileFlagged(selection),
    profileWake(selection),
  ]
    .filter((part): part is string => !!part)
    .join("\n\n");
  return { id: selection.id, version: selection.version, mode: selection.mode, step, text };
}
