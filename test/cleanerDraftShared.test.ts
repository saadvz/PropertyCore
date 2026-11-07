import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import { CLEANER, COURT, LANDLORD, LANE, LINE, sharedAccount, type SharedAccount } from "./sharedHarness";

/**
 * A setup draft on an account with more than one property (saadvz/TourCore#166, after #190): it names
 * the people already on the account's other properties, so a draft that reuses one says so in its
 * summary and saves with shared: true only after the host's yes. Never a phone. Only 555 numbers.
 */

const SLOW = { timeout: 180_000 };

let open: SharedAccount | undefined;
afterEach(() => {
  open?.m.close();
  open = undefined;
  closeHostedApps();
});

interface KnownPerson {
  name?: string;
  on: { label: string; role: string }[];
  saidYes: boolean;
  stopped?: true;
}

const knownOf = (structured: Record<string, unknown> | undefined) => (structured?.draft as { knownPeople?: KnownPerson[] } | undefined)?.knownPeople;

describe("a setup draft on an account with two properties", () => {
  it("names the cleaner already on the other property and their YES, never a phone, and still needs the host's shared: true", SLOW, async () => {
    open = await sharedAccount();
    const s = open;
    await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    const court = await s.add("Scratch Court");
    await s.tool("set_flows", { property: court, cleaning: true });

    const before = await s.tool("get_state", { property: court, choice: "cleaners" });
    expect(knownOf(before.structured)).toEqual([{ name: "Ana", on: [{ label: "Scratch Lane", role: "cleaner" }], saidYes: false }]);
    expect(before.text.includes(CLEANER.slice(-4))).toBe(false);

    await s.m.text(LINE, CLEANER, "YES", "SM-draft-yes");
    const after = await s.tool("get_state", { property: court });
    expect(knownOf(after.structured)?.[0]?.saidYes).toBe(true);

    // Reusing Ana still needs the host's yes.
    await s.tool("save_property", { property: court, business: "Scratch", address: COURT.property.address, timeZone: "America/New_York" });
    const refused = await s.call("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/shared: true/);
    await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only", shared: true });
    // Once she is on this property too, the draft no longer lists her as someone from elsewhere.
    expect(knownOf((await s.tool("get_state", { property: court })).structured)).toBeUndefined();
  });

  it("never says a cleaner who texted STOP said YES", SLOW, async () => {
    open = await sharedAccount();
    const s = open;
    await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    const court = await s.add("Scratch Court");
    await s.tool("set_flows", { property: court, cleaning: true });
    await s.m.text(LINE, CLEANER, "YES", "SM-draft-yes");
    await s.m.text(LINE, CLEANER, "STOP", "SM-draft-stop");
    const state = await s.tool("get_state", { property: court, choice: "cleaners" });
    expect(knownOf(state.structured)).toEqual([{ name: "Ana", on: [{ label: "Scratch Lane", role: "cleaner" }], saidYes: false, stopped: true }]);
  });

  it("shows the draft as each property's next step, and drafted: true names its property", SLOW, async () => {
    open = await sharedAccount();
    const s = open;
    const lane = await s.add("Scratch Lane");
    const court = await s.add("Scratch Court");
    await s.tool("set_flows", { property: lane, cleaning: true });
    await s.tool("set_flows", { property: court, cleaning: true });
    await s.tool("get_state", { property: lane, choice: "cleaners" });
    const overview = await s.tool("get_state", {});
    expect((overview.structured?.properties as { id: string; next?: string }[]).find((p) => p.id === lane)?.next).toBe("draft");
    const unnamed = await s.call("get_state", { drafted: true });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.text).toContain("Name the property");
    const named = await s.tool("get_state", { property: lane, drafted: true });
    expect(named.structured?.draft).toBeUndefined();
    expect((named.structured?.ask as { step?: string } | undefined)?.step).toBe("property");
  });

  it("lists nobody on an account's first property", SLOW, async () => {
    open = await sharedAccount();
    const s = open;
    const lane = await s.add("Scratch Lane");
    await s.tool("set_flows", { property: lane, cleaning: true });
    const state = await s.tool("get_state", { property: lane, choice: "cleaners" });
    expect(state.structured?.draft).toBeDefined();
    expect(knownOf(state.structured)).toBeUndefined();
  });
});
