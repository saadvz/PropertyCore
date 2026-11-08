import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import type { PeopleFile } from "../src/hub/people";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { CALENDAR_URL, FROZEN } from "./wiringProof";

/**
 * One account on one line, with properties set up through the agent's tools, for shared people
 * (saadvz/PropertyCore#190). Only 555 numbers; the door codes are the made-up Scratch pins.
 */

export const [LANE, COURT] = SCRATCH_TENANTS as [(typeof SCRATCH_TENANTS)[number], (typeof SCRATCH_TENANTS)[number]];
export const LINE = "+15555550150";
export const LANDLORD = LANE.ownerPhone;
/** The cleaner shared by both properties. */
export const CLEANER = LANE.cleanerPhone;
export const STRANGER = "+15555550199";
export const ZONE = "America/New_York";
export const INVITE = "Reply YES to get cleaning texts";

export type Scratch = typeof LANE;

export async function sharedAccount(options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  const m: MultiTenantApp = await multiTenantApp({ now: options.now ?? (() => new Date(FROZEN)), ...(options.env ? { env: options.env } : {}) });
  const accountId = m.registry.create({ label: "Scratch Homes", twilioNumber: LINE }).tenant.id;
  const token = await m.joinAt(accountId, "grok", "/mcp");
  const call = (name: string, args: Record<string, unknown>) => m.toolAt("/mcp", token, name, args);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await call(name, args);
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply;
  };
  const property = (id: string) => m.registry.get(accountId)!.properties.find((p) => p.id === id)!;
  const add = async (label: string) => (((await tool("add_property", { label })).structured?.property as { id: string }).id);
  const root = (id: string) => propertyFolder(m.app.root, accountId, property(id));
  const accountRoot = () => tenantFolder(m.app.root, accountId);

  /** Cleaner Core on one property up to save_people. */
  async function startProperty(id: string, scratch: Scratch) {
    const p = { property: id };
    await tool("set_flows", { ...p, cleaning: true });
    await tool("get_state", { ...p, choice: "cleaners" });
    await tool("save_property", { ...p, business: "Scratch", address: scratch.property.address, timeZone: ZONE });
  }

  /** The rest of setup after save_people: calendar, door code, texting, checks, times. */
  async function finishProperty(id: string, scratch: Scratch) {
    const p = { property: id };
    await tool("save_calendar_link", { ...p, url: CALENDAR_URL });
    const link = await tool("save_door_code", p);
    const path = new URL(String(link.structured?.uploadUrl)).pathname;
    const upload = await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: scratch.pin }) });
    expect(upload.status).toBe(200);
    await tool("set_up_texting", p);
    await tool("run_checks", p);
    await tool("confirm_times", { ...p, checkout: "10:30", checkIn: "15:00" });
  }

  /** A whole property: added, set up with these people, and live. */
  async function liveProperty(label: string, scratch: Scratch, people: Record<string, unknown>) {
    const id = await add(label);
    await startProperty(id, scratch);
    await tool("save_people", { property: id, host: LANDLORD, ...people });
    await finishProperty(id, scratch);
    return id;
  }

  const peopleFile = (): PeopleFile | undefined => {
    const path = join(accountRoot(), "people.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PeopleFile) : undefined;
  };
  const bodiesTo = (phone: string) => m.sms.sent.filter((s) => s.to === phone).map((s) => s.body);
  const seen = (id: string) => (JSON.parse(readFileSync(join(root(id), "cleaner-live.json"), "utf8")) as { seenInbound?: string[] }).seenInbound ?? [];

  return { m, accountId, token, call, tool, add, property, root, accountRoot, startProperty, finishProperty, liveProperty, peopleFile, bodiesTo, seen };
}

export type SharedAccount = Awaited<ReturnType<typeof sharedAccount>>;
