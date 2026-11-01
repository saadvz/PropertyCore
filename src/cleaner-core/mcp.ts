import { z } from "zod";
import type { SettingName } from "../install/secretStore";
import { ASSISTANT_PROFILES, CHATGPT_INSTRUCTIONS, CLAUDE_INSTRUCTIONS, MUSE_INSTRUCTIONS, type CleanerAssistant } from "./assistant";
import { DOOR_CODE_IN_CHAT, type LiveDesk, type ToolReply } from "./liveDesk";
import type { GoogleEventList } from "./sources";
import { DELIVERY_REPORTS, SCRATCH_TOOLS } from "./scratchQa";

export const CLEANER_MCP_PATH = "/mcp/cleaner-core";

/** A 24-hour clock time. Grok turns the host's words into this before it calls a tool. */
const HOUR_MINUTE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SERVER_INFO = { name: "cleaner-core", title: "Cleaning scheduler", version: "0.1.0" };

const TOOLS = [
  {
    name: "get_state",
    title: "See what's done",
    description:
      "Call this first and follow its next step. During setup it returns ask: the questions for this step, each with the field it fills, any options, and a default. Ask them one at a time in your own short words, show options as a choice card, then call the step's tool. Pass choice only when the host just answered get_state's own question: tours or cleaners.",
    input: z.object({ choice: z.enum(["tours", "cleaners"]).optional() }),
  },
  {
    name: "save_property",
    title: "Save the property",
    description:
      "Saves the business name, the property address, the time zone, and the usual checkoutTime and checkInTime, each a 24-hour HH:MM time like 11:00 or 16:00. Setup asks for the usual times before it moves on. Optional: the property's nickname and its type.",
    input: z.object({
      business: z.string(),
      address: z.string(),
      timeZone: z.string(),
      nickname: z.string().optional(),
      propertyType: z.string().optional(),
      checkoutTime: z.string().regex(HOUR_MINUTE, "24-hour HH:MM").optional(),
      checkInTime: z.string().regex(HOUR_MINUTE, "24-hour HH:MM").optional(),
    }),
  },
  {
    name: "save_people",
    title: "Save the people",
    description:
      "Saves the host and the cleaner. Each one is a phone number. An observer is optional. Optional: hostName (what the group calls the host; unset uses the business name), cleanerName, up to 4 contacts (name, role co-host, assistant, or observer, and phone), and groupChat: cleaner-only (one-to-one texts), cleaner-and-host, or everyone. When contacts are in the group, also doorCodeTo: group (the whole group gets the door code) or cleaner (only the cleaner, privately).",
    input: z.object({
      host: z.string(),
      hostName: z.string().optional(),
      cleaner: z.string(),
      observer: z.string().optional(),
      cleanerName: z.string().optional(),
      contacts: z.array(z.object({ name: z.string(), role: z.enum(["co-host", "assistant", "observer"]), phone: z.string() })).max(4).optional(),
      groupChat: z.enum(["cleaner-only", "cleaner-and-host", "everyone"]).optional(),
      doorCodeTo: z.enum(["group", "cleaner"]).optional(),
    }),
  },
  {
    name: "save_calendar_link",
    title: "Save the calendar link",
    description: "Saves where the bookings come from. Pass the Guesty Lite link as url, or google true when the host uses Google Calendar, or both. The first job is read from those.",
    input: z.object({ url: z.string().optional(), google: z.boolean().optional() }),
  },
  {
    name: "save_sources",
    title: "Save the booking calendars",
    description:
      "Saves where bookings come from. calendars replaces every saved link: each is a name and its public https iCal url (Guesty, Airbnb, Vrbo, direct, or other), up to 8. A link on your secure card can't be passed here: pass uploadLink with the calendar's name instead, and post the link from your own computer to the one-time uploadUrl in the reply. Pass google true or false only to change Google Calendar; leaving it out keeps it. If the change would call off an upcoming cleaning, it is refused with wouldCancel: ask the host, then save again with dropJobs true. Pass done true once the host says there are no more calendars to add. The reply never repeats a link.",
    input: z.object({
      calendars: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
      google: z.boolean().optional(),
      dropJobs: z.boolean().optional(),
      uploadLink: z.object({ name: z.string().optional() }).optional(),
      done: z.boolean().optional(),
    }),
  },
  {
    name: "save_schedule",
    title: "Save the messaging schedule",
    description:
      "Saves when the cleaner gets texts. firstText: when-confirmed (right after the host confirms the times), days-after-check-in with firstTextDays, or days-before-checkout with firstTextDays, sent at 9:00 AM that day. With many bookings ahead, when-confirmed offers them one after another as each is accepted; a days-before-checkout setting offers each one only on its day. reminder: morning-of or days-before-checkout with reminderDays, at reminderTime, a 24-hour HH:MM time like 18:00. Days run 1 to 14. Optional quietFrom and quietUntil, 24-hour HH:MM like 21:00 and 08:00, hold the first cleaning text and the reminder until they end; empty ones clear them. escalateTo names who should hear about problems; alerts still go to the host. A field left out keeps what was saved. Pass {} to keep the defaults: the first text 1 day before checkout, and the reminder at 8:00 AM on checkout morning. Nothing here sends the door code.",
    input: z.object({
      firstText: z.enum(["when-confirmed", "days-after-check-in", "days-before-checkout"]).optional(),
      firstTextDays: z.number().int().min(1).max(14).optional(),
      reminder: z.enum(["morning-of", "days-before-checkout"]).optional(),
      reminderDays: z.number().int().min(1).max(14).optional(),
      reminderTime: z.string().regex(HOUR_MINUTE, "24-hour HH:MM").optional(),
      quietFrom: z.string().regex(HOUR_MINUTE, "24-hour HH:MM").or(z.literal("")).optional(),
      quietUntil: z.string().regex(HOUR_MINUTE, "24-hour HH:MM").or(z.literal("")).optional(),
      escalateTo: z.string().optional(),
    }),
  },
  {
    name: "save_door_code",
    title: "Save the door code",
    description:
      "Stores the door code. A code on your secure card can't be passed here: call it with no code (lockLocation is fine) to get a one-time uploadUrl, and post {\"code\": \"...\"} to it from your own computer. The reply never includes the digits. The code is not returned later. lockLocation is optional: where the lock is, like back door lockbox, with no numbers. It is named in the cleaner's door code text.",
    input: z.object({ code: z.string().optional(), lockLocation: z.string().optional() }),
  },
  {
    name: "save_preferences",
    title: "Save the cleaning preferences",
    description:
      "Saves the cleaning preferences: checklist items (up to 12, each under 80 characters), photosRequired, supplyNotes, and other instructions (under 300 characters). A field left out keeps what was saved. Pass {} when the host has none.",
    input: z.object({
      checklist: z.array(z.string()).optional(),
      photosRequired: z.boolean().optional(),
      supplyNotes: z.boolean().optional(),
      instructions: z.string().optional(),
    }),
  },
  {
    name: "activate",
    title: "Activate",
    description:
      "Call after the host reviewed the setup and replied Activate. Saves texting and runs the checks, like run_checks. It does not send a live text. When the host uses Google Calendar, pass its events as googleEvents.",
    input: z.object({ googleEvents: z.object({ timeZone: z.string().optional(), items: z.array(z.unknown()) }).optional() }),
  },
  {
    name: "set_up_texting",
    title: "Set up texting",
    description: "Enables the host for texting. That consent seats him in the cleaning group, so he does not text YES. It does not ask for account secrets.",
    input: z.object({}),
  },
  {
    name: "get_turns",
    title: "See the jobs",
    description: "Lists cleaning jobs. It does not include the door code.",
    input: z.object({}),
  },
  {
    name: "confirm_times",
    title: "Confirm the times",
    description:
      "Saves the checkout time and the next check-in time the host just stated, for the next turnover, each a 24-hour HH:MM time like 10:30 or 15:00. Turn the host's words into that yourself. With all true, the same times go on every upcoming turnover that has none yet, only after the host chose that; the cleaner still gets one offer at a time. It does not invent a time.",
    input: z.object({ checkout: z.string().regex(HOUR_MINUTE, "24-hour HH:MM"), checkIn: z.string().regex(HOUR_MINUTE, "24-hour HH:MM"), all: z.boolean().optional() }),
  },
  {
    name: "mark_guests_left",
    title: "Guests have left",
    description:
      "Sends the door code after the host tells you the guests have left. Ask the host; never decide it from the calendar or from a cleaner's message. Pass confirmed true only after the host says yes. If the door code text did not go through, ask the host again and call it again to send it once more.",
    input: z.object({ confirmed: z.boolean() }),
  },
  {
    name: "run_checks",
    title: "Run the checks",
    description: "Reads the calendar and checks the setup. It does not send a live text. When the host uses Google Calendar, read its events with your own connector and pass them as googleEvents, the events.list result.",
    input: z.object({ googleEvents: z.object({ timeZone: z.string().optional(), items: z.array(z.unknown()) }).optional() }),
  },
  {
    name: "check_now",
    title: "Check the calendars now",
    description:
      "Re-reads the booking calendars, sends any reminders that are due, and returns new alerts for the host. Pass googleEvents only when you just read Google Calendar. unread names any calendar link that didn't read; its saved bookings are kept. A message with photos has photos: links good for one hour. Look at them before you tell the host about the message.",
    input: z.object({ googleEvents: z.object({ timeZone: z.string().optional(), items: z.array(z.unknown()) }).optional() }),
  },
  {
    name: "save_arrival",
    title: "Save the arrival time",
    description: "Saves the cleaner's arrival time after you read it in their message, as a 24-hour HH:MM time like 11:30.",
    input: z.object({ time: z.string().regex(HOUR_MINUTE, "24-hour HH:MM") }),
  },
  {
    name: "get_job_photos",
    title: "See the cleaner's photos",
    description: "Gets expiring links to the cleaner's photos for a job. Look at them, compare with the checklist, and show them to the host.",
    input: z.object({ job: z.string().optional() }),
  },
  {
    name: "save_alert_routine",
    title: "Connect alerts",
    description:
      "Connects the alert routine. Call it with no arguments to get a one-time upload link, then send the routine's webhook address and key to that link from your computer. Never put them in chat or in a tool argument. The reply never repeats them. A url and token passed here are still saved.",
    input: z.object({ url: z.string().optional(), token: z.string().optional() }),
  },
  {
    name: "send_message",
    title: "Send a message",
    description:
      "Sends the host's own message. With a group, messages go only to the group (to: group). Without one, to is the cleaner or a saved contact. Call once without confirmation to get a preview and code, show the host the exact text, and call again with the code only after the host says yes.",
    input: z.object({ to: z.string(), text: z.string(), confirmation: z.string().optional() }),
  },
  {
    name: "retry_send",
    title: "Send it again",
    description:
      "Sends a cleaning offer or reminder that may not have gone out once more, to the opted-in cleaner only. An alert tells you when one is waiting. Ask the host first, and pass confirmed true only after the host says yes.",
    input: z.object({ confirmed: z.boolean() }),
  },
  {
    name: "hold_job",
    title: "Pause the cleaning",
    description:
      "Pauses the cleaning, only when the host decides to. When a message sounds like a problem (a broken lock, no access, a mess, anything that might stop the cleaning), tell the host right away, quote what was said, and ask whether to pause. Call once without confirmation to get the question and a code, ask the host that question, and call again with the code only after the host says yes. Never pause on your own. A text from the cleaner cannot do this.",
    input: z.object({ confirmation: z.string().optional() }),
  },
  {
    name: "resume_job",
    title: "Resume the cleaning",
    description:
      "Resumes a cleaning that was on hold, only when the host decides to. Call once without confirmation to get the question and a code, ask the host that question, and call again with the code only after the host says yes. A text from the cleaner cannot do this.",
    input: z.object({ confirmation: z.string().optional() }),
  },
  {
    name: "reset_property",
    title: "Reset the property",
    description:
      "Resets Cleaner Core for this property, as if it was never set up: setup, jobs, messages, consent, the saved door code, the alert routine connection, and the group text on Twilio. Call once without confirmation to get a preview and code, show the host the exact text, and call again with the code only after the host says yes. Twilio settings and Grok logins stay.",
    input: z.object({ confirmation: z.string().optional() }),
  },
] as const;

function scratchCopy(name: (typeof SCRATCH_TOOLS)[number]["name"]) {
  const found = SCRATCH_TOOLS.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

const SCRATCH_TOOL_LIST = [
  {
    name: "reset_scratch",
    title: scratchCopy("reset_scratch").title,
    description: scratchCopy("reset_scratch").description,
    input: z.object({}),
  },
  {
    name: "read_inbox",
    title: scratchCopy("read_inbox").title,
    description: scratchCopy("read_inbox").description,
    input: z.object({}),
  },
  {
    name: "read_outbox",
    title: scratchCopy("read_outbox").title,
    description: scratchCopy("read_outbox").description,
    input: z.object({}),
  },
  {
    name: "send_test_text",
    title: scratchCopy("send_test_text").title,
    description: scratchCopy("send_test_text").description,
    input: z.object({ from: z.string(), text: z.string() }),
  },
  {
    name: "report_delivery",
    title: scratchCopy("report_delivery").title,
    description: scratchCopy("report_delivery").description,
    input: z.object({ which: z.string(), status: z.enum(DELIVERY_REPORTS) }),
  },
  {
    name: "add_test_turn",
    title: scratchCopy("add_test_turn").title,
    description: scratchCopy("add_test_turn").description,
    input: z.object({ checkout: z.string(), checkIn: z.string() }),
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"] | (typeof SCRATCH_TOOL_LIST)[number]["name"];

/** Every tool Cleaner Core can list, Scratch ones included. The shared service uses it to tell a cleaning tool from a touring one. */
export const CLEANER_TOOL_NAMES: readonly string[] = [...TOOLS, ...SCRATCH_TOOL_LIST].map((tool) => tool.name);

function listedTools(scratchTools: boolean) {
  return scratchTools ? [...TOOLS, ...SCRATCH_TOOL_LIST] : [...TOOLS];
}

const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** A Grok deployment's initialize instructions, unchanged. */
const GROK_INSTRUCTIONS = [
  "Call get_state first and follow its next step. Ask the host nothing about the property until get_state answers. When it returns ask, ask the host its questions in order, in a short plain sentence each. Each message asks exactly one question: never two in one message, even related ones like the checkout and check-in times, or a phone number and a name. When a question has options, show them as a choice card the host can tap, never as a list or a question in the text. Offer the default when there is one. Skip a question that has a when that doesn't apply. Then call the step's tool and follow its reply. Do not skip ahead. Do not read out a door code.",
  "Use check_now when a routine wakes you or the host says check my calendars. Read Google Calendar with your own connector first when the host uses it, only the calendar the host named for bookings. Post each alert in your own short words. Collect the door code only with your secure card, then send it from your own computer to the one-time upload link its setup step gives you. Never put a secret in chat. For the alert routine, send its webhook address and key from your own computer to the one-time upload link that save_alert_routine gives you.",
  "When check_now returns needsTimes, ask the host for the checkout time and the next check-in time, then call confirm_times with each as 24-hour HH:MM. You turn the host's words into clock times; Cleaner Core does not read words.",
  "The door code goes only after the host tells you the guests have left: ask them, then call mark_guests_left with confirmed true. When an alert says a text may not have gone out, ask the host whether to send it again, then call retry_send with confirmed true.",
  "confirm_times keeps a check-in time already saved. To change only the check-in time, tell the host it can't be changed by text yet.",
  "Read every message check_now returns. Tell the host in your own words when a message needs them: running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury. Stay quiet on routine replies. If a message gives an arrival time, call save_arrival.",
  "Cleaner Core never pauses a cleaning because of how a message sounds. When one sounds like a problem, tell the host right away, quote it, and ask whether to pause the cleaning. Pause with hold_job and resume with resume_job, each only after the host says yes.",
  "When a message needs a reply Cleaner Core doesn't send itself, draft one short reply and offer it to the host. Send it only with send_message after the host says yes.",
  "When check_now returns completed, call get_job_photos, look at the photos, and give the host a short summary in your own words: arrival, start and done times, checklist, what the photos show, and any notes.",
  "Setup goes in this order: save_property, save_sources, save_people, save_schedule, save_door_code on your secure card, save_preferences, then the Cleaner Core Check and Cleaner Core Alerts routines with save_alert_routine, then a review in your own words and activate after the host replies Activate. CLEANER_CORE_BOOTSTRAP.md in the repository has the full guide.",
].join(" ");

export type SaveSecrets = (values: Partial<Record<SettingName, string>>) => void;
export type DeleteSecrets = (names: SettingName[]) => void;

export async function handleCleanerMcpMessage(
  desk: LiveDesk,
  message: unknown,
  pinKey?: Buffer,
  scratchTools = false,
  saveSecrets?: SaveSecrets,
  deleteSecrets?: DeleteSecrets,
  /** The deployment's chat. Only the words and the photo format change. */
  assistant: CleanerAssistant = "grok",
): Promise<{ status: number; body?: unknown }> {
  if (Array.isArray(message)) return rpcError(null, -32600, "Batched requests aren't supported.");
  const parsed = Request.safeParse(message);
  if (!parsed.success) return rpcError(null, -32600, "That isn't a valid request.");
  const { id, method, params } = parsed.data;
  if (id === undefined) return { status: 202 };
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      // A Claude deployment has its own words. A Grok deployment's stay exactly as they were.
      instructions: { grok: GROK_INSTRUCTIONS, claude: CLAUDE_INSTRUCTIONS, chatgpt: CHATGPT_INSTRUCTIONS, muse: MUSE_INSTRUCTIONS }[assistant],
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: listedTools(scratchTools).map((tool) => {
        const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
        return { name: tool.name, title: tool.title, description: tool.description, inputSchema };
      }),
    });
  }
  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = listedTools(scratchTools).find((item) => item.name === name);
    if (!tool) return rpcError(id, -32602, "I can't do that from this chat.");
    const args = tool.input.safeParse(params?.arguments ?? {});
    if (!args.success) return rpcResult(id, { content: [{ type: "text", text: "That was missing something I need." }], isError: true });
    if (chatCarriesDoorCode(tool.name, args.data, desk)) {
      return rpcResult(id, { content: [{ type: "text", text: DOOR_CODE_IN_CHAT }], isError: true });
    }
    let reply: ToolReply;
    try {
      reply = await callTool(desk, tool.name, args.data, pinKey, saveSecrets, deleteSecrets);
    } catch {
      reply = { ok: false, error: "That didn't work. Try again." };
    }
    if (!reply.ok) {
      if (desk.leaks(reply.error) || (reply.result && desk.leaks(JSON.stringify(reply.result)))) reply = { ok: false, error: "That didn't work. Try again." };
      return rpcResult(id, { content: [{ type: "text", text: reply.error }], ...(reply.result ? { structuredContent: reply.result } : {}), isError: true });
    }
    const text = JSON.stringify(reply.result);
    if (desk.leaks(text)) return rpcResult(id, { content: [{ type: "text", text: "That didn't work. Try again." }], isError: true });
    // Claude can't open a signed photo link from a chat, so a Claude deployment sends the photos too.
    const links = tool.name === "get_job_photos" ? photoLinksOf(reply.result) : tool.name === "check_now" ? messagePhotoLinksOf(reply.result) : [];
    const images = links.length > 0 && ASSISTANT_PROFILES[assistant].photoImages ? desk.photoImages(links) : [];
    return rpcResult(id, { content: [{ type: "text", text }, ...images], structuredContent: reply.result, isError: false });
  }
  return rpcError(id, -32601, "I don't support that.");
}

/** The signed links on check_now's messages, in order. */
function messagePhotoLinksOf(result: Record<string, unknown>): { url: string }[] {
  const messages = result.messages;
  return Array.isArray(messages) ? messages.flatMap((message) => photoLinksOf(message as Record<string, unknown>)) : [];
}

/** The signed links in a get_job_photos result. */
function photoLinksOf(result: Record<string, unknown>): { url: string }[] {
  const photos = result.photos;
  return Array.isArray(photos) ? photos.filter((photo): photo is { url: string } => typeof (photo as { url?: unknown })?.url === "string") : [];
}

function chatCarriesDoorCode(name: string, args: object, desk: LiveDesk): boolean {
  for (const [key, value] of Object.entries(args)) {
    if (name === "save_door_code" && key === "code") continue;
    // The approval code is Cleaner Core's own, and a wrong one is refused when it is redeemed.
    if ((name === "send_message" || name === "reset_property" || name === "hold_job" || name === "resume_job") && key === "confirmation") continue;
    if (typeof value === "string" && desk.chatCarriesDoorCode(value)) return true;
  }
  // Calendar names, contact names, and checklist items are shown back, so a door code can't hide in one.
  if (name === "save_sources") {
    const calendars = (args as { calendars?: { name: string }[] }).calendars ?? [];
    if (calendars.some((calendar) => desk.chatCarriesDoorCode(calendar.name))) return true;
    const upload = (args as { uploadLink?: { name?: string } }).uploadLink;
    if (upload?.name && desk.chatCarriesDoorCode(upload.name)) return true;
  }
  if (name === "save_people") {
    const contacts = (args as { contacts?: { name: string }[] }).contacts ?? [];
    if (contacts.some((contact) => desk.chatCarriesDoorCode(contact.name))) return true;
  }
  if (name === "save_preferences") {
    const checklist = (args as { checklist?: string[] }).checklist ?? [];
    if (checklist.some((item) => desk.chatCarriesDoorCode(item))) return true;
  }
  return false;
}

async function callTool(desk: LiveDesk, name: ToolName, args: object, pinKey: Buffer | undefined, saveSecrets: SaveSecrets | undefined, deleteSecrets: DeleteSecrets | undefined): Promise<ToolReply> {
  switch (name) {
    case "get_state":
      return desk.getState((args as { choice?: "tours" | "cleaners" }).choice);
    case "save_property":
      return desk.saveProperty(args as Parameters<LiveDesk["saveProperty"]>[0], pinKey);
    case "save_people":
      return desk.savePeople(args as Parameters<LiveDesk["savePeople"]>[0], pinKey);
    case "save_calendar_link":
      return desk.saveCalendarLink(args as { url?: string; google?: boolean }, pinKey);
    case "save_sources":
      return desk.saveSources(args as Parameters<LiveDesk["saveSources"]>[0], pinKey);
    case "save_schedule":
      return desk.saveSchedule(args as Parameters<LiveDesk["saveSchedule"]>[0], pinKey);
    case "save_door_code":
      return desk.saveDoorCode(args as { code: string; lockLocation?: string }, pinKey);
    case "save_preferences":
      return desk.savePreferences(args as Parameters<LiveDesk["savePreferences"]>[0], pinKey);
    case "activate":
      return desk.activate(args as { googleEvents?: GoogleEventList });
    case "set_up_texting":
      return desk.setUpTexting();
    case "get_turns":
      return desk.getTurns();
    case "confirm_times":
      return desk.confirmTimes(args as { checkout: string; checkIn: string; all?: boolean });
    case "mark_guests_left":
      return desk.markGuestsLeft(args as { confirmed: boolean }, pinKey);
    case "run_checks":
      return desk.runChecks(args as { googleEvents?: GoogleEventList });
    case "check_now":
      return desk.checkNow(args as { googleEvents?: GoogleEventList }, saveSecrets);
    case "save_arrival":
      return desk.saveArrival(args as { time?: string });
    case "get_job_photos":
      return desk.getJobPhotos(args as { job?: string }, saveSecrets);
    case "save_alert_routine":
      if (!saveSecrets) return { ok: false, error: "I can't save the alert routine from here." };
      return desk.saveAlertRoutine(args as { url?: string; token?: string }, saveSecrets, pinKey);
    case "send_message":
      return desk.sendMessage(args as { to?: string; text?: string; confirmation?: string }, pinKey);
    case "retry_send":
      return desk.retrySend(args as { confirmed: boolean });
    case "hold_job":
      return desk.holdJob(args as { confirmation?: string });
    case "resume_job":
      return desk.resumeCleaning(args as { confirmation?: string });
    case "reset_property":
      if (!deleteSecrets) return { ok: false, error: "I can't reset the property from here." };
      return desk.resetProperty(args as { confirmation?: string }, deleteSecrets);
    case "reset_scratch":
      return desk.resetScratch();
    case "read_inbox":
      return desk.readInbox();
    case "read_outbox":
      return desk.readOutbox();
    case "send_test_text":
      return desk.sendTestText(args as { from?: string; text?: string });
    case "report_delivery":
      return desk.reportDelivery(args as { which?: string; status?: string });
    case "add_test_turn":
      return desk.addTestTurn(args as { checkout?: string; checkIn?: string });
  }
}

function rpcError(id: string | number | null, code: number, message: string): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function rpcResult(id: string | number | null, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}
