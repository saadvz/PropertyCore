import type { LockDesk, LockReply } from "./desk";

/**
 * Connected-lock tools (#180), as tools/list shows them, behind the account's "locks" switch. Each takes `property` on
 * the shared service. No tool returns or takes a door code, and no text here names the lock partner.
 */

const CONFIRMATION = { type: "string", maxLength: 80, description: "The code from the first call, only after the host's yes." };
const TWO_CALL = "Call without confirmation to get the question and a code, ask the host, and call again with the code only after their yes.";
const MODE = { type: "string", enum: ["ask", "automatic"] };

const GET = {
  name: "get_locks",
  title: "Connected locks",
  description:
    "The property's connected locks and sensors: online, battery, which locks the cleaner and pros use, how codes go out, standing codes, each per-visit code's status by door (scheduled: waiting for its window to open, which is normal before a visit), and any problem. After the host signs in: whether their lock account is connected (account), and its devices not yet on a property (available), whose ids save_locks takes. Never a code: you never see or pass one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const CONNECT = {
  name: "connect_lock",
  title: "Connect a smart lock",
  description:
    "Offer this when the host has a smart lock that works with an app: each cleaner and pro then gets their own code for each visit. Gives a one-time sign-in link: send it to the host, who signs in to their lock account there, never in chat. kind: sensors for a thermostat or noise sensor in an app. Then call get_locks to see the devices.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["locks", "sensors"] },
      fresh: { type: "boolean", description: "Only when get_locks says the lock account is still disconnected after the host signed in again: removes the stuck connection first, with the host's yes." },
      confirmation: CONFIRMATION,
    },
    additionalProperties: false,
  },
};

const SAVE = {
  name: "save_locks",
  title: "Pick this property's locks",
  description: `Which connected locks the cleaner and pros go through (doors), and which sensors are here, by their ids from get_locks. Ask the host whether any other door they use isn't a connected lock (a lockbox, a gate keypad): pass otherDoors: true, and the property keeps the saved door code. Connected locks switch on only once the alerts routine works. off: true switches back to the saved door code. ${TWO_CALL}`,
  inputSchema: {
    type: "object",
    properties: {
      doors: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 10 },
      sensors: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 10 },
      otherDoors: { type: "boolean" },
      off: { type: "boolean" },
      confirmation: CONFIRMATION,
    },
    additionalProperties: false,
  },
};

const SETTINGS = {
  name: "lock_settings",
  title: "How codes go out",
  description: `On connected locks, how codes go out. cleaners: ask (default; the code waits for the host's "guests have left") or automatic (the code goes at checkout time; the host gets a heads-up an hour before and can say pause). pros: ask (default; the host OKs each pro's code with approve_code) or automatic. packages: ask (default; the code for the person bringing a package in waits for the host's OK with approve_bring_in_code) or automatic (they get it by text once the drop is seen). extend: ask (default) or automatic (a pro still inside 15 minutes before their code stops gets 30 more minutes, never into the next check-in). ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { cleaners: MODE, pros: MODE, packages: MODE, extend: MODE, confirmation: CONFIRMATION }, additionalProperties: false },
};

const ADD_STANDING = {
  name: "add_standing_code",
  title: "Give someone a standing code",
  description: `A standing door code for the host (role owner), a co-owner or a co-host, so their own entries are recorded too. Never for a cleaner or pro: theirs are per visit. When the host asks for their own, it's role owner with the host's name: leave phone out, and their confirmed number on file is used; the question names its last four, so never ask the host to type their number. Property Core makes the code. The host's own code skips the YES: the private link goes to their confirmed number once they say yes here. Anyone else gets one text asking them to reply YES, then a private link that shows the code once. Never ask for or repeat a code. ${TWO_CALL}`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      phone: { type: "string", maxLength: 30, description: "Their mobile, with country code. Leave out for the host's own code (role owner): the number on file is used." },
      role: { type: "string", enum: ["owner", "co-owner", "co-host"] },
      confirmation: CONFIRMATION,
    },
    required: ["name", "role"],
    additionalProperties: false,
  },
};

const LINK = {
  name: "standing_code_link",
  title: "New link to a standing code",
  description: `Texts the person a new private link to their standing code, after they replied YES; the old link stops working. Before their YES, it texts the invite again instead (when theirs never arrived), so there's no need to remove and remake the code. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { id: { type: "string", maxLength: 40 }, confirmation: CONFIRMATION }, required: ["id"], additionalProperties: false },
};

const REMOVE = {
  name: "remove_standing_code",
  title: "Remove a standing code",
  description: `Removes a standing code from the locks. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { id: { type: "string", maxLength: 40 }, confirmation: CONFIRMATION }, required: ["id"], additionalProperties: false },
};

export const LOCK_TOOLS: readonly Record<string, unknown>[] = [GET, CONNECT, SAVE, SETTINGS, ADD_STANDING, LINK, REMOVE];
export const LOCK_TOOL_NAMES: ReadonlySet<string> = new Set(LOCK_TOOLS.map((tool) => tool.name as string));

/** Answers one lock tool. Undefined when the name isn't one of them. */
export async function handleLockTool(desk: LockDesk, name: string, args: unknown): Promise<LockReply | undefined> {
  if (!LOCK_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const allowed = new Set(Object.keys(((LOCK_TOOLS.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties)));
  if (Object.keys(input).some((key) => !allowed.has(key))) return { text: "That tool doesn't take that field.", isError: true };
  if (name === "get_locks") return desk.list();
  if (name === "connect_lock") return desk.connectLink(input);
  if (name === "save_locks") return desk.saveLocks(input);
  if (name === "lock_settings") return desk.settings(input);
  if (name === "add_standing_code") return desk.addStanding(input);
  if (name === "standing_code_link") return desk.newLink(input);
  return desk.removeStanding(input);
}
