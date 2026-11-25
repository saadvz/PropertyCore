/**
 * The camera tools (#239), as tools/list shows them. Each takes `property` on the shared service. Hosts see
 * "Ring" by name (Saad, 19 Nov); the code underneath stays provider-neutral.
 */

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

const CONNECT = {
  name: "connect_cameras",
  title: "Connect Ring cameras",
  description:
    "A one-time link, good for 30 minutes, where the host agrees to what Property Core reads. The page then tells them how to connect Property Core in Ring, and Ring sends them back to a Property Core page to finish. Never ask for their Ring password, or for the pairing word the page shows them. Give the link to the host; after they finish, call list_cameras and ask which outdoor cameras belong to this property. Indoor cameras are never used.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const LIST = {
  name: "list_cameras",
  title: "Ring cameras",
  description:
    "The host's Ring cameras, which ones this property uses, whether each is online, and any camera notes to tell the host once (a camera offline, or back). With no Ring account connected, says so; use connect_cameras.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const PICK = {
  name: "pick_cameras",
  title: "Pick this property's cameras",
  description:
    "Saves which of the host's Ring cameras belong to this property. Ask the host about each by name, and set outdoor: true only after they say it's outdoors; indoor cameras are never used. The list replaces the last one.",
  inputSchema: {
    type: "object",
    properties: { cameras: { type: "array", maxItems: 20, items: { type: "object", properties: { deviceId: { type: "string", maxLength: 100 }, outdoor: { type: "boolean" } }, required: ["deviceId", "outdoor"], additionalProperties: false } } },
    required: ["cameras"],
    additionalProperties: false,
  },
};

const DISCONNECT = {
  name: "disconnect_cameras",
  title: "Disconnect Ring",
  description: "Only when the host asks: forgets the host's Ring sign-in and every property's camera picks. Events already kept stay in the property's record.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const NIGHT = {
  name: "check_night",
  title: "Check one night",
  description: "Runs the nightly stay check now for one night of a stay, on this property's camera events, against the booking and the house rules. Returns clean, or the alert text with the clip. It sends nothing to anyone.",
  inputSchema: { type: "object", properties: { date: { ...DATE, description: "The night, YYYY-MM-DD: the evening's date." } }, required: ["date"], additionalProperties: false },
};

const TIMELINE = {
  name: "stay_timeline",
  title: "Stay timeline",
  description: "Who came and went during one stay, from the property's camera events (and lock events once the lock is connected), in local time, ready to attach to a platform claim. Counts only; nobody is identified.",
  inputSchema: { type: "object", properties: { checkIn: { ...DATE, description: "The stay's check-in date." } }, required: ["checkIn"], additionalProperties: false },
};

const PIN = {
  name: "pin_clip",
  title: "Keep a clip as evidence",
  description: "Only when the host asks: copies one camera event's clip from Ring into the property's evidence, from 30 seconds before to 60 seconds after. This is the only video Property Core keeps. Take eventId from stay_timeline.",
  inputSchema: { type: "object", properties: { eventId: { type: "string", maxLength: 200 } }, required: ["eventId"], additionalProperties: false },
};

export const CAMERA_TOOLS: readonly Record<string, unknown>[] = [CONNECT, LIST, PICK, DISCONNECT, NIGHT, TIMELINE, PIN];
export const CAMERA_TOOL_NAMES: ReadonlySet<string> = new Set(CAMERA_TOOLS.map((tool) => tool.name as string));
