import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPLY_TOOL_NAMES } from "../src/supply-core/tools";

/** Supply Core's Grok bootstrap, template, and routine: consistent with the tools, and with the rules the landlord set. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "supply-template");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

interface Manifest {
  name: string;
  profile: string;
  setupPrompt: string;
  readme: string;
  hostedSupplyCoreUrl: string;
  repository: { url: string; bootstrap: string };
  routines: { name: string; doc: string; trigger: string; allowedTools: string[]; credentialsTravelWithTemplate: boolean }[];
  neverIncluded: string[];
}

const manifest = (): Manifest => JSON.parse(read(join(TEMPLATE, "template.json"))) as Manifest;

const RULES = [
  "Call check_cart before Place Order, every time.",
  "Place an order only on go, or after the landlord's yes and approve_cart's code.",
  "A routine run never calls approve_cart with a code.",
  "Never type, paste, or pass a card number, expiry, or security code to Supply Core.",
  "On go, check out with the saved Vault card. If the store or Grok raises its own approval card, prepare the order with Buy now and ask the landlord to tap Pay.",
];

describe("Supply Core template", () => {
  it("parses, names files that exist, and lists only real Supply Core tools", () => {
    const m = manifest();
    expect(m.name).toBe("Supply Core");
    for (const file of [m.profile, m.setupPrompt, m.readme]) expect(existsSync(join(TEMPLATE, file)), file).toBe(true);
    expect(m.repository.bootstrap).toBe("SUPPLY_CORE_BOOTSTRAP.md");
    expect(m.hostedSupplyCoreUrl).toBe("https://tourcore-production-8b80.up.railway.app");
    expect(m.routines.map((r) => r.name)).toEqual(["Supply Core Check"]);
    for (const routine of m.routines) {
      expect(existsSync(join(TEMPLATE, routine.doc)), routine.doc).toBe(true);
      expect(routine.credentialsTravelWithTemplate).toBe(false);
      expect(read(join(TEMPLATE, routine.doc))).toContain(`# Routine: ${routine.name}`);
      for (const tool of routine.allowedTools) expect(SUPPLY_TOOL_NAMES.has(tool), tool).toBe(true);
      expect(routine.allowedTools).toEqual(["get_supply_state", "check_supplies", "check_cart", "approve_cart", "record_order", "record_problem", "mark_delivered"]);
    }
  });

  it("never ships card details, Vault contents, calendar links, or order numbers", () => {
    const never = manifest().neverIncluded.join("\n").toLowerCase();
    for (const word of ["card", "vault", "calendar link", "order number"]) expect(never).toContain(word);
  });

  it("the bootstrap and the routine carry the checkout rules word for word", () => {
    const bootstrap = read(join(ROOT, "SUPPLY_CORE_BOOTSTRAP.md"));
    const routine = read(join(TEMPLATE, "routines/supply-core-check.md"));
    for (const rule of RULES) {
      expect(bootstrap, rule).toContain(rule);
      expect(routine, rule).toContain(rule);
    }
    expect(bootstrap).toContain("Hands-off ordering: on.");
    expect(bootstrap).not.toContain("Until the hands-off probe passes");
  });

  it("the routine passes Google events whenever the property has Google Calendar saved, by either flow", () => {
    const routine = read(join(TEMPLATE, "routines/supply-core-check.md"));
    expect(routine).toContain("If Google Calendar is saved for the property, by Supply Core or by Cleaner Core");
    expect(routine).toContain("If its `next` asks for Google events, read them and call `check_supplies` again.");
  });

  it("the routine covers the fallback, unconfirmed, and late steps", () => {
    const routine = read(join(TEMPLATE, "routines/supply-core-check.md"));
    expect(routine).toContain("unconfirmed");
    expect(routine).toContain("late");
    expect(routine).toContain("Buy now");
    expect(routine).toContain("record_problem");
  });

  it("the cleaner routines pass the cleaner's supplies answer to report_low", () => {
    for (const doc of ["cleaner-core-check.md", "cleaner-core-alerts.md"]) {
      const text = read(join(ROOT, "cleaner-template/routines", doc));
      expect(text, doc).toContain("supply-report");
      expect(text, doc).toContain("report_low");
    }
    expect(read(join(ROOT, "CLEANER_CORE_BOOTSTRAP.md"))).toContain("SUPPLY_CORE_BOOTSTRAP.md");
  });

  it("the Supply Core safety gates doc lists all seven gates", () => {
    const gates = read(join(ROOT, "docs/supply-core-safety-gates.md"));
    for (const gate of ["No card details", "No order without go or the landlord", "Caps and price jumps", "Cleaner text", "DONE supplies question", "No real shopping in tests", "Tenants apart"]) expect(gates, gate).toContain(gate);
  });
});

