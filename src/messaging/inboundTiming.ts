import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One correlation id for an inbound text, so a host log can split Tour Core
 * time from the messaging provider's send time.
 *
 *   inbound sms correlation=sms:sendblue:SM123 phase=webhook_received elapsedMs=0 modelMs=0 sendMs=0 tourCoreMs=0
 *   inbound sms correlation=sms:sendblue:SM123 phase=processing_finished ...
 *   inbound sms correlation=sms:sendblue:SM123 phase=send_requested ...
 *   inbound sms correlation=sms:sendblue:SM123 phase=send_returned ...
 *   inbound sms correlation=sms:sendblue:SM123 phase=done ...
 *
 * tourCoreMs is elapsed time minus time spent inside the provider send call.
 * modelMs is time spent waiting on an intent model, if one ran.
 * processing_finished is logged once, immediately before the first send.
 * A text that sends nothing still logs processing_finished, then done.
 */

export type InboundPhase = "webhook_received" | "processing_finished" | "send_requested" | "send_returned" | "done";

interface TimingState {
  correlation: string;
  started: number;
  modelMs: number;
  sendMs: number;
  processingMarked: boolean;
  log: (line: string) => void;
}

const storage = new AsyncLocalStorage<TimingState>();

export function smsCorrelationId(provider: string, providerMessageId: string): string {
  return `sms:${provider}:${providerMessageId}`;
}

export function inboundSmsLine(state: { correlation: string; elapsedMs: number; modelMs: number; sendMs: number }, phase: InboundPhase): string {
  const tourCoreMs = Math.max(0, state.elapsedMs - state.sendMs);
  return `inbound sms correlation=${state.correlation} phase=${phase} elapsedMs=${state.elapsedMs} modelMs=${state.modelMs} sendMs=${state.sendMs} tourCoreMs=${tourCoreMs}`;
}

export async function runInboundSmsTiming<T>(correlation: string, log: (line: string) => void, fn: () => Promise<T>): Promise<T> {
  const state: TimingState = { correlation, started: Date.now(), modelMs: 0, sendMs: 0, processingMarked: false, log };
  return storage.run(state, async () => {
    notePhase("webhook_received");
    try {
      return await fn();
    } finally {
      if (!state.processingMarked) notePhase("processing_finished");
      notePhase("done");
    }
  });
}

function notePhase(phase: InboundPhase): void {
  const state = storage.getStore();
  if (!state) return;
  if (phase === "processing_finished") {
    if (state.processingMarked) return;
    state.processingMarked = true;
  }
  const elapsedMs = Date.now() - state.started;
  state.log(inboundSmsLine({ correlation: state.correlation, elapsedMs, modelMs: state.modelMs, sendMs: state.sendMs }, phase));
}

/** Marks Tour Core finished, once, immediately before the first outbound send. */
export function markInboundProcessingFinished(): void {
  notePhase("processing_finished");
}

/** Times one provider send. Outside an inbound text this is a plain call. */
export async function timeOutboundSend<T>(send: () => Promise<T>): Promise<T> {
  const state = storage.getStore();
  if (!state) return send();
  markInboundProcessingFinished();
  notePhase("send_requested");
  const start = Date.now();
  try {
    return await send();
  } finally {
    state.sendMs += Date.now() - start;
    notePhase("send_returned");
  }
}

export function addInboundModelMs(ms: number): void {
  const state = storage.getStore();
  if (!state || ms <= 0) return;
  state.modelMs += ms;
}

/**
 * A hung model must not use the whole reply budget. Each model call waits at most 6s (the default too).
 * A question can make two calls (a second read, then a fact pick), so the worst case stays near 12s:
 * under Twilio's 15s webhook wait, and the text is saved before it's handed over either way.
 */
export const INTENT_MODEL_TIMEOUT_CAP_MS = 6000;

export function intentModelTimeoutMs(requested?: number): number {
  const value = requested && requested > 0 ? requested : INTENT_MODEL_TIMEOUT_CAP_MS;
  return Math.min(value, INTENT_MODEL_TIMEOUT_CAP_MS);
}
