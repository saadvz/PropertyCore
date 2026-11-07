import { holdNote } from "./cleanerTexts";
import { GROK_HELPER } from "./assistant";

export const REVIEW_KINDS = [
  "stale-source",
  "airbnb-exception",
  "same-day-capacity",
  "missed-reminder",
  "conflicting-replies",
  "failed-sms",
  "uncertain-sms",
  "shared-chat-routing",
  "possible-code-exposure",
  "group-problem",
] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewStatus = "open" | "resolved";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  subject: string;
  status: ReviewStatus;
  at: string;
  version: number;
}

export interface AuditEvent {
  actor: string;
  source: string;
  version: number;
  reason: string;
  at: string;
  action: string;
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

export interface ReviewDetail {
  day?: string;
  about?: "offer" | "reminder";
}

/** Host-facing review alerts. None of these repeat a door code or a full phone number. */
export function reviewAlert(kind: ReviewKind, address: string, detail?: ReviewDetail, helper = GROK_HELPER): string {
  switch (kind) {
    case "stale-source":
      return `I can't see the latest bookings for ${address} right now, so I'm holding new cleanings and the door code. I'll pick back up once the calendar updates. If a time changed, just text it to me.`;
    case "airbnb-exception":
      return `I saved a manual Airbnb booking exception for ${address}. I did not change the cleaning until you confirm it.`;
    case "same-day-capacity":
      return `Same-day cleaning at ${address} may be too tight. I saved it for your review and did not add another offer.`;
    case "missed-reminder":
      return reminderDeliveryNote(detail?.day ?? "", helper);
    case "conflicting-replies":
      return `I got conflicting replies about the cleaning at ${address}. I did not change the job.`;
    case "failed-sms":
      return `A text failed to send. I saved it for your review and did not count it as delivered.`;
    case "uncertain-sms":
      return detail?.about === "reminder" ? reminderDeliveryNote(detail.day ?? "", helper) : offerDeliveryNote(detail?.day ?? "", helper);
    case "shared-chat-routing":
      return `I could not tell who should get the cleaning texts at ${address}. I did not start a group or send the door code.`;
    case "possible-code-exposure":
      return "I held a text to the cleaner because it looked like it had the door code in it.";
    case "group-problem":
      return holdNote(address);
  }
}

function offerDeliveryNote(day: string, helper: string): string {
  return `My cleaning offer to the cleaner for ${day} may not have gone out. I didn't resend it. Tell ${helper} if you want it sent again.`;
}

function reminderDeliveryNote(day: string, helper: string): string {
  return `My reminder to the cleaner for ${day} didn't go out. I didn't resend it. Tell ${helper} if you want it sent again.`;
}

/** Host-facing rotation and offboarding steps. The demo does not change the lock. */
export function codeHandlingText(address: string): string {
  return `To change the outdoor code at ${address}, set the new code on the lock yourself, then save it in your Cleaner Core chat, which gives you a one-time secure link for it. Never text me the code. I store only a sealed reference. I do not change the lock. To offboard a cleaner, reply STOP from their number or tell me to remove them. I will not send the code again until you confirm a new cleaner and the guests have left.`;
}

export const HEALTH_NOTE = "Cleaner Core health. This check does not send texts.";

export function reviewId(kind: ReviewKind, subject: string): string {
  return `review:${kind}:${subject}`;
}
