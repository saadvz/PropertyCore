import { alertProblem, type AlertProblem } from "./guard";
import type { HostAlertLedger } from "./ledger";
import type { AlertKind } from "./routes";

/**
 * One property's pass of the host-alert clock (#250): collect what each producer says is due, keep it in the
 * ledger, let the producer mark it told, then hand every kept alert that hasn't gone yet to the routine its kind is
 * routed to. The order is what makes it exactly once: keep first, mark second, hand over last, and each step
 * dedupes by the alert's id. It texts nobody: a sink is a note in the host's own chat.
 */

export interface HostAlert {
  id: string;
  kind: AlertKind;
  text: string;
}

export interface DueItem {
  /** Absent when there's nothing to tell, such as a clean night: the producer still records that it ran. */
  alert?: HostAlert;
  /** Marks it told in the producer's own record. Runs only after the alert is kept (or withheld). */
  commit: () => void;
}

export interface AlertSource {
  kind: AlertKind;
  due: () => DueItem[];
}

/** Hands one alert to a routine. The sink's name when it was taken, else undefined (tried again next pass). */
export type AlertSink = (alert: HostAlert) => Promise<string | undefined>;

/** A kept alert not handed over in this long is let go: "Today at…" and "Tonight at…" don't keep. */
export const ALERT_KEEPS_MS = 48 * 60 * 60_000;

export interface PassResult {
  kept: string[];
  delivered: string[];
  withheld: { id: string; kind: AlertKind; problem: AlertProblem }[];
  failed: AlertKind[];
}

export async function runHostAlerts(input: { sources: readonly AlertSource[]; ledger: HostAlertLedger; sinkFor: (kind: AlertKind) => AlertSink; now: Date; label?: string }): Promise<PassResult> {
  const result: PassResult = { kept: [], delivered: [], withheld: [], failed: [] };
  for (const source of input.sources) {
    try {
      for (const item of source.due()) {
        const alert = item.alert;
        if (alert && !input.ledger.has(alert.id)) {
          const problem = alertProblem(alert.text, input.label ? { label: input.label } : {});
          if (problem) {
            input.ledger.withhold(alert);
            result.withheld.push({ id: alert.id, kind: alert.kind, problem });
          } else if (input.ledger.keep(alert)) {
            result.kept.push(alert.id);
          }
        }
        item.commit();
      }
    } catch {
      result.failed.push(source.kind);
    }
  }
  for (const alert of input.ledger.pending()) {
    if (input.now.getTime() - Date.parse(alert.keptAt) >= ALERT_KEEPS_MS) {
      input.ledger.expired(alert.id);
      continue;
    }
    let via: string | undefined;
    try {
      via = await input.sinkFor(alert.kind)({ id: alert.id, kind: alert.kind, text: alert.text });
    } catch {
      via = undefined;
    }
    if (via) {
      input.ledger.delivered(alert.id, via);
      result.delivered.push(alert.id);
    }
  }
  return result;
}
