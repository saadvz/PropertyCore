import { isLiveMessaging, TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { usesLocalMessaging } from "../messaging/propertyScope";
import { visitorSubject } from "../visitor/identity";
import { FIELD_WORDS, missingProfileFields } from "../config/unitProfile";
import type { ConfigIssue, ConfigSection } from "../config/validateConfig";
import { SimulatedClock } from "../core/clock";
import { nextTourDay } from "../core/schedule";
import { TourCore } from "../core/TourCore";
import { checkMessaging, createDurin, createStore, createVerificationProvider } from "../createTourCore";
import { DemoMessagingAdapter } from "../messaging/Messenger";
import type { MessagingCheck } from "../messaging/sendblue/readiness";
import { probeRuntimeStore, type RuntimeStore } from "../storage/runtimeStore";
import { joinList as listWords } from "../operator/tourDayWords";

export type ReadinessCheckId = "property" | "units" | "hours" | "routes" | "verification" | "messaging" | "storage" | "progress" | "access" | "audit";

export interface ReadinessProblem {
  code: string;
  message: string;
  /** Underlying technical error, for developer mode only. */
  detail?: string;
  /** Which part of setup the problem lives in, when it comes from the setup answers. */
  section?: ConfigSection;
  unitId?: string;
}

export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  ok: boolean;
  /** Plain-language problems; empty when ok. */
  problems: string[];
  /** Machine-readable codes matching problems. */
  codes: string[];
  details: ReadinessProblem[];
}

export interface ReadinessResult {
  passed: boolean;
  checkedAt: string;
  checks: ReadinessCheck[];
  /** Step-by-step messaging connection checks (empty for demo messaging). */
  messaging?: MessagingCheck[];
  /** Optional notes that do not fail the check. */
  advisories?: string[];
}

const LABELS: Record<ReadinessCheckId, string> = {
  property: "Property details",
  units: "Unit information",
  hours: "Tour hours",
  routes: "Unit routes",
  verification: "Verification",
  messaging: "Messaging",
  storage: "Records",
  progress: "Tour progress can be safely saved",
  access: "Door access",
  audit: "Audit/export",
};

const SECTION_TO_CHECK: Record<ConfigSection, ReadinessCheckId> = {
  property: "property",
  hours: "hours",
  units: "routes",
  routes: "routes",
  verification: "verification",
  services: "messaging",
};

/**
 * Deterministic: the same config and clock give the same answer. Each check
 * exercises the real application pieces the config selects, not canned text.
 */
export async function runReadinessCheck(
  input: unknown,
  options: {
    now?: Date;
    /** Where running text-message tours are saved. When given, real-phone properties also check it works. */
    runtime?: RuntimeStore;
    /** Why this property can't use its texting number (the number itself isn't valid). */
    lineProblem?: string;
    /** Installation messaging provider, so local loopback is labeled test mode. */
    installed?: { provider?: string };
  } = {},
): Promise<ReadinessResult> {
  const now = options.now ?? new Date();
  const realPhones = isLiveMessaging((input as { messagingMode?: string } | undefined)?.messagingMode);
  const ids = (Object.keys(LABELS) as ReadinessCheckId[]).filter((id) => id !== "progress" || (realPhones && options.runtime));
  const problems = new Map<ReadinessCheckId, ReadinessProblem[]>(ids.map((k) => [k, []]));
  const fail = (id: ReadinessCheckId, problem: ReadinessProblem) => problems.get(id)!.push(problem);
  if (options.lineProblem) fail("messaging", { code: "LINE_IN_USE", message: options.lineProblem, section: "services" });

  const issues: ConfigIssue[] = validateConfig(input);
  for (const issue of issues) {
    fail(SECTION_TO_CHECK[issue.section], { code: issue.code, message: issue.message, section: issue.section, ...(issue.unitId ? { unitId: issue.unitId } : {}) });
  }

  const shape = TourCoreConfigShape.safeParse(input);
  if (!shape.success) {
    for (const id of ["messaging", "storage", "access", "audit"] as const) fail(id, { code: "SETUP_INCOMPLETE", message: "Finish the setup answers first." });
    return finish(problems, now);
  }
  const config = shape.data;

  // Every unit needs its basic leasing details, each either given or explicitly marked not provided.
  for (const unit of config.units) {
    const missing = missingProfileFields(unit);
    if (missing.length) {
      fail("units", {
        code: "UNIT_INFO_MISSING",
        message: `${visitorSubject(config.property, unit.name)} still needs ${listWords(missing.map((f) => FIELD_WORDS[f]))} (or say which you don't want listed).`,
        section: "units",
        unitId: unit.id,
      });
    }
  }

  if (!issues.some((i) => i.section === "hours" || i.code === "TIMEZONE_INVALID")) {
    try {
      nextTourDay(config, now);
    } catch {
      fail("hours", { code: "NO_UPCOMING_TOURS", message: "There are no tour times in the next two weeks.", section: "hours" });
    }
  }

  await probe(fail, "verification", "verification", () => createVerificationProvider(config));
  const messagingChecks = await checkMessaging(config).catch(() => [
    { id: "account" as const, label: "Visitor messaging", ok: false, code: "MESSAGING_CHECK_FAILED", message: "Couldn't check visitor messaging right now." },
  ]);
  for (const c of messagingChecks.filter((c) => !c.ok)) fail("messaging", { code: c.code ?? "MESSAGING_NOT_READY", message: c.message, section: "services" });
  await probe(fail, "storage", "services", async () => {
    const store = createStore(config);
    const record = { id: "readiness_probe", name: "Readiness probe", phone: "+10000000000", createdAt: now.toISOString() };
    await store.put("prospects", record);
    if ((await store.get("prospects", record.id))?.id !== record.id) throw new Error("Tour records couldn't be saved and read back.");
  });
  if (problems.has("progress")) {
    try {
      probeRuntimeStore(options.runtime!, now);
    } catch (err) {
      fail("progress", { code: "PROGRESS_NOT_SAVEABLE", message: "Tour Core can't safely save active tours right now.", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  await probe(fail, "access", "services", async () => {
    const health = await createDurin(config, new SimulatedClock(now), () => {}).getHealth();
    if (!health.healthy) throw new Error("The door system isn't responding right now, so doors would stay locked.");
  });
  if (issues.length === 0) {
    await probe(fail, "audit", undefined, async () => {
      const clock = new SimulatedClock(now);
      const core = new TourCore({
        config: config as TourCoreConfig,
        clock,
        store: createStore(config),
        messenger: new DemoMessagingAdapter(() => {}),
        verification: createVerificationProvider(config),
        durin: createDurin(config, clock, () => {}),
      });
      await core.exportRecords();
    });
  } else {
    fail("audit", { code: "SETUP_INCOMPLETE", message: "Tour records can be checked once the items above are fixed." });
  }

  const result = finish(problems, now);
  if (usesLocalMessaging(config, options.installed)) {
    const messaging = result.checks.find((c) => c.id === "messaging")!;
    messaging.label = messaging.ok ? "Visitor texting: test mode" : "Visitor messaging";
  } else if (isLiveMessaging(config.messagingMode)) {
    const messaging = result.checks.find((c) => c.id === "messaging")!;
    messaging.label = messaging.ok ? "Visitor messaging connected" : "Visitor messaging";
  }
  const advisories = config.operator.visitorContact
    ? []
    : ["No visitor help number is set, so stuck visitors can only text back."];
  return { ...result, messaging: messagingChecks, advisories };
}

async function probe(
  fail: (id: ReadinessCheckId, problem: ReadinessProblem) => void,
  id: ReadinessCheckId,
  section: ConfigSection | undefined,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = (err as { code?: string }).code ?? "CHECK_FAILED";
    fail(id, { code, message: err instanceof Error ? err.message : "Something went wrong during this check.", ...(section ? { section } : {}) });
  }
}

function finish(problems: Map<ReadinessCheckId, ReadinessProblem[]>, now: Date): ReadinessResult {
  const checks = (Object.keys(LABELS) as ReadinessCheckId[])
    .filter((id) => problems.has(id))
    .map((id) => {
      const list = problems.get(id)!;
      const label = id === "progress" && list.length ? "Saving tour progress" : LABELS[id];
      return { id, label, ok: list.length === 0, problems: list.map((p) => p.message), codes: list.map((p) => p.code), details: list };
    });
  return { passed: checks.every((c) => c.ok), checkedAt: now.toISOString(), checks };
}
