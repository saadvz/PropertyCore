import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { BOOKING_EMAILS_FILE, readBookingEmails } from "../src/hub/bookingEmails";
import { sampleEmail } from "./airbnbEmails";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { BUSINESS } from "./wiringProof";

/** An Airbnb email on an account with two properties goes to the one its listing names (#244). Made-up emails, 555 numbers. */

const SLOW = { timeout: 90_000 };
const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function twoProperties(courtName = "Harbor Cottage by the Water", laneName = "Lane House") {
  open = await multiTenantApp();
  const m = open;
  const account = m.registry.create({ label: "Lane", twilioNumber: "+15555550150" }).tenant;
  const token = await m.join(account.id, "grok");
  const lane = m.registry.addProperty(account.id, "12 Scratch Lane");
  m.registry.setFlow(account.id, lane.id, "cleaning", true);
  const court = m.registry.addProperty(account.id, "8 Scratch Court");
  m.registry.setFlow(account.id, court.id, "cleaning", true);
  for (const [property, address, nickname] of [
    [lane, "12 Scratch Lane, Teaneck, NJ 07666", laneName],
    [court, "8 Scratch Court, Teaneck, NJ 07666", courtName],
  ] as const) {
    await m.toolAt(PATH, token, "get_state", { property: property.id, choice: "cleaners", drafted: true });
    const saved = await m.toolAt(PATH, token, "save_property", { property: property.id, business: BUSINESS, address, timeZone: ZONE, nickname });
    expect(saved.isError).toBe(false);
  }
  const folder = (property: typeof lane) => propertyFolder(m.app.root, account.id, m.registry.get(account.id)!.properties.find((p) => p.id === property.id)!);
  return { m, token, lane, court, folder };
}

describe("an Airbnb email on an account with two properties", () => {
  it("goes to the property whose nickname is the email's listing, and only that one keeps it", SLOW, async () => {
    const { m, token, lane, court, folder } = await twoProperties();
    const reply = await m.toolAt(PATH, token, "read_booking_email", { email: sampleEmail("confirmed-stacked") });
    expect(reply.isError).toBe(false);
    expect(reply.structured?.outcome).toBe("pending");
    expect(readBookingEmails(folder(court)).map((item) => item.parsed?.confirmationCode)).toEqual(["HMXK4Q2Z9R"]);
    expect(existsSync(join(folder(lane), BOOKING_EMAILS_FILE))).toBe(false);
  });

  it("asks which property when no listing matches, and keeps nothing", SLOW, async () => {
    const { m, token, lane, court, folder } = await twoProperties("Court Flat");
    const reply = await m.toolAt(PATH, token, "read_booking_email", { email: sampleEmail("confirmed-stacked") });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe(
      `The Airbnb listing "Harbor Cottage by the Water" doesn't match a property yet. Which property is this Airbnb email for? Ask the host, then pass property as one of: ${lane.id} (12 Scratch Lane), ${court.id} (8 Scratch Court).`,
    );
    expect(existsSync(join(folder(lane), BOOKING_EMAILS_FILE))).toBe(false);
    expect(existsSync(join(folder(court), BOOKING_EMAILS_FILE))).toBe(false);
    // Naming the property goes to its desk, which asks the host whether the listing is its own.
    const named = await m.toolAt(PATH, token, "read_booking_email", { property: court.id, email: sampleEmail("confirmed-stacked") });
    expect(named.structured?.outcome).toBe("mismatch");
  });

  it("asks which property when the listing matches both", SLOW, async () => {
    const { m, token } = await twoProperties("Harbor Cottage by the Water", "Harbor Cottage by the Water");
    const reply = await m.toolAt(PATH, token, "read_booking_email", { email: sampleEmail("confirmed-stacked") });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("matches more than one property");
  });
});
