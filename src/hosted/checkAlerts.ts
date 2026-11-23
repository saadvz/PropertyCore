import { z } from "zod";
import { findProperty, propertyFolder } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { ALERT_KEEPS_MS } from "../host-alerts/clock";
import { HostAlertLedger } from "../host-alerts/ledger";
import { ALERT_KINDS, type AlertKind } from "../host-alerts/routes";
import type { Job } from "../jobs/jobs";
import { quietLines } from "./botTools";
import { alertRoutes } from "./hostAlerts";
import { hasCoreBot } from "./jobDeps";
import type { ToolCaller } from "./jobTools";
import { issueJobRoutineLink, JOB_ROUTINE_LINK_MINUTES } from "./jobRoutineLink";
import { nameProperty } from "./propertyTools";
import type { FrontReply } from "./serviceTools";

/**
 * check_alerts (#250): how the Property Core bot and the Supply Core bot read the host alerts routed to them. It is
 * the hand-over, not a listing: each alert is returned once and marked shown in the property's host-alerts.json,
 * and the producer's own record (packages.json, the camera notes, the visit checks) is never touched here. With
 * connect: true it reads nothing and gives the calling chat a one-time link for its own Alerts routine.
 */

export const CHECK_ALERTS = "check_alerts";

const Args = z.strictObject({ property: z.string().trim().min(1).max(200).optional(), connect: z.boolean().optional() });

const TOOL = {
  name: CHECK_ALERTS,
  title: "Check alerts",
  description:
    'What the clock found for the host since you last asked: a package not seen by 9 PM, a camera offline, a visit that didn\'t happen, a night\'s stay check. Call it when your Alerts routine wakes you and on your scheduled check, and tell the host each of alerts and each of notes once: an alert is returned only once. With no property it reads every property. Pass connect: true to read nothing and get uploadUrl, a one-time link for this chat\'s own Alerts routine: from your own cloud computer, POST JSON {"url": "<webhook address>", "token": "<webhook key>"} to it with Content-Type: application/json, using the values from the host\'s secure cards. Never put them in chat or in a tool argument.',
  inputSchema: {
    type: "object",
    properties: {
      property: { type: "string", maxLength: 200, description: "A property's id from get_state, to read only that property. Its exact label works too." },
      connect: { type: "boolean", description: "True to get the one-time upload link for this chat's Alerts routine instead of reading alerts." },
    },
    additionalProperties: false,
  },
};

type Caller = ToolCaller & { grantId: string; assistant: string };

/** The job that reads an alert routed here. One routed to the account's one Alerts routine but never taken by a desk's notes is the Property Core chat's. */
const READER: Record<"alerts" | "property" | "supplies", Job> = { alerts: "property", property: "property", supplies: "supplies" };

/** True when this caller reads alerts with check_alerts: the account's `bots` switch is on, a core has its own bot connected, and the caller has a job that reads them. */
function reads(h: HostedCleaner, tenant: Tenant, caller: ToolCaller): boolean {
  return (caller.jobs.includes("property") || caller.jobs.includes("supplies")) && hasCoreBot(h, tenant);
}

/** check_alerts as tools/list shows it. An account with one bot lists what it always listed. */
export function listedCheckAlerts(h: HostedCleaner, tenant: Tenant, caller: ToolCaller): Record<string, unknown>[] {
  return reads(h, tenant, caller) ? [TOOL] : [];
}

const fail = (text: string): FrontReply => ({ text, isError: true });
const ok = (structured: Record<string, unknown>): FrontReply => ({ text: JSON.stringify(structured), structured, isError: false });

export async function checkAlertsCall(h: HostedCleaner, tenant: Tenant, caller: Caller, args: unknown): Promise<FrontReply> {
  if (!reads(h, tenant, caller)) return fail(`There's no tool named ${CHECK_ALERTS} here. Call get_state.`);
  const parsed = Args.safeParse(args ?? {});
  if (!parsed.success) return fail("check_alerts takes property and connect, both optional, and nothing else.");
  if (parsed.data.connect) {
    // Only a Grok Bot's routine can be woken; any other chat reads its alerts on its own schedule.
    if (caller.assistant !== "grok") return fail("An Alerts routine is for Grok Bot. Call check_alerts on your scheduled check instead.");
    if (!h.origin()) return fail("Upload links aren't available on this service yet.");
    return ok({ uploadUrl: issueJobRoutineLink(h, tenant, caller.grantId), expiresInMinutes: JOB_ROUTINE_LINK_MINUTES });
  }
  let properties = tenant.properties;
  if (parsed.data.property !== undefined) {
    const named = findProperty(tenant, parsed.data.property);
    if (!named) return fail(nameProperty(tenant));
    properties = [named];
  }
  const routes = alertRoutes(h, tenant);
  const kinds: AlertKind[] = ALERT_KINDS.filter((kind) => caller.jobs.includes(READER[routes(kind)]));
  const now = h.now();
  const alerts: { id: string; kind: AlertKind; property: string; text: string; keptAt: string }[] = [];
  for (const property of properties) {
    const ledger = new HostAlertLedger(propertyFolder(h.dataRoot, tenant.id, property), () => now);
    for (const alert of ledger.unshown(kinds)) {
      // "Today at…" and "Tonight at…" don't keep: one older than the clock keeps an alert is let go, not shown late.
      if (now.getTime() - Date.parse(alert.keptAt) >= ALERT_KEEPS_MS) continue;
      alerts.push({ id: alert.id, kind: alert.kind, property: property.id, text: alert.text, keptAt: alert.keptAt });
      ledger.shown(alert.id);
    }
  }
  alerts.sort((a, b) => Date.parse(a.keptAt) - Date.parse(b.keptAt));
  // The Property Core bot also hears, once, about a core's bot that has gone quiet with news waiting.
  return ok({ alerts, notes: caller.jobs.includes("property") ? quietLines(h, tenant) : [] });
}
