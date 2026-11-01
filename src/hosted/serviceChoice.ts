/**
 * The one question a host gets about a number's service, and its choices: on the shared address's
 * Allow page, next to the invite code, and in chat when it wasn't picked there.
 */
export const SERVICE_QUESTION = "Which do you want to set up: Tour Core or Cleaner Core?";
export const SERVICE_CHOICES = [
  { label: "Tour Core: self-guided tours for a rental unit", service: "touring" },
  { label: "Cleaner Core: a cleaner for a property", service: "cleaning" },
] as const;

export type ServicePick = (typeof SERVICE_CHOICES)[number]["service"];

/** The pick, when it's one of the choices. */
export function servicePick(raw: unknown): ServicePick | undefined {
  return SERVICE_CHOICES.find((choice) => choice.service === raw)?.service;
}
