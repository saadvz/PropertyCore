import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { GUEST_MESSAGES_FILE, readGuestFacts, readGuestMessages } from "../src/guest-messages/store";
import { sampleMessage } from "./airbnbEmails";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub, supply } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #242 on the shared service: guest messages, behind GUEST_MESSAGES=1, for the property a call names or matches. */

const LANE = "+15555550152";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-10-14T15:00:00.000Z");
const TOOLS = ["get_guest_facts", "save_guest_facts", "read_guest_message", "save_guest_reply"];
const LISTING = "Harbor Cottage by the Water";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function account(env: NodeJS.ProcessEnv, listings: string[][] = [[]]) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...env }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const properties = listings.map((titles, index) => {
    const property = m.registry.addProperty(tenant.id, `${12 + index} Scratch Lane`);
    m.registry.setFlow(tenant.id, property.id, "supplies", true);
    const root = propertyFolder(m.app.root, tenant.id, property);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "hub.json"), JSON.stringify({ ...hub, property: { ...hub.property, nickname: `Scratch ${index}` }, ...(titles.length ? { airbnbListings: titles } : {}) }));
    writeFileSync(join(root, "supply.json"), JSON.stringify(supply));
    return { property, root };
  });
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, token, properties };
}

describe("guest messages on the shared service", () => {
  it("isn't listed or answered without GUEST_MESSAGES", SLOW, async () => {
    const { m, token, properties } = await account({});
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, token, "get_guest_facts", { property: properties[0]!.property.id })).isError).toBe(true);
  });

  it("is listed with GUEST_MESSAGES=1 and saves a fact and reads a message for the property named", SLOW, async () => {
    const { m, token, properties } = await account({ GUEST_MESSAGES: "1" });
    const [{ property, root }] = properties as [(typeof properties)[number]];
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());
    expect((await m.toolAt(PATH, token, "save_guest_facts", { property: property.id, topic: "parking", text: "Driveway, left side." })).isError).toBe(false);
    const read = await m.toolAt(PATH, token, "read_guest_message", { property: property.id, email: sampleMessage("message") });
    expect(read.isError).toBe(false);
    expect(read.structured).toMatchObject({ guest: "Jamie", facts: [{ topic: "parking", text: "Driveway, left side." }] });
    expect(readGuestFacts(root).facts).toHaveLength(1);
    expect(readGuestMessages(root).map((record) => record.event)).toEqual(["taken"]);
  });

  it("routes a message to the one property whose listing matches", SLOW, async () => {
    const { m, token, properties } = await account({ GUEST_MESSAGES: "true" }, [["Lakeside Loft"], [LISTING]]);
    const read = await m.toolAt(PATH, token, "read_guest_message", { email: sampleMessage("message") });
    expect(read.isError).toBe(false);
    expect(existsSync(join(properties[0]!.root, GUEST_MESSAGES_FILE))).toBe(false);
    expect(readGuestMessages(properties[1]!.root)).toHaveLength(1);
  });

  it("names the routed property, so the reply can go to it", SLOW, async () => {
    const { m, token, properties } = await account({ GUEST_MESSAGES: "1" }, [["Lakeside Loft"], [LISTING]]);
    const read = await m.toolAt(PATH, token, "read_guest_message", { email: sampleMessage("message") });
    const target = properties[1]!.property;
    expect(read.structured).toMatchObject({ property: { id: target.id, label: target.label } });
    expect(String(read.structured?.next)).toContain(target.id);
    const reply = await m.toolAt(PATH, token, "save_guest_reply", { property: (read.structured!.property as { id: string }).id, messageId: read.structured!.messageId, text: "Park in the driveway, left side." });
    expect(reply.isError).toBe(false);
    expect(reply.structured?.confirmation).toBeDefined();
  });

  it("asks which property when none match, and when both match, storing nothing", SLOW, async () => {
    for (const listings of [[["Lakeside Loft"], ["Pine Cabin"]], [[LISTING], [LISTING]]]) {
      const { m, token, properties } = await account({ GUEST_MESSAGES: "1" }, listings);
      const asked = await m.toolAt(PATH, token, "read_guest_message", { email: sampleMessage("message") });
      expect(asked.isError).toBe(true);
      expect(asked.text).toContain("Which property");
      for (const { root } of properties) expect(existsSync(join(root, GUEST_MESSAGES_FILE))).toBe(false);
      open?.close();
      open = undefined;
      closeHostedApps();
    }
  });

  it("initialize carries the guest line only with the flag on", SLOW, async () => {
    const off = await account({});
    const before = await off.m.rpcAt(PATH, off.token, "initialize", { protocolVersion: "2025-06-18" });
    expect(JSON.stringify(before)).not.toContain("read_guest_message");
    open?.close();
    closeHostedApps();
    const on = await account({ GUEST_MESSAGES: "1" });
    const after = await on.m.rpcAt(PATH, on.token, "initialize", { protocolVersion: "2025-06-18" });
    expect(JSON.stringify(after)).toContain("read_guest_message");
  });
});
