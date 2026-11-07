import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { HOSTED_ADMIN_TOOLS } from "../src/install/hostedAdminTools";
import { mcpToolList } from "../src/mcp/mcpBridge";
import { mcpInstructions } from "../src/playbooks/instructions";
import { setup, bookTour, minutesFrom } from "./helpers";
import { installHarness } from "./installHarness";

/**
 * #176: until the lock integration is announced, nothing a tester's agent reads
 * names the lock provider. Agents say "door access". Stored identifiers
 * (`durin-mock`, `DURIN_DEMO`, `DENY_DURIN_UNHEALTHY`) are renamed later, in #179,
 * and class and file names inside src/ stay as they are.
 */
// Skips "during" (lowercase g, so camelCase like sentDuringPayments too). Record keys such as
// durinGrantRef are stored identifiers, listed below, for #179 to rename.
const NAME = /[dD][uU][rR][iI][nN](?!g)/;
const STORED_IDENTIFIERS = /durin-mock|DURIN_DEMO|DENY_DURIN_UNHEALTHY|durinGrantRef/g;

function mentions(text: string, label: string): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => NAME.test(line.replace(STORED_IDENTIFIERS, "")))
    .map(({ line, i }) => `${label}:${i + 1}: ${line.trim().slice(0, 160)}`);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(md|json|html|txt|ya?ml|js|mjs)$/.test(name) ? [path] : [];
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

describe("tester-facing docs never name the lock provider", () => {
  it("root docs, package.json, agent templates, docs/ and config/ say door access instead", () => {
    const rootDocs = readdirSync(".").filter((name) => name.endsWith(".md"));
    const templates = readdirSync(".").filter((name) => name.endsWith("-template") && statSync(name).isDirectory());
    const files = [...rootDocs, "package.json", ...templates.flatMap(filesUnder), ...filesUnder(".grok"), ...filesUnder("docs"), ...filesUnder("config")];
    expect(files).toContain("README.md");
    expect(files.some((file) => file.startsWith(".grok/skills/"))).toBe(true);
    expect(files).toContain("grok-template/bot-profile.md");
    expect(files.flatMap((file) => mentions(readFileSync(file, "utf8"), file))).toEqual([]);
  });
});

describe("text the server sends to agents never names the lock provider", () => {
  it("MCP tool descriptions, input schemas and startup instructions", () => {
    const admin = HOSTED_ADMIN_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, input: z.toJSONSchema(t.input) }));
    const text = [JSON.stringify(mcpToolList(), null, 1), JSON.stringify(admin, null, 1), mcpInstructions(), mcpInstructions("ops"), mcpInstructions("qa")].join("\n");
    expect(mentions(text, "mcp")).toEqual([]);
  });

  it("access denials, grants, extensions and their audit records", async () => {
    const unhealthy = setup();
    const t1 = await bookTour(unhealthy);
    unhealthy.clock.set(t1.slotStart);
    unhealthy.durin.setHealthy(false, "controller offline");
    const denied = await t1.request("entrance");
    expect(denied.decision.code).toBe("DENY_DURIN_UNHEALTHY");

    const failing = setup();
    const t2 = await bookTour(failing);
    failing.clock.set(t2.slotStart);
    failing.durin.failNextRequest("door controller timeout");
    const failed = await t2.request("entrance");
    expect(failed.decision.code).toBe("DENY_PROVIDER_FAILURE");

    const ok = setup();
    const t3 = await bookTour(ok);
    ok.clock.set(minutesFrom(t3.slotStart, 1));
    const granted = await t3.request("entrance");
    const reused = await t3.request("entrance");
    expect(reused.reusedGrant).toBe(true);
    await ok.core.extendTourWindow(t3.reservation.id);

    const text = JSON.stringify(
      {
        decisions: [denied, failed, granted, reused].map((o) => o.decision),
        records: [await unhealthy.core.exportRecords(), await failing.core.exportRecords(), await ok.core.exportRecords()],
      },
      null,
      1,
    );
    expect(text).toMatch(/door access/i);
    expect(mentions(text, "records")).toEqual([]);
  });

  it("install status, including the technical provider field Grok reads", async () => {
    const install = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    cleanups.push(install.cleanup);
    const status = await install.status();
    expect(status.components.find((c) => c.component === "ACCESS")).toMatchObject({ technical: { provider: "DEMO" } });
    expect(mentions(JSON.stringify(status, null, 1), "status")).toEqual([]);
  });

  it("demo door-access log lines", async () => {
    const lines: string[] = [];
    const access = new MockDurinAccessAdapter({ doorNames: { entrance: "Entrance" }, log: (l) => lines.push(l), now: () => new Date("2026-09-28T14:00:00Z") });
    const grant = await access.requestAccess({
      reservationId: "r1",
      prospectId: "p1",
      doorId: "entrance",
      validFrom: "2026-09-28T14:00:00Z",
      validUntil: "2026-09-28T14:45:00Z",
      idempotencyKey: "k1",
    });
    expect(grant.ok).toBe(true);
    if (grant.ok) await access.revokeAccess({ reservationId: "r1", doorId: "entrance", grantRef: grant.grantRef });
    expect(lines).toHaveLength(2);
    expect(mentions(lines.join("\n") + "\n" + JSON.stringify(grant), "log")).toEqual([]);
  });

  it("npm run demo output", () => {
    const run = spawnSync("node_modules/.bin/tsx", ["src/demo/run.ts", "--auto"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/door access/i);
    expect(mentions(run.stdout + run.stderr, "demo")).toEqual([]);
  });
});
