import { describe, expect, it } from "vitest";
import { CLEANER_TOOL_NAMES } from "../src/cleaner-core/mcp";
import { CAMERA_FRONT_NAMES } from "../src/hosted/cameras";
import { FIXER_FRONT_NAMES } from "../src/hosted/fixer";
import { GUEST_FRONT_NAMES } from "../src/hosted/guestMessages";
import { HOURS_FRONT_NAMES } from "../src/hosted/hours";
import { elsewhereLine, jobInstructions, jobsOf, leftBehindLine, mayCall, teamLine } from "../src/hosted/jobTools";
import { LOCK_FRONT_NAMES } from "../src/hosted/locks";
import { OVERSIGHT_FRONT_NAMES } from "../src/hosted/oversight";
import { PACKAGE_FRONT_NAMES } from "../src/hosted/packages";
import { STAY_CHECK_FRONT_NAMES } from "../src/hosted/stayCheck";
import { SUPPLY_FRONT_NAMES } from "../src/hosted/supplies";
import { VISITS_FRONT_NAMES } from "../src/hosted/visits";
import { coreBot, holderOf, isQuiet, isTeam, jobOfPath, JOBS, jobsFor, mainConnection, QUIET_MS, quietAfterMs, type JobConnection, type JobDeps } from "../src/jobs/jobs";

/** #250, the rule: who has and who holds each job. Made-up grant ids only; nothing here reaches a desk. */

const main: JobConnection = { grantId: "g-main", assistant: "grok", connectedAt: "2026-11-22T10:00:00.000Z" };
const fixerBot: JobConnection = { grantId: "g-fix", assistant: "grok", connectedAt: "2026-11-22T11:00:00.000Z", job: "fixer" };
const deps = (over: Partial<JobDeps> = {}): JobDeps => ({ botsOn: true, isLive: () => true, hasRoutine: () => false, ...over });

describe("the rule for who holds each job", () => {
  it("an account with only /mcp connections has and holds every job on the primary", () => {
    const account = { primaryGrantId: "g-main", connections: [main] };
    expect(jobsFor(account, main, deps())).toEqual(["property", "cleaning", "supplies", "fixer"]);
    for (const job of JOBS) expect(holderOf(account, job, deps())?.grantId).toBe("g-main");
    expect(isTeam(account, deps())).toBe(false);
  });

  it("a core bot with no routine has its job and holds nothing", () => {
    const account = { primaryGrantId: "g-main", connections: [main, fixerBot] };
    expect(jobsFor(account, fixerBot, deps())).toEqual(["fixer"]);
    expect(jobsFor(account, main, deps())).toContain("fixer");
    expect(holderOf(account, "fixer", deps())?.grantId).toBe("g-main");
    expect(isTeam(account, deps())).toBe(false);
  });

  it("a core bot with its routine saved holds its job, and /mcp stops having it", () => {
    const d = deps({ hasRoutine: (id) => id === "g-fix" });
    const account = { primaryGrantId: "g-main", connections: [main, fixerBot] };
    expect(holderOf(account, "fixer", d)?.grantId).toBe("g-fix");
    expect(jobsFor(account, main, d)).toEqual(["property", "cleaning", "supplies"]);
    expect(jobsFor(account, fixerBot, d)).toEqual(["fixer"]);
    expect(holderOf(account, "cleaning", d)?.grantId).toBe("g-main");
    expect(isTeam(account, d)).toBe(true);
  });

  it("the job comes back when the grant ends or the switch goes off", () => {
    const account = { primaryGrantId: "g-main", connections: [main, fixerBot] };
    const saved = { hasRoutine: (id: string) => id === "g-fix" };
    expect(holderOf(account, "fixer", deps({ ...saved, isLive: (id) => id !== "g-fix" }))?.grantId).toBe("g-main");
    expect(jobsFor(account, fixerBot, deps({ ...saved, isLive: (id) => id !== "g-fix" }))).toEqual([]);
    expect(holderOf(account, "fixer", deps({ ...saved, botsOn: false }))?.grantId).toBe("g-main");
    expect(jobsFor(account, fixerBot, deps({ ...saved, botsOn: false }))).toEqual([]);
    expect(jobsFor(account, main, deps({ ...saved, botsOn: false }))).toEqual(["property", "cleaning", "supplies", "fixer"]);
    expect(isTeam(account, deps({ ...saved, botsOn: false }))).toBe(false);
  });

  it("the primary is never a core connection", () => {
    const account = { primaryGrantId: "g-fix", connections: [fixerBot, main] };
    expect(mainConnection(account, deps())?.grantId).toBe("g-main");
    expect(mainConnection({ connections: [fixerBot] }, deps())).toBeUndefined();
    expect(holderOf({ connections: [fixerBot] }, "property", deps())).toBeUndefined();
  });

  it("a second /mcp chat has the same tools as the primary and holds nothing", () => {
    const second: JobConnection = { grantId: "g-second", assistant: "grok", connectedAt: "2026-11-22T12:00:00.000Z" };
    const account = { primaryGrantId: "g-main", connections: [main, second] };
    expect(jobsFor(account, second, deps())).toEqual(jobsFor(account, main, deps()));
    for (const job of JOBS) expect(holderOf(account, job, deps())?.grantId).toBe("g-main");
  });

  it("the oldest live /mcp connection stands in when the primary's grant is gone", () => {
    const second: JobConnection = { grantId: "g-second", assistant: "grok", connectedAt: "2026-11-22T12:00:00.000Z" };
    const account = { primaryGrantId: "g-main", connections: [second, main] };
    expect(mainConnection(account, deps({ isLive: (id) => id !== "g-main" }))?.grantId).toBe("g-second");
  });

  it("the newest of two bots for one job is the one that counts", () => {
    const newer: JobConnection = { ...fixerBot, grantId: "g-fix-2", connectedAt: "2026-11-22T13:00:00.000Z" };
    expect(coreBot({ connections: [main, newer, fixerBot] }, "fixer", deps())?.grantId).toBe("g-fix-2");
    expect(coreBot({ connections: [main, fixerBot] }, "fixer", deps({ botsOn: false }))).toBeUndefined();
  });

  it("a Supply Core bot checks once a day, so it is quiet only after 26 hours", () => {
    const supplyBot: JobConnection = { ...fixerBot, grantId: "g-sup", job: "supplies", lastSeenAt: "2026-11-22T12:00:00.000Z" };
    expect(isQuiet(supplyBot, new Date("2026-11-22T18:00:00.000Z"))).toBe(false);
    expect(isQuiet(supplyBot, new Date("2026-11-23T13:59:00.000Z"))).toBe(false);
    expect(isQuiet(supplyBot, new Date("2026-11-23T14:00:00.000Z"))).toBe(true);
    expect(quietAfterMs("supplies")).toBe(26 * 60 * 60_000);
    expect(quietAfterMs("cleaning")).toBe(QUIET_MS);
    expect(quietAfterMs("fixer")).toBe(QUIET_MS);
  });

  it("quiet is 150 minutes from the last call, or from connecting when it never called", () => {
    const seen = { ...fixerBot, lastSeenAt: "2026-11-22T12:00:00.000Z" };
    expect(isQuiet(seen, new Date("2026-11-22T14:29:00.000Z"))).toBe(false);
    expect(isQuiet(seen, new Date("2026-11-22T14:30:00.000Z"))).toBe(true);
    expect(isQuiet(fixerBot, new Date("2026-11-22T13:29:00.000Z"))).toBe(false);
    expect(isQuiet(fixerBot, new Date("2026-11-22T13:30:00.000Z"))).toBe(true);
  });

  it("maps the three addresses and nothing else", () => {
    expect(jobOfPath("/mcp/cleaner")).toBe("cleaning");
    expect(jobOfPath("/mcp/supply")).toBe("supplies");
    expect(jobOfPath("/mcp/fixer")).toBe("fixer");
    expect(jobOfPath("/mcp")).toBeUndefined();
    expect(jobOfPath("/mcp/cleaner-core")).toBeUndefined();
  });
});

describe("which jobs may call each tool", () => {
  const ALL = ["property", "cleaning", "supplies", "fixer"] as const;

  it("every listed tool belongs to at least one job", () => {
    const sets = [CLEANER_TOOL_NAMES, SUPPLY_FRONT_NAMES, FIXER_FRONT_NAMES, PACKAGE_FRONT_NAMES, LOCK_FRONT_NAMES, CAMERA_FRONT_NAMES, STAY_CHECK_FRONT_NAMES, OVERSIGHT_FRONT_NAMES, VISITS_FRONT_NAMES, GUEST_FRONT_NAMES, HOURS_FRONT_NAMES];
    for (const names of sets) for (const name of names) expect(jobsOf(name).length, name).toBeGreaterThan(0);
    for (const name of ["get_state", "add_property", "set_flows"]) expect(jobsOf(name).length, name).toBeGreaterThan(0);
    expect(jobsOf("no_such_tool")).toEqual([]);
  });

  it("the tools that move money, doors or flows have one owner", () => {
    expect(jobsOf("mark_guests_left")).toEqual(["cleaning"]);
    expect(jobsOf("save_door_code")).toEqual(["cleaning"]);
    expect(jobsOf("guests_left")).toEqual(["fixer"]);
    expect(jobsOf("approve_job")).toEqual(["fixer"]);
    expect(jobsOf("approve_code")).toEqual(["fixer"]);
    expect(jobsOf("approve_cart")).toEqual(["supplies"]);
    expect(jobsOf("approve_bring_in_code")).toEqual(["supplies"]);
    for (const name of ["set_flows", "add_property"]) expect(jobsOf(name)).toEqual(["property"]);
    for (const name of LOCK_FRONT_NAMES) expect(jobsOf(name), name).toEqual(["property"]);
  });

  it("the shared tools belong to the cores that answer them", () => {
    expect(jobsOf("get_state")).toEqual([...ALL]);
    expect(jobsOf("get_job_photos")).toEqual(["cleaning", "fixer"]);
    expect(jobsOf("preview_schedule")).toEqual(["supplies", "fixer"]);
    expect(jobsOf("choose_supplies")).toEqual(["cleaning"]);
  });

  it("a caller may call what its jobs own, and a core's bot can never answer the Supply Core question", () => {
    expect(mayCall("check_fixes", { job: "fixer", jobs: ["fixer"] })).toBe(true);
    expect(mayCall("check_now", { job: "fixer", jobs: ["fixer"] })).toBe(false);
    expect(mayCall("set_flows", { job: "fixer", jobs: ["fixer"] })).toBe(false);
    expect(mayCall("check_fixes", { jobs: ["property", "cleaning", "supplies"] })).toBe(false);
    expect(mayCall("choose_supplies", { jobs: [...ALL] })).toBe(true);
    expect(mayCall("choose_supplies", { job: "cleaning", jobs: ["cleaning"] })).toBe(false);
    expect(mayCall("no_such_tool", { job: "fixer", jobs: ["fixer"] })).toBe(true);
    expect(mayCall("get_state", { job: "fixer", jobs: [] })).toBe(false);
  });

  it("the lines name the bot to open", () => {
    expect(elsewhereLine("fixer", true)).toBe("Fixer Core has its own bot on this account. Ask the host to open the Fixer Core bot for that.");
    expect(elsewhereLine("cleaning", false)).toBe("That belongs to the Property Core bot. Ask the host to open the Property Core bot for that.");
    expect(elsewhereLine("property", false)).toBe("That belongs to the Property Core bot. Ask the host to open the Property Core bot for that.");
    expect(leftBehindLine("fixer")).toBe("Delete your Fixer Core routines here. That bot runs its own.");
    expect(jobInstructions("supplies")).toContain("This connection runs Supply Core for the host's properties, and nothing else.");
    expect(teamLine(["cleaning", "fixer"])).toBe("Cleaner Core and Fixer Core each have their own bot on this account. Send the host to that bot's chat for their work.");
    expect(teamLine(["fixer"])).toBe("Fixer Core has its own bot on this account. Send the host to that bot's chat for its work.");
    expect(teamLine(["cleaning", "supplies", "fixer"])).toBe("Cleaner Core, Supply Core and Fixer Core each have their own bot on this account. Send the host to that bot's chat for their work.");
  });
});
