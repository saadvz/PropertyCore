import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { isStartText, isStopText, TenantOptOuts } from "../src/hosted/crossService";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** STOP and the earlier cleaning setup's people on a parked touring account, and STOP on a shared line. Only 555 numbers. */

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

/**
 * A parked touring account that ran cleaning before the move to properties: its old cleaning setup,
 * with a host and a cleaner, is still in the account folder. Joined on /mcp.
 */
async function touringAfterCleaning(m: MultiTenantApp) {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  mkdirSync(tenantFolder(m.app.root, tenant.id), { recursive: true });
  writeFileSync(join(tenantFolder(m.app.root, tenant.id), "cleaner-live.json"), JSON.stringify({ address: "1 Scratch Lane, Springfield, IL 62701", host: HOST, cleaner: CLEANER, cleanerName: "Mike" }));
  await m.makeTouring(tenant.id);
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  return { tenant, token };
}

describe("on a touring account", () => {
  it("keeps a phone that texted STOP opted out until START", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = await touringAfterCleaning(m);
    expect((await m.text(LANE, VISITOR, "STOP", "SMx1")).status).toBe(200);
    await m.text(LANE, VISITOR, "Tour", "SMx2");
    expect(m.app.logs.join("\n")).toContain(`A text reached ${tenant.id} from a phone that opted out. Nothing was sent.`);
    const before = m.app.logs.length;
    await m.text(LANE, VISITOR, "START", "SMx3");
    await m.text(LANE, VISITOR, "Tour", "SMx4");
    expect(m.app.logs.slice(before).join("\n")).not.toContain("opted out");
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
  });

  it("doesn't answer a cleaner from its old cleaning setup as a tour request, and tells the host once", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant, token } = await touringAfterCleaning(m);
    await m.text(LANE, CLEANER, "DONE", "SMc1");
    await m.text(LANE, CLEANER, "DONE again", "SMc2");
    const logs = m.app.logs.join("\n");
    expect(logs).toContain(`A text reached ${tenant.id} from someone in its cleaning setup. Nothing was sent.`);
    const state = await m.toolAt("/mcp", token, "get_state");
    const notices = (state.structured?.serviceNotices ?? []) as string[];
    expect(notices).toEqual(["Someone from your cleaning setup texted this number, which is set up for touring now. They didn't get a reply."]);
    expect(m.sms.sent).toEqual([]);
  });

  it("keeps the host's notes when touring's get_state answers with an error, and shows them on the next good one (#215)", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringAfterCleaning(m);
    await m.text(LANE, CLEANER, "DONE", "SMn1");
    const refused = await m.toolAt("/mcp", token, "get_state", { notAnArgument: true });
    expect(refused.isError).toBe(true);
    expect(refused.structured?.serviceNotices).toBeUndefined();
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.structured?.serviceNotices).toEqual(["Someone from your cleaning setup texted this number, which is set up for touring now. They didn't get a reply."]);
    // Shown once: the reply that carried them cleared them.
    expect((await m.toolAt("/mcp", token, "get_state")).structured?.serviceNotices).toBeUndefined();
  });

  it("rejects a forged STOP: the signature is checked before any opt-out is kept", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = await touringAfterCleaning(m);
    const forged = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMf", From: VISITOR, To: LANE, Body: "STOP" }, "/elsewhere");
    expect(forged.status).toBe(403);
    expect(new TenantOptOuts(m.app.root).stopped(tenant.id, VISITOR)).toBe(false);
  });

  it("routes an injury text from the old cleaning setup's people too", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    await touringAfterCleaning(m);
    const before = m.app.logs.length;
    await m.text(LANE, CLEANER, "I fell and I'm bleeding, call 911", "SMh3");
    expect(m.app.logs.slice(before).join("\n")).not.toContain("Nothing was sent.");
  });
});

describe("on an account of properties", () => {
  it("always gives HELP and an injury text to the property, even from a phone that texted STOP", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: {} }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const property = m.registry.addProperty(tenant.id, "1 Scratch Lane");
    m.registry.setFlow(tenant.id, property.id, "cleaning", true);
    await m.text(LANE, CLEANER, "STOP", "SMh0");
    const before = m.app.logs.length;
    await m.text(LANE, CLEANER, "HELP", "SMh1");
    await m.text(LANE, CLEANER, "I fell and I'm bleeding, call 911", "SMh2");
    expect(m.app.logs.slice(before).join("\n")).not.toContain("opted out");
  });

  it("rejects a forged STOP: the signature is checked before any opt-out is kept", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: {} }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    for (const label of ["1 Scratch Lane", "2 Scratch Lane"]) m.registry.setFlow(tenant.id, m.registry.addProperty(tenant.id, label).id, "cleaning", true);
    const forged = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMf", From: VISITOR, To: LANE, Body: "STOP" }, "/elsewhere");
    expect(forged.status).toBe(403);
    expect(new TenantOptOuts(m.app.root).stopped(tenant.id, VISITOR)).toBe(false);
  });
});

describe("waiting texts", () => {
  it("doesn't hand over a waiting text from a phone that opted out while it waited", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
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
