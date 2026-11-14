import { afterEach, describe, expect, it } from "vitest";
import { hoursDeskFor } from "../src/hours-log/desk";
import { readHours } from "../src/hours-log/store";
import { handleHoursTool, HOURS_TOOL_NAMES, HOURS_TOOLS } from "../src/hours-log/tools";
import { engine, fixer, octoberFolder, type Fixture } from "./hoursFixture";

/** #238: the host reviews and confirms each month in chat, then the agent writes it to their Sheet. */

let open: Fixture | undefined;
afterEach(() => {
  open?.cleanup();
  open = undefined;
});

const NOW = new Date("2026-11-03T15:00:00.000Z");

function desk() {
  open = octoberFolder();
  return hoursDeskFor(open.root, { now: () => NOW });
}

const call = async (d: ReturnType<typeof desk>, name: string, args: Record<string, unknown>) => (await handleHoursTool(d, name, args))!;

async function confirmOctober(d: ReturnType<typeof desk>) {
  const asked = await call(d, "review_hours", { month: "2026-10" });
  const code = (asked.structured?.confirmation as { code: string }).code;
  return call(d, "review_hours", { month: "2026-10", confirmation: code });
}

describe("review_hours", () => {
  it("shows the month by log, what needs the host, and the checkout check, with a code to confirm", async () => {
    const reply = await call(desk(), "review_hours", { month: "2026-10" });
    expect(reply.isError).toBe(false);
    const s = reply.structured!;
    expect((s.logs as { name: string }[]).map((l) => l.name)).toEqual(["Sam", "Ana", "Drip Plumbing", "Property Core"]);
    expect(s.needs).toContainEqual(expect.stringContaining("2026-10-25"));
    expect(s.reconcile).toMatchObject({ unmatched: ["2026-10-25"] });
    const confirmation = s.confirmation as { code: string; question: string };
    expect(confirmation.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(confirmation.question).toContain("October 2026");
    expect(readHours(open!.root).months).toEqual({});
  });

  it("confirms the month with the host's code, keeping only its fingerprint", async () => {
    const reply = await confirmOctober(desk());
    expect(reply.isError).toBe(false);
    const mark = readHours(open!.root).months["2026-10"];
    expect(mark).toMatchObject({ confirmedAt: NOW.toISOString(), rulesVersion: 1 });
    expect(mark?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(readHours(open!.root))).not.toContain("Turnover cleaning");
  });

  it("refuses a code from before the rows changed", async () => {
    const d = desk();
    const asked = await call(d, "review_hours", { month: "2026-10" });
    open!.write("cleaner-job/cleaner-core.json", { ...engine, jobs: engine.jobs.map((j) => (j.id === "job_oct4" ? { ...j, doneAt: "2026-10-04T18:00:00.000Z" } : j)) });
    const reply = await call(d, "review_hours", { month: "2026-10", confirmation: (asked.structured?.confirmation as { code: string }).code });
    expect(reply.isError).toBe(true);
    expect(readHours(open!.root).months).toEqual({});
  });

  it("refuses a month that isn't YYYY-MM, or hasn't ended yet", async () => {
    const d = desk();
    expect((await call(d, "review_hours", { month: "October" })).isError).toBe(true);
    const current = await call(d, "review_hours", { month: "2026-11" });
    expect(current.isError).toBe(false);
    expect(current.structured?.confirmation).toBeUndefined();
    expect(current.text).toContain("isn't over");
  });
});

describe("export_hours", () => {
  it("refuses a month the host hasn't confirmed", async () => {
    const reply = await call(desk(), "export_hours", { month: "2026-10" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("review_hours");
  });

  it("gives each log as Sheet rows in the host's columns after the confirm", async () => {
    const d = desk();
    await call(d, "save_hours_settings", { sheet: "Lane hours 2026", columns: [{ field: "date", header: "Day" }, { field: "hours", header: "Hrs" }] });
    await confirmOctober(d);
    const reply = await call(d, "export_hours", { month: "2026-10" });
    expect(reply.isError).toBe(false);
    const logs = reply.structured?.logs as { name: string; rows: string[][] }[];
    expect(logs.find((l) => l.name === "Ana")?.rows).toEqual([
      ["Day", "Hrs"],
      ["2026-10-04", "2.50"],
      ["2026-10-12", "2.00"],
    ]);
    expect(reply.structured?.sheet).toBe("Lane hours 2026");
    expect(reply.structured?.next).toContain("stored: true");
  });

  it("refuses when a row changed since the confirm, and asks for a new review", async () => {
    const d = desk();
    await confirmOctober(d);
    open!.write("cleaner-job/cleaner-core.json", { ...engine, jobs: engine.jobs.map((j) => (j.id === "job_oct4" ? { ...j, doneAt: "2026-10-04T18:00:00.000Z" } : j)) });
    const reply = await call(d, "export_hours", { month: "2026-10" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("changed");
  });

  it("records the export once the agent says it wrote the Sheet", async () => {
    const d = desk();
    await confirmOctober(d);
    await call(d, "export_hours", { month: "2026-10" });
    const stored = await call(d, "export_hours", { month: "2026-10", stored: true });
    expect(stored.isError).toBe(false);
    expect(readHours(open!.root).months["2026-10"]).toMatchObject({ exportedAt: NOW.toISOString() });
  });

  it("a month with no records confirms and exports empty logs", async () => {
    const d = desk();
    const asked = await call(d, "review_hours", { month: "2026-08" });
    await call(d, "review_hours", { month: "2026-08", confirmation: (asked.structured?.confirmation as { code: string }).code });
    const reply = await call(d, "export_hours", { month: "2026-08" });
    expect(reply.isError).toBe(false);
    expect(reply.structured?.logs).toEqual([]);
  });
});

describe("save_hours_settings", () => {
  it("saves codes with the host's minutes, and the next review uses them", async () => {
    const d = desk();
    const saved = await call(d, "save_hours_settings", { codes: [{ code: "REP-2", group: "Repairs and upkeep", activity: "Approve a repair", minutes: 10 }], ownerName: "Sam Rivera" });
    expect(saved.isError).toBe(false);
    const review = await call(d, "review_hours", { month: "2026-10" });
    const owner = (review.structured?.logs as { name: string; hours: number }[])[0];
    // Four REP-2 rows at 10 minutes, each 0.17 hours on the Sheet.
    expect(owner).toMatchObject({ name: "Sam Rivera", hours: 0.68 });
  });

  it("refuses bad settings and saves nothing", async () => {
    const d = desk();
    const reply = await call(d, "save_hours_settings", { kindCodes: { cleaning: "NOPE" } });
    expect(reply.isError).toBe(true);
    expect(readHours(open!.root).settings).toEqual({});
  });
});

describe("the tools", () => {
  it("are listed with a month argument, and an unknown name isn't answered", async () => {
    expect([...HOURS_TOOL_NAMES]).toEqual(["review_hours", "export_hours", "save_hours_settings"]);
    expect(HOURS_TOOLS.map((t) => t.name)).toEqual([...HOURS_TOOL_NAMES]);
    expect(await handleHoursTool(desk(), "get_state", {})).toBeUndefined();
  });

  it("never name the lock provider or tell the agent to give tax advice", () => {
    const text = JSON.stringify(HOURS_TOOLS);
    expect(text).not.toMatch(/[dD]urin(?!g)/);
    expect(text).toContain("tax advice");
  });
});

describe("review of #238", () => {
  it("a broken hours.json is a plain refusal, not a crash", async () => {
    const d = desk();
    open!.write("hours.json", null);
    for (const name of ["review_hours", "export_hours", "save_hours_settings"]) {
      const reply = await call(d, name, name === "save_hours_settings" ? { ownerName: "Sam" } : { month: "2026-10" });
      expect(reply.isError, name).toBe(true);
      expect(reply.text, name).toContain("hours.json");
    }
  });

  it("refuses the export after the host changed the columns since the confirm", async () => {
    const d = desk();
    await confirmOctober(d);
    await call(d, "save_hours_settings", { columns: [{ field: "date", header: "Day" }] });
    expect((await call(d, "export_hours", { month: "2026-10" })).isError).toBe(true);
  });

  it("an approval replaced after the confirm stays in the confirmed month", async () => {
    const d = desk();
    await confirmOctober(d);
    open!.write("fixer.json", { ...fixer, jobs: [{ ...fixer.jobs[0], booking: { ...fixer.jobs[0]!.booking, hostYes: undefined } }, fixer.jobs[1]] });
    const reply = await call(d, "export_hours", { month: "2026-10" });
    expect(reply.isError).toBe(false);
    const owner = (reply.structured?.logs as { name: string; rows: string[][] }[])[0]!;
    expect(owner.rows.some((row) => row.some((cell) => cell.startsWith("Approved Drip Plumbing's booking")))).toBe(true);
  });
});
