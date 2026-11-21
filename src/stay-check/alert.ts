import { formatClockTime, formatTime } from "../core/timezone";
import type { Flag } from "./check";

/**
 * The night's alert text (#239): one message, every flag in it, in the property's time zone. Plain words, counts
 * only: no door code and no guest's name. The host-alert clock (src/hosted/hostAlerts.ts, #250) sends it.
 */

function sentence(flag: Flag, timeZone: string): string {
  const time = formatTime(new Date(flag.at), timeZone);
  switch (flag.kind) {
    case "people":
      return flag.basis === "booking" ? `${flag.peak} people on camera at ${time}, booked for ${flag.allowed}.` : `${flag.peak} people on camera at ${time}, and the house rules allow ${flag.allowed}.`;
    case "pets":
      return `${flag.peak > 1 ? `${flag.peak} animals` : "An animal"} on camera at ${time}, and the house rules say no pets.`;
    case "vehicles":
      return `${flag.peak} cars on camera at ${time}, and the house rules allow ${flag.allowed}.`;
    case "quiet":
      return `Noise at ${time} during quiet hours${flag.quietHours ? ` (${formatClockTime(flag.quietHours.start)} to ${formatClockTime(flag.quietHours.end)})` : ""}.`;
  }
}

export function alertText(label: string, flags: Flag[], timeZone: string): string {
  const parts = flags.map((flag) => sentence(flag, timeZone));
  const evidence = flags.find((flag) => flag.evidence)?.evidence;
  if (evidence) {
    const camera = /camera$/i.test(evidence.device.trim()) ? evidence.device.trim() : `${evidence.device.trim()} camera`;
    parts.push(`Clip: ${camera}, ${formatTime(new Date(evidence.at), timeZone)}.`);
  }
  return `Tonight at ${label}: ${parts.join(" ")}`;
}
