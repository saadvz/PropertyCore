import type { TextKind } from "./core";
import { isOn } from "./flag";

export const SCRATCH_PROPERTY_REFUSAL = "That only works on the Scratch test property.";
export const SCRATCH_NUMBER_REFUSAL = "That only works with 555 test numbers.";
export const SCRATCH_RESET_LINE = "Scratch is reset. No jobs, notes or test texts are left.";
/** Added when the old group couldn't be removed on Twilio. The next group text replaces it. */
export const SCRATCH_GROUP_KEPT = "I couldn't remove the old group text on Twilio, so the next group text will replace it.";
export const SCRATCH_TEST_WENT_THROUGH = "The test text went through.";
export const SCRATCH_TEXT_MISSING = "I couldn't find that test text.";
export const SCRATCH_WHICH_NEEDED = "Say which test text you mean.";
export const SCRATCH_TEXT_NEEDED = "Say the test text.";
export const SCRATCH_STATUS_NEEDED = "Say whether that text was sent, delivered, failed, or undelivered.";

export const SCRATCH_TOOLS = [
  {
    name: "reset_scratch",
    title: "Reset Scratch",
    description: "Clears Scratch jobs, notes, and test texts, and removes the Scratch group text on Twilio. The door code and texting setup stay. It only works on the Scratch test property.",
  },
  {
    name: "read_inbox",
    title: "Read test texts in",
    description: "Lists test texts that came in, in everyday words. It never includes a door code.",
  },
  {
    name: "read_outbox",
    title: "Read test texts out",
    description: "Lists test texts that went out. Each line names who it went to and whether it was delivered. It never includes a door code.",
  },
  {
    name: "send_test_text",
    title: "Send a test text",
    description: "Sends a test text as the host, the cleaner, or the observer. It follows the same path as a real text. It only works with 555 test numbers on the Scratch test property.",
  },
  {
    name: "report_delivery",
    title: "Record a delivery",
    description: "Records that a test text was sent, delivered, failed, or undelivered. It does not text anyone.",
  },
  {
    name: "add_test_turn",
    title: "Add a test turnover",
    description: "Creates one test turnover from a checkout time and the next check-in. It does not read a calendar. It only works on the Scratch test property.",
  },
] as const;

export const DELIVERY_REPORTS = ["sent", "delivered", "failed", "undelivered"] as const;
export type DeliveryReport = (typeof DELIVERY_REPORTS)[number];

const STREETS = ["scratch lane", "scratch court", "scratch annex"];

const KIND_NAME: Record<TextKind, string> = {
  "host-checkout": "Checkout question",
  "host-checkin": "Check-in question",
  offer: "Cleaning offer",
  intro: "Group intro",
  corrected: "Time correction",
  "cancel-update": "Cancellation",
  reminder: "Reminder",
  confirm: "Confirmation",
  declined: "Decline note",
  stop: "Opt-out text",
  help: "Help reply",
  start: "Start note",
  emergency: "Injury alert",
  "opt-in": "Opt-in text",
  pin: "Door code text",
  "pin-notice": "Door code notice",
  "pin-failed": "Door code problem",
  "pin-held": "Door code hold",
  started: "Start note",
  done: "Done note",
  next: "Next step",
  held: "Hold note",
  review: "Review note",
  resume: "Resume note",
  "host-message": "Host message",
  checklist: "Checklist",
};

export function scratchToolsOn(env: NodeJS.ProcessEnv): boolean {
  return isOn(env.CLEANER_CORE_SCRATCH_TOOLS);
}

export function isScratchPropertyAddress(address: string | undefined): boolean {
  const text = address?.trim().toLowerCase() ?? "";
  return STREETS.some((street) => text.includes(street));
}

export function isDeliveryReport(value: string): value is DeliveryReport {
  return (DELIVERY_REPORTS as readonly string[]).includes(value);
}

export function whoTheyAre(phone: string, people: { host?: string; cleaner?: string; observer?: string }): string {
  if (people.cleaner && phone === people.cleaner) return "the cleaner";
  if (people.host && phone === people.host) return "the host";
  if (people.observer && phone === people.observer) return "the observer";
  return "a saved test number";
}

export function outboxLabel(kind: TextKind, role: string): string {
  if (kind === "intro" && role === "the group") return "Group intro";
  if (kind === "emergency" && role === "the host") return "Injury alert to the host";
  if (kind === "emergency") return `Injury reply to ${role}`;
  if (kind === "stop" && role === "the host") return "Hold note to the host";
  if (kind === "pin") return `Door code text to ${role}`;
  return `${KIND_NAME[kind]} to ${role}`;
}

export function outboxLine(kind: TextKind, role: string, status: string): string {
  return `${outboxLabel(kind, role)}: ${status}.`;
}

export function inboxLine(role: string, text: string): string {
  return `Text from ${role}: ${text}.`;
}
