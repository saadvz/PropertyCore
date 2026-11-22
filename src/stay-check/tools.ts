import type { StayCheckDesk, StayCheckReply } from "./desk";
import { CHECK_KINDS, MAX_RULE_TEXT, MAX_RULES } from "./rules";

/** The nightly stay check's tools (#239), as tools/list shows them. Each one takes `property` on the shared service. */

const CLOCK = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" };
const KINDS = { type: "string", enum: [...CHECK_KINDS] };

const CHECK = {
  oneOf: [
    { type: "object", properties: { kind: { const: "people" }, max: { type: "integer", minimum: 1, maximum: 50, description: "Leave out to use the number booked." } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "pets" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "vehicles" }, max: { type: "integer", minimum: 0, maximum: 20 } }, required: ["kind", "max"], additionalProperties: false },
    {
      type: "object",
      properties: { kind: { const: "quiet" }, start: { ...CLOCK, description: "24-hour, like 22:00." }, end: { ...CLOCK, description: "24-hour, like 07:00. May be after midnight." }, noiseLimit: { type: "integer", minimum: 30, maximum: 120, description: "Decibels. When set, only noise over it counts. Leave out to use the sensor's own noise alert." } },
      required: ["kind", "start", "end"],
      additionalProperties: false,
    },
  ],
};

const GET = {
  name: "get_house_rules",
  title: "House rules",
  description:
    "The host's house rules: one list, used by the nightly stay check and for drafting guest replies, with the check time and anything allowed for one stay. With none saved, it says how to ask the host for their rules in their own words, starting with what the cameras can check (guests, pets, cars, quiet hours). Setup asks this and nothing else about the house. Never suggest a rule they didn't give. Read back each rule the cameras can watch in checkable form before you save its check.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const SAVE = {
  name: "save_house_rules",
  title: "Save house rules",
  description: `Saves the host's house rules in their own words, and the nightly check time. rules replaces the whole list; an empty list clears it. add puts one rule at the end, like a rule the host gave while answering a guest. Give a rule a check only after you read it back and the host agreed; save every other rule as text only. At most one check of each kind. No door codes or long numbers in a rule. Up to ${MAX_RULES} rules. Every rule is used for guest replies too. Nothing is sent to anyone from here.`,
  inputSchema: {
    type: "object",
    properties: {
      rules: {
        type: "array",
        maxItems: MAX_RULES,
        items: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_RULE_TEXT, description: "The host's words." }, check: CHECK }, required: ["text"], additionalProperties: false },
      },
      add: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_RULE_TEXT, description: "The host's words." }, check: CHECK }, required: ["text"], additionalProperties: false, description: "One rule to add to the end of the list. Not with rules." },
      checkTime: { ...CLOCK, description: "When the night is checked, 24-hour. A time before noon checks the night before it. Unset is 23:00." },
    },
    additionalProperties: false,
  },
};

const ALLOW = {
  name: "allow_for_stay",
  title: "Allow something for one stay",
  description: "Something the host allows for one stay only, like a dog on this weekend's stay. Call it only after the host says so. The stay is named by its check-in date. An empty allow list removes the stay's allowance.",
  inputSchema: {
    type: "object",
    properties: { checkIn: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The stay's check-in date, YYYY-MM-DD." }, allow: { type: "array", items: KINDS, maxItems: CHECK_KINDS.length } },
    required: ["checkIn", "allow"],
    additionalProperties: false,
  },
};

const MARK_FALSE = {
  name: "mark_flag_false",
  title: "Mark a nightly flag false",
  description:
    "Call only after the host says a nightly stay check flag was wrong, like a neighbour's car counted as a guest's. That kind of flag then needs one more sighting in a night at this property, up to 3. It never raises the number of guests or cars allowed; to allow something for one stay, use allow_for_stay instead.",
  inputSchema: { type: "object", properties: { kind: KINDS }, required: ["kind"], additionalProperties: false },
};

export const STAY_CHECK_TOOLS: readonly Record<string, unknown>[] = [GET, SAVE, ALLOW, MARK_FALSE];
export const STAY_CHECK_TOOL_NAMES: ReadonlySet<string> = new Set(STAY_CHECK_TOOLS.map((tool) => tool.name as string));

/** Answers one stay check tool. Undefined when the name isn't one of them. */
export function handleStayCheckTool(desk: StayCheckDesk, name: string, args: unknown): StayCheckReply | undefined {
  if (!STAY_CHECK_TOOL_NAMES.has(name)) return undefined;
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (name === "get_house_rules") return desk.getRules();
  if (name === "save_house_rules") return desk.saveRules({ rules: input.rules, add: input.add, checkTime: input.checkTime });
  if (name === "mark_flag_false") return desk.markFlagFalse({ kind: input.kind });
  return desk.allowForStay({ checkIn: input.checkIn, allow: input.allow });
}
