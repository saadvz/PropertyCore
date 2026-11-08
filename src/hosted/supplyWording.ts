import type { CleanerAssistant } from "../cleaner-core/assistant";
import type { AskQuestion } from "../hub/ask";
import { CARD_REFUSAL, type SupplyReply } from "../supply-core/desk";
import { CARDS, type SupplyAsk } from "../supply-core/setupAsk";
import { listedSupplyTools, NO_CARDS, SUPPLY_TOOLS, type SupplyTool } from "../supply-core/tools";

/**
 * Supply Core in each always-on agent's own words. Grok's are the desk's own and stay exactly as
 * they were. Muse shops in its own cloud browser: the host signs in to each store there themselves,
 * the store keeps the payment method, and a calendar link goes on the host's private page. The live
 * probe (2026-10-29) showed Muse's safety check refuses a tool reply that tells it to send a value
 * somewhere, so no Muse reply does. Only the words change, never a gate.
 */

/** The Muse recurring task that checks and orders once a day. */
export const MUSE_SUPPLY_TASK_NAME = "Supply Core";

/** Where the Muse Supply Core skill and its task live in the repository. */
export const MUSE_SUPPLY_SKILL = "muse-template/skills/supply-core";

const MUSE_NO_CARDS = "Never pass a card number, expiry, or security code: each store keeps its own saved payment method.";

/** The card refusal on Muse: no Vault there, since each store keeps its own payment method. */
export const MUSE_CARD_REFUSAL = "That looks like a card number. Supply Core never takes card details: each store keeps its own saved payment method.";

const MUSE_CARDS =
  "Search only the plan's stores, in your browser. Show 3 to 4 products from them as product cards if you can show them, each with its short name, pack size, price, and store. Then show a choice card with one option per product, by its short name, so the host can tap their pick. Never list products as plain text.";

const MUSE_PAGE = "It works once and expires in 10 minutes. Call get_supply_state once the host says it's saved.";

/** save_supply_sources' reply on Muse: data about the host's private page, never an instruction to send a value. */
export const MUSE_SUPPLY_UPLOAD_NEXT = `uploadUrl is the host's private page for this calendar's export link. ${MUSE_PAGE}`;

const MUSE_SOURCES_HOW =
  "A calendar link goes on the host's private page: call save_supply_sources with uploadLink { name }. Its uploadUrl is the host's private page for the link. For Google Calendar, call it with google: true, and pass that calendar's events as googleEvents to every check_supplies. When that's all, call it with done: true.";

const MUSE_ROUTINE_HOW = `Create one Muse recurring task named ${MUSE_SUPPLY_TASK_NAME} yourself, daily at checkTime, from references/supply-core-task.md in your Supply Core skill (${MUSE_SUPPLY_SKILL} in the repository), with its prompt word for word and the property's connector. If the account already has that task, don't make a second one: it checks every property with Supply Core on. Then call save_supply_settings with routineCreated: true.`;

function museStoreHow(store: string): string {
  return `Check it yourself in your browser, without placing an order: open ${store}. If you aren't signed in, hand the browser to the host so they sign in themselves, including any code the site sends them. Then check that the delivery address is the property's, and that a payment method is saved on the store account. If one is missing, hand the host the browser on the store's address or payment page so they add it there. Never ask for a password or card number in chat, and never type one. When it's ready, call save_supply_settings with storesReady: ["${store}"].`;
}

const MUSE_DESCRIPTIONS: Record<string, (description: string) => string> = {
  save_supply_settings: (d) => d.replace("(the plan's stores you checked you can check out with: signed in, delivering to the property, a payment method ready)", "(the plan's stores you checked in your browser: signed in, delivering to the property, a payment method saved on the store account)"),
  save_supply_item: (d) => d.replace("from your product cards", "from the products you showed"),
  save_supply_sources: () =>
    "For by-bookings items: saves to the property's booking calendars, shared with Cleaner Core, whether Cleaner Core is on or off. Skip it when the property already has its calendars. uploadLink { name } gives the host's one-time private page for the calendar link. Never put the link in chat or in a tool argument. google: true when the bookings are in Google Calendar; then pass that calendar's events as googleEvents to every check_supplies. done: true when that's all.",
  record_order: () =>
    "Records an order you placed: the cartToken (or an unconfirmed orderId you found in the store's order history), the order number, chargedCents, and expectedBy (YYYY-MM-DD). approvedBy: host-browser when the host placed the order themselves in your browser.",
};

/** A Supply Core tool as this agent's tools/list shows it. */
export function describeSupplyTool(tool: SupplyTool, assistant: CleanerAssistant): string {
  if (assistant !== "muse") return tool.description;
  const own = MUSE_DESCRIPTIONS[tool.name];
  return (own ? own(tool.description) : tool.description).replace(NO_CARDS, MUSE_NO_CARDS);
}

/** Every Supply Core tool as this agent's tools/list shows it. */
export function listedSupplyToolsFor(assistant: CleanerAssistant): Record<string, unknown>[] {
  return listedSupplyTools(
    SUPPLY_TOOLS.map((tool) => tool.name),
    (tool) => describeSupplyTool(tool, assistant),
  );
}

function museQuestion(step: SupplyAsk["step"], question: AskQuestion): AskQuestion {
  if (step === "products" && question.how?.includes(CARDS)) return { ...question, how: question.how.replace(CARDS, MUSE_CARDS) };
  if (step === "sources" && question.field === "source") return { ...question, how: MUSE_SOURCES_HOW };
  if (step === "routine" && question.field === "routineCreated") return { ...question, ask: `nothing: create the ${MUSE_SUPPLY_TASK_NAME} recurring task yourself`, how: MUSE_ROUTINE_HOW };
  if (step === "accounts" && question.field === "storesReady") {
    const store = /^whether you can check out at (.+)$/.exec(question.ask)?.[1];
    if (store) return { ...question, how: museStoreHow(store) };
  }
  return question;
}

/** The setup ask for Muse: shopping in its own browser, the host's private page, and a Muse recurring task. */
export function museSupplyAsk(ask: SupplyAsk): SupplyAsk {
  return { ...ask, questions: ask.questions.map((question) => museQuestion(ask.step, question)) };
}

/** A Supply Core reply in this agent's words. Grok's is unchanged. */
export function supplyReplyFor(assistant: CleanerAssistant, name: string, reply: SupplyReply): SupplyReply {
  if (assistant !== "muse") return reply;
  if (reply.isError && reply.text === CARD_REFUSAL) return { ...reply, text: MUSE_CARD_REFUSAL };
  if (reply.isError || !reply.structured) return reply;
  let structured = reply.structured;
  const ask = structured.ask as SupplyAsk | undefined;
  if (ask && Array.isArray(ask.questions)) structured = { ...structured, ask: museSupplyAsk(ask) };
  if (name === "save_supply_sources" && typeof structured.uploadUrl === "string") structured = { ...structured, next: MUSE_SUPPLY_UPLOAD_NEXT };
  if (structured === reply.structured) return reply;
  return { ...reply, text: JSON.stringify(structured), structured };
}
