import type { LockReply } from "./desk";
import type { GuestCodeDesk } from "./guestDesk";

/**
 * Guest-code tools (#262), as tools/list shows them, behind GUEST_CODES and SMART_LOCKS. Each takes
 * `property` on the shared service. No tool returns or takes a door code, and no text here names the
 * lock partner.
 */

const CONFIRMATION = { type: "string", maxLength: 80, description: "The code from the first call, only after the host's yes." };
const TWO_CALL = "Call without confirmation to get the question and a code, ask the host, and call again with the code only after their yes.";
const STAY = { type: "string", maxLength: 20, description: "The booking's confirmation code, from get_guest_codes." };
const DATE = { type: "string", maxLength: 10, description: "YYYY-MM-DD" };
const ID = { type: "string", maxLength: 40 };

const GET = {
  name: "get_guest_codes",
  title: "Guests' door codes",
  description:
    "How guests' door codes work here (automatic, ask or off), each upcoming booking's code status and whether the host's private link went, and each lease. Only on a property with a connected lock. Never a code: you never see or pass one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const MODE = {
  name: "guest_codes",
  title: "How guests' door codes work",
  description: `The host's choice, only once the property's lock is connected: automatic (a code for each booking, on the lock from check-in to checkout, made 7 days ahead; the host gets a private link to copy it into their arrival message), ask (the host says yes to each booking's code), or off (the host makes guests' codes themselves; every booking's code comes off). ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["automatic", "ask", "off"] }, confirmation: CONFIRMATION }, required: ["mode"], additionalProperties: false },
};

const MAKE = {
  name: "make_guest_code",
  title: "Make one booking's door code",
  description: `When guests' codes are on ask: the host's yes to one booking's code. Take stay from get_guest_codes, where that booking shows waiting-for-host. It then follows the booking's changes on its own. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { stay: STAY, confirmation: CONFIRMATION }, required: ["stay"], additionalProperties: false },
};

const LINK = {
  name: "guest_code_link",
  title: "New link to a booking's door code",
  description: `A new private link for the host to one booking's door code. It opens once; the old link stops working. Give it to the host; never open it yourself. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { stay: STAY, confirmation: CONFIRMATION }, required: ["stay"], additionalProperties: false },
};

const ADD_LEASE = {
  name: "add_lease",
  title: "Give a tenant a door code",
  description: `A door code for a tenant on an off-platform lease, from its start until the end of move-out day. Property Core makes the code. The tenant gets one text asking them to reply YES, then a private link that shows the code once. Never ask for or repeat a code. ${TWO_CALL}`,
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 60 }, phone: { type: "string", maxLength: 30, description: "Their mobile, with country code." }, start: DATE, moveOut: DATE, confirmation: CONFIRMATION },
    required: ["name", "phone", "start", "moveOut"],
    additionalProperties: false,
  },
};

const CHANGE_LEASE = {
  name: "change_lease",
  title: "Change a lease's move-out day",
  description: `A new move-out day for a lease; the tenant's code then ends at the end of that day. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { id: ID, moveOut: DATE, confirmation: CONFIRMATION }, required: ["id", "moveOut"], additionalProperties: false },
};

const REMOVE_LEASE = {
  name: "remove_lease",
  title: "Remove a tenant's door code",
  description: `Takes a tenant's door code off the lock. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { id: ID, confirmation: CONFIRMATION }, required: ["id"], additionalProperties: false },
};

const LEASE_LINK = {
  name: "lease_code_link",
  title: "New link to a tenant's door code",
  description: `Texts the tenant a new private link to their door code, after they replied YES. The old link stops working. ${TWO_CALL}`,
  inputSchema: { type: "object", properties: { id: ID, confirmation: CONFIRMATION }, required: ["id"], additionalProperties: false },
};

export const GUEST_TOOLS: readonly Record<string, unknown>[] = [GET, MODE, MAKE, LINK, ADD_LEASE, CHANGE_LEASE, REMOVE_LEASE, LEASE_LINK];
export const GUEST_TOOL_NAMES: ReadonlySet<string> = new Set(GUEST_TOOLS.map((tool) => tool.name as string));

/** Answers one guest-code tool. Undefined when the name isn't one of them. */
export async function handleGuestTool(desk: GuestCodeDesk, name: string, args: unknown): Promise<LockReply | undefined> {
  if (!GUEST_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const allowed = new Set(Object.keys((GUEST_TOOLS.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties));
  if (Object.keys(input).some((key) => !allowed.has(key))) return { text: "That tool doesn't take that field.", isError: true };
  if (name === "get_guest_codes") return desk.status();
  if (name === "guest_codes") return desk.setMode(input);
  if (name === "make_guest_code") return desk.makeCode(input);
  if (name === "guest_code_link") return desk.newLink(input);
  if (name === "add_lease") return desk.addLease(input);
  if (name === "change_lease") return desk.changeLease(input);
  if (name === "remove_lease") return desk.removeLease(input);
  return desk.leaseLink(input);
}
