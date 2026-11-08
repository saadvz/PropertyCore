/**
 * Visitor verification choices. Writable values are `basic-form` (the default)
 * and `none`. Older files may still say `mock` or `document-check`; those are
 * read as `basic-form` and are not offered again.
 */

export const VERIFICATION_QUESTION =
  "Should visitors fill out a short identity form before their tour? I recommend it, so you know who's coming in.";

export const NO_FORM_QUESTION =
  "Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?";

export const BASIC_FORM_CHOICE = "Basic identity form (recommended)";

export const NO_FORM_SUMMARY = "No identity form.";

export const WEB_VERIFICATION_HEADING = "Should visitors fill out a short identity form before their tour?";
export const WEB_VERIFICATION_LEAD = "We recommend it, so you know who's coming in.";

export const REUSE_FIELD_LABEL = "How many days before a visitor fills out the form again?";
export const REUSE_FIELD_HELP =
  "A visitor who already filled out the form can book another tour within this many days without filling it out again.";

export function verificationReuseSentence(days: number): string {
  const span = days === 1 ? "1 day" : `${days} days`;
  return `Visitors who filled out the form won't be asked again for ${span}.`;
}

/** CLI confirm before changing how long a filled-out form can be reused. */
export function verificationKeepQuestion(days: number): string {
  return `${verificationReuseSentence(days)} Keep that?`;
}

/** Review and click-path rows. No form is one line, with no reuse wording. */
export function verificationSummaryRows(mode: string | undefined, days: number): string[] {
  if (mode === "none") return [NO_FORM_SUMMARY];
  return [BASIC_FORM_CHOICE, verificationReuseSentence(days)];
}

/** True for the older stored modes (mock, document-check), which are read as the basic identity form. Neither is a writable choice. */
export function isLegacyVerification(mode: string | undefined): boolean {
  return mode === "mock" || mode === "document-check";
}

/** In-memory view of a stored setup. Does not write the file. */
export function presentVerification<T extends { verificationMode: string }>(config: T): T {
  if (!isLegacyVerification(config.verificationMode)) return config;
  return { ...config, verificationMode: "basic-form" };
}
