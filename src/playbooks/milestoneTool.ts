import type { StepId } from "./shared";

/** The milestone tool for this step. Day-to-day work and backups use the Phase 4 tools. */
export function milestoneToolFor(step: StepId): string {
  switch (step) {
    case "texting-choose":
    case "texting-keys":
    case "texting-line":
    case "texting-test":
      return "set_up_texting";
    case "backups":
      return "backup_records";
    case "operate":
    case "another":
      return "get_inbox";
    case "property-address":
    case "property-confirm":
    case "property-type":
    case "hours-help":
      return "save_property";
    case "units-which":
    case "units-home":
    case "units-details":
      return "save_units";
    case "units-route":
      return "save_doors_and_routes";
    case "hours":
      return "save_hours";
    case "facts":
      return "save_facts";
    case "alerts":
      return "save_settings";
    case "readiness":
    case "practice":
      return "run_checks";
    case "publish":
      return "publish";
    default:
      return "get_state";
  }
}
