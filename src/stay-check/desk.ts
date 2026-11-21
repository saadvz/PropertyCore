import { stayForNight, type EmailStay } from "../hub/bookingEmails";
import { addCalendarDays, zonedInstant } from "../hub/calendar";
import { readHubFile, type HubFile, type Stay as CalendarStay } from "../hub/store";
import { checkNight, NO_CHECKABLE_RULE, type NightResult } from "./check";
import type { StayEvent } from "./events";
import { checkTimeProblem, cleanCheck, isCheckKind, markFalse, needed, rulesProblem, type CheckKind, type HouseRule } from "./rules";
import { readStayCheck, StayCheckFileError, writeStayCheck, type StayCheckFile } from "./store";

/**
 * The nightly stay check's desk for one property (#239): the host's house rules, per-stay allowances, and one
 * night's check against given events. It texts nobody: the result goes back to the caller, and the host-alert clock (src/hosted/hostAlerts.ts, #250) sends it.
 */

export interface StayCheckReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface StayCheckDeps {
  now: () => Date;
}

export const DEFAULT_CHECK_TIME = "23:00";
const DEFAULT_CHECK_IN = "16:00";
const DEFAULT_CHECKOUT = "11:00";
const DATE_SHAPE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** A real calendar date as YYYY-MM-DD: 2026-02-31 isn't one. */
const DATE = { test: (value: string) => DATE_SHAPE.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value };

export const ASK_FOR_RULES =
  "No house rules are saved yet. Ask the host for their house rules in their own words. Examples help: \"No more than 6 guests\", \"No pets\", \"Two cars max\", \"Quiet after 10 PM\", \"No parties\". Don't suggest rules they didn't give. For each rule the cameras can watch (guests, pets, cars, quiet hours), read it back in checkable form, like \"I'll flag more than 6 people on camera at once\", and save its check only after they agree. Save every other rule as text. Then ask what time they'd like the nightly check; 11 PM is a good default.";

const ok = (structured: Record<string, unknown>): StayCheckReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): StayCheckReply => ({ text, isError: true });


export class StayCheckDesk {
  constructor(
    private readonly root: string,
    private readonly deps: StayCheckDeps,
  ) {}

  /** A broken stay-check.json is a plain refusal, and nothing is written over it. */
  private guarded(run: () => StayCheckReply): StayCheckReply {
    try {
      return run();
    } catch (error) {
      if (error instanceof StayCheckFileError) return fail(error.message);
      throw error;
    }
  }

  private hub(): HubFile | undefined {
    try {
      return readHubFile(this.root);
    } catch {
      return undefined;
    }
  }

  /** The saved rules, check time and allowances. With none saved, how to ask the host for theirs. */
  getRules(): StayCheckReply {
    return this.guarded(() => {
      const file = readStayCheck(this.root);
      if (!file.rules.length) return ok({ rules: [], ask: ASK_FOR_RULES });
      return ok({ rules: file.rules, checkTime: file.checkTime ?? DEFAULT_CHECK_TIME, checkTimeChosen: file.checkTime !== undefined, allowances: file.allowances });
    });
  }

  /** `rules` replaces the list (an empty list clears it). `checkTime` replaces the saved time. */
  saveRules(input: { rules?: unknown; checkTime?: unknown }): StayCheckReply {
    return this.guarded(() => {
      if (input.rules === undefined && input.checkTime === undefined) return fail("Give the host's rules, a check time, or both.");
      const problem = (input.rules !== undefined ? rulesProblem(input.rules) : undefined) ?? (input.checkTime !== undefined ? checkTimeProblem(input.checkTime) : undefined);
      if (problem) return fail(problem);
      const file = readStayCheck(this.root);
      const next: StayCheckFile = { ...file };
      if (input.rules !== undefined) {
        next.rules = (input.rules as HouseRule[]).map((rule) => ({ text: rule.text.trim(), ...(rule.check ? { check: cleanCheck(rule.check) } : {}) }));
        next.rulesSavedAt = this.deps.now().toISOString();
      }
      if (input.checkTime !== undefined) next.checkTime = input.checkTime as string;
      writeStayCheck(this.root, next);
      const watched = next.rules.filter((rule) => rule.check).length;
      return ok({
        saved: true,
        rules: next.rules,
        checkTime: next.checkTime ?? DEFAULT_CHECK_TIME,
        next: next.rules.length
          ? `Saved. ${watched ? `${watched} of these the cameras can watch.` : "None of these can be watched by the cameras yet, so no night is checked."} Nothing is sent to anyone from here.`
          : "Saved. No house rules now, so no night is checked.",
      });
    });
  }

  /** Something the host allowed for one stay, by its check-in date. An empty list removes the stay's allowance. */
  allowForStay(input: { checkIn?: unknown; allow?: unknown }): StayCheckReply {
    return this.guarded(() => {
      if (typeof input.checkIn !== "string" || !DATE.test(input.checkIn)) return fail("Give the stay's check-in date as YYYY-MM-DD, like 2026-11-20.");
      if (!Array.isArray(input.allow) || !input.allow.every(isCheckKind)) return fail("Give what's allowed as a list of people, pets, vehicles or quiet. An empty list removes the allowance.");
      const checkIn = input.checkIn;
      const allow = [...new Set(input.allow as CheckKind[])];
      const file = readStayCheck(this.root);
      const allowances = file.allowances.filter((entry) => entry.checkIn !== checkIn);
      if (allow.length) allowances.push({ checkIn, allow });
      allowances.sort((a, b) => a.checkIn.localeCompare(b.checkIn));
      writeStayCheck(this.root, { ...file, allowances });
      const onCalendar = (this.hub()?.stays ?? []).some((stay) => stay.kind === "stay" && stay.checkIn === checkIn);
      const unmatched = allow.length && !onCalendar ? ` No stay on the calendar checks in ${checkIn} yet, so check the date with the host.` : "";
      return ok({ saved: true, checkIn, allow, next: allow.length ? `Saved. ${allow.join(", ")} won't be flagged for the stay that checks in ${checkIn}.${unmatched}` : `Removed. The stay that checks in ${checkIn} is checked as usual.` });
    });
  }

  /** A flag the host said was wrong: that kind needs one more sighting at this property next time, up to 3. Allowed numbers never change. */
  markFlagFalse(input: { kind?: unknown }): StayCheckReply {
    return this.guarded(() => {
      if (!isCheckKind(input.kind)) return fail("Say which flag was wrong: people, pets, vehicles or quiet.");
      const kind = input.kind;
      const file = markFalse(readStayCheck(this.root), kind);
      writeStayCheck(this.root, file);
      const sightingsNeeded = needed(file.sightings, kind);
      return ok({ saved: true, kind, sightingsNeeded, next: `Noted. A ${kind} flag at this property now needs ${sightingsNeeded} sightings in one night. The house rule itself is unchanged.` });
    });
  }

  /** The calendar stay covering the night of `date` (check-in night yes, checkout night no). Blocks aren't stays. */
  private stayFor(hub: HubFile, date: string): CalendarStay | undefined {
    return (hub.stays ?? []).find((stay) => stay.kind === "stay" && stay.checkIn <= date && date < stay.checkout);
  }

  private window(hub: HubFile, stay: CalendarStay, email: EmailStay | undefined, date: string, checkTime: string, timeZone: string) {
    const run = (night: string) => zonedInstant(checkTime < "12:00" ? addCalendarDays(night, 1) : night, checkTime, timeZone);
    const checkInTime = (email?.checkIn === stay.checkIn ? email.checkInTime : undefined) ?? hub.property.checkInTime ?? DEFAULT_CHECK_IN;
    const checkoutTime = (email?.checkout === stay.checkout ? email.checkoutTime : undefined) ?? hub.property.checkoutTime ?? DEFAULT_CHECKOUT;
    // No night reaches back before check-in, so turnover day never counts against the stay, whatever the check time.
    const arrived = zonedInstant(stay.checkIn, checkInTime, timeZone);
    const prior = date === stay.checkIn ? arrived : run(addCalendarDays(date, -1));
    const from = prior < arrived ? arrived : prior;
    const end = addCalendarDays(date, 1) === stay.checkout ? zonedInstant(stay.checkout, checkoutTime, timeZone) : run(date);
    return { from, to: end < from ? from : end };
  }

  /** The night's window, from the previous run to this one; undefined with no stay that night or no time zone. */
  nightWindow(date: string): { from: string; to: string } | undefined {
    if (!DATE.test(date)) return undefined;
    const hub = this.hub();
    const timeZone = hub?.property.timeZone;
    const stay = hub && this.stayFor(hub, date);
    if (!hub || !timeZone || !stay) return undefined;
    let checkTime = DEFAULT_CHECK_TIME;
    try {
      checkTime = readStayCheck(this.root).checkTime ?? DEFAULT_CHECK_TIME;
    } catch {
      // A broken record has no check time to read; the default stands for the window alone.
    }
    return this.window(hub, stay, stayForNight(this.root, date), date, checkTime, timeZone);
  }

  /** One night of a stay against the given events. Returns the result; sends nothing. */
  runNight(date: string, events: StayEvent[], label: string): NightResult {
    if (!DATE.test(date)) return { status: "skipped", reason: "Give the night as YYYY-MM-DD." };
    let file: StayCheckFile;
    try {
      file = readStayCheck(this.root);
    } catch (error) {
      if (error instanceof StayCheckFileError) return { status: "skipped", reason: error.message };
      throw error;
    }
    if (!file.rules.some((rule) => rule.check)) return { status: "skipped", reason: NO_CHECKABLE_RULE };
    const hub = this.hub();
    const timeZone = hub?.property.timeZone;
    if (!hub || !timeZone) return { status: "skipped", reason: "The property has no time zone, so its nights can't be told apart." };
    const stay = this.stayFor(hub, date);
    if (!stay) return { status: "skipped", reason: "No stay covers this night." };
    const email = stayForNight(this.root, date);
    return checkNight({
      label,
      rules: file.rules,
      sightings: file.sightings,
      allow: file.allowances.find((entry) => entry.checkIn === stay.checkIn)?.allow ?? [],
      ...(email && (email.guests !== undefined || email.infants !== undefined || email.pets !== undefined)
        ? { booking: { ...(email.guests !== undefined ? { guests: email.guests } : {}), ...(email.infants ? { infants: email.infants } : {}), ...(email.pets ? { pets: email.pets } : {}) } }
        : {}),
      timeZone,
      window: this.window(hub, stay, email, date, file.checkTime ?? DEFAULT_CHECK_TIME, timeZone),
      events,
    });
  }
}

export function stayCheckDeskFor(root: string, deps: StayCheckDeps): StayCheckDesk {
  return new StayCheckDesk(root, deps);
}
