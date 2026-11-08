import type { Weekday } from "../core/timezone";

const TOUR_DAY_ORDER: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export const DAY_NAME: Readonly<Record<Weekday, string>> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "Monday to Friday", "Saturday and Sunday", "Saturday to Monday".
 * Sunday sits next to Monday, so a run can wrap the week. "to" is only
 * for a run of three or more days. One or two days are listed one by one.
 * The list uses commas and one "and" before the last part.
 */
export function describeTourDays(days: readonly Weekday[]): string {
  const ordered = TOUR_DAY_ORDER.filter((day) => days.includes(day));
  if (ordered.length === TOUR_DAY_ORDER.length) return "every day";
  const groups: Weekday[][] = [];
  for (const day of ordered) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && TOUR_DAY_ORDER.indexOf(day) === TOUR_DAY_ORDER.indexOf(prev) + 1) last.push(day);
    else groups.push([day]);
  }
  if (groups.length > 1 && groups[0]![0] === "MON" && groups[groups.length - 1]!.at(-1) === "SUN") {
    const sundaySide = groups.pop()!;
    const mondaySide = groups.shift()!;
    groups.unshift([...sundaySide, ...mondaySide]);
  }
  return joinList(groups.flatMap((group) => {
    if (group.length >= 3) return [`${DAY_NAME[group[0]!]} to ${DAY_NAME[group[group.length - 1]!]}`];
    return group.map((day) => DAY_NAME[day]);
  }));
}
