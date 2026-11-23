import { CLEANER_TOOL_NAMES } from "../cleaner-core/mcp";
import { CORE_JOBS, JOB_NAMES, JOBS, type CoreJob, type Job } from "../jobs/jobs";
import { CAMERA_FRONT_NAMES } from "./cameras";
import { FIXER_FRONT_NAMES } from "./fixer";
import { GUEST_FRONT_NAMES } from "./guestMessages";
import { HOURS_FRONT_NAMES } from "./hours";
import { LOCK_FRONT_NAMES } from "./locks";
import { OVERSIGHT_FRONT_NAMES } from "./oversight";
import { PACKAGE_FRONT_NAMES } from "./packages";
import { STAY_CHECK_FRONT_NAMES } from "./stayCheck";
import { CHOOSE, SUPPLY_FRONT_NAMES } from "./supplies";
import { VISITS_FRONT_NAMES } from "./visits";

/**
 * What each job holds (#250), built from the name sets that already exist. A job is a second filter on top of the
 * flows and the account's switches: it only ever takes a tool away from a connection. The check is made on the call,
 * before any desk is reached, and on the list.
 */

/** A caller as the job check reads it: the job of its address, when it is a core's own bot, and the jobs it has now. */
export interface ToolCaller {
  job?: CoreJob;
  jobs: readonly Job[];
}

const PROPERTY_ONLY: ReadonlySet<string> = new Set(["add_property", "set_flows", "remove_bot", ...LOCK_FRONT_NAMES, ...CAMERA_FRONT_NAMES, ...STAY_CHECK_FRONT_NAMES, ...OVERSIGHT_FRONT_NAMES, ...VISITS_FRONT_NAMES, ...GUEST_FRONT_NAMES, ...HOURS_FRONT_NAMES]);
const CLEANING: ReadonlySet<string> = new Set(CLEANER_TOOL_NAMES);

/** The check tools a routine calls: one left behind in the Property Core chat is told to delete itself. */
const ROUTINE_CHECKS: Record<string, CoreJob> = { check_now: "cleaning", check_supplies: "supplies", check_fixes: "fixer" };

/** The jobs that may call this tool. Empty for a name no desk knows. */
export function jobsOf(tool: string): readonly Job[] {
  if (tool === "get_state") return JOBS;
  // The host alerts a bot reads (#250). The name is checkAlerts.ts's CHECK_ALERTS.
  if (tool === "check_alerts") return ["property", "supplies"];
  if (tool === "get_job_photos") return ["cleaning", "fixer"];
  if (tool === "preview_schedule") return ["supplies", "fixer"];
  // Cleaner Core's setup question about Supply Core. It turns a flow on, so only a /mcp chat may answer it (mayCall).
  if (tool === CHOOSE) return ["cleaning"];
  if (PROPERTY_ONLY.has(tool)) return ["property"];
  if (CLEANING.has(tool)) return ["cleaning"];
  if (SUPPLY_FRONT_NAMES.has(tool) || PACKAGE_FRONT_NAMES.has(tool)) return ["supplies"];
  if (FIXER_FRONT_NAMES.has(tool)) return ["fixer"];
  return [];
}

/**
 * The tools one core's side may file into another core with (#250), and the job that owns each: Cleaner Core reads
 * Supply Core's list to match item ids, marks items low, and opens a repair. The owning bot works what is filed.
 */
export const FILING_TOOLS = { get_supply_state: "supplies", report_low: "supplies", open_job: "fixer" } as const satisfies Record<string, CoreJob>;
export type FilingTool = keyof typeof FILING_TOOLS;

/** True when this caller has "cleaning" and lacks the tool's owning job: the call is a filing, answered by filing.ts. */
export function isFiling(tool: string, caller: ToolCaller): tool is FilingTool {
  return Object.hasOwn(FILING_TOOLS, tool) && caller.jobs.includes("cleaning") && !caller.jobs.includes(FILING_TOOLS[tool as FilingTool]);
}

/** True when the caller may call it. A name no desk knows passes, so it reaches the usual "There's no tool named" line. */
export function mayCall(tool: string, caller: ToolCaller): boolean {
  if (caller.jobs.length === 0) return false;
  if (isFiling(tool, caller)) return true;
  const owners = jobsOf(tool);
  if (owners.length === 0) return true;
  // A core's bot can't turn a flow on or off.
  if (tool === CHOOSE && caller.job) return false;
  return owners.some((job) => caller.jobs.includes(job));
}

/** The job whose bot the host is sent to for a tool this caller may not call. */
export function ownerFor(tool: string, caller: ToolCaller): Job {
  if (tool === CHOOSE && caller.job) return "property";
  return jobsOf(tool)[0] ?? "property";
}

/** The routine a left-behind check belongs to, when this tool is one. */
export function routineCheckOf(tool: string): CoreJob | undefined {
  return ROUTINE_CHECKS[tool];
}

export const NO_JOBS = "Separate bots are off for this account. Ask the host to open the Property Core bot.";

/** The refusal for a tool another bot holds: one fixed line that names the bot, so the host is sent to the right chat. */
export function elsewhereLine(owner: Job, ownBot: boolean): string {
  if (ownBot && owner !== "property") return `${JOB_NAMES[owner]} has its own bot on this account. Ask the host to open the ${JOB_NAMES[owner]} bot for that.`;
  return "That belongs to the Property Core bot. Ask the host to open the Property Core bot for that.";
}

/** Added when a routine left behind in the Property Core chat calls a check that another bot now runs. */
export function leftBehindLine(owner: CoreJob): string {
  return `Delete your ${JOB_NAMES[owner]} routines here. That bot runs its own.`;
}

/** The first line of initialize for a core's own bot. */
export function jobInstructions(job: CoreJob): string {
  const name = JOB_NAMES[job];
  return `This connection runs ${name} for the host's properties, and nothing else. Call get_state first. When the account has more than one property, name the property in every property tool call with its id from get_state. For anything outside ${name}, send the host to the Property Core bot's chat.`;
}

/** For the Property Core chat on a team: which cores have their own bot. */
export function teamLine(ownBots: readonly CoreJob[]): string {
  const names = CORE_JOBS.filter((job) => ownBots.includes(job)).map((job) => JOB_NAMES[job]);
  if (names.length === 1) return `${names[0]} has its own bot on this account. Send the host to that bot's chat for its work.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} each have their own bot on this account. Send the host to that bot's chat for their work.`;
}
