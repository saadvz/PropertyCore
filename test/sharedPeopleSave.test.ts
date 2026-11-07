import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks } from "../src/cleaner-core/liveDesk";
import { sharedRefusal } from "../src/hosted/sharedRoute";
import { closeHostedApps } from "./cleanerOauthHarness";
import { CLEANER, COURT, INVITE, LANDLORD, LANE, LINE, sharedAccount, STRANGER, type SharedAccount } from "./sharedHarness";

/** Saving a person who is already on another property of the account (saadvz/TourCore#190). Only 555 numbers. */

const SLOW = { timeout: 180_000 };
let open: SharedAccount | undefined;
afterEach(() => {
  open?.m.close();
  open = undefined;
  closeHostedApps();
});

async function laneLive() {
  open = await sharedAccount();
  const lane = await open.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  const court = await open.add("Scratch Court");
  await open.startProperty(court, COURT);
  return { s: open, lane, court };
}

describe("save_people with someone already on another property", () => {
  it("is refused to the agent until the host's shared: true, and nobody is texted", SLOW, async () => {
    const { s, court } = await laneLive();
    const before = s.m.sms.sent.length;
    const refused = await s.call("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, groupChat: "cleaner-only" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(sharedRefusal([{ label: "Scratch Lane", role: "cleaner" }]));
    expect(s.m.sms.sent.length).toBe(before);
  });

  it("saves with shared: true, and the account list has them on both", SLOW, async () => {
    const { s, lane, court } = await laneLive();
    await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, groupChat: "cleaner-only", shared: true });
    const person = s.peopleFile()!.people.find((p) => p.phone === CLEANER)!;
    expect(person.where).toEqual([
      { propertyId: lane, role: "cleaner" },
      { propertyId: court, role: "cleaner" },
    ]);
    expect(s.peopleFile()!.hosts[court]).toBe(LANDLORD);
  });

  it("keeps each property's own role: the cleaner on Lane is an observer on Court", SLOW, async () => {
    const { s, court } = await laneLive();
    await s.tool("save_people", { property: court, host: LANDLORD, cleaner: COURT.cleanerPhone, observer: CLEANER, shared: true });
    const person = s.peopleFile()!.people.find((p) => p.phone === CLEANER)!;
    expect(person.where.find((w) => w.propertyId === court)?.role).toBe("observer");
  });

  it("names every other property the phone is on", SLOW, async () => {
    const { s, court } = await laneLive();
    await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, groupChat: "cleaner-only", shared: true });
    const annex = await s.add("Scratch Annex");
    await s.startProperty(annex, { ...LANE, property: { ...LANE.property, address: "9 Scratch Annex, Teaneck, NJ 07666" } });
    const refused = await s.call("save_people", { property: annex, host: LANDLORD, cleaner: CLEANER });
    expect(refused.text).toBe(sharedRefusal([{ label: "Scratch Lane", role: "cleaner" }, { label: "Scratch Court", role: "cleaner" }]));
  });

  it("still refuses the landlord's phone as a person, and a person's phone as the host, even with shared: true", SLOW, async () => {
    const { s, court } = await laneLive();
    const landlord = await s.call("save_people", { property: court, host: COURT.ownerPhone, cleaner: LANDLORD, shared: true });
    expect(landlord.isError).toBe(true);
    expect(landlord.text).toContain("Scratch Lane");
    const host = await s.call("save_people", { property: court, host: CLEANER, cleaner: COURT.cleanerPhone, shared: true });
    expect(host.isError).toBe(true);
    expect(host.text).toContain("Scratch Lane");
  });

  it("a person who already said YES on Lane gets no invite from Court, and Court goes straight on", SLOW, async () => {
    const { s, court } = await laneLive();
    await s.m.text(LINE, CLEANER, "YES", "SM-ana-yes");
    expect(s.peopleFile()!.people.find((p) => p.phone === CLEANER)?.optedIn).toBeDefined();
    const before = s.bodiesTo(CLEANER).length;
    await s.tool("save_people", { property: court, host: LANDLORD, cleaner: CLEANER, groupChat: "cleaner-only", shared: true });
    await s.finishProperty(court, COURT);
    const after = s.bodiesTo(CLEANER).slice(before);
    expect(after.some((body) => body.includes(INVITE))).toBe(false);
    expect(after.some((body) => body.includes("8 Scratch Court"))).toBe(true);
    for (const body of after) expect(body).not.toContain("12 Scratch Lane, Teaneck");
  });

  it("an account set up before people.json gets it on its next save, with the older STOPs kept", SLOW, async () => {
    const { s, lane } = await laneLive();
    rmSync(join(s.accountRoot(), "people.json"));
    writeFileSync(join(s.accountRoot(), "opt-outs.json"), JSON.stringify({ phones: [STRANGER] }));
    resetLiveDesks();
    await s.tool("save_people", { property: lane, host: LANDLORD, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    const file = s.peopleFile()!;
    expect(file.movedAt).toBeDefined();
    expect(file.people.find((p) => p.phone === STRANGER)?.stopped).toBeDefined();
    expect(file.people.find((p) => p.phone === CLEANER)?.where).toEqual([{ propertyId: lane, role: "cleaner" }]);
    expect(existsSync(join(s.accountRoot(), "opt-outs.json"))).toBe(true);
  });
});
