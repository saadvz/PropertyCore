import { nextProfileQuestion } from "../config/unitProfile";
import { spokenAsk } from "../playbooks/compose";
import { RECONNECT_INSTRUCTIONS, SHARED_STEPS } from "../playbooks/shared";
import type { ReportedClient } from "../playbooks/select";
import { visitorHelpQuestion } from "../setup/setupActions";
import { mcpAuthModeFromEnv } from "../mcp/authMode";
import { MCP_PATH } from "../mcp/paths";
import { installationAlertHealth } from "../alerts/alertHealth";
import { describeUpdates, enabledUpdates } from "../alerts/preferences";
import type { InstalledMessaging, OperatorServices } from "../operator/services";
import { publishGuards, visitorTexting } from "../operator/setupFlow";
import { LOCAL_TEST_TEXTING, localTestModeSentence, modeSentence, visitorsTextLine } from "../setup/setupActions";
import { isCurrent, type PropertyWorkspace } from "../setup/workspace";
import { probeRuntimeStore } from "../storage/runtimeStore";
import { DEPLOYMENT_MODE_LABELS, isTenantWorker, type DeploymentMode } from "./deployment";
import type { Installation } from "./installation";
import { activeFromNumber, createMessagingProvider, ensureMessagingSelection, MESSAGING_PROVIDER_CATALOG, selectionFromInstallation } from "../messaging/registry";

/**
 * Where this installation stands, component by component, in one
 * provider-neutral model. Tour Core decides the whole onboarding sequence
 * here (not in Grok's instructions): `nextStep` is the one thing to do now,
 * who does it, what to say to the operator, and (separately) what Grok needs
 * to know to do it. Whether a component is required or optional is decided
 * here too, never by the agent.
 *
 * Canonical P0 order:
 *   runtime → public connection → Grok connection → visitor texting
 *   → first property → operator alerts (recommended) → readiness
 *   → practice tour → publish (explicit yes) → operate
 *   → offer another property (the published one stays published)
 *
 * Copy rules: `operatorMessage`, `summary` and `lines` are safe to say to a
 * landlord as-is (no URLs, ports, commands, tool counts or protocol names).
 * Anything technical is in `grokInstructions` / `technical`, for Grok's own
 * actions and troubleshooting only.
 */

export const INSTALLATION_COMPONENTS = [
  "RUNTIME",
  "PUBLIC_ENDPOINT",
  "GROK_OPERATOR",
  "VISITOR_MESSAGING",
  "STORAGE",
  "ACCESS",
  "PROPERTY",
  "OPERATOR_ALERTS",
  "READINESS",
  "PRACTICE_TOUR",
  "PUBLISH",
] as const;
export type InstallationComponent = (typeof INSTALLATION_COMPONENTS)[number];

export const COMPONENT_STATES = ["NOT_CONFIGURED", "ACTION_REQUIRED", "CONFIGURING", "READY", "DEGRADED", "ERROR"] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/**
 *  REQUIRED_BEFORE_PROPERTY  must be READY before property setup is offered.
 *  REQUIRED_TO_PUBLISH       part of the property path; publish needs it.
 *  RECOMMENDED               offered at its point in the sequence; the operator may decline (skip_optional_setup).
 */
export type Requirement = "REQUIRED_BEFORE_PROPERTY" | "REQUIRED_TO_PUBLISH" | "RECOMMENDED";

export const REQUIREMENTS: Record<InstallationComponent, Requirement> = {
  RUNTIME: "REQUIRED_BEFORE_PROPERTY",
  PUBLIC_ENDPOINT: "REQUIRED_BEFORE_PROPERTY",
  GROK_OPERATOR: "REQUIRED_BEFORE_PROPERTY",
  VISITOR_MESSAGING: "REQUIRED_BEFORE_PROPERTY",
  STORAGE: "REQUIRED_BEFORE_PROPERTY",
  ACCESS: "REQUIRED_BEFORE_PROPERTY",
  PROPERTY: "REQUIRED_TO_PUBLISH",
  OPERATOR_ALERTS: "RECOMMENDED",
  READINESS: "REQUIRED_TO_PUBLISH",
  PRACTICE_TOUR: "REQUIRED_TO_PUBLISH",
  PUBLISH: "REQUIRED_TO_PUBLISH",
};

/** Infrastructure that must be READY before property setup is offered. */
export const INFRASTRUCTURE = INSTALLATION_COMPONENTS.filter((c) => REQUIREMENTS[c] === "REQUIRED_BEFORE_PROPERTY");
/** Components the operator may decline. */
export const OPTIONAL_COMPONENTS = INSTALLATION_COMPONENTS.filter((c) => REQUIREMENTS[c] === "RECOMMENDED");

export const COMPONENT_LABELS: Record<InstallationComponent, string> = {
  RUNTIME: "Tour Core",
  PUBLIC_ENDPOINT: "Secure connection",
  GROK_OPERATOR: "Grok connection",
  VISITOR_MESSAGING: "Visitor texting",
  STORAGE: "Tour records",
  ACCESS: "Access system",
  PROPERTY: "Property",
  OPERATOR_ALERTS: "Tour updates",
  READINESS: "Readiness check",
  PRACTICE_TOUR: "Practice tour",
  PUBLISH: "Publish",
};

/** Conversation phase: where the operator is in onboarding. Phases only move forward unless the state changes. */
export type OnboardingPhase = "BOOTSTRAP" | "CONNECT" | "INFRASTRUCTURE" | "PROPERTY" | "VALIDATE" | "PUBLISH" | "OPERATE";

const PHASE_OF: Record<InstallationComponent, OnboardingPhase> = {
  RUNTIME: "BOOTSTRAP",
  PUBLIC_ENDPOINT: "BOOTSTRAP",
  GROK_OPERATOR: "CONNECT",
  VISITOR_MESSAGING: "INFRASTRUCTURE",
  STORAGE: "INFRASTRUCTURE",
  ACCESS: "INFRASTRUCTURE",
  PROPERTY: "PROPERTY",
  OPERATOR_ALERTS: "PROPERTY",
  READINESS: "VALIDATE",
  PRACTICE_TOUR: "VALIDATE",
  PUBLISH: "PUBLISH",
};

export type InstallationAction =
  | "START_RUNTIME"
  | "ESTABLISH_PUBLIC_ENDPOINT"
  | "CHECK_PUBLIC_ENDPOINT"
  | "CONNECT_GROK"
  | "RECONNECT_GROK"
  | "FIX_GROK_CONNECTOR"
  | "CHOOSE_MESSAGING_PROVIDER"
  | "CHOOSE_MESSAGING_LINE"
  | "CONNECT_VISITOR_MESSAGING"
  | "TEST_VISITOR_MESSAGING"
  | "RECONNECT_VISITOR_MESSAGING"
  | "FIX_VISITOR_MESSAGING"
  | "WAIT_FOR_HOST_NUMBER"
  | "CHECK_STORAGE"
  | "CONNECT_GOOGLE_DRIVE"
  | "CONFIRM_BACKUP_DESTINATION"
  | "FINISH_GOOGLE_DRIVE"
  | "SET_UP_PROPERTY"
  | "ADD_ANOTHER_PROPERTY"
  | "FINISH_PROPERTY_SETUP"
  | "OFFER_OPERATOR_ALERTS"
  | "CONNECT_OPERATOR_ALERTS"
  | "TEST_OPERATOR_ALERTS"
  | "FIX_OPERATOR_ALERTS"
  | "RUN_READINESS"
  | "RUN_PRACTICE_TOUR"
  | "PUBLISH"
  | "FIX_PROPERTY_TEXTING"
  | "DONE";

/**
 *  GROK                      Grok does it itself (a tool call, or a command on its computer), without asking.
 *  OPERATOR                  a human step Grok can't do (e.g. approving the connection).
 *  OPERATOR_IN_SECURE_SETUP  credentials, collected by secure secret input when Grok can fill the form, otherwise on Tour Core's secure setup page.
 *  OPERATOR_DECISION         Grok asks the question in operatorMessage; the operator decides.
 */
export type PerformedBy = "GROK" | "OPERATOR" | "OPERATOR_IN_SECURE_SETUP" | "OPERATOR_DECISION";

export interface InstallationStep {
  component: InstallationComponent | null;
  action: InstallationAction;
  phase: OnboardingPhase;
  performedBy: PerformedBy;
  /** Safe to say to the operator as-is: plain words, no technical details. */
  operatorMessage: string;
  /** For Grok only (may contain addresses or commands). Never repeat it to the operator. */
  grokInstructions?: string;
  /** The Tour Core tool that does or starts this step. */
  tool?: string;
  /** The Grok skill that walks through it. */
  skill?: string;
  /** Which part of the secure setup page to open (pass to get_secure_setup_url). */
  secureSetupStep?: "visitor-messaging" | "operator-alerts";
  /** A command Grok runs on the Tour Core computer (never the operator's). Never shown to the operator. */
  command?: string;
  /** Choices for an OPERATOR_DECISION step. Grok asks these; it does not invent a different list. */
  choices?: { id: string; label: string; description: string }[];
  /** Credential labels for Grok's secure input. Never values. */
  credentialFields?: { label: string; secret: boolean }[];
  /** RECOMMENDED steps can be declined with skip_optional_setup. */
  optional?: boolean;
}

export interface ComponentStatus {
  component: InstallationComponent;
  label: string;
  state: ComponentState;
  requirement: Requirement;
  /** One plain sentence for the operator. */
  summary: string;
  /** Provider role, e.g. LOCAL_DEMO or DURIN_DEMO. Never a credential. For Grok, not the operator. */
  provider?: string;
  /** Technical details for Grok's own actions or troubleshooting. Never repeat them to the operator. */
  technical?: string[];
  next?: InstallationStep;
  /** Recommended but not required improvements (e.g. turning on alerts later). */
  optionalActions: InstallationStep[];
}

export interface InstallationStatus {
  schemaVersion: 1;
  installationId?: string;
  deploymentMode: DeploymentMode;
  deploymentLabel: string;
  phase: OnboardingPhase;
  components: ComponentStatus[];
  /** Every REQUIRED_BEFORE_PROPERTY component is READY. */
  infrastructureReady: boolean;
  nextStep: InstallationStep;
  /** Operator-safe. */
  summary: string;
  /** Operator-safe checklist. */
  lines: string[];
  /** For Grok's own actions and troubleshooting only. */
  technical: { publicAddress?: string; connectorUrl?: string; deploymentMode: DeploymentMode };
  checkedAt: string;
}

export interface StatusOptions {
  /** From outside the process (bootstrap): whether the runtime answered. Inside the server it's running by definition. */
  runtime?: { running: boolean; message?: string };
  /**
   * Skip every write this read would otherwise do: persisting an inferred
   * texting choice, and the disk probe. Existing tools leave this unset.
   */
  readOnly?: boolean;
  /** When set, the alerts offer uses that client's spoken question. With no client, the pinned offer stays. */
  client?: ReportedClient;
}

const BOOTSTRAP = "npm run bootstrap:grok";

export const OPERATOR_MESSAGES = {
  firstProperty: "Everything needed to start is connected and tested. Would you like to add your first property?",
  anotherProperty: "Would you like to set up another property?",
  offerAlerts: "Your property is configured. Would you like me to keep you updated when someone books, starts or finishes a tour, and alert you if something needs your input?",
  recommendUpdates: "I recommend alerts for bookings, tour starts, completions and anything that needs your attention. Want to use those defaults?",
  validate:
    "Prospects can text your touring number to ask questions, choose a day and time, verify their details, and complete the self-guided tour in the same conversation. I'll run a readiness check and a practice tour before we turn it on.",
  operate: "Your property is published. Visitor texting is live. Door access is still in demo mode, so no physical locks will open. I'll keep you updated on your tours and let you know when something needs your attention.",
  operateWithoutAlerts: "Your property is published. Visitor texting is live. Door access is still in demo mode, so no physical locks will open. Ask me any time to show active tours or what needs your attention.",
} as const;

const ROUTINE_DOC = "grok-template/routines/operator-updates.md";

/**
 * How Grok connects its own routine without the address or key entering the
 * conversation. Grok's computer-use sees the screen, so a value that's shown
 * on screen is in its context; only a value it never displays can be moved by
 * Grok itself.
 */
const ROUTINE_SETUP =
  `Create the Tour Core Operator Updates routine yourself (authenticated webhook trigger; instructions in ${ROUTINE_DOC}). ` +
  "Then call get_secure_setup_url with step operator-alerts. Prefer Grok's secure secret input: ask for the webhook address and key securely and fill Tour Core's form yourself. They are not shown in chat and are not tool arguments. " +
  "If the routine panel lets you copy both values with copy buttons while they stay hidden on screen, you may paste those hidden values into the matching masked fields yourself, without reading or repeating them. " +
  "Hand the browser to the operator only when secure fill isn't available or a value is shown on screen. Never put the address or key in chat, tool arguments, files or commands.";

/**
 * The same routine on the shared service. The address and key go to the shared service, which keeps
 * them per chat, through the one-time link save_alert_routine gives. Grok posts them itself.
 */
const TOURING_ROUTINE_SETUP =
  `Create the Tour Core Operator Updates routine yourself (authenticated webhook trigger; instructions in ${ROUTINE_DOC}). ` +
  "Then call save_alert_routine and do its next step: from your own cloud computer, post the routine's webhook address and key to the one-time link it gives. " +
  "You made the routine, so you already hold both. Only if you don't, ask the host for them with Grok's secure secret input card. " +
  "Never send the link to the host or ask them to open a page. Never put the address or key in chat or in a tool argument.";

function component(c: InstallationComponent, state: ComponentState, summary: string, extra: Partial<ComponentStatus> = {}): ComponentStatus {
  return { component: c, label: COMPONENT_LABELS[c], state, requirement: REQUIREMENTS[c], summary, optionalActions: [], ...extra };
}

function step(c: InstallationComponent, action: InstallationAction, performedBy: PerformedBy, operatorMessage: string, extra: Partial<InstallationStep> = {}): InstallationStep {
  return { component: c, action, phase: PHASE_OF[c], performedBy, operatorMessage, ...(REQUIREMENTS[c] === "RECOMMENDED" ? { optional: true } : {}), ...extra };
}

// ------------------------------------------------------------ components

function runtimeStatus(options: StatusOptions): ComponentStatus {
  if (options.runtime && !options.runtime.running) {
    return component("RUNTIME", "ERROR", "Tour Core isn't running.", {
      technical: options.runtime.message ? [options.runtime.message] : undefined,
      next: step("RUNTIME", "START_RUNTIME", "GROK", "I'm starting Tour Core.", { command: BOOTSTRAP, grokInstructions: `Run ${BOOTSTRAP} in the Tour Core folder on your cloud computer.` }),
    });
  }
  return component("RUNTIME", "READY", "Tour Core is installed and running.");
}

function endpointStatus(inst: Installation, mode: DeploymentMode): ComponentStatus {
  const url = inst.publicBaseUrl();
  const raw = inst.sendblueEnv().publicBaseUrlRaw;
  const manifest = safe(() => inst.files.manifest());
  const quick = manifest?.publicEndpointProvider === "CLOUDFLARE_QUICK_TUNNEL" && manifest.publicBaseUrl === url;
  const technical = [...(url ? [`Public address: ${url}`] : []), ...(quick ? ["Temporary quick-tunnel address: it changes if the tunnel restarts."] : [])];
  const establish = (): InstallationStep =>
    mode === "GROK_MANAGED_P0"
      ? step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "GROK", "I'm setting up Tour Core's secure public connection.", { command: BOOTSTRAP, grokInstructions: `Run ${BOOTSTRAP} in the Tour Core folder on your cloud computer.` })
      : mode === "HOSTED_RAILWAY_P0"
        ? step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "GROK", "Tour Core's public connection isn't ready yet.", {
            grokInstructions: "HOSTED_RAILWAY_P0 has no public https address. The distributor must set RAILWAY_PUBLIC_DOMAIN or PUBLIC_BASE_URL. Do not install cloudflared or start a quick tunnel, and do not ask the operator to create a Railway project.",
          })
        : step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "OPERATOR", "Tour Core needs a secure public connection before it can be reached.", {
            grokInstructions:
              mode === "SELF_HOSTED" ? "Set PUBLIC_BASE_URL to the server's stable https address and restart Tour Core." : "Start a secure tunnel and set PUBLIC_BASE_URL (README, developer path).",
          });
  if (!url) {
    if (raw) return component("PUBLIC_ENDPOINT", "ERROR", "Tour Core's public connection isn't set up correctly.", { technical: ["PUBLIC_BASE_URL isn't https."], next: establish() });
    return component("PUBLIC_ENDPOINT", mode === "LOCAL_DEVELOPER" ? "NOT_CONFIGURED" : "ACTION_REQUIRED", "Tour Core doesn't have a secure public connection yet.", { next: establish() });
  }
  const check = inst.files.state().publicEndpointCheck;
  const recheck = step("PUBLIC_ENDPOINT", "CHECK_PUBLIC_ENDPOINT", "GROK", "I'm checking Tour Core's secure public connection.", { tool: "check_public_endpoint" });
  if (!check || check.url !== url) return component("PUBLIC_ENDPOINT", "ACTION_REQUIRED", "Tour Core's secure public connection hasn't been checked yet.", { technical, next: recheck });
  if (!check.ok) {
    return component("PUBLIC_ENDPOINT", "ERROR", "Tour Core's secure public connection isn't working.", {
      technical: [...technical, check.message],
      next: mode === "GROK_MANAGED_P0" ? { ...establish(), operatorMessage: "Tour Core's secure public connection stopped working. I'm repairing it." } : recheck,
    });
  }
  return component("PUBLIC_ENDPOINT", "READY", "Tour Core has a secure public connection.", { technical });
}

function approvalInstructions(inst: Installation): string {
  if (inst.deploymentMode() !== "HOSTED_RAILWAY_P0") return "Open the approval screen (/grok on the Tour Core computer) in your cloud browser and hand control to the operator.";
  return "Tour Core shows a pairing code. The operator clicks Allow. Do not click Allow yourself. Do not mention Railway. The first Allow claims this demo; a later unrelated account is refused.";
}

function grokStatus(inst: Installation): ComponentStatus {
  const mode = mcpAuthModeFromEnv(inst.env());
  const url = inst.publicBaseUrl();
  const connector = url ? `${new URL(url).origin}${MCP_PATH}` : undefined;
  const hosted = inst.deploymentMode() === "HOSTED_RAILWAY_P0";
  const approval = approvalInstructions(inst);
  const connectMessage = hosted
    ? "Tour Core is online. I need your approval to connect. Tour Core will show you a pairing code. Click Allow."
    : "Tour Core is installed and running. I need your approval to connect to it. I've opened the approval screen. Check that the codes match and click Allow.";
  if (typeof mode !== "string") {
    return component("GROK_OPERATOR", "ERROR", "Grok can't connect to Tour Core because of a setting.", {
      technical: [`TOURCORE_MCP_AUTH_MODE "${mode.invalid}" turns the connector off.`],
      next: step("GROK_OPERATOR", "FIX_GROK_CONNECTOR", "GROK", "I'm fixing a Tour Core setting so I can connect to it.", { grokInstructions: "Remove TOURCORE_MCP_AUTH_MODE (or set it to oauth) and restart Tour Core." }),
    });
  }
  if (mode === "static") {
    return inst.env().TOURCORE_OPERATOR_TOKEN?.trim()
      ? component("GROK_OPERATOR", "READY", "Grok is connected.", { technical: ["Development static-token mode. Use OAuth for a real Grok Bot."] })
      : component("GROK_OPERATOR", "ACTION_REQUIRED", "Grok isn't connected to Tour Core yet.", {
          next: step("GROK_OPERATOR", "FIX_GROK_CONNECTOR", "GROK", "I'm fixing a Tour Core setting so I can connect to it.", { grokInstructions: "Static mode has no token: remove TOURCORE_MCP_AUTH_MODE and restart Tour Core." }),
        });
  }
  if (!connector) return component("GROK_OPERATOR", "NOT_CONFIGURED", "Grok can connect once Tour Core has a secure public connection.");
  let connections: ReturnType<Installation["grants"]["connections"]> = [];
  try {
    connections = inst.grants.connections();
  } catch {
    connections = [];
  }
  const technical = [`Connector address: ${connector}`];
  if (connections.some((c) => c.address === connector)) return component("GROK_OPERATOR", "READY", "Grok is connected.", { technical });
  if (connections.length) {
    return component("GROK_OPERATOR", "ACTION_REQUIRED", "Tour Core's connection changed, so Grok needs to reconnect.", {
      technical,
      next: step("GROK_OPERATOR", "RECONNECT_GROK", "OPERATOR", hosted ? "Tour Core's connection changed, so I need your approval to reconnect. Tour Core will show you a pairing code. Click Allow." : "Tour Core's secure connection changed, so I need your approval to reconnect. I've opened the approval screen. Check that the codes match and click Allow.", {
        grokInstructions: `Remove the old Tour Core connector and add it again at ${connector} with OAuth (no token). ${approval} After approval, call get_installation_status without waiting to be asked.`,
      }),
    });
  }
  return component("GROK_OPERATOR", "ACTION_REQUIRED", "Grok isn't connected to Tour Core yet.", {
    technical,
    next: step("GROK_OPERATOR", "CONNECT_GROK", "OPERATOR", connectMessage, {
      grokInstructions: `Add Tour Core as a custom connector at ${connector} with OAuth (leave token fields empty). ${approval} After approval, say "Connected. I'm checking the rest of the setup now." and call get_installation_status without waiting to be asked.`,
    }),
  });
}

function credentialAsk(id: string): string {
  if (id === "sendblue") return "Sendblue needs your API key, API secret, and messaging number. I'll ask for them securely; they won't be shown to me in chat.";
  if (id === "twilio") return "Twilio needs your Account SID, Auth Token, and Tour Core phone number. I'll ask for them securely; they won't be shown to me in chat.";
  if (id === "local") return "The local loopback is ready. No account details are needed.";
  return "Photon needs your project credentials. I'll ask for them securely; they won't be shown to me in chat.";
}

function credentialStep(provider: { id: string; configFields: () => { label: string; secret: boolean }[] }): InstallationStep {
  const fields = provider.configFields().map((field) => field.label).join(", ");
  return step("VISITOR_MESSAGING", "CONNECT_VISITOR_MESSAGING", "OPERATOR_IN_SECURE_SETUP", credentialAsk(provider.id), {
    tool: "get_secure_setup_url",
    secureSetupStep: "visitor-messaging",
    credentialFields: provider.configFields().map((field) => ({ label: field.label, secret: field.secret })),
    grokInstructions:
      `Stay in this conversation. Use Grok's secure secret-input control for each field (${fields}). The values must not appear in ordinary chat or in tool arguments. Then call get_secure_setup_url with step visitor-messaging, fill that form yourself, and submit it. After it is saved, call get_next_installation_step and continue. Do not ask what to do next. Do not tell the operator to open a page, leave the chat, or type the values. ` +
      "Fallback only: if secure secret input is unavailable, say that the normal secure collection could not be used, then hand over the browser. Do not choose that path because it is easier. " +
      (provider.id === "twilio" ? "Do not ask for a brand id, campaign id, or compliance profile. Tour Core does not check carrier registration. " : "") +
      (provider.id === "photon" ? "After the project credentials are saved, Tour Core discovers provisioned lines. Do not ask the operator to type a phone number. " : ""),
  });
}

function messagingStatus(inst: Installation, readOnly = false): ComponentStatus {
  const selection = readOnly ? selectionFromInstallation(inst) : ensureMessagingSelection(inst);
  const choose = step("VISITOR_MESSAGING", "CHOOSE_MESSAGING_PROVIDER", "OPERATOR_DECISION", "How would you like prospects to text Tour Core?", {
    tool: "choose_messaging_provider",
    choices: MESSAGING_PROVIDER_CATALOG.map((p) => ({ id: p.id, label: p.displayName, description: p.description })),
    grokInstructions:
      "Ask how prospects should text Tour Core, using only the choices on this step and each choice's description. When they pick one, call choose_messaging_provider with that id. Do not assume Sendblue. Do not give legal or compliance advice beyond that description. Future providers come from this step, not from a hardcoded list.",
  });
  if (selection.invalid) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting isn't available with that choice.", {
      technical: [`Visitor messaging: provider=${selection.invalid} status=NEEDS_ACTION`, `Tour Core doesn't include a messaging provider named "${selection.invalid}".`],
      next: choose,
    });
  }
  if (!selection.provider) {
    return component("VISITOR_MESSAGING", "NOT_CONFIGURED", "Visitor texting isn't connected yet.", {
      technical: ["Visitor messaging: provider=none status=NOT_CONFIGURED"],
      next: choose,
    });
  }

  const provider = createMessagingProvider(selection.provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
  const statusLine = (status: string) => `Visitor messaging: provider=${provider.id} status=${status}`;
  const connect = credentialStep(provider);
  const validation = provider.validateConfiguration();
  const usableLines = (inst.files.state().messagingLines ?? []).filter((line) => line.status !== "unavailable");
  if (provider.id === "photon" && validation.ok && !inst.env().TOURCORE_PHOTON_PHONE_NUMBER?.trim() && usableLines.length > 1) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Photon is connected. Which of these lines should prospects text?", {
      provider: provider.id,
      technical: [statusLine("NEEDS_ACTION"), "Choose a line Photon reported. Do not ask for a number that is not in this list."],
      next: step("VISITOR_MESSAGING", "CHOOSE_MESSAGING_LINE", "OPERATOR_DECISION", "Photon is connected. Which of these lines should prospects text?", {
        tool: "choose_messaging_line",
        choices: usableLines.map((line) => ({ id: line.address, label: line.address, description: line.status ?? "available" })),
        grokInstructions:
          "Show only these line numbers and ask which one prospects should text. They are not secrets. After the operator picks one, call choose_messaging_line with that address, then call get_next_installation_step and continue. Do not ask them to type a number Photon did not list. Do not tell them to open a setup page.",
      }),
    });
  }
  if (!validation.ok) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting isn't connected yet.", {
      provider: provider.id,
      technical: [statusLine("NEEDS_ACTION"), ...validation.problems],
      next: connect,
    });
  }

  const check = inst.files.state().visitorMessaging;
  const recordedProvider = check?.provider ?? (provider.id === "sendblue" ? "sendblue" : undefined);
  const test = step("VISITOR_MESSAGING", "TEST_VISITOR_MESSAGING", "GROK", "I'm testing visitor texting.", { tool: "test_visitor_messaging" });
  const changedAt = latest(...provider.credentialNames().map((name) => inst.secrets.updatedAt(name as never)));
  const number = activeFromNumber(inst);
  if (!check || recordedProvider !== provider.id || (changedAt && check.at < changedAt)) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting is set up but hasn't been tested yet.", {
      provider: provider.id,
      technical: [statusLine("NEEDS_ACTION")],
      next: test,
    });
  }
  if (check.publicBaseUrl !== inst.publicBaseUrl()) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting needs updating after Tour Core's connection changed.", {
      provider: provider.id,
      technical: [statusLine("NEEDS_ACTION")],
      next: step("VISITOR_MESSAGING", "RECONNECT_VISITOR_MESSAGING", "GROK", "I'm updating visitor texting to use Tour Core's new connection.", { tool: "test_visitor_messaging" }),
    });
  }
  if (!check.ok) {
    const accountProblem = check.problems.some((p) => /account|sign in|details|number|line|project/i.test(p));
    return component("VISITOR_MESSAGING", "ERROR", check.problems[0] ?? check.message, {
      provider: provider.id,
      technical: [statusLine("NEEDS_ACTION"), ...check.problems],
      next: accountProblem ? { ...connect, action: "FIX_VISITOR_MESSAGING", operatorMessage: `${check.problems[0] ?? check.message} I'll ask for the details securely; they won't be shown in chat.` } : test,
    });
  }
  const readySummary =
    provider.id === "local"
      ? LOCAL_TEST_TEXTING
      : `Visitor texting is connected and working${number ? ` (${number})` : ""}.`;
  return component("VISITOR_MESSAGING", "READY", readySummary, {
    provider: provider.id,
    technical: [statusLine("CONNECTED")],
  });
}

/**
 * The installation's real visitor texting, for property setup: a new property
 * uses it, and in a Grok-managed install a property can't be published
 * without it. Undefined when no texting account is set up. `mode` stays
 * The installation's primary provider stays here. A property may opt into
 * local test texts without changing this.
 */
export function installedMessaging(inst: Installation, options?: { readOnly?: boolean }): InstalledMessaging | undefined {
  const readOnly = options?.readOnly === true;
  const selection = readOnly ? selectionFromInstallation(inst) : ensureMessagingSelection(inst);
  if (!selection.provider) return undefined;
  const provider = createMessagingProvider(selection.provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
  if (!provider.validateConfiguration().ok) return undefined;
  // A touring process texts on the host's number the shared service gave it; that number is its texting.
  const status = isTenantWorker(inst.deploymentMode()) ? hostNumberStatus(inst) : messagingStatus(inst, readOnly);
  return { mode: "live", provider: selection.provider, ready: status.state === "READY", requiredForPublish: inst.deploymentMode() === "GROK_MANAGED_P0" };
}

const DRIVE_INSTRUCTIONS =
  "If your built-in Google Drive connector is not connected, connect it the normal way (grok.com/connectors, or Grok Bot Marketplace / Settings → Plugins) and let the operator approve Google there. Do not ask for a Google password, API key, or client secret. " +
  "Then call begin_google_drive_connect. If it returns an authorizationUrl, open that for Tour Core's own approval and say the summary: Grok's Drive connection cannot save Tour Core's records while you are away, and xAI does not document handing that connector's token to Tour Core. " +
  "If the operator says no, call use_local_demo_storage and tell them records stay on this computer and are not portable. If begin_google_drive_connect says the Google app is not configured, say the summary and offer to keep records on this computer; do not ask them to create a Google Cloud project.";

const HOSTED_BACKUP_INSTRUCTIONS =
  "Use Grok's native Google Drive connector only. If Drive is already connected, reuse it. Do not ask for a Google password, OAuth client id, client secret, API key, or refresh token. Do not call begin_google_drive_connect and do not open a Tour Core Google approval. " +
  "Create or find a private folder named Tour Core with folders Backups, Exports, and Properties. Do not create a public sharing link and do not use that folder as the live database. " +
  "Then call confirm_backup_destination with provider google_drive and folderName Tour Core. accountLabel may be a short display name. Do not pass tokens. " +
  "If the operator declines, call decline_portable_backup. Operational records stay on hosted Tour Core either way. After the first property is published, call create_portable_backup and upload that file to Tour Core/Backups, then confirm_backup_stored.";

function storageStatus(inst: Installation, messagingReady: boolean, readOnly = false): ComponentStatus {
  let writable = true;
  if (!readOnly) {
    try {
      probeRuntimeStore(inst.runtime, new Date(inst.now()));
    } catch {
      writable = false;
    }
  }
  const provider = inst.records.provider();
  const summary = inst.records.summary();
  if (!writable) {
    return component("STORAGE", "ERROR", "Tour Core couldn't save a test record.", { provider, next: step("STORAGE", "CHECK_STORAGE", "GROK", "I'm checking where tour records are kept.", { tool: "test_storage" }) });
  }
  if (inst.records.model() === "HOSTED_P0_VOLUME") return hostedVolumeStatus(inst, messagingReady, summary);
  if (provider === "GOOGLE_DRIVE_READY") return component("STORAGE", "READY", summary, { provider: "GOOGLE_DRIVE_READY" });
  if (provider === "LOCAL_DEMO") return component("STORAGE", "READY", summary, { provider: "LOCAL_DEMO", technical: ["Local demo storage stays on this computer. It is not portable."] });
  if (provider === "ERROR") {
    return component("STORAGE", "ERROR", summary, { provider: "ERROR", next: step("STORAGE", "CHECK_STORAGE", "GROK", "I'm checking where tour records are kept.", { tool: "test_storage" }) });
  }
  if (!messagingReady) return component("STORAGE", "NOT_CONFIGURED", "Offered once visitor texting is working.", { provider: "NOT_CONFIGURED" });
  if (provider === "GOOGLE_DRIVE_CONNECTING") {
    const phase = inst.files.state().storage?.migration?.phase;
    const tool = phase === "VERIFIED" ? "activate_google_drive_storage" : phase === "COPIED" ? "verify_storage_migration" : phase === "PREPARED" || phase === "COPYING" ? "migrate_storage_to_google_drive" : "finish_google_drive_setup";
    return component("STORAGE", "CONFIGURING", summary, {
      provider: "GOOGLE_DRIVE_CONNECTING",
      next: step("STORAGE", "FINISH_GOOGLE_DRIVE", "GROK", "I'm finishing the Google Drive connection.", { tool, grokInstructions: "Call that tool. Do not ask for a Google password or token." }),
    });
  }
  return component("STORAGE", "ACTION_REQUIRED", "Tour records are still stored on this computer.", {
    provider: "NOT_CONFIGURED",
    next: step("STORAGE", "CONNECT_GOOGLE_DRIVE", "OPERATOR_DECISION", "Visitor texting is working. Next I recommend connecting Google Drive so your property and tour records stay with you even if this Tour Core computer changes.", {
      tool: "begin_google_drive_connect",
      grokInstructions: DRIVE_INSTRUCTIONS,
    }),
  });
}

function hostedVolumeStatus(inst: Installation, messagingReady: boolean, summary: string): ComponentStatus {
  const backup = inst.files.state().portableBackup;
  const connected = !!backup?.destination;
  const declined = !!backup?.declinedAt && !connected;
  if (!messagingReady) return component("STORAGE", "NOT_CONFIGURED", "Offered once visitor texting is working.", { provider: "HOSTED_VOLUME" });
  if (connected || declined) {
    return component("STORAGE", "READY", summary, {
      provider: "HOSTED_VOLUME",
      technical: [
        connected
          ? "Backup destination confirmed through Grok. Tour Core does not hold a Google token. The Railway volume is the live operational store."
          : "The operator declined portable backups. The Railway volume remains the live operational store.",
      ],
    });
  }
  return component("STORAGE", "ACTION_REQUIRED", summary, {
    provider: "HOSTED_VOLUME",
    next: step(
      "STORAGE",
      "CONFIRM_BACKUP_DESTINATION",
      "OPERATOR_DECISION",
      "Visitor texting is connected. Next I recommend Google Drive so I can keep portable backups and exports of your Tour Core records there.",
      { tool: "confirm_backup_destination", grokInstructions: HOSTED_BACKUP_INSTRUCTIONS },
    ),
  });
}

// On the shared service the service gives each touring host its address, its sign-in, and its number.
const SHARED_ENDPOINT = component("PUBLIC_ENDPOINT", "READY", "The shared service gives Tour Core its public address.");
const SHARED_CONNECTOR = component("GROK_OPERATOR", "READY", "Connected through the shared service.");
export const HOST_NUMBER_MISSING = "This host's texting number isn't set up yet. The service's admin adds it, and I'll pick it up from there.";

/** The host's Twilio number, from the shared service. Nothing to choose and no keys to enter. */
function hostNumberStatus(inst: Installation): ComponentStatus {
  // A Scratch host on a 555 number texts through the local test outbox; that is its texting.
  if (selectionFromInstallation(inst).provider === "local") return component("VISITOR_MESSAGING", "READY", "Texts stay in the Scratch test outbox.", { provider: "local" });
  const provider = createMessagingProvider("twilio", { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
  if (provider.validateConfiguration().ok) return component("VISITOR_MESSAGING", "READY", "Texting is on this host's number.", { provider: "twilio" });
  return component("VISITOR_MESSAGING", "ERROR", HOST_NUMBER_MISSING, {
    provider: "twilio",
    next: step("VISITOR_MESSAGING", "WAIT_FOR_HOST_NUMBER", "GROK", HOST_NUMBER_MISSING, {
      grokInstructions: "Do not ask for a number, a provider, or keys. Tell the host the admin is adding their number, then call get_state later.",
    }),
  });
}

function accessStatus(): ComponentStatus {
  return component("ACCESS", "READY", "Demo. No real doors open.", { provider: "DURIN_DEMO" });
}

/**
 * The property onboarding works on. An unfinished property wins, so a second
 * building can be set up while another stays published. Otherwise the
 * published one, else the most recently saved, else a draft.
 */
export function primaryProperty(ws: PropertyWorkspace): { id: string; saved: boolean } | undefined {
  const ids = ws.propertyIds().filter((id) => !ws.has(id) || !ws.load(id).state.removedAt);
  if (!ids.length) return undefined;
  const saved = ws.list();
  const unfinished = saved
    .filter((p) => p.state.status !== "PUBLISHED_FOR_DEMO")
    .sort((a, b) => (b.state.savedAt ?? "").localeCompare(a.state.savedAt ?? ""))[0];
  if (unfinished) return { id: unfinished.config.property.id, saved: true };
  const draftOnly = ids.find((id) => !saved.some((p) => p.config.property.id === id));
  if (draftOnly) return { id: draftOnly, saved: false };
  const published = saved.find((p) => p.state.status === "PUBLISHED_FOR_DEMO");
  if (published) return { id: published.config.property.id, saved: true };
  const recent = [...saved].sort((a, b) => (b.state.savedAt ?? "").localeCompare(a.state.savedAt ?? ""))[0];
  if (recent) return { id: recent.config.property.id, saved: true };
  return { id: ids[0]!, saved: false };
}

function anotherPropertyStep(operate: string): InstallationStep {
  return {
    component: "PROPERTY",
    action: "ADD_ANOTHER_PROPERTY",
    phase: "OPERATE",
    performedBy: "OPERATOR_DECISION",
    operatorMessage: `${operate} ${OPERATOR_MESSAGES.anotherProperty}`,
    tool: "create_property_setup",
    skill: "setup-property",
    optional: true,
    grokInstructions:
      "The published property stays published. If they want another property, ask for the street address and call create_property_setup, then follow get_next_installation_step for that property. If they don't want another, stop. Don't call create_property_setup before they say yes and give an address.",
  };
}

function propertyStatus(services: OperatorServices, installed: InstalledMessaging | undefined): { status: ComponentStatus; ready: boolean; name?: string } {
  const ws = services.workspace;
  const primary = primaryProperty(ws);
  if (!primary) {
    return {
      ready: false,
      status: component("PROPERTY", "NOT_CONFIGURED", "No property is set up yet.", {
        next: step("PROPERTY", "SET_UP_PROPERTY", "OPERATOR_DECISION", OPERATOR_MESSAGES.firstProperty, { skill: "setup-property" }),
      }),
    };
  }
  const { draft, unsavedChanges } = ws.openDraft(primary.id);
  const name = draft.property.name;
  if (!primary.saved || unsavedChanges) {
    return {
      ready: false,
      name,
      status: component("PROPERTY", "CONFIGURING", `${name} is still being set up.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "OPERATOR_DECISION", `Let's finish setting up ${name}.`, { skill: "setup-property", tool: "review_property_setup" }),
      }),
    };
  }
  const texting = visitorTexting(services, primary.id, draft.messagingMode, installed);
  if (texting.state === "not-using-it" && installed?.requiredForPublish) {
    return {
      ready: false,
      name,
      status: component("PROPERTY", "CONFIGURING", `${name} isn't using your touring number yet.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "GROK", "Visitor texting is connected, but this property isn't using it yet. I'm connecting the property to your touring number.", {
          tool: "set_services",
          grokInstructions: "Call set_services with messaging sendblue for this property yourself; don't ask the operator how to text people. Then call get_next_installation_step.",
        }),
      }),
    };
  }
  const question = nextProfileQuestion(draft.units);
  if (question) {
    return {
      ready: false,
      name,
      status: component("PROPERTY", "CONFIGURING", `${name} still needs some unit details.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "OPERATOR_DECISION", question.question, {
          skill: "setup-property",
          tool: "set_unit_details",
          grokInstructions: "Ask this in plain words and save the answer with set_unit_details (the operator's words; \"not sure\" or \"don't list it\" count as answers). get_unit_details shows what's still missing.",
        }),
      }),
    };
  }
  const published = primary.saved && ws.has(primary.id) && ws.load(primary.id).state.status === "PUBLISHED_FOR_DEMO";
  const help = published ? undefined : visitorHelpQuestion(draft);
  if (help) {
    return {
      ready: false,
      name,
      status: component("PROPERTY", "CONFIGURING", `${name} still has an optional visitor help step.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "OPERATOR_DECISION", help.nextQuestion, {
          skill: "setup-property",
          tool: "update_property_details",
          grokInstructions:
            "Ask operatorMessage word for word. Save a number with update_property_details visitorContact. If they skip, call update_property_details with skipVisitorHelp true so it is not asked again. Never use the team's private alert line as the visitor number.",
        }),
      }),
    };
  }
  return { ready: true, name, status: component("PROPERTY", "READY", `${name} is set up.`) };
}

function alertsStatus(inst: Installation, propertyReady: boolean, client?: ReportedClient): ComponentStatus {
  const env = inst.env();
  // A touring process on the shared service never holds the routine; the shared service says whether it's connected.
  const worker = isTenantWorker(inst.deploymentMode());
  const routineSetup = worker ? TOURING_ROUTINE_SETUP : ROUTINE_SETUP;
  const configured = worker ? inst.sink().configured() : !!env.TOURCORE_GROK_ROUTINE_URL?.trim() && !!env.TOURCORE_GROK_ROUTINE_KEY?.trim();
  const state = inst.files.state();
  const skipped = state.skipped?.OPERATOR_ALERTS;
  const connect = (operatorMessage: string, action: InstallationAction = "CONNECT_OPERATOR_ALERTS", performedBy: PerformedBy = "OPERATOR_IN_SECURE_SETUP") =>
    worker
      ? step("OPERATOR_ALERTS", action, "GROK", operatorMessage, { tool: "save_alert_routine", grokInstructions: routineSetup })
      : step("OPERATOR_ALERTS", action, performedBy, operatorMessage, { tool: "get_secure_setup_url", secureSetupStep: "operator-alerts", grokInstructions: routineSetup });
  const offerMessage = client ? spokenAsk(client, "alerts") : OPERATOR_MESSAGES.offerAlerts;
  const offer = step("OPERATOR_ALERTS", "OFFER_OPERATOR_ALERTS", "OPERATOR_DECISION", offerMessage, {
    tool: "set_notification_preferences",
    secureSetupStep: "operator-alerts",
    grokInstructions:
      `If they say yes: only if it helps, confirm the defaults ("${OPERATOR_MESSAGES.recommendUpdates}"), then call set_notification_preferences (preset recommended unless they chose otherwise). ` +
      `Say "I'm setting up your tour updates." ${routineSetup} ` +
      "If they say no: call skip_optional_setup with component OPERATOR_ALERTS. Never say \"webhook\" or \"routine\" to the operator.",
  });
  const chosen = describeUpdates(enabledUpdates(state.operatorUpdates));
  if (!configured) {
    if (!propertyReady) return component("OPERATOR_ALERTS", "NOT_CONFIGURED", "Offered once your first property is set up.", { provider: "GROK_ROUTINE" });
    if (skipped) return component("OPERATOR_ALERTS", "NOT_CONFIGURED", "Tour updates are off. You can turn them on any time.", { provider: "GROK_ROUTINE", optionalActions: [offer] });
    if (state.operatorUpdates) {
      return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Tour updates are chosen but not connected yet.", {
        provider: "GROK_ROUTINE",
        next: connect("I'm setting up your tour updates. I'll ask for the connection securely; it won't be shown in chat.", "CONNECT_OPERATOR_ALERTS"),
      });
    }
    return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Tour updates aren't turned on yet.", { provider: "GROK_ROUTINE", next: offer });
  }
  const changedAt = latest(inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY"));
  const test = step("OPERATOR_ALERTS", "TEST_OPERATOR_ALERTS", "GROK", "I'm sending a test update.", { tool: "test_operator_alerts" });
  if (worker) {
    // The shared service sends the test update when the routine connects, from this outbox, and retries
    // it. Its delivery is the passed test: there is no test tool or setup page on the shared service.
    const tests = inst.outbox.records().filter((r) => r.event.eventType === "installation.test");
    if (!tests.some((r) => r.status === "delivered")) {
      return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Tour updates are connected. The test update is on its way.", {
        provider: "GROK_ROUTINE",
        next: step("OPERATOR_ALERTS", "TEST_OPERATOR_ALERTS", "GROK", "I'm checking that the test update reached you.", {
          tool: "get_state",
          grokInstructions:
            "The test update goes out on its own and is retried until it gets through. Wait for its note, then call get_state again. Do not set up tour updates again, open a setup page, or ask for an address or a key.",
        }),
      });
    }
  }
  const check = worker ? { ok: true, message: "", credentialsChangedAt: changedAt } : inst.files.state().operatorAlerts;
  const degradedNext = step("OPERATOR_ALERTS", "TEST_OPERATOR_ALERTS", "GROK", SHARED_STEPS["alerts-degraded"].ask, {
    tool: "test_operator_alerts",
    grokInstructions:
      "Send the test this step names. Do not set up tour updates again. Do not create a routine. Do not ask for an address or a key. Do not ask whether they want tour updates.",
  });
  if (!check || check.credentialsChangedAt !== changedAt) return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Tour updates are set up but haven't been tested yet.", { provider: "GROK_ROUTINE", next: test });
  if (!check.ok) {
    const addressSaved = !!env.TOURCORE_GROK_ROUTINE_URL?.trim();
    return component("OPERATOR_ALERTS", "ERROR", "Tour updates aren't reaching you.", {
      provider: "GROK_ROUTINE",
      technical: [check.message],
      next: addressSaved
        ? step("OPERATOR_ALERTS", "FIX_OPERATOR_ALERTS", "OPERATOR_IN_SECURE_SETUP", SHARED_STEPS["alerts-error"].ask, {
            tool: "get_secure_setup_url",
            secureSetupStep: "operator-alerts",
            grokInstructions: RECONNECT_INSTRUCTIONS,
          })
        : connect("I'm setting up your tour updates. I'll ask for the connection securely; it won't be shown in chat."),
    });
  }
  const health = installationAlertHealth(inst);
  if (health.retrying > 0 || health.failed > 0) {
    return component("OPERATOR_ALERTS", "DEGRADED", "Some tour updates haven't reached you yet.", {
      provider: "GROK_ROUTINE",
      technical: [`${health.retrying} waiting to retry, ${health.failed} gave up.`, ...(health.lastError ? [health.lastError] : [])],
      next: degradedNext,
    });
  }
  return component("OPERATOR_ALERTS", "READY", `I'll keep you posted on ${chosen}.`, { provider: "GROK_ROUTINE" });
}

function validationStatuses(services: OperatorServices, propertyReady: boolean, installed: InstalledMessaging | undefined): ComponentStatus[] {
  const blocked = (c: InstallationComponent, summary: string) => component(c, "NOT_CONFIGURED", summary);
  const primary = propertyReady ? primaryProperty(services.workspace) : undefined;
  if (!primary) {
    return [blocked("READINESS", "Runs once a property is set up."), blocked("PRACTICE_TOUR", "Runs once the readiness check passes."), blocked("PUBLISH", "Available once the practice tour passes.")];
  }
  const { config, state } = services.workspace.load(primary.id);
  const name = config.property.name;
  const guards = publishGuards(services, primary.id, config.messagingMode, installed);
  const texting = visitorTexting(services, primary.id, config.messagingMode, installed);
  const textingStatus = texting.state === "test-mode" ? "test mode" : texting.state === "connected" ? "live" : "practice only";
  const liveSummary = `${name} is published. Visitor texting: ${textingStatus}. Door access: ${config.accessMode === "durin-mock" ? "demo" : "connected"}.`;
  const readinessOk = !!state.readiness?.passed && isCurrent(state.readiness, state);
  const dryOk = !!state.dryTour?.passed && isCurrent(state.dryTour, state);
  const published = state.status === "PUBLISHED_FOR_DEMO";
  const failedReadiness = !!state.readiness && !state.readiness.passed && isCurrent(state.readiness, state);
  return [
    readinessOk
      ? component("READINESS", "READY", `${name} passed its readiness check.`)
      : component("READINESS", failedReadiness ? "ERROR" : "ACTION_REQUIRED", failedReadiness ? `${name}'s readiness check found something to fix.` : `${name} needs a readiness check.`, {
          next: step("READINESS", "RUN_READINESS", "GROK", failedReadiness ? `I'm checking ${name} again.` : OPERATOR_MESSAGES.validate, { tool: "run_readiness_check", skill: "run-readiness-check" }),
        }),
    !readinessOk
      ? blocked("PRACTICE_TOUR", "Runs once the readiness check passes.")
      : dryOk
        ? component("PRACTICE_TOUR", "READY", `${name}'s practice tour passed.`)
        : component("PRACTICE_TOUR", "ACTION_REQUIRED", `${name} needs a practice tour.`, {
            next: step("PRACTICE_TOUR", "RUN_PRACTICE_TOUR", "GROK", `I'm running a practice tour of ${name}. Nobody is texted and no real door opens.`, { tool: "run_dry_tour", skill: "simulate-tour" }),
          }),
    published && guards.length
      ? component("PUBLISH", "ERROR", `${name} is published, but texts to your touring number aren't reaching it.`, {
          technical: guards.map((g) => g.message),
          next: step("PUBLISH", "FIX_PROPERTY_TEXTING", "GROK", `${guards[0]!.message.replace(/ I'll connect.*$/, "")} I'm fixing that now.`, {
            tool: guards[0]!.code === "TEXTING_NOT_CONNECTED" ? "set_services" : "run_readiness_check",
            grokInstructions:
              "Fix it yourself through Tour Core: set_services with messaging sendblue if the property still uses practice texts, then run_readiness_check and run_dry_tour, then ask the publish question again. Don't tell the operator the property is live until PUBLISH is READY.",
          }),
        })
      : published
      ? component("PUBLISH", "READY", liveSummary)
      : !(readinessOk && dryOk)
        ? blocked("PUBLISH", "Available once the readiness check and practice tour pass.")
        : component("PUBLISH", "ACTION_REQUIRED", `${name} is ready to publish.`, {
            next: step("PUBLISH", "PUBLISH", "OPERATOR_DECISION", `Everything passed. Would you like me to publish ${name} for demo?`, {
              tool: "publish_demo_property",
              skill: "setup-property",
              grokInstructions:
                "The operator's yes to the publish question is the approval. Call publish_demo_property and ask only the confirmation it returns. After it reports published, call get_installation_status and use that. Do not say publishing still needs a yes once the status is published. A tour update during install does not undo this: re-read get_next_installation_step and follow that.",
            }),
          }),
  ];
}

// -------------------------------------------------------------- overall

export function getInstallationStatus(inst: Installation, services: OperatorServices, options: StatusOptions = {}): InstallationStatus {
  const deployment = inst.deployment();
  const mode = deployment.mode;
  const readOnly = options.readOnly === true;
  const worker = isTenantWorker(mode);
  const messaging = worker ? hostNumberStatus(inst) : messagingStatus(inst, readOnly);
  const infra = worker
    ? [runtimeStatus(options), SHARED_ENDPOINT, SHARED_CONNECTOR, messaging, storageStatus(inst, messaging.state === "READY", readOnly), accessStatus()]
    : [runtimeStatus(options), endpointStatus(inst, mode), grokStatus(inst), messaging, storageStatus(inst, messaging.state === "READY", readOnly), accessStatus()];
  if (deployment.invalid) infra[0]!.technical = [...(infra[0]!.technical ?? []), `TOURCORE_DEPLOYMENT_MODE "${deployment.invalid}" isn't recognized; using ${mode}.`];
  const infrastructureReady = infra.every((c) => c.state === "READY");
  const installed = installedMessaging(inst, { readOnly });
  const property = propertyStatus(services, installed);
  const components: ComponentStatus[] = [
    ...infra,
    // Nothing on the property path is offered until the infrastructure is ready.
    infrastructureReady ? property.status : component("PROPERTY", property.ready ? "READY" : "NOT_CONFIGURED", property.ready ? property.status.summary : "Set up once Tour Core is connected and tested."),
    alertsStatus(inst, infrastructureReady && property.ready, options.client),
    ...validationStatuses(services, infrastructureReady && property.ready, installed),
  ];
  const alertsOn = components.find((c) => c.component === "OPERATOR_ALERTS")!.state === "READY";
  const primary = primaryProperty(services.workspace);
  const textingState =
    !!primary && services.workspace.has(primary.id)
      ? visitorTexting(services, primary.id, services.workspace.load(primary.id).config.messagingMode, installed).state
      : undefined;
  const blocking = components.find((c) => c.state !== "READY" && c.next)?.next;
  const nextStep =
    blocking ??
    anotherPropertyStep(operateMessage(textingState === "connected" ? "connected" : textingState === "test-mode" ? "test-mode" : "practice", alertsOn, activeFromNumber(inst)));
  if (!blocking) {
    const property = components.find((c) => c.component === "PROPERTY");
    if (property) property.optionalActions = [...property.optionalActions, nextStep];
  }
  const phase: OnboardingPhase = nextStep.phase;
  const url = inst.publicBaseUrl();
  const manifest = safe(() => inst.files.manifest());
  return {
    schemaVersion: 1,
    ...(manifest ? { installationId: manifest.installationId } : {}),
    deploymentMode: mode,
    deploymentLabel: DEPLOYMENT_MODE_LABELS[mode],
    phase,
    components,
    infrastructureReady,
    nextStep,
    summary: summaryFor(phase, infrastructureReady, components),
    lines: components.filter((c) => c.state !== "NOT_CONFIGURED" || c.component === "PROPERTY").map(statusLine),
    technical: { deploymentMode: mode, ...(url ? { publicAddress: url, connectorUrl: `${new URL(url).origin}${MCP_PATH}` } : {}) },
    checkedAt: new Date(inst.now()).toISOString(),
  };
}

/** What operating means today, per subsystem: texting can be live or test-mode while door access is still demo. */
export function operateMessage(texting: "connected" | "test-mode" | "practice", alertsOn: boolean, number?: string): string {
  if (texting === "connected") {
    const message = alertsOn ? OPERATOR_MESSAGES.operate : OPERATOR_MESSAGES.operateWithoutAlerts;
    return number ? message.replace("Visitor texting is live.", `Visitor texting is live. ${visitorsTextLine(number)}`) : message;
  }
  const modes = texting === "test-mode" ? localTestModeSentence(true) : modeSentence(false, true);
  return `Your property is published. ${modes} ${alertsOn ? "I'll keep you updated on your tours and let you know when something needs your attention." : "Ask me any time to show active tours or what needs your attention."}`;
}

function summaryFor(phase: OnboardingPhase, infrastructureReady: boolean, components: ComponentStatus[]): string {
  if (phase === "OPERATE") return "Your property is published.";
  if (!infrastructureReady) {
    const left = components.filter((c) => INFRASTRUCTURE.includes(c.component) && c.state !== "READY").length;
    return `${components[0]!.state === "READY" ? "Tour Core is running. " : ""}${left} more thing${left === 1 ? "" : "s"} to connect before your first property.`;
  }
  if (phase === "PROPERTY") return "Everything needed to run Tour Core is connected and tested.";
  if (phase === "VALIDATE") return "Your property is set up. Next come the readiness check and a practice tour.";
  return "Everything passed. Publishing needs your OK.";
}

export function statusLine(c: ComponentStatus): string {
  const mark = c.state === "READY" ? "\u2713" : c.state === "ERROR" || c.state === "DEGRADED" ? "\u2717" : "\u2022";
  return `${mark} ${c.label}: ${c.summary}`;
}

function latest(...values: (string | undefined)[]): string | undefined {
  return values.filter((v): v is string => !!v).sort().at(-1);
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
