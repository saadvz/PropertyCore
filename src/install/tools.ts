import { z } from "zod";
import { describeOperatorUpdate } from "../alerts/describeUpdate";
import { choosePreferences, describeUpdates, enabledUpdates, PROBLEMS_ONLY, RECOMMENDED_UPDATES, UPDATE_KINDS, UPDATE_LABELS } from "../alerts/preferences";
import type { OperatorTool, ToolContext } from "../operator/tools";
import { tool } from "../operator/defineTool";
import { SetupInputError } from "../setup/setupActions";
import { checkPublicEndpoint, deployedCommitLabel, runtimeHealth, testAccess, testOperatorAlerts, testStorage, testVisitorMessaging } from "./checks";
import { toE164 } from "../messaging/Messenger";
import { chooseMessagingProvider } from "../messaging/switchProvider";
import { resolvePropertyId } from "../operator/resolve";
import type { Installation } from "./installation";
import { isHostedRailway } from "./deployment";
import { HOSTED_SETUP_SESSION_MINUTES, HOSTED_SETUP_WRITES, DEFAULT_SETUP_SESSION_MINUTES } from "./setupSessions";
import { STORAGE_TOOLS } from "./storageTools";
import { BACKUP_TOOLS } from "../backup/tools";
import { getInstallationStatus, INSTALLATION_COMPONENTS, OPTIONAL_COMPONENTS, type ComponentStatus, type InstallationComponent } from "./status";
import { readState } from "./stateView";
import { ensureMessagingSelection } from "../messaging/registry";
import { SHARED_STEPS } from "../playbooks/shared";
import { LOCAL_TEST_TEXTING } from "../setup/setupActions";

/**
 * Installation tools for the operator's agent host. They report and test the
 * installation; they never take a credential as input and never return one.
 * Credentials go in only through the secure setup page on the Tour Core
 * computer (get_secure_setup_url). There is deliberately no tool that sets an
 * API key, sender key or webhook secret, and none that runs a shell command.
 */

function installation(ctx: ToolContext): Installation {
  if (!ctx.installation) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  return ctx.installation;
}

/** The same secure-setup card get_secure_setup_url returns. No visitor name, number, or message. */
export function secureSetupLink(inst: Installation, localUrl: string | undefined, step?: "visitor-messaging" | "operator-alerts"): Record<string, unknown> {
  const hosted = isHostedRailway(inst.deploymentMode());
  const minted = hosted ? inst.sessions.mint(HOSTED_SETUP_SESSION_MINUTES, { csrf: true, writes: HOSTED_SETUP_WRITES }) : inst.sessions.mint();
  const base = hosted ? inst.publicBaseUrl() : (localUrl ?? "http://localhost:4321");
  if (!base) return { summary: "Tour Core doesn't have a secure page for credentials yet.", instructions: "The hosted public address isn't set, so there is no setup page to open." };
  const minutes = Math.round((minted.expiresAt - inst.now()) / 60_000) || (hosted ? HOSTED_SETUP_SESSION_MINUTES : DEFAULT_SETUP_SESSION_MINUTES);
  const fragment = `s=${minted.token}${minted.csrf ? `&c=${minted.csrf}` : ""}${step ? `&step=${step}` : ""}`;
  return {
    summary: "I'll ask for these credentials securely; they won't be shown in chat. Then I'll fill Tour Core's setup form.",
    url: `${base}/install#${fragment}`,
    expiresInMinutes: minutes,
    instructions: hosted
      ? "Open url over https. Prefer Grok's secure secret input and fill the form yourself. Do not show the link, do not ask for the values in chat, and do not pass them as tool arguments. The link expires and can only be used a few times. Hand the browser to the operator only if secure fill isn't available for a field. When they're saved, call get_state."
      : "Open url yourself in your cloud browser (it only works on the Tour Core computer). Prefer Grok's secure secret input and fill the form yourself. Do not show the link, do not ask for the values in chat, and do not pass them as tool arguments. Use a provider login when that provider has one. Hand the browser to the operator only if secure fill isn't available for a field. When they're saved, call get_state.",
  };
}

const componentOut = (c: ComponentStatus) => ({
  component: c.component,
  label: c.label,
  state: c.state,
  requirement: c.requirement,
  summary: c.summary,
  ...(c.next ? { next: c.next } : {}),
  ...(c.optionalActions.length ? { optionalActions: c.optionalActions } : {}),
  ...(c.provider || c.technical?.length ? { technical: { ...(c.provider ? { provider: c.provider } : {}), ...(c.technical?.length ? { details: c.technical } : {}) } } : {}),
});

/** Returned with every step: the order is Tour Core's, not the agent's. */
export const SEQUENCE_RULE =
  "Tour Core decides the order. Do this step now. Don't offer other setup, don't ask the operator what to do next, and don't start property setup before Tour Core offers it. Say operatorMessage in your own words; never show grokInstructions, technical details, addresses or commands to the operator.";

const TECHNICAL_NOTE = "For your own actions and troubleshooting only. Never show these to the operator.";

const SecureStep = z.enum(["visitor-messaging", "operator-alerts"]);

export const INSTALLATION_TOOLS: OperatorTool[] = [
  tool({
    name: "get_state",
    title: "Current setup",
    kind: "read",
    description:
      "A read-only picture of this install, or of one property when propertyId is set. Returns setup, units, doors, routes, hours, verification, texting, alerts, a one-line health summary, a one-line storage summary, milestones, the next step, and this client's playbook. It does not change anything. Call it first and follow its next step. The landlord connector doesn't list the older status tools.",
    input: z.strictObject({
      propertyId: z.string().optional().describe("One property. Leave it out to read the whole install."),
    }),
    run: async (ctx, i) => readState({ installation: ctx.installation, services: ctx.services, client: ctx.client }, i.propertyId),
  }),
  tool({
    name: "get_installation_status",
    title: "Installation status",
    kind: "read",
    description:
      "Where this Tour Core installation stands, component by component, in the order Tour Core sets them up, with the onboarding phase and the next step. The source of truth for \"What's left to set up?\". summary and lines are safe to say to the operator; technical is for you only. Never contains credentials.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const s = getInstallationStatus(installation(ctx), ctx.services, { client: ctx.client });
      return {
        summary: s.summary,
        phase: s.phase,
        infrastructureReady: s.infrastructureReady,
        lines: s.lines,
        nextStep: s.nextStep,
        rule: SEQUENCE_RULE,
        components: s.components.map(componentOut),
        technical: {
          note: TECHNICAL_NOTE,
          deployment: s.deploymentLabel,
          ...s.technical,
          ...(ctx.connector === "qa" ? { commit: deployedCommitLabel(ctx.installation?.env() ?? {}) } : {}),
        },
      };
    },
  }),
  tool({
    name: "get_next_installation_step",
    title: "Next installation step",
    kind: "read",
    description:
      "The one next step Tour Core decided: component, action, phase, who does it (GROK, OPERATOR, OPERATOR_IN_SECURE_SETUP or OPERATOR_DECISION), the tool or skill to use, what to tell the operator (operatorMessage), and what you need to do it (grokInstructions, for you only). Follow it; call it again after each step. When a property is already published, the next step is ADD_ANOTHER_PROPERTY (create_property_setup) so another property can be set up. The published property stays published. If the operator doesn't want another, stop.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const s = getInstallationStatus(installation(ctx), ctx.services, { client: ctx.client });
      return { summary: s.nextStep.operatorMessage, ...s.nextStep, infrastructureReady: s.infrastructureReady, rule: SEQUENCE_RULE };
    },
  }),
  tool({
    name: "skip_optional_setup",
    title: "Skip an optional setup step",
    kind: "change",
    description:
      "Records that the operator declined an optional setup step Tour Core offered (only components Tour Core marks RECOMMENDED, e.g. OPERATOR_ALERTS), so the sequence moves on. Only after the operator clearly says no. It can be turned on later.",
    input: z.strictObject({ component: z.enum(OPTIONAL_COMPONENTS as [InstallationComponent, ...InstallationComponent[]]) }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const state = inst.files.state();
      inst.files.writeState({ ...state, skipped: { ...state.skipped, [i.component]: new Date(inst.now()).toISOString() } });
      const next = getInstallationStatus(inst, ctx.services).nextStep;
      return { summary: "No problem, that's off for now. You can turn it on any time.", nextStep: next, rule: SEQUENCE_RULE };
    },
  }),
  tool({
    name: "get_installation_component",
    title: "One installation component",
    kind: "read",
    description: "The status of one installation component, with details and its next step.",
    input: z.strictObject({ component: z.enum(INSTALLATION_COMPONENTS) }),
    run: async (ctx, i) => {
      const c = getInstallationStatus(installation(ctx), ctx.services).components.find((x) => x.component === i.component)!;
      return { ...componentOut(c), summary: `${c.label}: ${c.summary}` };
    },
  }),
  tool({
    name: "check_runtime_health",
    title: "Check Tour Core's health",
    kind: "read",
    description:
      "Whether Tour Core is running and healthy: version, uptime, deployment mode, whether running tours can be saved, alerts waiting to be delivered, storagePath, persistentVolume, and volumeMount. alertDelivery is the same missed-update count installation status uses (pending, retrying, failed, delivered), counting only misses since the last passing test. A later ordinary delivery does not clear a miss. persistentVolume true means TOURCORE_HOME is on a mounted volume. On the hosted product, persistentVolume false means records sit on disposable disk and will be wiped on the next deploy: tell the operator a volume must be attached so records last. Never set or recommend TOURCORE_ALLOW_EPHEMERAL_STORAGE on a live service; that switch is only for disposable demos.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const h = runtimeHealth(installation(ctx));
      return { summary: h.runtimeRecords === "ok" ? "Tour Core is running and healthy." : "Tour Core is running, but it can't save tour progress right now.", ok: h.runtimeRecords === "ok", technical: { note: TECHNICAL_NOTE, ...h } };
    },
  }),
  tool({
    name: "check_public_endpoint",
    title: "Check the public address",
    kind: "change",
    description: "Checks from the outside that Tour Core's public https address reaches this installation, and records the result.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await checkPublicEndpoint(installation(ctx), { attempts: 2, delayMs: 2000 });
      return {
        ok: r.ok,
        summary: r.ok ? "Tour Core has a secure public connection." : "Tour Core's secure public connection isn't working yet.",
        technical: { note: TECHNICAL_NOTE, detail: r.message, ...(r.url ? { publicAddress: r.url } : {}) },
      };
    },
  }),
  tool({
    name: "choose_messaging_provider",
    title: "Choose visitor texting",
    kind: "change",
    description:
      "Records which messaging provider prospects will use: sendblue, twilio, photon, or local (QA loopback; no real texts). Pass property to put only that building on local test texts; the installation's live texting and other published buildings stay as they are. Without a property, local is refused when more than one building exists. Takes no credentials. An installation-wide switch takes the previous provider out of active use and requires a new connection test. Saved account details and attached lines for other providers stay. Property and tour records stay.",
    input: z.strictObject({
      provider: z.enum(["sendblue", "twilio", "photon", "local"]),
      property: z.string().max(200).optional().describe("Which building should use this option. Required for local when more than one building exists."),
    }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const propertyId = i.property ? resolvePropertyId(ctx.services.workspace, i.property) : undefined;
      const chosen = await chooseMessagingProvider(inst, i.provider, { workspace: ctx.services.workspace, propertyId });
      if (chosen.scope === "installation") ctx.resetMessaging?.();
      const next = getInstallationStatus(inst, ctx.services).nextStep;
      return { summary: chosen.summary, provider: i.provider, changed: chosen.changed, scope: chosen.scope, nextStep: next, rule: SEQUENCE_RULE };
    },
  }),
  tool({
    name: "choose_messaging_line",
    title: "Choose a messaging line",
    kind: "change",
    description: "Saves which Photon line prospects will text. The address must be one Tour Core already discovered. Takes no secrets.",
    input: z.strictObject({ line: z.string().min(8).max(40).describe("One of the line addresses Tour Core listed.") }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const wanted = toE164(i.line);
      const known = (inst.files.state().messagingLines ?? []).map((line) => toE164(line.address) ?? line.address);
      if (!wanted || !known.includes(wanted)) throw new SetupInputError("LINE_NOT_LISTED", "Choose one of the lines Tour Core listed.");
      inst.secrets.set({ TOURCORE_PHOTON_PHONE_NUMBER: wanted }, new Date(inst.now()));
      ctx.resetMessaging?.();
      const next = getInstallationStatus(inst, ctx.services).nextStep;
      return { summary: `Prospects will text ${wanted}. I'll test that line next.`, line: wanted, nextStep: next, rule: SEQUENCE_RULE };
    },
  }),
  tool({
    name: "test_visitor_messaging",
    title: "Test visitor messaging",
    kind: "change",
    description:
      "Checks the selected visitor-texting provider (account, number or line, incoming messages, identity-form links) using details already saved, and registers Tour Core's incoming-message address when that provider supports it. Takes no credentials. Nothing is texted. A passing test does not mean carrier registration is complete. If Photon reports more than one line, ask the operator which listed line to use and call choose_messaging_line.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testVisitorMessaging(installation(ctx), { onConnected: ctx.resetMessaging });
      const { checks, incomingMessages, previousAddress, textingNumber, message, lines, needsLineChoice } = r;
      return {
        ok: r.ok,
        summary: needsLineChoice
          ? "Photon is connected. Choose one of the available lines."
          : r.ok
            ? ensureMessagingSelection(installation(ctx)).provider === "local"
              ? LOCAL_TEST_TEXTING
              : "Visitor texting is connected and working."
            : "Visitor texting isn't working yet.",
        ...(textingNumber ? { textingNumber } : {}),
        ...(needsLineChoice ? { needsLineChoice: true, lines } : {}),
        technical: { note: TECHNICAL_NOTE, detail: message, checks, incomingMessages, ...(previousAddress ? { previousAddress } : {}) },
      };
    },
  }),
  tool({
    name: "get_notification_preferences",
    title: "Tour update preferences",
    kind: "read",
    description:
      "Which tour updates the operator gets (tour booked, started, finished, cancelled) and which problems they're alerted to (a visitor needs input, a door problem, an identity check that didn't pass), plus Tour Core's recommended default. Normal texts and door requests never wake the operator. Missed tours (no-shows) aren't detected yet.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const prefs = installation(ctx).files.state().operatorUpdates;
      const enabled = enabledUpdates(prefs);
      return {
        summary: `I'll keep you posted on ${describeUpdates(enabled)}.`,
        chosen: !!prefs,
        enabled,
        recommended: RECOMMENDED_UPDATES,
        recommendation: `I recommend alerts for ${describeUpdates(RECOMMENDED_UPDATES)}.`,
        choices: UPDATE_KINDS.map((k) => ({ update: k, when: UPDATE_LABELS[k], on: enabled.includes(k), recommended: RECOMMENDED_UPDATES.includes(k) })),
      };
    },
  }),
  tool({
    name: "set_notification_preferences",
    title: "Choose tour updates",
    kind: "change",
    description:
      `Saves which tour updates the operator wants, after they answered "${SHARED_STEPS.alerts.ask}". preset "recommended" = bookings, tour starts, completions and anything that needs attention; "problems-only" = only what needs their input. Or pass the exact updates they asked for. Things that happened before a kind was turned on are never announced late.`,
    input: z.strictObject({
      preset: z.enum(["recommended", "problems-only"]).optional(),
      updates: z.array(z.enum(UPDATE_KINDS)).max(UPDATE_KINDS.length).optional().describe("Only when the operator picked specific updates."),
    }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const enabled = i.updates ?? (i.preset === "problems-only" ? PROBLEMS_ONLY : RECOMMENDED_UPDATES);
      const state = inst.files.state();
      const prefs = choosePreferences(state.operatorUpdates, enabled, new Date(inst.now()));
      inst.files.writeState({ ...state, operatorUpdates: prefs });
      const next = getInstallationStatus(inst, ctx.services).nextStep;
      return { summary: `Got it. I'll keep you posted on ${describeUpdates(prefs.enabled)}.`, enabled: prefs.enabled, nextStep: next, rule: SEQUENCE_RULE };
    },
  }),
  tool({
    name: "get_operator_update",
    title: "Read a tour update",
    kind: "read",
    description:
      "What one operator update is about, from Tour Core's records: call it with the eventId when the Tour Core Operator Updates routine wakes you. Returns summary, one plain sentence to tell the operator (e.g. \"New tour booked: Testy is scheduled to tour Unit 1A today at 3:00 PM.\"), plus the tour or issue behind it. The webhook itself never carries names or details.",
    input: z.strictObject({ eventId: z.string().min(8).max(90).describe("The eventId from the routine's webhook payload. Never show it to the operator.") }),
    run: async (ctx, i) => {
      const record = installation(ctx).outbox.get(i.eventId);
      if (!record) throw new SetupInputError("UPDATE_NOT_FOUND", "I couldn't find that update.");
      return describeOperatorUpdate(ctx.services, record.event, ctx.now());
    },
  }),
  tool({
    name: "test_operator_alerts",
    title: "Test tour updates",
    kind: "change",
    description: "Sends one test update to the connected Grok Routine (Tour Core Operator Updates) and reports whether it was accepted. Takes no credentials.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testOperatorAlerts(installation(ctx));
      return {
        ok: r.ok,
        summary: r.ok ? "Tour updates are working: I sent a test update." : "The test update didn't get through yet.",
        technical: { note: TECHNICAL_NOTE, detail: r.message },
      };
    },
  }),
  tool({
    name: "test_storage",
    title: "Test tour records storage",
    kind: "change",
    description: "Saves, reads back and removes a test record where tour records are kept, and says where that is.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testStorage(installation(ctx), ctx.services);
      return { summary: r.message, ...r };
    },
  }),
  tool({
    name: "test_access",
    title: "Test the access system",
    kind: "read",
    description: 'Checks that the access system answers. Say "Access system: Demo" or "Access system: Connected"; never name the lock provider. No door opens.',
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testAccess(installation(ctx));
      return { summary: r.message, ...r };
    },
  }),
  tool({
    name: "get_secure_setup_url",
    title: "Open secure setup",
    kind: "change",
    description:
      "A short-lived link to Tour Core's secure setup page. On a local or Grok-managed install it only opens in the browser on the Tour Core computer. On the hosted demo it is an https page with a one-time session. Prefer a secure secret input that fills the form without the values entering chat. Hand the browser to the operator only if that fill isn't available. Never ask for credentials in chat and never pass them as tool arguments.",
    input: z.strictObject({ step: SecureStep.optional().describe("Which part to open: visitor-messaging or operator-alerts (Grok Routine).") }),
    run: async (ctx, i) => secureSetupLink(installation(ctx), ctx.localUrl?.(), i.step),
  }),
  ...STORAGE_TOOLS,
  ...BACKUP_TOOLS,
];
