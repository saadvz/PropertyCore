import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bookingPlatformsOn } from "../src/cleaner-core/flag";
import { bookingEmailsLine, normalizeSources, PRESET_SENDERS, senderAddress, sourceFor, type BookingSource } from "../src/hub/bookingSources";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Where a property takes bookings (#263). Made-up addresses only. */

const noCode = () => false;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the BOOKING_PLATFORMS flag", () => {
  it("is off unless exactly 1 or true", () => {
    expect(bookingPlatformsOn({})).toBe(false);
    expect(bookingPlatformsOn({ BOOKING_PLATFORMS: "yes" })).toBe(false);
    expect(bookingPlatformsOn({ BOOKING_PLATFORMS: "1" })).toBe(true);
    expect(bookingPlatformsOn({ BOOKING_PLATFORMS: " TRUE " })).toBe(true);
  });
});

describe("normalizeSources", () => {
  it("fills in Vrbo's and Booking.com's senders", () => {
    const saved = normalizeSources([{ platform: "airbnb" }, { platform: "vrbo" }, { platform: "booking" }], noCode);
    expect(saved).toEqual({
      ok: true,
      sources: [{ platform: "airbnb" }, { platform: "vrbo", sender: PRESET_SENDERS.vrbo }, { platform: "booking", sender: PRESET_SENDERS.booking }],
    });
  });

  it("keeps a sender the host changed for Vrbo, lower-cased", () => {
    expect(normalizeSources([{ platform: "vrbo", sender: " Owner@Messages.HomeAway.com " }], noCode)).toEqual({ ok: true, sources: [{ platform: "vrbo", sender: "owner@messages.homeaway.com" }] });
  });

  it("needs a sender for the host's own site, and a sender and a name for Other", () => {
    expect(normalizeSources([{ platform: "direct" }], noCode).ok).toBe(false);
    expect(normalizeSources([{ platform: "other", sender: "stays@example.test" }], noCode).ok).toBe(false);
    expect(normalizeSources([{ platform: "other", sender: "stays@example.test", name: "Furnished Finder" }], noCode)).toEqual({
      ok: true,
      sources: [{ platform: "other", sender: "stays@example.test", name: "Furnished Finder" }],
    });
  });

  it("refuses an address that isn't one, an unknown platform, a repeat, or too many", () => {
    expect(normalizeSources([{ platform: "direct", sender: "Bookings <me@example.test>" }], noCode).ok).toBe(false);
    expect(normalizeSources([{ platform: "expedia" as never }], noCode).ok).toBe(false);
    expect(normalizeSources([{ platform: "airbnb" }, { platform: "airbnb" }], noCode).ok).toBe(false);
    const many = Array.from({ length: 9 }, (_, i) => ({ platform: "other" as const, sender: `s${i}@example.test`, name: `Site ${i}` }));
    expect(normalizeSources(many, noCode).ok).toBe(false);
  });

  it("refuses a name or sender that carries the door code", () => {
    const carries = (text: string) => text.includes("4821");
    expect(normalizeSources([{ platform: "other", sender: "stays@example.test", name: "Code 4821" }], carries)).toMatchObject({ ok: false });
    expect(normalizeSources([{ platform: "direct", sender: "door4821@example.test" }], carries)).toMatchObject({ ok: false });
  });
});

describe("matching a sender", () => {
  const sources: BookingSource[] = [{ platform: "airbnb" }, { platform: "vrbo", sender: PRESET_SENDERS.vrbo }, { platform: "direct", sender: "bookings@example.test" }];

  it("reads the address from a From header", () => {
    expect(senderAddress("Vrbo <sender@messages.homeaway.com>")).toBe("sender@messages.homeaway.com");
    expect(senderAddress("bookings@example.test")).toBe("bookings@example.test");
    expect(senderAddress('"sender@messages.homeaway.com" <guest-7x2@messages.homeaway.com>')).toBe("guest-7x2@messages.homeaway.com");
    expect(senderAddress("<a@b.test> trailing")).toBeUndefined();
  });

  it("matches the saved address exactly, and Airbnb by its domain", () => {
    expect(sourceFor(sources, "Vrbo <SENDER@messages.homeaway.com>")?.platform).toBe("vrbo");
    expect(sourceFor(sources, "Airbnb <automated@airbnb.com>")?.platform).toBe("airbnb");
    expect(sourceFor(sources, "My Place <bookings@example.test>")?.platform).toBe("direct");
  });

  it("never matches a guest's relayed Vrbo address or a display name posing as a saved sender", () => {
    expect(sourceFor(sources, "Guest via Vrbo <guest-7x2@messages.homeaway.com>")).toBeUndefined();
    expect(sourceFor(sources, '"bookings@example.test" <someone@else.test>')).toBeUndefined();
  });

  it("doesn't read Airbnb when the host didn't choose it", () => {
    expect(sourceFor([{ platform: "direct", sender: "bookings@example.test" }], "Airbnb <automated@airbnb.com>")).toBeUndefined();
  });
});

describe("the line for the agent", () => {
  it("names only the chosen platforms and their senders", () => {
    const line = bookingEmailsLine([{ platform: "airbnb" }, { platform: "vrbo", sender: PRESET_SENDERS.vrbo }, { platform: "other", sender: "stays@example.test", name: "Furnished Finder" }]);
    expect(line).toContain("Airbnb");
    expect(line).toContain("sender@messages.homeaway.com (Vrbo)");
    expect(line).toContain("stays@example.test (Furnished Finder)");
    expect(line).not.toContain("Booking.com");
  });

  it("without Airbnb, never mentions it", () => {
    expect(bookingEmailsLine([{ platform: "direct", sender: "bookings@example.test" }])).not.toContain("Airbnb");
  });
});

describe("the hub keeps them", () => {
  function hub() {
    const root = mkdtempSync(join(tmpdir(), "booking-sources-"));
    dirs.push(root);
    return { root, hub: hubFor(root, { now: () => new Date("2026-11-20T12:00:00Z") }) };
  }

  it("is Airbnb only until the host saves platforms", () => {
    expect(hub().hub.bookingSources()).toEqual([{ platform: "airbnb" }]);
  });

  it("saves and reads back the platforms and the samples okay", () => {
    const { root, hub: first } = hub();
    expect(first.setBookingSources([{ platform: "vrbo" }, { platform: "direct", sender: "bookings@example.test" }]).ok).toBe(true);
    expect(first.setShareSamples(true).ok).toBe(true);
    resetHubs();
    const again = hubFor(root, { now: () => new Date() });
    expect(again.bookingSources()).toEqual([{ platform: "vrbo", sender: PRESET_SENDERS.vrbo }, { platform: "direct", sender: "bookings@example.test" }]);
    expect(again.shareSamples()).toBe(true);
  });
});
