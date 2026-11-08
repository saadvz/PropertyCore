import { z } from "zod";
import type { Prospect } from "../domain/model";
import { normalizePhone } from "../core/phone";

/**
 * Shape of one completed "basic identity" form response. The browser demo
 * and the tokenized phone form both produce this. It records who the visitor
 * says they are; it does not prove identity.
 */
export const BasicFormResponseSchema = z.object({
  responseId: z.string().min(1),
  submittedAt: z.iso.datetime({ offset: true }),
  answers: z.object({
    governmentFirstName: z.string().trim().min(1),
    governmentLastName: z.string().trim().min(1),
    email: z.email(),
    phone: z.string().trim().min(7),
  }),
});

export type VerificationOutcome =
  | { passed: true; reference: string; claimed: { firstName: string; lastName: string; email: string; phone: string } }
  | { passed: false; reference: string; reason: string };

export interface VerificationProvider {
  readonly method: "basic-form" | "none";
  /** True when no visitor action is needed; Tour Core completes the check itself. */
  readonly automatic: boolean;
  /** What the visitor is told when the check is requested, and whether a form follows. */
  request(prospect: Prospect): { body: string; form: boolean };
  /** A fallback link when no personal link can be issued (older demos). */
  defaultLink?(prospect: Prospect): string;
  evaluate(submission: unknown, prospect: Prospect): VerificationOutcome;
}

export class BasicFormVerification implements VerificationProvider {
  readonly method = "basic-form" as const;
  readonly automatic = false;
  constructor(private readonly formUrl: string) {}

  defaultLink(prospect: Prospect): string {
    return `${this.formUrl}?ref=${encodeURIComponent(prospect.id)}`;
  }

  request(): { body: string; form: boolean } {
    return { body: "Thanks! One last step before your tour: please fill out this short form with your legal name, email and phone.", form: true };
  }

  evaluate(submission: unknown, prospect: Prospect): VerificationOutcome {
    const parsed = BasicFormResponseSchema.safeParse(submission);
    const reference = typeof (submission as { responseId?: unknown })?.responseId === "string"
      ? (submission as { responseId: string }).responseId
      : "unknown";
    if (!parsed.success) return { passed: false, reference, reason: "form response is incomplete or invalid" };

    const { answers } = parsed.data;
    if (normalizePhone(answers.phone) !== prospect.phone) {
      return { passed: false, reference, reason: "phone number on the form does not match the texting number" };
    }
    return {
      passed: true,
      reference: parsed.data.responseId,
      claimed: {
        firstName: answers.governmentFirstName,
        lastName: answers.governmentLastName,
        email: answers.email,
        phone: normalizePhone(answers.phone),
      },
    };
  }
}

/** No identity form. The visit is recorded from the texting opt-in and the visitor is not asked who they are. */
export class NoFormVerification implements VerificationProvider {
  readonly method = "none" as const;
  readonly automatic = true;

  request(): { body: string; form: boolean } {
    return { body: "", form: false };
  }

  evaluate(_submission: unknown, prospect: Prospect): VerificationOutcome {
    const [firstName = prospect.name, ...rest] = prospect.name.trim().split(/\s+/);
    return {
      passed: true,
      reference: `none_${prospect.id}`,
      claimed: { firstName, lastName: rest.join(" "), email: "", phone: prospect.phone },
    };
  }
}
