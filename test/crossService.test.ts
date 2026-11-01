import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStartText, isStopText, TenantOptOuts } from "../src/hosted/crossService";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** STOP covers both services on a number, and the inactive service's people get no reply. Only 555 numbers. */

const LANE = "+15555550150";
const HOST = "+15555550151";
const CLEANER = "+15555550152";
const VISITOR = "+15555550177";
const SLOW = { timeout: 120_000 };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

describe("STOP and START words", () => {
  it("reads STOP and plain-language stops, but never a bare cancel", () => {
    expect(isStopText("STOP")).toBe(true);
    expect(isStopText(" unsubscribe ")).toBe(true);
    expect(isStopText("please stop texting me")).toBe(true);
    expect(isStopText("cancel")).toBe(false);
    expect(isStopText("don't stop")).toBe(false);
    expect(isStartText("START")).toBe(true);
    expect(isStartText("yes")).toBe(true);
    expect(isStartText("yes please book me")).toBe(false);
  });

  it("keeps each tenant's opt-outs apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "optouts-"));
    try {
      const book = new TenantOptOuts(dir);
      book.stop("tnt_lane000001", "(555) 555-0177");
      expect(book.stopped("tnt_lane000001", VISITOR)).toBe(true);
      expect(book.stopped("tnt_mill000001", VISITOR)).toBe(false);
      book.start("tnt_lane000001", VISITOR);
      expect(book.stopped("tnt_lane000001", VISITOR)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A cleaning tenant with a host and a cleaner saved, joined on /mcp. */
async function cleaningWithPeople(m: MultiTenantApp) {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service: "cleaning" });
  await m.toolAt("/mcp", token, "get_state", { choice: "cleaners" });
  await m.toolAt("/mcp", token, "save_property", { business: "Lane Stays", address: "1 Scratch Lane, Springfield, IL 62701", timeZone: "America/Chicago" });
  const people = await m.toolAt("/mcp", token, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", groupChat: "cleaner-only" });
  expect(people.isError, people.text).toBe(false);
  return { tenant, token };
}

async function switchTo(m: MultiTenantApp, token: string, to: "touring" | "cleaning") {
  const asked = await m.toolAt("/mcp", token, "switch_service", { to });
  const code = (asked.structured?.confirmation as { code: string } | undefined)?.code;
  expect(code, asked.text).toBeDefined();
  const done = await m.toolAt("/mcp", token, "switch_service", { to, confirmation: code });
  expect(done.isError, done.text).toBe(false);
}

describe("across a switch", () => {
  it("keeps a phone that texted STOP to cleaning opted out after the switch to touring, until START", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant, token } = await cleaningWithPeople(m);
    expect((await m.text(LANE, VISITOR, "STOP", "SMx1")).status).toBe(200);
    await switchTo(m, token, "touring");
    await m.text(LANE, VISITOR, "Tour", "SMx2");
    expect(m.app.logs.join("\n")).toContain(`A text reached ${tenant.id} from a phone that opted out. Nothing was sent.`);
    const before = m.app.logs.length;
    await m.text(LANE, VISITOR, "START", "SMx3");
    await m.text(LANE, VISITOR, "Tour", "SMx4");
    expect(m.app.logs.slice(before).join("\n")).not.toContain("opted out");
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
  });

  it("doesn't answer a cleaner's DONE as a tour request after the switch, and tells the host once", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant, token } = await cleaningWithPeople(m);
    await switchTo(m, token, "touring");
    await m.text(LANE, CLEANER, "DONE", "SMc1");
    await m.text(LANE, CLEANER, "DONE again", "SMc2");
    const logs = m.app.logs.join("\n");
    expect(logs).toContain(`A text reached ${tenant.id} from someone in its cleaning setup. Nothing was sent.`);
    const state = await m.toolAt("/mcp", token, "get_state");
    const notices = (state.structured?.serviceNotices ?? []) as string[];
    expect(notices).toEqual(["Someone from your cleaning setup texted this number, which is set up for touring now. They didn't get a reply."]);
    expect(m.sms.sent).toEqual([]);
  });

  it("rejects a forged STOP: the signature is checked before any opt-out is kept", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = await cleaningWithPeople(m);
    const forged = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMf", From: VISITOR, To: LANE, Body: "STOP" }, "/elsewhere");
    expect(forged.status).toBe(403);
    expect(new TenantOptOuts(m.app.root).stopped(tenant.id, VISITOR)).toBe(false);
  });

  it("always gives HELP and an injury text to the service, even from a phone that texted STOP, with touring off", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: {} }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "cleaning" });
    await m.text(LANE, CLEANER, "STOP", "SMh0");
    const before = m.app.logs.length;
    await m.text(LANE, CLEANER, "HELP", "SMh1");
    await m.text(LANE, CLEANER, "I fell and I'm bleeding, call 911", "SMh2");
    expect(m.app.logs.slice(before).join("\n")).not.toContain("opted out");
  });

  it("routes an injury text from the inactive service's people too", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await cleaningWithPeople(m);
    await switchTo(m, token, "touring");
    const before = m.app.logs.length;
    await m.text(LANE, CLEANER, "I fell and I'm bleeding, call 911", "SMh3");
    expect(m.app.logs.slice(before).join("\n")).not.toContain("Nothing was sent.");
  });

  it("doesn't hand over a waiting text from a phone that opted out while it waited", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    const touring = m.touring()!;
    touring.supervisor.stop(tenant.id);
    await m.text(LANE, VISITOR, "TOUR", "SMwait1");
    expect(touring.inbox.pending(tenant.id)).toHaveLength(1);
    new TenantOptOuts(m.app.root).stop(tenant.id, VISITOR);
    await touring.start(m.registry.get(tenant.id)!);
    expect(touring.inbox.pending(tenant.id)).toEqual([]);
    // The touring process logs each text it takes by its MessageSid. This one never reached it.
    expect(m.app.logs.join("\n")).not.toContain("SMwait1");
  });
});
