import type { VisitDesk, VisitReply } from "./desk";
import { MAX_LIST_DAYS } from "./desk";

/** Visit records' tools (#237), as tools/list shows them. Each takes `property` on the shared service. None writes a lock event. */

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

const LIST = {
  name: "list_visits",
  title: "Visits",
  description: `Each cleaning and Fixer Core visit at the property, with when the person arrived and left and their time on site, where each time came from (the lock, the cleaner's texts, the visit page, DONE), and its flags: late, at-risk, no-show, no-done, not-ready. Times come from the lock only when one is connected; otherwise from the cleaner's texts, as before. From and to are local dates, at most ${MAX_LIST_DAYS} days; with neither, the last week and the next day. Read-only: nothing is sent to anyone.`,
  inputSchema: { type: "object", properties: { from: { ...DATE, description: "First day, YYYY-MM-DD." }, to: { ...DATE, description: "Last day, YYYY-MM-DD." } }, additionalProperties: false },
};

const HEALTH = {
  name: "visit_health",
  title: "Visit log health",
  description: "How the property's visit log reads: lines kept, lines skipped, the last lock event's time and how many lock codes are named. A lock that has gone quiet shows here. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const NAME_CODE = {
  name: "name_lock_code",
  title: "Name a lock code",
  description:
    "Saves whose a lock code is, by the lock's own name for it (like Cleaner or Ace Plumbing), so its unlocks count as that person's arrival. Call it only after the host says whose it is. person is cleaner, pro (with the pro's proId from Fixer Core), host, guest, shared (a code more than one person uses) or none to forget it. Never give the code's digits.",
  inputSchema: {
    type: "object",
    properties: {
      codeName: { type: "string", minLength: 1, maxLength: 80, description: "The lock's name for the code, never the code." },
      person: { type: "string", enum: ["cleaner", "pro", "host", "guest", "shared", "none"] },
      proId: { type: "string", description: "With person pro: the pro's id." },
    },
    required: ["codeName", "person"],
    additionalProperties: false,
  },
};

export const VISIT_TOOLS: readonly Record<string, unknown>[] = [LIST, HEALTH, NAME_CODE];
export const VISIT_TOOL_NAMES: ReadonlySet<string> = new Set(VISIT_TOOLS.map((tool) => tool.name as string));

/** Answers one visit records tool. Undefined when the name isn't one of them. */
export function handleVisitTool(desk: VisitDesk, name: string, args: unknown): VisitReply | undefined {
  if (!VISIT_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (name === "list_visits") return desk.listVisits({ from: input.from, to: input.to });
  if (name === "visit_health") return desk.health();
  return desk.nameLockCode({ codeName: input.codeName, person: input.person, proId: input.proId });
}
