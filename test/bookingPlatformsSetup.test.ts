import { afterEach, describe, expect, it } from "vitest";
import type { LiveDesk } from "../src/cleaner-core/liveDesk";
import { cleanerInstructions, handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { platformsQuestion, sourcesAsk } from "../src/cleaner-core/setupAsk";
import { deskFeatures } from "./featureEnv";
import { PIN_KEY, cleanupDesks, liveOneToOne, ok, refused } from "./cleanerDeskHarness";

/** Setting up the host's booking platforms (#263): the question, save_sources, and what the agent is told. Made-up addresses only. */

afterEach(() => cleanupDesks());

async function desk(on: boolean) {
  const opened = await liveOneToOne();
  if (on) Object.assign(opened.env, deskFeatures("booking-platforms"));
  return opened;
}

async function rpc(live: LiveDesk, method: string, params?: Record<string, unknown>, assistant: "claude" | "grok" = "claude") {
  const reply = await handleCleanerMcpMessage(live, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, PIN_KEY, false, undefined, undefined, assistant);
  return (reply.body as { result: Record<string, unknown> }).result;
}

type Listed = { name: string; description: string; inputSchema: { properties: Record<string, { properties?: Record<string, unknown> }> } };
const toolNamed = async (live: LiveDesk, name: string) => ((await rpc(live, "tools/list")).tools as Listed[]).find((tool) => tool.name === name)!;

describe("with the account's booking platforms off", () => {
  it("lists the tools, says the instructions and answers get_state exactly as before", async () => {
    const { desk: live } = await desk(false);
    const email = await toolNamed(live, "read_booking_email");
    expect(email.inputSchema.properties).not.toHaveProperty("extracted");
    expect(email.inputSchema.properties.email!.properties).not.toHaveProperty("authentication");
    expect(email.description).not.toContain("extracted");
    expect((await toolNamed(live, "save_sources")).inputSchema.properties).not.toHaveProperty("bookingEmails");
    expect((await rpc(live, "initialize")).instructions).toBe(cleanerInstructions("claude"));
    expect(ok(await live.getState())).not.toHaveProperty("bookingEmails");
    expect(ok(await live.checkNow())).not.toHaveProperty("bookingEmails");
  });
});

describe("with the account's booking platforms on", () => {
  it("tells the agent to look only for the saved platforms, and to ask once when none are saved", async () => {
    const { desk: live } = await desk(true);
    const before = String(ok(await live.getState()).bookingEmails);
    expect(before).toContain("Airbnb");
    expect(before).toContain("ask once");
    ok(await live.saveSources({ bookingEmails: [{ platform: "airbnb" }, { platform: "direct", sender: "bookings@example.test" }] }, PIN_KEY));
    const after = String(ok(await live.getState()).bookingEmails);
    expect(after).toContain("bookings@example.test (your booking site)");
    expect(after).not.toContain("ask once");
    expect(String(ok(await live.checkNow()).bookingEmails)).toContain("bookings@example.test");
  });

  it("saves the platforms without touching the calendars, and refuses a bad sender", async () => {
    const { desk: live } = await desk(true);
    const turnsBefore = ok(await live.getTurns()).turns;
    ok(await live.saveSources({ bookingEmails: [{ platform: "vrbo" }], shareSamples: true }, PIN_KEY));
    expect(ok(await live.getTurns()).turns).toEqual(turnsBefore);
    expect(String(ok(await live.getState()).bookingEmails)).toContain("sender@messages.homeaway.com (Vrbo)");
    expect(refused(await live.saveSources({ bookingEmails: [{ platform: "direct", sender: "not an address" }] }, PIN_KEY)).error).toContain("isn't an email address");
  });

  it("saves nothing when the calendar part of the same call is refused", async () => {
    const { desk: live } = await desk(true);
    expect(refused(await live.saveSources({ bookingEmails: [{ platform: "vrbo" }], calendars: [] }, PIN_KEY)).error).toBeTruthy();
    expect(String(ok(await live.getState()).bookingEmails)).not.toContain("sender@messages.homeaway.com");
  });

  it("passes an all-digit approval code through the tool call", async () => {
    const { desk: live } = await desk(true);
    const call = await rpc(live, "tools/call", { name: "read_booking_email", arguments: { email: { from: "x@example.test", subject: "s", body: "b" }, confirmation: "482937" } });
    expect(String((call.content as { text: string }[])[0]!.text)).not.toContain("door code");
  });

  it("refuses the platforms with the flag off", async () => {
    const { desk: live } = await desk(false);
    expect(refused(await live.saveSources({ bookingEmails: [{ platform: "vrbo" }] }, PIN_KEY)).error).toBeTruthy();
  });

  it("lists read_booking_email with extracted and the sender check, and save_sources with the platforms", async () => {
    const { desk: live } = await desk(true);
    const email = await toolNamed(live, "read_booking_email");
    expect(email.inputSchema.properties).toHaveProperty("extracted");
    expect(email.inputSchema.properties.email!.properties).toHaveProperty("authentication");
    expect(email.description).toContain("extracted");
    expect((await toolNamed(live, "save_sources")).inputSchema.properties).toHaveProperty("bookingEmails");
  });

  it("passes extracted through the tool call to the desk", async () => {
    const { desk: live } = await desk(true);
    ok(await live.saveSources({ bookingEmails: [{ platform: "direct", sender: "bookings@example.test" }] }, PIN_KEY));
    const call = await rpc(live, "tools/call", {
      name: "read_booking_email",
      arguments: {
        email: { from: "bookings@example.test", subject: "New booking DB-4417", body: "Booking DB-4417, Oct 18 to Oct 22.", messageId: "<db@example.test>", receivedAt: "2026-10-14T15:00:00.000Z" },
        extracted: { kind: "confirmed", reference: "DB-4417", checkIn: { date: "2026-10-18" }, checkout: { date: "2026-10-22" } },
      },
    });
    const text = String((call.content as { text: string }[])[0]!.text);
    expect(text).toContain("awaiting-host");
  });

  it("adds one sentence to Claude's instructions, and leaves Grok's pinned ones alone", async () => {
    const { desk: live } = await desk(true);
    const claude = String((await rpc(live, "initialize")).instructions);
    expect(claude.startsWith(cleanerInstructions("claude"))).toBe(true);
    expect(claude).toContain("bookingEmails");
    expect((await rpc(live, "initialize", undefined, "grok")).instructions).toBe(cleanerInstructions("grok"));
  });
});

describe("the setup question", () => {
  it("asks which platforms, with Other last, and the sender for those that need one", () => {
    const question = platformsQuestion();
    expect(question.field).toBe("bookingEmails");
    expect(question.multiple).toBe(true);
    expect(question.options!.map((option) => option.value)).toEqual(["airbnb", "vrbo", "booking", "direct", "other"]);
    expect(question.how).toContain("sender");
    expect(sourcesAsk("Scratch Lane", true).questions.map((item) => item.field)).toContain("bookingEmails");
    expect(sourcesAsk("Scratch Lane").questions.map((item) => item.field)).not.toContain("bookingEmails");
  });
});
