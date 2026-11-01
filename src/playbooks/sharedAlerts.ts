import type { ReportedClient } from "./select";

/**
 * Touring's tour-updates step on the shared service, for each chat. The service keeps the routine
 * itself, so each chat connects it its own way: Grok posts from its computer, Claude's host uses a
 * private page, and a ChatGPT or Muse task connects with nothing secret at all.
 */

export type SharedPlatform = "grok" | "claude" | "chatgpt" | "muse";

/** The chat behind a client name. Grok when it can't tell, since Grok is the supported path. */
export function sharedPlatformOf(client?: ReportedClient): SharedPlatform {
  const name = client?.name?.trim().toLowerCase() ?? "";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("muse")) return "muse";
  return "grok";
}

const OPEN = "For you, not out loud: this is today's tour-updates step, plus the wake. Do not ask a second question.";
const TEXTS =
  'Then ask "Want tour updates texted to your phone too?" as a choice card (Urgent only, Everything, No texts) and call save_host_texts with their answer, with their phone when they want texts.';
const CLOSE = ["If they say no, record the skip. Skipping stays possible.", "Do not say webhook, routine, event id, or secure link out loud."];

const SETUP: Record<SharedPlatform, string[]> = {
  grok: [
    "If they say yes, call save_settings with their choice, then create the Tour Core Operator Updates routine yourself. Call save_alert_routine and, from your own cloud computer, post the routine's webhook address and key to the one-time link it gives. You made the routine, so you hold both. Only if you don't, collect them with your secure secret input card first.",
    "Never send that link to the landlord or ask them to open a page. Never put the address or the key in chat or in a tool argument. A test note means it is done.",
  ],
  claude: [
    "If they say yes, call save_settings with their choice, then help them make a Claude scheduled task named Tour Core Updates with an API trigger, using the prompt in the Property Core template's Claude touring task doc.",
    "Call save_alert_routine. It gives a one-time link to a private page: send the landlord that link, and they paste the task's Fire URL and token there. Never ask for either in chat or put them in a tool argument. A test note means it is done.",
  ],
  chatgpt: [
    "If they say yes, call save_settings with their choice, then create a recurring task that runs every hour, using the prompt in the Property Core template's ChatGPT touring task doc. Tell them ChatGPT checks for updates at most once an hour.",
    "Then call save_alert_routine with no arguments. Nothing secret is saved and there's no link. Connecting it is the whole step.",
  ],
  muse: [
    "If they say yes, call save_settings with their choice, then create a recurring task, as often as they like, using the prompt in the Property Core template's Muse touring task reference. Tell them Muse checks for updates as often as that task runs.",
    "Then call save_alert_routine with no arguments. Nothing secret is saved and there's no link. Connecting it is the whole step.",
  ],
};

/** The tour-updates step for this chat on the shared service. */
export function sharedAlertsStep(platform: SharedPlatform): string {
  return [OPEN, ...SETUP[platform], TEXTS, ...CLOSE].join(" ");
}
