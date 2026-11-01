import { PROPERTY_TYPE_LABELS, validateConfig } from "../config/tourCoreConfig";
import { isValidTimeZone } from "../core/timezone";
import { UNSET_ZONE_LINE } from "../setup/storedTimeZone";
import type { PropertyWorkspace } from "../setup/workspace";
import { nextProfileQuestion } from "../config/unitProfile";
import { hoursStepSay } from "../operator/milestones";
import { addressConfirmQuestion, nextAddressPartQuestion } from "../setup/address";
import { renderPlaybook, spokenAsk } from "../playbooks/compose";
import { milestoneToolFor } from "../playbooks/milestoneTool";
import type { ReportedClient } from "../playbooks/select";
import { SETUP_HELP_ENDING } from "../playbooks/setupHelp";
import { SHARED_STEPS, type StepId } from "../playbooks/shared";
import { visitorTexting } from "../operator/setupFlow";
import type { OperatorServices } from "../operator/services";
import { draftView } from "../setup/presenters";
import {
  BUILDING_ACCESS_QUESTION,
  BUILDING_ENTRANCE_QUESTION,
  ENTRY_INSTRUCTIONS_QUESTION,
  SetupInputError,
  condoNextQuestion,
  operatorFacingPropertyName,
  visitorHelpQuestion,
  type SetupDraft,
} from "../setup/setupActions";
import { isCurrent, statusLabel } from "../setup/workspace";
import { operatorUnitName } from "../visitor/identity";
import { googleClientConfig } from "../storage/googleOAuth";
import type { SettingName } from "./secretStore";
import { isHostedRailway, isTenantWorker } from "./deployment";
import { activeFromNumber } from "../messaging/registry";
import type { Installation } from "./installation";
import { storageVolumeHealth } from "./persistentVolume";
import { getInstallationStatus, installedMessaging, primaryProperty, type InstallationStatus, type InstallationStep } from "./status";

const MILESTONES = [
  { id: "texting", order: 1, title: "Texting" },
  { id: "backups", order: 2, title: "Backups" },
  { id: "property", order: 3, title: "Property" },
  { id: "units", order: 4, title: "Units, doors, and routes" },
  { id: "hours", order: 5, title: "Hours" },
  { id: "practice", order: 6, title: "Practice tour" },
  { id: "publish", order: 7, title: "Publish" },
] as const;

type MilestoneId = (typeof MILESTONES)[number]["id"];

const SELF_HOST_DRIVE_ACTIONS = new Set(["CONNECT_GOOGLE_DRIVE", "FINISH_GOOGLE_DRIVE"]);
const SELF_HOST_DRIVE_TOOLS = new Set(["begin_google_drive_connect", "finish_google_drive_setup", "use_local_demo_storage", "migrate_storage_to_google_drive", "activate_google_drive_storage"]);

export interface StateReadInput {
  installation?: Installation;
  services: OperatorServices;
  client?: ReportedClient;
}

interface Picture {
  id?: string;
  draft?: SetupDraft;
  addressReady: boolean;
  needsAddressConfirm: boolean;
  typeReady: boolean;
  unitsReady: boolean;
  routesOpen: boolean;
  condoAccessOpen: boolean;
  helpOpen: boolean;
  hoursReady: boolean;
  readinessPassed: boolean;
  practicePassed: boolean;
  published: boolean;
}

function component(status: InstallationStatus, name: string) {
  return status.components.find((item) => item.component === name);
}

function pictureOf(services: OperatorServices, id: string | undefined): Picture {
  const empty: Picture = {
    addressReady: false,
    needsAddressConfirm: false,
    typeReady: false,
    unitsReady: false,
    routesOpen: false,
    condoAccessOpen: false,
    helpOpen: false,
    hoursReady: false,
    readinessPassed: false,
    practicePassed: false,
    published: false,
  };
  if (!id) return empty;
  let draft: SetupDraft;
  try {
    draft = services.workspace.openDraft(id).draft;
  } catch {
    return empty;
  }
  const saved = services.workspace.has(id) ? services.workspace.load(id) : undefined;
  const canonical = draft.property.canonicalAddress;
  const missingStreet = !!canonical && !canonical.street?.trim();
  const missingState = !!canonical && !canonical.state?.trim();
  const missingCity = !!canonical && !canonical.city?.trim();
  const missingZip = !!canonical && !canonical.postalCode;
  const addressReady = !!draft.property.address.trim() && !missingStreet && !missingState && !missingCity && !missingZip && draft.property.addressConfirmed !== false;
  const needsAddressConfirm =
    !!canonical?.street?.trim() &&
    !!canonical?.city?.trim() &&
    !!canonical?.state?.trim() &&
    !!canonical?.postalCode &&
    draft.property.addressConfirmed === false;
  const typeReady = !!draft.property.propertyType;
  const issues = validateConfig(draft);
  const structuralIssues = issues.some((issue) => issue.section === "units" || issue.section === "routes");
  const routesOpen = draft.units.length > 0 && issues.some((issue) => issue.section === "routes");
  const condo = condoNextQuestion(draft);
  const condoAccessOpen = !!condo && (condo.nextQuestion === BUILDING_ACCESS_QUESTION || condo.nextQuestion === BUILDING_ENTRANCE_QUESTION);
  const profileOpen = !!nextProfileQuestion(draft.units);
  const entryOpen = condo?.nextQuestion === ENTRY_INSTRUCTIONS_QUESTION;
  const unitsReady = addressReady && typeReady && draft.units.length > 0 && !structuralIssues && !profileOpen && !entryOpen && !condoAccessOpen;
  const helpOpen = !!visitorHelpQuestion(draft);
  const otherIssues = issues.some((issue) => issue.section !== "units" && issue.section !== "routes");
  const readinessPassed = !!saved && !!saved.state.readiness?.passed && isCurrent(saved.state.readiness, saved.state);
  const practicePassed = !!saved && !!saved.state.dryTour?.passed && isCurrent(saved.state.dryTour, saved.state);
  const published = saved?.state.status === "PUBLISHED_FOR_DEMO";
  const hoursConfirmed = published || readinessPassed || practicePassed || services.workspace.hoursWereConfirmed(id);
  return {
    id,
    draft,
    addressReady,
    needsAddressConfirm,
    typeReady,
    unitsReady,
    routesOpen,
    condoAccessOpen,
    helpOpen,
    hoursReady: unitsReady && !helpOpen && !otherIssues && hoursConfirmed,
    readinessPassed,
    practicePassed,
    published,
  };
}

function presentNext(status: InstallationStatus): InstallationStep {
  const step = status.nextStep;
  const hosted = isHostedRailway(status.deploymentMode);
  const selfHostDrive = SELF_HOST_DRIVE_ACTIONS.has(step.action) || (!!step.tool && SELF_HOST_DRIVE_TOOLS.has(step.tool));
  if (!hosted || !selfHostDrive) return step;
  return {
    ...step,
    component: "STORAGE",
    action: "CONFIRM_BACKUP_DESTINATION",
    performedBy: "OPERATOR_DECISION",
    operatorMessage: SHARED_STEPS.backups.ask,
    tool: "backup_records",
    optional: true,
  };
}

function stepFor(action: string, picture: Picture): StepId {
  // WAIT_FOR_HOST_NUMBER: a touring host on the shared service waits for the admin to add their number.
  if (action === "START_RUNTIME" || action === "ESTABLISH_PUBLIC_ENDPOINT" || action === "CHECK_PUBLIC_ENDPOINT" || action === "WAIT_FOR_HOST_NUMBER") return "starting";
  if (action === "CONNECT_GROK" || action === "RECONNECT_GROK" || action === "FIX_GROK_CONNECTOR") return "connect";
  if (action === "CHOOSE_MESSAGING_PROVIDER") return "texting-choose";
  if (action === "CONNECT_VISITOR_MESSAGING" || action === "FIX_VISITOR_MESSAGING") return "texting-keys";
  if (action === "CHOOSE_MESSAGING_LINE") return "texting-line";
  if (action === "TEST_VISITOR_MESSAGING" || action === "RECONNECT_VISITOR_MESSAGING") return "texting-test";
  if (action === "CONFIRM_BACKUP_DESTINATION" || action === "CONNECT_GOOGLE_DRIVE" || action === "FINISH_GOOGLE_DRIVE" || action === "CHECK_STORAGE") return "backups";
  if (action === "SET_UP_PROPERTY") return "property-address";
  if (action === "FINISH_PROPERTY_SETUP") {
    if (!picture.addressReady) return picture.needsAddressConfirm ? "property-confirm" : "property-address";
    if (!picture.typeReady) return "property-type";
    if (!picture.unitsReady) {
      if (picture.draft?.property.propertyType === "SINGLE_FAMILY" && picture.draft.units.length === 0) return "units-home";
      if (!picture.draft || picture.draft.units.length === 0) return "units-which";
      if (picture.condoAccessOpen) return "units-details";
      if (picture.routesOpen) return "units-route";
      return "units-details";
    }
    if (picture.helpOpen) return "hours-help";
    return "hours";
  }
  if (action === "OFFER_OPERATOR_ALERTS" || action === "CONNECT_OPERATOR_ALERTS" || action === "TEST_OPERATOR_ALERTS" || action === "FIX_OPERATOR_ALERTS") return "alerts";
  if (action === "RUN_READINESS") return "readiness";
  if (action === "RUN_PRACTICE_TOUR") return "practice";
  if (action === "PUBLISH" || action === "FIX_PROPERTY_TEXTING") return "publish";
  if (action === "ADD_ANOTHER_PROPERTY" || action === "DONE") return picture.published ? "another" : "operate";
  return "operate";
}

function milestonesFor(status: InstallationStatus, picture: Picture) {
  const textingDone = component(status, "VISITOR_MESSAGING")?.state === "READY";
  const backupsDone = component(status, "STORAGE")?.state === "READY";
  const propertyDone = picture.addressReady && picture.typeReady;
  const done = [textingDone, backupsDone, propertyDone, picture.unitsReady, picture.hoursReady, picture.readinessPassed && picture.practicePassed, picture.published];
  const prior = ["RUNTIME", "PUBLIC_ENDPOINT", "GROK_OPERATOR"].map((name) => component(status, name)).find((item) => item && item.state !== "READY");
  const alerts = component(status, "OPERATOR_ALERTS");
  const alertsBlocking = !!alerts && alerts.state !== "READY" && alerts.state !== "NOT_CONFIGURED" && alerts.state !== "DEGRADED" && !!alerts.next && picture.hoursReady && !(picture.readinessPassed && picture.practicePassed);
  const waiting = [
    "Texting isn't finished yet.",
    "Backups aren't decided yet. Saving a copy or skipping both still count.",
    "The property isn't set up yet.",
    "Units, doors, and routes aren't finished.",
    "Touring hours aren't confirmed yet.",
    "The practice tour hasn't passed.",
    "This place isn't published yet.",
  ];
  let marked = false;
  return MILESTONES.map((milestone, index) => {
    if (done[index]) return { ...milestone, status: "done" as const };
    if (marked) return { ...milestone, status: "blocked" as const, reason: waiting[index]! };
    if (milestone.id === "texting" && prior) {
      marked = true;
      const reason = prior.component === "RUNTIME" ? "Tour Core isn't running yet." : prior.component === "PUBLIC_ENDPOINT" ? "The connection isn't ready yet." : "You're not connected yet.";
      return { ...milestone, status: "blocked" as const, reason };
    }
    if (milestone.id === "practice" && alertsBlocking) {
      marked = true;
      return { ...milestone, status: "blocked" as const, reason: "Tour updates aren't set yet. You can turn them on or skip them." };
    }
    marked = true;
    return { ...milestone, status: "next" as const };
  });
}

function focusStep(milestones: ReturnType<typeof milestonesFor>, action: string, picture: Picture): StepId {
  const current = milestones.find((milestone) => milestone.status === "next");
  const practiceBlocked = milestones.some((milestone) => milestone.id === "practice" && milestone.status === "blocked" && milestone.reason?.startsWith("Tour updates"));
  if (!current && practiceBlocked) return "alerts";
  if (!current) return stepFor(action, picture);
  if (current.id === "texting" || current.id === "backups") return stepFor(action, picture);
  if (current.id === "property") {
    if (picture.needsAddressConfirm) return "property-confirm";
    if (!picture.addressReady) return "property-address";
    return "property-type";
  }
  if (current.id === "units" || current.id === "hours") return stepFor("FINISH_PROPERTY_SETUP", picture);
  if (current.id === "practice") return picture.readinessPassed ? "practice" : "readiness";
  return "publish";
}

/** Landlord status when hosted records are not on a lasting volume. No help-page ending. */
export const DISK_NOT_SAVED = "Tour Core is running, but your records aren't saved anywhere permanent yet, so the next update could erase them.";

function healthLine(inst: Installation, status: InstallationStatus): string {
  if (component(status, "RUNTIME")?.state !== "READY") return `Tour Core isn't running right now. I'll try again. ${SETUP_HELP_ENDING}`;
  if (isHostedRailway(status.deploymentMode) && storageVolumeHealth(inst.options.root).persistentVolume === false) return DISK_NOT_SAVED;
  return "Tour Core is running.";
}

function storageLine(inst: Installation): string {
  const backup = inst.files.state().portableBackup;
  switch (inst.records.provider()) {
    case "HOSTED_VOLUME":
      if (backup?.destination) return "Records are kept here, and a portable copy has a folder.";
      if (backup?.declinedAt) return "Records are kept here. You skipped a portable copy.";
      return "Records are kept here. A portable copy isn't set up yet.";
    case "GOOGLE_DRIVE_READY":
      return "Records are kept in a folder you own.";
    case "GOOGLE_DRIVE_CONNECTING":
      return "A folder for records is still being connected.";
    case "LOCAL_DEMO":
      return "Records stay on this computer.";
    case "ERROR":
      return `Records couldn't be checked just now. I'll look again. ${SETUP_HELP_ENDING}`;
    default:
      return "A place for records isn't set up yet.";
  }
}

function alertsLine(status: InstallationStatus): string {
  const summary = component(status, "OPERATOR_ALERTS")?.summary ?? "Tour updates aren't turned on yet.";
  return /webhook|routine|grok|http/i.test(summary) ? "Tour updates aren't turned on yet." : summary;
}

export const TEXTING_NOT_CHOSEN = "Texting isn't set up yet.";
export const TEXTING_KEYS_NEEDED = "Texting needs a login before it can connect.";
export const TEXTING_NEEDS_LINE = "Texting is connected. Choose the number people should text.";
export const TEXTING_TESTING = "A number is saved. Texting still needs a check.";
export const TEXTING_WORKING = "Texting is working.";
export const TEXTING_TEST_MODE = "Texting is in test mode, so texts won't reach real phones yet.";
export const TEXTING_ERROR = "Texting isn't working right now.";

/** Plain texting line for the landlord. Ignores provider names in the raw summary. */
export function textingSummary(part: { state?: string; provider?: string; next?: { action?: string } } | undefined): string {
  if (!part) return TEXTING_NOT_CHOSEN;
  if (part.state === "READY" && part.provider === "local") return TEXTING_TEST_MODE;
  if (part.state === "READY") return TEXTING_WORKING;
  if (part.state === "ERROR") return TEXTING_ERROR;
  const action = part.next?.action;
  if (action === "CHOOSE_MESSAGING_LINE") return TEXTING_NEEDS_LINE;
  if (action === "CONNECT_VISITOR_MESSAGING" || action === "FIX_VISITOR_MESSAGING") return TEXTING_KEYS_NEEDED;
  if (action === "TEST_VISITOR_MESSAGING" || action === "RECONNECT_VISITOR_MESSAGING") return TEXTING_TESTING;
  return TEXTING_NOT_CHOSEN;
}

function textingLine(status: InstallationStatus): string {
  return textingSummary(component(status, "VISITOR_MESSAGING"));
}

/** The texting line, plus the number visitors text once texting works, so the host can always ask for it. */
function textingOf(inst: Installation, status: InstallationStatus): { summary: string; number?: string } {
  const number = component(status, "VISITOR_MESSAGING")?.state === "READY" ? activeFromNumber(inst) : undefined;
  return { summary: textingLine(status), ...(number ? { number } : {}) };
}

function setupOf(services: OperatorServices, inst: Installation, picture: Picture, status: InstallationStatus) {
  if (!picture.id || !picture.draft) return undefined;
  const draft = picture.draft;
  const view = draftView(draft);
  const saved = services.workspace.has(picture.id) ? services.workspace.load(picture.id) : undefined;
  const texting = visitorTexting(services, picture.id, draft.messagingMode, installedMessaging(inst, { readOnly: true }));
  return {
    propertyId: picture.id,
    name: operatorFacingPropertyName(draft),
    address: view.property.address,
    propertyType: draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : "Not chosen yet",
    ...(view.property.timezone ? { timezone: view.property.timezoneLabel } : {}),
    status: saved ? statusLabel(saved) : "Setup in progress",
    units: view.units.map((unit) => ({
      name: operatorUnitName(draft.property, unit.name),
      ...(unit.door ? { door: unit.door.name } : {}),
      ...(unit.route ? { route: unit.route.doorNames.join(" → ") } : {}),
    })),
    doors: view.doors.map((door) => ({ name: door.name, kind: door.kindLabel })),
    routes: view.units.filter((unit) => unit.route).map((unit) => ({ unit: operatorUnitName(draft.property, unit.name), doors: unit.route!.doorNames })),
    hours: view.tourHours.summary ?? view.tourHours.label,
    verification: view.reviewCards.find((card) => card.step === "verification")?.rows ?? [],
    texting: texting.label,
    alerts: alertsLine(status),
  };
}

function propertyList(services: OperatorServices) {
  const ws = services.workspace;
  return ws
    .propertyIds()
    .filter((id) => !ws.has(id) || !ws.load(id).state.removedAt)
    .map((id) => {
      const { draft } = ws.openDraft(id);
      const saved = ws.has(id) ? ws.load(id) : undefined;
      return { propertyId: id, name: operatorFacingPropertyName(draft), address: draft.property.address, status: saved ? statusLabel(saved) : "Setup in progress" };
    });
}

/** Building access and the entrance name come before a condo route can be saved. Profile and entry instructions come after the route. */
function unitsDetailSay(draft: SetupDraft): string | undefined {
  const condo = condoNextQuestion(draft);
  if (condo && (condo.nextQuestion === BUILDING_ACCESS_QUESTION || condo.nextQuestion === BUILDING_ENTRANCE_QUESTION)) return condo.nextQuestion;
  const profile = nextProfileQuestion(draft.units);
  if (profile) return profile.question;
  if (condo?.nextQuestion === ENTRY_INSTRUCTIONS_QUESTION) return condo.nextQuestion;
  return undefined;
}

function toolFor(step: StepId, draft: SetupDraft | undefined): string {
  if (step === "units-details" && draft) {
    const condo = condoNextQuestion(draft);
    if (condo?.nextQuestion === BUILDING_ACCESS_QUESTION) return "save_property";
    if (condo?.nextQuestion === BUILDING_ENTRANCE_QUESTION) return "save_doors_and_routes";
    if (nextProfileQuestion(draft.units)) return "save_units";
    if (condo?.nextQuestion === ENTRY_INSTRUCTIONS_QUESTION) return "save_property";
  }
  return milestoneToolFor(step);
}

const RAW_SLOT = /\{[A-Za-z][A-Za-z0-9]*\}/;
export const DRIVE_NOT_SET_UP_LINE = "Google Drive isn't set up for Tour Core yet, so I'll keep your records on this computer for now.";

/** Open-source install with no Tour Core Google app yet. The landlord keeps records on this computer. */
function driveNotSetUpLine(inst: Installation): string | undefined {
  if (isHostedRailway(inst.deploymentMode())) return undefined;
  if (inst.records.provider() !== "NOT_CONFIGURED") return undefined;
  const google = googleClientConfig(inst.env(), (name) => inst.secrets.get(name as SettingName));
  if (google.clientId && google.clientSecret) return undefined;
  return DRIVE_NOT_SET_UP_LINE;
}

/** The line for this step, with saved details filled in. Never leaves a raw slot. */
function sayFor(client: ReportedClient | undefined, step: StepId, draft: SetupDraft | undefined): string {
  let say = spokenAsk(client, step);
  if (step === "units-details" && draft) {
    const detail = unitsDetailSay(draft);
    if (detail) say = detail;
  }
  if (step === "hours" && draft) say = hoursStepSay(draft.tourHours);
  if ((step === "property-address" || step === "property-confirm") && draft?.property.canonicalAddress) {
    const part = nextAddressPartQuestion(draft.property.canonicalAddress);
    if (part) say = part;
    else if (draft.property.addressConfirmed === false) {
      const question = addressConfirmQuestion(draft.property.canonicalAddress);
      if (question) say = question;
    }
  }
  if (RAW_SLOT.test(say) && draft) say = say.replaceAll("{address}", draft.property.address);
  if (RAW_SLOT.test(say)) throw new SetupInputError("UNFILLED_SLOT", "That line still has a blank.");
  return say;
}

/** A published property whose zone is blank or not a real place. Tours stay off until one is set. */
function publishedMissingZone(workspace: PropertyWorkspace, onlyId?: string): boolean {
  const ids = onlyId ? [onlyId] : workspace.propertyIds();
  return ids.some((propertyId) => {
    if (!workspace.has(propertyId)) return false;
    const saved = workspace.load(propertyId);
    return saved.state.status === "PUBLISHED_FOR_DEMO" && !saved.state.removedAt && !isValidTimeZone(saved.config.property.timezone);
  });
}

/** One read-only picture. Does not persist texting choices or probe the disk. */
export function readState(input: StateReadInput, propertyId?: string): Record<string, unknown> {
  const inst = input.installation;
  if (!inst) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  const status = getInstallationStatus(inst, input.services, { readOnly: true });
  const requested = propertyId?.trim() || undefined;
  const id = requested ?? primaryProperty(input.services.workspace)?.id;
  if (requested) {
    const known = input.services.workspace.propertyIds().includes(requested);
    if (!known) {
      try {
        input.services.workspace.openDraft(requested);
      } catch {
        throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
      }
    }
  }
  const picture = pictureOf(input.services, id);
  const milestones = milestonesFor(status, picture);
  const current = milestones.find((milestone) => milestone.status === "next") ?? null;
  const next = presentNext(status);
  const zoneBlock = publishedMissingZone(input.services.workspace, requested);
  const alerts = component(status, "OPERATOR_ALERTS");
  const addressSaved = !!inst.env().TOURCORE_GROK_ROUTINE_URL?.trim();
  const alertsDegraded = !zoneBlock && next.component === "OPERATOR_ALERTS" && alerts?.state === "DEGRADED";
  const alertsReconnect = !zoneBlock && next.component === "OPERATOR_ALERTS" && alerts?.state === "ERROR" && addressSaved;
  const step = alertsDegraded ? "alerts-degraded" : alertsReconnect ? "alerts-error" : focusStep(milestones, next.action, picture);
  const say = zoneBlock ? UNSET_ZONE_LINE : (inst && step === "backups" && driveNotSetUpLine(inst)) || sayFor(input.client, step, picture.draft);
  const playbook = renderPlaybook(input.client, step, say, { sharedService: isTenantWorker(inst.deploymentMode()) });
  const copy = SHARED_STEPS[step];
  const setup = setupOf(input.services, inst, picture, status);
  return {
    summary: zoneBlock ? UNSET_ZONE_LINE : current ? `${current.title} is next.` : status.phase === "OPERATE" ? "Your property is published." : "Nothing is waiting on you.",
    scope: requested ? "property" : "install",
    ...(requested ? {} : { properties: propertyList(input.services) }),
    ...(setup ? { setup } : {}),
    units: setup?.units ?? [],
    doors: setup?.doors ?? [],
    routes: setup?.routes ?? [],
    hours: setup?.hours ?? null,
    verification: setup?.verification ?? [],
    texting: textingOf(inst, status),
    alerts: { summary: alertsLine(status) },
    health: { summary: healthLine(inst, status) },
    storage: { summary: storageLine(inst) },
    milestones,
    currentMilestone: current?.id ?? null,
    nextStep: {
      action: next.action,
      component: next.component,
      tool: zoneBlock ? "save_property" : alertsDegraded ? "test_operator_alerts" : alertsReconnect ? "get_secure_setup_url" : toolFor(step, picture.draft),
      say,
      doneLooksLike: copy.done,
    },
    playbook: { id: playbook.id, version: playbook.version, mode: playbook.mode, step: playbook.step, text: playbook.text },
  };
}

export type { MilestoneId };
