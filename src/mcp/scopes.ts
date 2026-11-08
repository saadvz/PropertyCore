import { HOSTED_ADMIN_TOOLS, hostedResetToolVisible } from "../install/hostedAdminTools";
import type { Installation } from "../install/installation";
import { OPERATOR_TOOLS, type OperatorTool } from "../operator/tools";

/**
 * Which connector a request arrived on. Unset means the in-process engine:
 * the browser, tests, and the eval harness still see every tool.
 */
export type ConnectorScope = "landlord" | "ops" | "qa";

/** The 20 core landlord tools, then the two backup tools. Order is the tools/list order. */
export const LANDLORD_CORE_TOOLS = [
  "get_state",
  "save_property",
  "save_units",
  "save_doors_and_routes",
  "save_hours",
  "save_facts",
  "save_settings",
  "set_up_texting",
  "run_checks",
  "publish",
  "remove_property",
  "get_tours",
  "schedule_tour",
  "cancel_tour",
  "hold_tour",
  "pause_tours",
  "get_inbox",
  "reply_to_time_request",
  "resolve_issue",
  "export_records",
  "backup_records",
  "restore_records",
] as const;

export const HOSTED_OWNER_TOOL = "reset_hosted_demo";

/**
 * Self-host storage recovery, the Drive connect those tools need, and runtime health.
 * Texting stays on the landlord connector.
 */
export const OPS_TOOL_NAMES = [
  "discover_storage",
  "takeover_storage_writer",
  "prepare_storage_migration",
  "migrate_storage_to_google_drive",
  "verify_storage_migration",
  "activate_google_drive_storage",
  "disconnect_google_drive_storage",
  "get_storage_status",
  "get_storage_location",
  "begin_google_drive_connect",
  "finish_google_drive_setup",
  "check_runtime_health",
  "check_public_endpoint",
] as const;

/**
 * Local and demo exercising, plus checks that stay on the QA connector.
 * The landlord connector keeps the 22 tools. Nine of these map to a landlord
 * tool. test_operator_alerts, run_dry_tour, and get_installation_status stay
 * on QA. run_checks stops when the connection isn't ready, so it cannot stand
 * in for those two, and get_state is not the installation status tool.
 */
export const QA_TOOL_NAMES = [
  "inject_local_sms",
  "read_local_outbox",
  "use_local_demo_storage",
  "list_exceptions",
  "inspect_exception",
  "resolve_exception",
  "test_operator_alerts",
  "begin_restore_upload",
  "preview_portable_restore",
  "import_portable_backup",
  "schedule_one_off_tour",
  "resume_tours",
  "revoke_tour_access",
  "run_dry_tour",
  "get_installation_status",
] as const;

export function connectorRefusal(scope: ConnectorScope): string {
  if (scope === "landlord") {
    return "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again.";
  }
  if (scope === "ops") return "The ops connector can't run that tool.";
  return "The QA connector can't run that tool.";
}

export function knownOperatorTool(name: string): boolean {
  return OPERATOR_TOOLS.some((tool) => tool.name === name) || HOSTED_ADMIN_TOOLS.some((tool) => tool.name === name);
}

type ScopeContext = { installation?: Installation; caller?: { clientId?: string } } | undefined;

export function catalog(ctx: ScopeContext): OperatorTool[] {
  return hostedResetToolVisible(ctx) ? [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS] : [...OPERATOR_TOOLS];
}

/** Tools this connector may list and call, in tools/list order. */
export function toolsForConnector(connector: ConnectorScope, ctx: ScopeContext): OperatorTool[] {
  const all = catalog(ctx);
  const byName = new Map<string, OperatorTool>();
  for (const tool of all) if (!byName.has(tool.name)) byName.set(tool.name, tool);
  const pick = (names: readonly string[]) => names.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
  if (connector === "ops") return pick(OPS_TOOL_NAMES);
  if (connector === "qa") return pick(QA_TOOL_NAMES);
  const names: string[] = [...LANDLORD_CORE_TOOLS];
  if (hostedResetToolVisible(ctx)) names.push(HOSTED_OWNER_TOOL);
  return pick(names);
}
