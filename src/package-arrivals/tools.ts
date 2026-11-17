import type { PackageDesk, PackageReply } from "./desk";
import { MAX_BRING_IN_HOURS } from "./desk";

/** Package arrivals' tools (#241), as tools/list shows them. Each one takes `property` on the shared service. */

const ORDER_ID = { type: "string", maxLength: 40, description: "The Supply Core order's id, from check_packages or check_supplies." };
const TIME = { type: "string", maxLength: 40, description: "An ISO time, like 2026-11-17T15:00:00Z." };
const PHONE = { type: "string", pattern: "^\\+\\d{8,15}$", description: "The person's phone as saved for this property, like +15555550111." };

const CHECK = {
  name: "check_packages",
  title: "Package arrivals: what's expected",
  description:
    "Every Supply Core order expected at the property and where it stands: expected (not due yet), notSeen (expected and nothing confirmed the drop by 9 PM local on its day; tell the host once), waiting (already told), toBringIn (at the door, no one set to bring it in), visits (who's bringing each in and by when), and bringInLate (not marked inside by its deadline; tell the host once). Run it after check_supplies in the Supply Core Check routine, and whenever the host asks about a delivery. Follow its ask and next. It texts nobody.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const SEEN = {
  name: "mark_package_seen",
  title: "A package is at the door",
  description:
    "Records that a package was dropped at the door, with when and how it was confirmed: tracking (the carrier says delivered), host (the host saw it or was told), or camera. A camera sighting replaces any other; otherwise the earliest is kept. Also call mark_delivered for the order if you haven't. When the host saved a default bring-in person, their visit is planned at once.",
  inputSchema: { type: "object", properties: { orderId: ORDER_ID, how: { type: "string", enum: ["tracking", "host", "camera"] }, at: { ...TIME, description: "When it was dropped. Leave out for now." } }, required: ["orderId", "how"], additionalProperties: false },
};

const PLAN = {
  name: "plan_bring_in",
  title: "Who brings a package in",
  description:
    "The bring-it-in visit for one delivery: the person the host picked, who must be saved for this property as the cleaner, a co-host or an assistant, and have said YES. Leave person out to use the host's saved default. The deadline is the drop plus the host's hours. The bring-in code waits on the lock connection, and Property Core doesn't text the person: tell the host who and by when, and they let the person know.",
  inputSchema: { type: "object", properties: { orderId: ORDER_ID, person: PHONE }, required: ["orderId"], additionalProperties: false },
};

const INSIDE = {
  name: "mark_brought_in",
  title: "A package is inside",
  description:
    "Records that the package is inside, with when, and when the person started if they said, so the hours log has the time it took. Pass only times the host or the person gave. A short note is fine, with no codes or long numbers in it.",
  inputSchema: {
    type: "object",
    properties: { orderId: ORDER_ID, at: { ...TIME, description: "When it was inside. Leave out for now." }, startedAt: { ...TIME, description: "When the person started bringing it in." }, note: { type: "string", maxLength: 200 } },
    required: ["orderId"],
    additionalProperties: false,
  },
};

const SETTINGS = {
  name: "save_package_settings",
  title: "Package arrivals settings",
  description: `Saves, only as the host says: bringInHours (how many hours a package may sit at the door before it should be inside, 1 to ${MAX_BRING_IN_HOURS}) and person (the default bring-in person's phone, saved for this property and opted in; null clears it).`,
  inputSchema: { type: "object", properties: { bringInHours: { type: "integer", minimum: 1, maximum: MAX_BRING_IN_HOURS }, person: { ...PHONE, type: ["string", "null"] } }, additionalProperties: false },
};

export const PACKAGE_TOOLS: readonly Record<string, unknown>[] = [CHECK, SEEN, PLAN, INSIDE, SETTINGS];
export const PACKAGE_TOOL_NAMES: ReadonlySet<string> = new Set(PACKAGE_TOOLS.map((tool) => tool.name as string));

const KEYS: Record<string, readonly string[]> = {
  check_packages: [],
  mark_package_seen: ["orderId", "how", "at"],
  plan_bring_in: ["orderId", "person"],
  mark_brought_in: ["orderId", "at", "startedAt", "note"],
  save_package_settings: ["bringInHours", "person"],
};

/** Answers one package arrivals tool. Undefined when the name isn't one of them. */
export function handlePackageTool(desk: PackageDesk, name: string, args: unknown): PackageReply | undefined {
  if (!PACKAGE_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const unknown = Object.keys(input).filter((key) => !KEYS[name]!.includes(key));
  if (unknown.length > 0) return { text: `${name} doesn't take ${unknown.join(", ")}.`, isError: true };
  if (name === "check_packages") return desk.check();
  if (name === "mark_package_seen") return desk.markSeen(input);
  if (name === "plan_bring_in") return desk.planBringIn(input);
  if (name === "mark_brought_in") return desk.markBroughtIn(input);
  return desk.saveSettings(input);
}
