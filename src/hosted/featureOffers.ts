/**
 * After a property's core setup, get_state offers each feature that's on for the account and fits the property, one
 * at a time, with Skip always there. What's on comes from the tools listed for the account (each feature's tools
 * are listed only while its switch is on), never from a hard-coded list of switches. The host's answer, yes or
 * skip, is kept on the property, so an offer is made once. Offering changes nothing and texts nobody: on yes, the
 * agent runs that feature's own tools, which keep their own approvals.
 */

export const OFFER_IDS = ["locks", "guest-codes", "house-rules", "expected-visits", "packages", "hours", "visits"] as const;

export type OfferId = (typeof OFFER_IDS)[number];

export function isOfferId(value: unknown): value is OfferId {
  return typeof value === "string" && (OFFER_IDS as readonly string[]).includes(value);
}

/** What the property's offers are worked out from. */
export interface OfferContext {
  /** Every tool name listed for the account right now. */
  listed: ReadonlySet<string>;
  /** The property has a lock connected. */
  lockConnected: boolean;
  /** Supply Core is on for the property. */
  supplies: boolean;
  /** The offers the host already answered on this property. */
  answered: readonly string[];
}

export interface Offer {
  offer: OfferId;
  /** The one-line pitch, for the agent to say in its own short words. */
  pitch: string;
  /** "setup": Yes or Skip. "tell": nothing to set up, the host just hears it's there. */
  kind: "setup" | "tell";
  /** What to do on yes. */
  onYes?: string;
  /** The tools that offer leads to. */
  tools: string[];
}

const has = (ctx: OfferContext, ...names: string[]) => names.filter((name) => ctx.listed.has(name));

/** Every offer that fits the property now, in the order setup makes them, answered or not. */
export function offersFor(ctx: OfferContext): Offer[] {
  const offers: Offer[] = [];
  if (has(ctx, "connect_lock").length > 0 && !ctx.lockConnected) {
    offers.push({
      offer: "locks",
      kind: "setup",
      pitch: "Do you have a smart lock that works with an app? I can connect it so each cleaner and pro gets their own code.",
      onYes: "Follow the Connected locks steps in your Cleaner Core guide, starting with connect_lock.",
      tools: has(ctx, "connect_lock", "get_locks", "save_locks"),
    });
  }
  if (has(ctx, "guest_codes").length > 0 && ctx.lockConnected) {
    offers.push({
      offer: "guest-codes",
      kind: "setup",
      pitch: "Want each guest to get their own door code for their stay? I make it on the lock and give you a private link to paste into your arrival message.",
      onYes: "Ask whether codes are made automatically, after asking the host before each booking, or not at all, as a choice card, and call guest_codes with it: it takes their yes in two calls.",
      tools: has(ctx, "guest_codes"),
    });
  }
  const rules = has(ctx, "get_house_rules", "get_guest_facts");
  if (rules.length > 0) {
    offers.push({
      offer: "house-rules",
      kind: "setup",
      pitch: "Want to add your house rules? I keep them in one list.",
      onYes: `Call ${rules.join(" or ")} and follow what it says.`,
      tools: has(ctx, "get_house_rules", "save_house_rules", "get_guest_facts", "save_guest_facts"),
    });
  }
  if (has(ctx, "add_expected_visit").length > 0) {
    offers.push({
      offer: "expected-visits",
      kind: "setup",
      pitch: "When someone says they'll stop by, tell me, and I'll flag it the same day if nobody comes in. Is anyone expected soon?",
      onYes: "Take who and when, and call add_expected_visit as it says.",
      tools: has(ctx, "add_expected_visit", "list_expected_visits"),
    });
  }
  if (has(ctx, "save_package_settings").length > 0 && ctx.supplies) {
    offers.push({
      offer: "packages",
      kind: "setup",
      pitch: "When a supply order is left at the door, I can make sure someone brings it inside. Want to pick who that is by default?",
      onYes: "Ask who, from the people already saved for this property, and call save_package_settings with only what the host says.",
      tools: has(ctx, "save_package_settings", "check_packages"),
    });
  }
  if (has(ctx, "save_hours_settings").length > 0) {
    offers.push({
      offer: "hours",
      kind: "setup",
      pitch: "Want an hours log? I keep one row per work session for you, your cleaner and each pro, and write each month to your spreadsheet.",
      onYes: "Ask which spreadsheet they use, and save it with save_hours_settings. Ask nothing else now: the log fills in on its own.",
      tools: has(ctx, "save_hours_settings", "review_hours", "export_hours"),
    });
  }
  if (has(ctx, "list_visits").length > 0) {
    offers.push({
      offer: "visits",
      kind: "tell",
      pitch: "I also keep a record of each cleaning and repair visit: who came, and when they arrived and left. Ask me for it anytime.",
      tools: has(ctx, "list_visits"),
    });
  }
  return offers;
}

/** The instruction beside every offer. */
export function offerNext(offer: Offer, assistant: string): string {
  const cards = assistant === "claude" || assistant === "chatgpt" ? "a short list of choices" : "a choice card";
  const answer =
    offer.kind === "tell"
      ? "Say the pitch in one short line, with nothing to answer."
      : `Say the pitch in one short line in your own words, with Yes and Skip as ${cards}. Skip is always there, and the host can set it up later. On yes: ${offer.onYes}`;
  return `Only in a chat with the host, never on a routine run, and only after everything in next is done. ${answer} Then call get_state with offered: "${offer.offer}" and the property, whatever they answered, for the next one. Never offer two at once.`;
}

/** The next offer the host hasn't answered on this property, with its instruction and how many more follow. */
export function nextOffer(ctx: OfferContext, assistant: string): Record<string, unknown> | undefined {
  const open = offersFor(ctx).filter((offer) => !ctx.answered.includes(offer.offer));
  const first = open[0];
  if (!first) return undefined;
  return {
    offer: first.offer,
    pitch: first.pitch,
    tools: first.tools,
    next: offerNext(first, assistant),
    ...(open.length > 1 ? { more: open.length - 1 } : {}),
  };
}
