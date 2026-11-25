import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findProperty, propertyFolder } from "../cleaner-core/hosted/properties";
import { TenantRegistry } from "../cleaner-core/hosted/registry";
import { loadLocalEnv } from "../web/env";
import { ENTRY_WHO, sandboxEntry, safeLine, type EntryWho, type SandboxKeypad } from "./sandboxEntry";
import { SeamError, seamFromEnv } from "./seam";

/**
 * npm run locks:sandbox-entry -- --property <id or label> --who <cleaner|pro|vendor|visitor|host|guest|package|shared>
 *   [--account <tnt_…>] [--pick <n or job id>] [--door <door name>] [--data <data folder>]
 *
 * Run on the service, where the data volume and SEAM_API_KEY are (#303). Types the person's code on the
 * property's sandbox lock through the lock partner, so the unlock comes back through the webhook like a
 * real one. Refuses a key that isn't a sandbox workspace's. Prints whose code it was, the door and the
 * time, never a code. Not an agent tool.
 */

const USAGE = `Usage: npm run locks:sandbox-entry -- --property <id or label> --who <${ENTRY_WHO.join("|")}> [--account <account id>] [--pick <n or job id>] [--door <door name>] [--data <data folder>]`;

function arg(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

function timeZoneOf(root: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, "hub.json"), "utf8")) as { property?: { timeZone?: unknown } };
    return typeof raw.property?.timeZone === "string" ? raw.property.timeZone : undefined;
  } catch {
    return undefined;
  }
}

export async function main(args: string[], env: NodeJS.ProcessEnv, keypad: SandboxKeypad | undefined, say: (line: string) => void, now: () => Date = () => new Date()): Promise<number> {
  const out = (line: string) => say(safeLine(line));
  const propertyRef = arg(args, "property");
  const who = arg(args, "who") as EntryWho | undefined;
  if (!propertyRef || !who || !ENTRY_WHO.includes(who)) {
    out(USAGE);
    return 2;
  }
  if (!keypad) {
    out("SEAM_API_KEY isn't set here. Run this on the service, where the sandbox workspace's key is.");
    return 1;
  }
  const dataRoot = resolve(arg(args, "data") ?? env.TOURCORE_HOME ?? "tourcore-data");
  if (!existsSync(join(dataRoot, "tenants.json"))) {
    out("No accounts in that data folder. Run this on the service, or pass --data with its data folder.");
    return 1;
  }
  const account = arg(args, "account");
  const registry = new TenantRegistry(dataRoot, now);
  const matches = registry
    .list()
    .filter((tenant) => !account || tenant.id === account)
    .flatMap((tenant) => {
      const property = findProperty(tenant, propertyRef);
      return property ? [{ tenant, property }] : [];
    });
  if (matches.length === 0) {
    out("No property matches that id or name.");
    return 2;
  }
  if (matches.length > 1) {
    out("More than one account has a property by that name. Run again with --account.");
    return 2;
  }
  const { tenant, property } = matches[0]!;
  const root = propertyFolder(dataRoot, tenant.id, property);
  const pick = arg(args, "pick");
  const door = arg(args, "door");
  const timeZone = timeZoneOf(root);
  try {
    const outcome = await sandboxEntry({ root, who, keypad, now, ...(pick ? { pick } : {}), ...(door ? { door } : {}), ...(timeZone ? { timeZone } : {}) });
    for (const line of outcome.lines) out(line);
    return outcome.exitCode;
  } catch (error) {
    // A SeamError holds only the status and the error type; anything else is named, never printed.
    out(error instanceof SeamError ? error.message : "Something went wrong before the code was entered. Nothing was printed from it.");
    return 1;
  }
}

if (process.argv[1] && /sandboxEntryCli\.[tj]s$/.test(process.argv[1])) {
  loadLocalEnv();
  void main(process.argv.slice(2), process.env, seamFromEnv(process.env), (line) => console.log(line)).then((code) => process.exit(code));
}
