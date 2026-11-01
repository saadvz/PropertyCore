import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { placementOf } from "../src/core/customSlot";
import { slotsOn } from "../src/core/schedule";
import { zonedTimeToUtc } from "../src/core/timezone";
import { tourWindows, windowOn } from "../src/core/tourWindows";
import { hoursStepSay } from "../src/operator/milestones";
import { draftView } from "../src/setup/presenters";
import { SetupInputError, setTourHours } from "../src/setup/setupActions";
import { tourHoursVisitorReply } from "../src/visitor/tourHoursQuestion";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, type InstallHarness } from "./installHarness";

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI"] as const;
const WEEKEND = ["SAT", "SUN"] as const;

/** A saved property with weekdays 9-5, the one-window shape older files use. */
function weekdayConfig(): TourCoreConfig {
  const config = loadConfig();
  return setTourHours(config, { days: [...WEEKDAYS], start: "09:00", end: "17:00", slotEveryMinutes: 60, tourLengthMinutes: 45, earlyArrivalMinutes: 10 });
}

/** Weekdays 9-5 plus weekends 9-8. */
function splitConfig(): TourCoreConfig {
  return setTourHours(weekdayConfig(), { days: [...WEEKEND], start: "09:00", end: "20:00", merge: true });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function harness(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

const TUNNEL = "https://tour-windows.trycloudflare.com";

function hostedInstall(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", url: TUNNEL });
  h.connectGrok();
  return h;
}

describe("different tour hours on different days", () => {
  it("adds weekend hours and keeps the weekday ones", () => {
    const hours = splitConfig().tourHours;
    expect(tourWindows(hours)).toEqual([
      { days: ["MON", "TUE", "WED", "THU", "FRI"], start: "09:00", end: "17:00" },
      { days: ["SUN", "SAT"], start: "09:00", end: "20:00" },
    ]);
    expect(windowOn(hours, "MON")).toEqual({ start: "09:00", end: "17:00" });
    expect(windowOn(hours, "SAT")).toEqual({ start: "09:00", end: "20:00" });
    // `days` stays every touring day, so older readers still see every open day.
    expect([...hours.days].sort()).toEqual(["FRI", "MON", "SAT", "SUN", "THU", "TUE", "WED"]);
    expect(validateConfig(splitConfig())).toEqual([]);
  });

  it("replaces every window without merge, as the setup page and CLI always did", () => {
    const replaced = setTourHours(splitConfig(), { days: [...WEEKEND], start: "10:00", end: "16:00" });
    expect(replaced.tourHours.windows).toBeUndefined();
    expect(tourWindows(replaced.tourHours)).toEqual([{ days: ["SUN", "SAT"], start: "10:00", end: "16:00" }]);
  });

  it("changes named days only and joins days that end up with the same hours", () => {
    const sat = setTourHours(weekdayConfig(), { days: ["SAT"], merge: true });
    expect(sat.tourHours.windows).toBeUndefined();
    expect(tourWindows(sat.tourHours)).toEqual([{ days: ["MON", "TUE", "WED", "THU", "FRI", "SAT"], start: "09:00", end: "17:00" }]);
    const friday = setTourHours(splitConfig(), { days: ["FRI"], start: "09:00", end: "20:00", merge: true });
    expect(tourWindows(friday.tourHours)).toEqual([
      { days: ["MON", "TUE", "WED", "THU"], start: "09:00", end: "17:00" },
      { days: ["SUN", "FRI", "SAT"], start: "09:00", end: "20:00" },
    ]);
  });

  it("asks which days when new times could belong to more than one window", () => {
    expect(() => setTourHours(splitConfig(), { start: "10:00", merge: true })).toThrow(SetupInputError);
    expect(() => setTourHours(splitConfig(), { start: "10:00", merge: true })).toThrow(
      "Which days are those hours for? Right now Monday to Friday, 9 AM to 5 PM, and Saturday and Sunday, 9 AM to 8 PM.",
    );
    expect(() => setTourHours(splitConfig(), { days: ["FRI", "SAT"], end: "18:00", merge: true })).toThrow("What hours should tours run on Friday and Saturday?");
  });

  it("reads a saved single-window file as one window and saves it back the same way", () => {
    const raw = JSON.parse(JSON.stringify(weekdayConfig()));
    expect(raw.tourHours.windows).toBeUndefined();
    const parsed = TourCoreConfigShape.parse(raw);
    expect(tourWindows(parsed.tourHours)).toEqual([{ days: ["MON", "TUE", "WED", "THU", "FRI"], start: "09:00", end: "17:00" }]);
    const resaved = setTourHours(parsed, { tourLengthMinutes: 30 });
    expect(resaved.tourHours).toEqual({ ...parsed.tourHours, tourLengthMinutes: 30 });
  });

  it("offers each day's own tour times and judges custom times by that day's hours", () => {
    const config = splitConfig();
    const tz = config.property.timezone;
    const monday = { year: 2026, month: 9, day: 28 };
    const saturday = { year: 2026, month: 10, day: 3 };
    expect(slotsOn(config, monday).map((slot) => slot.label).at(-1)).toBe("4:00 PM");
    expect(slotsOn(config, saturday).map((slot) => slot.label).at(-1)).toBe("7:00 PM");
    expect(slotsOn(config, saturday)).toHaveLength(11);
    expect(placementOf(config, zonedTimeToUtc({ ...monday, hour: 18, minute: 15 }, tz))).toBe("OUTSIDE_HOURS");
    expect(placementOf(config, zonedTimeToUtc({ ...saturday, hour: 18, minute: 15 }, tz))).toBe("INSIDE_HOURS");
  });

  it("checks each window is long enough for a tour", () => {
    const short = setTourHours(weekdayConfig(), { days: ["SAT"], start: "09:00", end: "09:30", merge: true });
    expect(validateConfig(short).map((issue) => issue.message)).toContain("The tour hours on Saturday are too short to fit a 45-minute tour.");
  });

  it("lists every window in the hours summary, the hours step, and the visitor reply", () => {
    const config = splitConfig();
    expect(draftView(config).tourHours.summary).toBe(
      "Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day. Saturday, Sunday, 9:00 AM-8:00 PM. That's up to 11 tours a day.",
    );
    expect(draftView(weekdayConfig()).tourHours.summary).toBe("Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day.");
    expect(hoursStepSay(config.tourHours)).toBe("Tours run Monday to Friday, 9 AM to 5 PM, and Saturday and Sunday, 9 AM to 8 PM. Want to change that?");
    expect(tourHoursVisitorReply(config.tourHours, "MON").body).toBe(
      "Tours run Monday to Friday, 9 AM to 5 PM, and Saturday and Sunday, 9 AM to 8 PM. Which day works for you? Just reply with a day, like today, tomorrow, or Saturday.",
    );
  });
});

describe("save_hours with more than one window", () => {
  async function weekdayProperty(h: GrokHarness): Promise<string> {
    const created = await h.ok("create_property_setup", { address: "30 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    const saved = await h.ok("save_hours", { property: id, days: "Monday to Friday", start: "9 AM", end: "5 PM" });
    expect(saved.message).toBe("Tours run Monday to Friday, 9 AM to 5 PM.");
    return id;
  }

  it("adds Saturday and Sunday 9 AM to 8 PM and keeps Monday to Friday 9 AM to 5 PM", async () => {
    const h = harness();
    const id = await weekdayProperty(h);
    const added = await h.ok("save_hours", { property: id, days: "Saturday and Sunday", start: "9 AM", end: "8 PM" });
    expect(added.status).toBe("done");
    expect(added.message).toBe("Tours run Monday to Friday, 9 AM to 5 PM, and Saturday and Sunday, 9 AM to 8 PM.");
    const read = await h.ok("get_tour_hours", { property: id });
    expect(read.summary).toBe("Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day. Saturday, Sunday, 9:00 AM-8:00 PM. That's up to 11 tours a day.");
  });

  it("replaces every day's hours when the host says replace", async () => {
    const h = harness();
    const id = await weekdayProperty(h);
    const replaced = await h.ok("save_hours", { property: id, days: "weekends", start: "9 AM", end: "8 PM", replace: true });
    expect(replaced.message).toBe("Tours run Saturday and Sunday, 9 AM to 8 PM.");
  });

  it("asks which days before changing times that could mean either window", async () => {
    const h = harness();
    const id = await weekdayProperty(h);
    await h.ok("save_hours", { property: id, days: "weekends", start: "9 AM", end: "8 PM" });
    const before = h.workspace.openDraft(id).draft.tourHours;
    const asked = await h.ok("save_hours", { property: id, start: "10 AM" });
    expect(asked.status).toBe("next");
    expect(asked.message).toContain("Which days are those hours for?");
    expect(h.workspace.openDraft(id).draft.tourHours).toEqual(before);
  });

  it("lists both windows in get_state", async () => {
    const h = hostedInstall();
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    await h.ok("use_local_demo_storage");
    const created = await h.ok("create_property_setup", { address: "34 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    await h.ok("save_hours", { property: id, days: "weekdays", start: "9 AM", end: "5 PM" });
    await h.ok("save_hours", { property: id, days: "Saturday and Sunday", start: "9 AM", end: "8 PM" });
    const state = await h.ok("get_state", { propertyId: id });
    expect(state.hours).toBe("Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day. Saturday, Sunday, 9:00 AM-8:00 PM. That's up to 11 tours a day.");
  });

  it("lets the first save replace the starting default", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "32 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    const saved = await h.ok("save_hours", { property: id, days: "weekends", start: "10 AM", end: "4 PM" });
    expect(saved.message).toBe("Tours run Saturday and Sunday, 10 AM to 4 PM.");
  });
});
