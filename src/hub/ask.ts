/**
 * The shape of a setup question, shared by every flow: the field it fills, what to find out, and the
 * options to show as a choice card. Nothing here is sent to anyone.
 */

export interface AskOption {
  value: string;
  label: string;
}

export interface AskQuestion {
  /** The tool argument this answer fills, or a choice Grok uses to pick the next question. */
  field: string;
  /** What to find out, as a short phrase. Grok words the question itself. */
  ask: string;
  required: boolean;
  /** Show these as a choice card. The host picks one, or several when `multiple` is set. */
  options?: AskOption[];
  multiple?: boolean;
  /** The answer to offer first, as an option value or a plain value. */
  default?: string;
  example?: string;
  /** Asked only when an earlier answer calls for it. */
  when?: string;
  /** How to collect or use the answer. */
  how?: string;
}

/** The instruction beside every ask. */
export function askNext(tool: string): string {
  return `Ask the host the questions in ask, in order, in your own short words. Each message asks exactly one question: never two in one message, even related ones like the checkout and check-in times, or a phone number and a name. Wait for the answer before the next one. When a question has options, show them as a choice card the host can tap, never as a list or a question in the text. Skip a question the host already answered. Then call ${tool}.`;
}
