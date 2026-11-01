import { z } from "zod";
import { ASSISTANT_PROFILES, type CleanerAssistant } from "../cleaner-core/assistant";
import { tourCoreTenants } from "../cleaner-core/flag";
import { scratchToolsOn } from "../cleaner-core/scratchQa";
import type { Tenant, TenantService } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { HOST_TEXT_CHOICES, hostTextsAsk, saveHostTexts, type HostTextChoice } from "./hostTexts";
import { standDownService, switchService } from "./service";
import { issueTouringAlertLink, refreshTouringAlerts, TOURING_ALERT_LINK_MINUTES, TOURING_TASK_NAME } from "./touringAlerts";
import { takeUpdates } from "./touringUpdates";
import { touringScratch } from "./touringEnv";
import { readScratchInbox, readScratchOutbox, sendScratchText } from "./touringScratch";
import type { TouringInbox } from "./touringForward";
import type { TouringSupervisor } from "./touringSupervisor";

/**
 * The tools the shared service answers itself, around whichever service a tenant's number runs:
 * choosing a service, switching it, standing it down, and the touring alert routine. Everything else
 * goes to the active service.
 */

export type ToolState = "unset" | TenantService;

export function toolsFor(tenant: Tenant): ToolState {
  return tenant.service ?? "unset";
}

interface FrontTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
}

const Service = z.enum(["touring", "cleaning"]);

/** The one question a host gets on connecting, and its choices, so the chat can show them as buttons. */
export const SERVICE_QUESTION = "Which do you want to set up: Tour Core or Cleaner Core?";
export const SERVICE_CHOICES = [
  { label: "Tour Core: self-guided tours for a rental unit", service: "touring" },
  { label: "Cleaner Core: a cleaner for a property", service: "cleaning" },
] as const;

/** Said in the tool descriptions too, so a chat that reads only its tool list still asks the question. */
const ASK_ON_CONNECT = `Right after connecting, before anything else, ask the host exactly "${SERVICE_QUESTION}" with two buttons: "${SERVICE_CHOICES[0].label}" and "${SERVICE_CHOICES[1].label}". Don't describe what you can do instead.`;

const GET_STATE: FrontTool = {
  name: "get_state",
  title: "What's next",
  description: `${ASK_ON_CONNECT} This gives that question and its choices. Then call choose_service with their answer.`,
  input: z.object({}),
};
const CHOOSE: FrontTool = {
  name: "choose_service",
  title: "Choose a service",
  description: `${ASK_ON_CONNECT} Call this with their pick: touring for Tour Core, cleaning for Cleaner Core. The number answers for that service only until the host asks to switch.`,
  input: z.object({ service: Service }),
};
const SWITCH: FrontTool = {
  name: "switch_service",
  title: "Switch the number's service",
  description:
    "Moves this number to the other service, only when the host asks and nothing is live. Call once without confirmation to get what's still live or the question and a code, ask the host that question, and call again with the code only after the host says yes. No texts go out.",
  input: z.object({ to: Service, confirmation: z.string().max(40).optional() }),
};
const STAND_DOWN: FrontTool = {
  name: "stand_down_service",
  title: "Stand the service down",
  description:
    "Stops what's live on this number's service so it can switch, keeping the setup. Call once without confirmation to get a preview of what stops and the exact texts that go out, show the host, and call again with the code only after the host says yes.",
  input: z.object({ confirmation: z.string().max(40).optional() }),
};
const SAVE_ALERT_ROUTINE: FrontTool = {
  name: "save_alert_routine",
  title: "Connect touring alerts",
  description:
    "Connects the touring alert routine. Gives a one-time link; from your own cloud computer, post the routine's webhook address and key to it. Never send the link to the host, and never put the address or key in chat or in a tool argument.",
  input: z.object({}),
};

const GET_UPDATES: FrontTool = {
  name: "get_updates",
  title: "What's new on tours",
  description:
    "For a recurring task that checks on a schedule: returns the tour updates since this chat last checked, oldest first, each with a plain line, and marks them read. For anything urgent, call get_inbox for the details. Say nothing when the list is empty.",
  input: z.object({}),
};

const SAVE_HOST_TEXTS: FrontTool = {
  name: "save_host_texts",
  title: "Text tour updates to the host",
  description:
    "Saves whether tour updates are also texted to the host's own phone: urgent only (a visitor asking for a time, or a problem), all of them, or none. Ask the host first, as a choice card. Takes the host's phone when they want texts.",
  input: z.object({ which: z.enum(["urgent", "all", "off"]), phone: z.string().max(40).optional() }),
};

/** Scratch QA on a touring tenant's 555 number, named and worded like Cleaner Core's. */
const SCRATCH: FrontTool[] = [
  { name: "read_inbox", title: "Read test texts in", description: "Lists test texts that came in to this Scratch number.", input: z.object({}) },
  { name: "read_outbox", title: "Read test texts out", description: "Lists the texts touring sent back, each with who it went to.", input: z.object({}) },
  {
    name: "send_test_text",
    title: "Send a test text",
    description: "Sends a test text as a visitor. It follows the same path as a real text. It only works with 555 test numbers on a Scratch number.",
    input: z.object({ from: z.string().max(40), text: z.string().max(1600) }),
  },
];

const BY_STATE: Record<ToolState, FrontTool[]> = {
  unset: [GET_STATE, CHOOSE],
  cleaning: [SWITCH, STAND_DOWN],
  touring: [SAVE_ALERT_ROUTINE, SAVE_HOST_TEXTS, GET_UPDATES, SWITCH, STAND_DOWN],
};

/** Every name the front answers in some state. A call to one of them in another state is refused, never forwarded. */
export const FRONT_TOOL_NAMES = new Set([GET_STATE, CHOOSE, SWITCH, STAND_DOWN, SAVE_ALERT_ROUTINE, SAVE_HOST_TEXTS, GET_UPDATES, ...SCRATCH].map((tool) => tool.name));

/** True when a touring tenant gets the Scratch tools: the flag is on and its number is a 555 number. */
export function scratchFor(h: HostedCleaner, tenant: Tenant): boolean {
  return tenant.service === "touring" && scratchToolsOn(h.baseEnv()) && touringScratch(tenant);
}

export function frontToolsFor(state: ToolState, scratch = false): FrontTool[] {
  return state === "touring" && scratch ? [...BY_STATE.touring, ...SCRATCH] : BY_STATE[state];
}

/** The front tools as tools/list shows them. */
export function listedFrontTools(state: ToolState, scratch = false): Record<string, unknown>[] {
  return frontToolsFor(state, scratch).map((tool) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { name: tool.name, title: tool.title, description: tool.description, inputSchema };
  });
}

/** A chat still holding the other service's tools after a choice or a switch. */
export const wrongServiceLine = (service: TenantService) => `This number is set up for ${service} now. Start a new chat to see its tools.`;

export const CHOSEN_LINE = (service: TenantService) => `Set up for ${service}. Your tools have changed. If you don't see the new ones, start a new chat.`;

const UNSET_BOTH =
  "This number isn't set up yet. Ask the host the question in say right away, with the two choices as buttons. Touring: visitors text this number to book a self-guided tour of a rental unit. Cleaning: turnover cleanings from the host's booking calendar. Then call choose_service with the service they picked.";

const UNSET_CLEANING_ONLY = "This number isn't set up yet. It can run cleaning: turnover cleanings from the host's booking calendar. Call choose_service with cleaning.";

/** Like Cleaner Core's: Grok posts the routine it made from its own computer. The host never opens the link. */
const ALERT_UPLOAD_NEXT =
  'From your own cloud computer, POST JSON {"url": "<webhook address>", "key": "<webhook key>"} to uploadUrl with Content-Type: application/json, using the address and key of the routine you made. If you don\'t hold them, ask the host for them with your secure secret input card first. Never send uploadUrl to the host, and never put the address or key in chat or in a tool argument. Then call get_state.';

/** The initialize instructions for a tenant that hasn't chosen yet. */
export const UNSET_INSTRUCTIONS =
  `As soon as you're connected, without waiting for the host to ask, ask exactly "${SERVICE_QUESTION}" with two buttons: "${SERVICE_CHOICES[0].label}" and "${SERVICE_CHOICES[1].label}". Do nothing else first. Then call choose_service with their pick.`;

/** What the shared service holds for touring tenants. Absent until the service runs touring at all. */
export interface TouringFront {
  supervisor: TouringSupervisor;
  inbox: TouringInbox;
  /** TOUR_CORE_TENANTS. */
  enabled(): boolean;
  /** The shared Twilio account's auth token, for checking and re-signing texts. */
  authToken(): string | undefined;
  /** Starts the tenant's process and hands it any texts that waited. */
  start(tenant: Tenant): Promise<void>;
  /** Hands the tenant's waiting texts to its process, oldest first, if it's up. */
  handOver(tenant: Tenant): Promise<void>;
}

export interface FrontContext {
  h: HostedCleaner;
  tenant: Tenant;
  caller: { grantId: string; assistant: CleanerAssistant };
  noteToolsChanged(): void;
}

export interface FrontReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

const fail = (text: string): FrontReply => ({ text, isError: true });
const done = (structured: Record<string, unknown>): FrontReply => ({ text: JSON.stringify(structured), structured, isError: false });

/** How long a choice waits for a touring process before answering anyway. */
const START_WAIT_MS = 30_000;

/** Answers a front tool. Undefined when the name isn't one of this state's front tools. */
export async function handleFrontTool(ctx: FrontContext, name: string, args: unknown): Promise<FrontReply | undefined> {
  const state = toolsFor(ctx.tenant);
  const tool = frontToolsFor(state, scratchFor(ctx.h, ctx.tenant)).find((item) => item.name === name);
  if (!tool) return undefined;
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return fail("That was missing something I need.");
  const touringOn = tourCoreTenants(ctx.h.baseEnv()) && !!ctx.h.touring;
  if (name === "get_state") {
    if (!touringOn) return done({ next: UNSET_CLEANING_ONLY, services: ["cleaning"] });
    return done({ next: UNSET_BOTH, say: SERVICE_QUESTION, choices: SERVICE_CHOICES, services: ["touring", "cleaning"] });
  }
  if (name === "choose_service") {
    const service = (parsed.data as { service: TenantService }).service;
    if (service === "touring" && !touringOn) return fail("Touring isn't available on this service yet. Choose cleaning.");
    ctx.h.registry.setService(ctx.tenant.id, service);
    if (service === "touring") {
      const tenant = ctx.h.registry.get(ctx.tenant.id)!;
      await Promise.race([ctx.h.touring!.start(tenant), new Promise((resolve) => setTimeout(resolve, START_WAIT_MS).unref())]);
    }
    ctx.h.log(`${ctx.tenant.id} chose ${service}.`);
    ctx.noteToolsChanged();
    return { text: CHOSEN_LINE(service), structured: { service }, isError: false };
  }
  if (name === "switch_service") {
    const { to, confirmation } = parsed.data as { to: TenantService; confirmation?: string };
    return switchService({ h: ctx.h, tenant: ctx.tenant, actor: "host", noteToolsChanged: ctx.noteToolsChanged }, { to, ...(confirmation ? { confirmation } : {}) });
  }
  if (name === "stand_down_service") {
    const { confirmation } = parsed.data as { confirmation?: string };
    return standDownService({ h: ctx.h, tenant: ctx.tenant, actor: "host", noteToolsChanged: ctx.noteToolsChanged }, confirmation ? { confirmation } : {});
  }
  if (name === "send_test_text") {
    const sent = await sendScratchText(ctx.h, ctx.tenant, parsed.data as { from: string; text: string });
    return { text: sent.text, isError: !sent.ok };
  }
  if (name === "read_inbox") return done({ texts: readScratchInbox(ctx.h, ctx.tenant.id) });
  if (name === "read_outbox") return done({ texts: readScratchOutbox(ctx.h, ctx.tenant.id) });
  if (name === "save_host_texts") {
    const saved = saveHostTexts(ctx.h, ctx.tenant, parsed.data as { which: HostTextChoice; phone?: string });
    return { text: saved.text, isError: !saved.ok };
  }
  if (name === "get_updates") return done({ updates: takeUpdates(ctx.h, ctx.tenant.id, ctx.caller.grantId) });
  if (name === "save_alert_routine") {
    const texts = hostTextsAsk(ctx.caller.assistant);
    const ask = `Then ask the host "${texts.say}" as a choice card (${HOST_TEXT_CHOICES.map((c) => c.label).join(", ")}; suggest ${HOST_TEXT_CHOICES.find((c) => c.which === texts.suggested)!.label}) and call save_host_texts with their answer.`;
    // A ChatGPT or Muse task can't be woken and holds no address or key: connecting it is the whole step.
    if (ASSISTANT_PROFILES[ctx.caller.assistant].polledTask) {
      ctx.h.secrets.setForConnection(ctx.tenant.id, ctx.caller.grantId, { [TOURING_TASK_NAME]: "1" });
      refreshTouringAlerts(ctx.h, ctx.tenant);
      return done({ connected: true, hostTexts: texts, next: `Tour updates are connected. Your task reads them with get_updates each time it runs. ${ask}` });
    }
    return done({
      uploadUrl: issueTouringAlertLink(ctx.h, ctx.tenant, ctx.caller.grantId),
      expiresInMinutes: TOURING_ALERT_LINK_MINUTES,
      hostTexts: texts,
      next: `${ALERT_UPLOAD_NEXT} Once it's connected: ${ask}`,
    });
  }
  return undefined;
}
