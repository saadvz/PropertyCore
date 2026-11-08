import type { PropertyWorkspace, PublishResult } from "./workspace";

/**
 * The setup engine's public actions. Any setup surface (the terminal wizard
 * today, a Grok Bot skill later) should drive setup only through these.
 */
export {
  createPropertySetup,
  setPropertyDetails,
  setAlertContact,
  addUnit,
  addTourableSpace,
  renameUnit,
  removeUnit,
  setUnitProfile,
  addDoor,
  renameDoor,
  removeDoor,
  setRoute,
  setTourHours,
  setVerificationPolicy,
  setServices,
  reviewSetup,
  visitorHelpQuestion,
  VISITOR_HELP_QUESTION,
  VISITOR_HELP_NUMBER_QUESTION,
  setBuildingAccess,
  setEntryInstructions,
  entryInstructionsFragment,
  SINGLE_FAMILY_SPACE_NAME,
  CONDO_UNIT_QUESTION,
  BUILDING_ACCESS_QUESTION,
  ENTRY_INSTRUCTIONS_QUESTION,
  describeDays,
  describeMinutes,
  describeInterval,
  SETUP_DEFAULTS,
  OperatorTeamCopy,
  CHOICE_LABELS,
  SetupInputError,
  type SetupDraft,
} from "./setupActions";
export { runReadinessCheck } from "./readiness";
export { runDryTour, type DryTourEvent, type DryTourResult } from "./dryTour";
export { PropertyWorkspace, statusLabel, isCurrent } from "./workspace";

/** Demo publish only: never a production launch. See PublicationStatus in ./workspace. */
export function publishDemoProperty(workspace: PropertyWorkspace, propertyId: string, now?: Date): Promise<PublishResult> {
  return workspace.publishDemoProperty(propertyId, now);
}
export { parseDays, parseTimeOfDay, parseMinutes, parseChoiceList, resolveTimeZone, inferTimeZone } from "./parse";
export { applySetupCommand } from "./commands";
export {
  draftView,
  readinessView,
  dryTourView,
  propertySummary,
  saveStateView,
  tourListView,
  tourDetailView,
  SETUP_STEPS,
  COMMON_TIME_ZONES,
} from "./presenters";
export { describeHistory } from "../audit/describe";
export { validateConfig } from "../config/tourCoreConfig";
