/**
 * The one question a host gets about a number's service, and its choices: on the shared address's
 * Allow page, next to the invite code, and in chat when it wasn't picked there. Touring is offered
 * while TOUR_CORE_TENANTS is on, and Supply Core while SUPPLY_CORE is on. Cleaning always is.
 */

const TOURING = { label: "Tour Core: self-guided tours for a rental unit", service: "touring" } as const;
const CLEANING = { label: "Cleaner Core: a cleaner for a property", service: "cleaning" } as const;
const SUPPLIES = { label: "Supply Core: supplies reordered for a property", service: "supplies" } as const;

export type ServiceChoice = typeof TOURING | typeof CLEANING | typeof SUPPLIES;
export type ServicePick = ServiceChoice["service"];

const NAMES: Record<ServicePick, string> = { touring: "Tour Core", cleaning: "Cleaner Core", supplies: "Supply Core" };

/** The choices on offer, in the order touring, cleaning, supplies. */
export function serviceChoices(opts: { touring: boolean; supplies: boolean }): ServiceChoice[] {
  return [...(opts.touring ? [TOURING] : []), CLEANING, ...(opts.supplies ? [SUPPLIES] : [])];
}

/** "Which do you want to set up: A or B?", or "A, B, or C?" for three. */
export function serviceQuestion(choices: readonly ServiceChoice[]): string {
  const names = choices.map((choice) => NAMES[choice.service]);
  const list = names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
  return `Which do you want to set up: ${list}?`;
}

/** Touring and cleaning, the choices before Supply Core. */
export const SERVICE_CHOICES = serviceChoices({ touring: true, supplies: false });
export const SERVICE_QUESTION = serviceQuestion(SERVICE_CHOICES);

/** The pick, when it's one of the choices on offer. */
export function servicePick(raw: unknown, choices: readonly ServiceChoice[] = serviceChoices({ touring: true, supplies: true })): ServicePick | undefined {
  return choices.find((choice) => choice.service === raw)?.service;
}
