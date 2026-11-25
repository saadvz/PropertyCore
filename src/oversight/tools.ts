import type { OversightDesk, OversightReply } from "./desk";
import { MAX_NOTE, MAX_WHO } from "./visits";

/** Remote oversight's expected visit tools (#240), as tools/list shows them. Each one takes `property` on the shared service. */

const CLOCK = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" };

const ADD = {
  name: "add_expected_visit",
  title: "Expect a visit",
  description:
    "Saves a visit the host expects at the property, like someone telling the host \"I'll stop by Thursday afternoon\": a property manager, a cleaner, a handyman or a friend. If no one comes in, it's flagged the same day: 1 hour after the window, or at 8 PM for an all-day visit. From what the host says or forwards: give who, date, and from and to when there's a time. Loose words get a suggested window the host can change: morning 08:00-12:00, afternoon 12:00-17:00, evening 17:00-20:00. No time at all is an all-day visit. Read the visit back to the host (\"Mike Doyle, Thursday Nov 19, 12 to 5 PM?\") and save only after they agree. From a calendar invite the visitor sent: pass the invite's text as invite, with who if it doesn't name the organizer. The first call reads it back without saving; call again with confirm: true once the host agrees. Never create a visit the host didn't give. No door codes in who or note. With connected locks, the visitor can have their own door code for this visit: give their phone, and the read-back becomes a question with a confirmation code (\"Mike Doyle, Thursday, Nov 19, 12 to 5 PM, with their own door code?\"); call again with confirmation only after the host's yes. They get one text asking them to reply YES (once ever), then the code by text 30 minutes before the visit, working for the visit's window. When the visitor told the host yes another way (email, a call, or the host set it up), pass confirmedVia: the code is made for this visit, and a visitor who doesn't take texts gets it through the host's private page (visit_code_link). No code during a guest's stay. Without a phone nothing is sent to anyone from here.",
  inputSchema: {
    type: "object",
    properties: {
      who: { type: "string", minLength: 1, maxLength: MAX_WHO, description: "The person's name, as the host or the invite gives it." },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The day at the property, YYYY-MM-DD." },
      from: { ...CLOCK, description: "24-hour, like 13:00. Give with to, or leave both out for an all-day visit." },
      to: { ...CLOCK, description: "24-hour, like 17:00, after from on the same day." },
      note: { type: "string", minLength: 1, maxLength: MAX_NOTE, description: "Why, like walk-through." },
      invite: { type: "string", maxLength: 20000, description: "A calendar invite's text (.ics), in place of date, from, to and note." },
      confirm: { type: "boolean", description: "With invite: true once the host agreed to the read-back." },
      phone: { type: "string", maxLength: 30, description: "The visitor's mobile, with country code, only when the host wants them to have their own door code for this visit. Needs connected locks. Never the host's own number." },
      confirmation: { type: "string", description: "With phone: the confirmation code from the first call, only after the host's yes to the read-back." },
      confirmedVia: { type: "string", enum: ["email", "call", "host-arranged"], description: "With phone, only when the host says the visitor already told them yes by email or on a call, or the host set the visit up with them: their code is made for this visit without waiting for their text YES, and the one question covers both." },
    },
    additionalProperties: false,
  },
};

const LIST = {
  name: "list_expected_visits",
  title: "Expected visits",
  description: "The visits expected at the property from today on, with their ids, and the last week's visits with when each was flagged or cancelled.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const CANCEL = {
  name: "cancel_expected_visit",
  title: "Cancel an expected visit",
  description: "Cancels one expected visit by its id, like when the visitor moves it. Call it only after the host says so. A moved visit is cancelled and saved again on the new day.",
  inputSchema: { type: "object", properties: { id: { type: "string", description: "The visit's id from list_expected_visits." } }, required: ["id"], additionalProperties: false },
};

const CONFIRM = {
  name: "confirm_expected_visit",
  title: "The visitor confirmed",
  description:
    "A visitor's own door code is made only once their yes to the visit is on record. A visitor who takes texts gives it by replying YES. Otherwise the host passes it on for one visit: via email or call when the visitor told them that way, or host-arranged when the host set the visit up with them. It counts for this visit only. The first call returns a question and a confirmation code; ask the host and call again with it only after their yes. A visitor who doesn't take texts (or replied STOP) gets their code through visit_code_link, for the host to read to them. Never returns a code.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The visit's id from list_expected_visits." },
      via: { type: "string", enum: ["email", "call", "host-arranged"] },
      confirmation: { type: "string", description: "The confirmation code from the first call, only after the host's yes." },
    },
    required: ["id", "via"],
    additionalProperties: false,
  },
};

const LINK = {
  name: "visit_code_link",
  title: "The host's page with a visitor's code",
  description:
    "On connected locks, for a visit the host confirmed whose visitor doesn't get texts from the line (or replied STOP): a private page for the host alone that shows the visitor's own door code once, for the host to read to them. The first call returns a question and a confirmation code; ask the host and call again with it only after their yes. It opens once and ends with the visit. Never send it to the visitor or a group. The code itself is never returned.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The visit's id from list_expected_visits." },
      confirmation: { type: "string", description: "The confirmation code from the first call, only after the host's yes." },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

export const OVERSIGHT_TOOLS: readonly Record<string, unknown>[] = [ADD, LIST, CANCEL, CONFIRM, LINK];
export const OVERSIGHT_TOOL_NAMES: ReadonlySet<string> = new Set(OVERSIGHT_TOOLS.map((tool) => tool.name as string));

/** Answers one expected visit tool. Undefined when the name isn't one of them. */
export function handleOversightTool(desk: OversightDesk, name: string, args: unknown): OversightReply | undefined {
  if (!OVERSIGHT_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (name === "add_expected_visit") return desk.addVisit({ who: input.who, date: input.date, from: input.from, to: input.to, note: input.note, invite: input.invite, confirm: input.confirm, phone: input.phone, confirmation: input.confirmation, confirmedVia: input.confirmedVia });
  if (name === "confirm_expected_visit") return desk.confirmVisit({ id: input.id, via: input.via, confirmation: input.confirmation });
  if (name === "visit_code_link") return desk.codeLink({ id: input.id, confirmation: input.confirmation });
  if (name === "list_expected_visits") return desk.listVisits();
  return desk.cancelVisit({ id: input.id });
}
