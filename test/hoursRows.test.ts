import { afterEach, describe, expect, it } from "vitest";
import { OWNER_KINDS, routeFact } from "../src/hours-log/ownerRules";
import { DEFAULT_SOURCES, factsFrom, ownerLockEntries, readRecords, type RowFact, type RowSource } from "../src/hours-log/sources";
import { buildMonth } from "../src/hours-log/month";
import { emptyFolder, engine, fixer, live, octoberFolder, supply, type Fixture } from "./hoursFixture";

/** #238: one fact per thing someone did, from the records Property Core already keeps. */

let open: Fixture | undefined;
afterEach(() => {
  open?.cleanup();
  open = undefined;
});

function october(): RowFact[] {
  open = octoberFolder();
  return factsFrom(readRecords(open.root));
}

const byKind = (facts: RowFact[], kind: string) => facts.filter((fact) => fact.kind === kind);

describe("rows from Cleaner Core", () => {
  it("a finished cleaning is one row in the cleaner's log, from START to DONE, on site", () => {
    const [row] = byKind(october(), "cleaning").filter((fact) => fact.reference.includes("job_oct4"));
    expect(row).toMatchObject({ log: "cleaner", actor: "cleaner", participant: "Ana", at: "2026-10-04T15:05:00.000Z", until: "2026-10-04T17:35:00.000Z", onSite: true, timing: "measured" });
    expect(row?.reference).toBe("Cleaner Core job job_oct4");
  });

  it("a cleaning with no START starts at the arrival time and says so", () => {
    const [row] = byKind(october(), "cleaning").filter((fact) => fact.reference.includes("job_oct12"));
    expect(row).toMatchObject({ at: "2026-10-12T15:00:00.000Z", until: "2026-10-12T17:00:00.000Z", timing: "scheduled" });
    expect(row?.needs).toContain("START");
  });

  it("a called-off cleaning leaves no row", () => {
    expect(october().some((fact) => fact.reference.includes("job_oct25"))).toBe(false);
  });

  it("the host's cleaning time and the host's own pay mark are owner rows; a receipt the system read is not", () => {
    const facts = october();
    expect(byKind(facts, "confirm-times")).toEqual([expect.objectContaining({ log: "owner", actor: "host", at: "2026-10-03T22:00:00.000Z", onSite: false })]);
    expect(byKind(facts, "pay-cleaner")).toEqual([expect.objectContaining({ log: "owner", actor: "host", at: "2026-10-05T13:30:00.000Z" })]);
    expect(byKind(facts, "record-payment")).toEqual([expect.objectContaining({ log: "property-core", actor: "system", at: "2026-10-13T12:00:00.000Z" })]);
  });
});

describe("rows from Fixer Core", () => {
  it("the pro's visit is a row in the pro's own log, from the booking's start to done", () => {
    const visits = byKind(october(), "repair-visit");
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({ log: "pro:pro_drip", actor: "pro", participant: "Drip Plumbing", at: "2026-10-08T13:00:00.000Z", until: "2026-10-08T14:30:00.000Z", onSite: true, timing: "scheduled" });
    expect(visits[0]?.reference).toBe("Fixer Core job job_sink, cost $180.00 from the pro");
  });

  it("each of the host's approvals is its own owner row", () => {
    const facts = october();
    for (const [kind, at] of [
      ["approve-repair", "2026-10-06T14:00:00.000Z"],
      ["pick-quote", "2026-10-07T15:00:00.000Z"],
      ["approve-booking", "2026-10-07T16:00:00.000Z"],
      ["approve-price", "2026-10-08T13:45:00.000Z"],
      ["record-cost", "2026-10-16T12:00:00.000Z"],
    ] as const) {
      expect(byKind(facts, kind), kind).toEqual([expect.objectContaining({ log: "owner", actor: "host", at, onSite: false })]);
    }
  });

  it("a repair the agent or the pro marked done is no owner row", () => {
    expect(byKind(october(), "confirm-repair")).toEqual([]);
  });
});

describe("rows from Supply Core", () => {
  it("an order the rules placed is in Property Core's log only", () => {
    const rows = october().filter((fact) => fact.reference.startsWith("Supply Core order ord_rules"));
    expect(rows).toEqual([expect.objectContaining({ kind: "auto-order", log: "property-core", actor: "system" })]);
  });

  it("an order the host approved on the Pay card is the host's approval, and the agent's placing", () => {
    const rows = october().filter((fact) => fact.reference.startsWith("Supply Core order ord_card"));
    expect(rows.map((row) => [row.kind, row.log])).toEqual([
      ["approve-order", "owner"],
      ["auto-order", "property-core"],
    ]);
    expect(rows[0]?.reference).toBe("Supply Core order ord_card, store order EM-1001");
  });

  it("an order the host placed in the browser is the host's own purchasing row", () => {
    const rows = october().filter((fact) => fact.reference.startsWith("Supply Core order ord_self"));
    expect(rows).toEqual([expect.objectContaining({ kind: "place-order", log: "owner", actor: "host" })]);
    expect(rows[0]?.task).toBe("Supply order from Example Mart: Paper towels x1, $24.00");
  });
});

describe("the system never writes owner time for its own work", () => {
  it("every owner row in a full month is the host's own action", () => {
    const owner = october().filter((fact) => fact.log === "owner");
    expect(owner.length).toBeGreaterThan(0);
    for (const fact of owner) {
      expect(fact.actor).toBe("host");
      expect(OWNER_KINDS.has(fact.kind)).toBe(true);
    }
  });

  it("a source that puts its own work in the owner's log is moved to Property Core's", () => {
    open = octoberFolder();
    const rogue: RowSource = () => [{ kind: "approve-order", actor: "system", log: "owner", participant: "", at: "2026-10-02T12:00:00.000Z", task: "Approved by rules", reference: "Supply Core order ord_x", onSite: false, timing: "rule" }];
    const facts = factsFrom(readRecords(open.root), [...DEFAULT_SOURCES, rogue]);
    const moved = facts.find((fact) => fact.reference === "Supply Core order ord_x");
    expect(moved).toMatchObject({ log: "property-core", timing: "system" });
  });

  it("a host action outside the owner kinds is not an owner row either", () => {
    expect(routeFact({ kind: "cleaning", actor: "host", log: "owner", participant: "", at: "2026-10-02T12:00:00.000Z", task: "x", reference: "y", onSite: true, timing: "measured" }).log).toBe("property-core");
  });
});

describe("sources", () => {
  it("an empty folder gives no rows and no error", () => {
    open = emptyFolder();
    expect(factsFrom(readRecords(open.root))).toEqual([]);
  });

  it("owner entries on standing lock codes wait on the lock connection (#180) and give nothing yet", () => {
    open = octoberFolder();
    expect(ownerLockEntries(readRecords(open.root))).toEqual([]);
    expect(DEFAULT_SOURCES).toContain(ownerLockEntries);
  });

  it("every row has a supporting reference", () => {
    for (const fact of october()) expect(fact.reference.trim()).not.toBe("");
  });
});

describe("one action of the host's is one owner row (review of #238)", () => {
  it("cleaning times saved in one call, for checkout and check-in, are one row", () => {
    open = octoberFolder();
    const at = "2026-10-11T20:00:00.000Z";
    open.write("cleaner-job/cleaner-core.json", {
      ...engine,
      hostFacts: [
        { jobId: "job_oct12", field: "checkout", version: 1, minutes: 660, at },
        { jobId: "job_oct12", field: "checkin", version: 1, minutes: 960, at },
      ],
    });
    const rows = byKind(factsFrom(readRecords(open.root)), "confirm-times");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reference).toContain("checkout v1");
    expect(rows[0]?.reference).toContain("checkin v1");
  });

  it("a repair the host marked done with its cost is one row", () => {
    open = octoberFolder();
    const at = "2026-10-15T15:00:00.000Z";
    open.write("fixer.json", { ...fixer, jobs: [{ ...fixer.jobs[1], done: { at, by: "host" }, cost: { cents: 12000, by: "host", at } }] });
    const owner = factsFrom(readRecords(open.root)).filter((fact) => fact.log === "owner" && fact.reference.startsWith("Fixer Core"));
    expect(owner).toHaveLength(1);
    expect(owner[0]?.task).toContain("is done");
    expect(owner[0]?.task).toContain("$120.00");
  });

  it("each time the host moved a visit is an owner row", () => {
    open = octoberFolder();
    open.write("fixer.json", { ...fixer, jobs: [{ ...fixer.jobs[0], reschedules: [{ at: "2026-10-07T18:00:00.000Z", reason: "guest stayed late" }] }] });
    expect(byKind(factsFrom(readRecords(open.root)), "reschedule-repair")).toEqual([expect.objectContaining({ log: "owner", actor: "host", at: "2026-10-07T18:00:00.000Z" })]);
  });
});

describe("only the landlord's own pay mark is the owner's (review of #238)", () => {
  it("a pay record that doesn't say who confirmed it is Property Core's", () => {
    open = octoberFolder();
    open.write("cleaner-live.json", { ...live, pay: { job_oct4: { ...live.pay.job_oct4, confirmedBy: undefined } } });
    const facts = factsFrom(readRecords(open.root));
    expect(byKind(facts, "pay-cleaner")).toEqual([]);
    expect(byKind(facts, "record-payment")).toHaveLength(1);
  });

  it("a row moved out of the owner's log names Property Core as its participant", () => {
    expect(routeFact({ kind: "approve-order", actor: "system", log: "owner", participant: "", at: "2026-10-02T12:00:00.000Z", task: "x", reference: "y", onSite: false, timing: "rule" }).participant).toBe("Property Core");
  });
});

describe("a confirmed month keeps the host's approvals (review of #238)", () => {
  it("an approval saved with the month comes back after its record was replaced", () => {
    open = octoberFolder();
    const before = factsFrom(readRecords(open.root)).filter((fact) => fact.log === "owner");
    const kept = before.filter((fact) => fact.kind === "approve-booking");
    open.write("fixer.json", { ...fixer, jobs: [{ ...fixer.jobs[0], booking: undefined, state: "booked" }, fixer.jobs[1]] });
    expect(byKind(factsFrom(readRecords(open.root)), "approve-booking")).toEqual([]);
    expect(byKind(factsFrom(readRecords(open.root), DEFAULT_SOURCES, kept), "approve-booking")).toEqual(kept);
    // Kept and still in the record, it's one row, not two.
    open.write("fixer.json", fixer);
    expect(byKind(factsFrom(readRecords(open.root), DEFAULT_SOURCES, kept), "approve-booking")).toHaveLength(1);
  });
});

describe("a replaced approval is still the host's (#238 follow-up)", () => {
  const sink = fixer.jobs[0]!;
  const steps = [
    { kind: "approve-repair", at: sink.hostGo!.at },
    { kind: "pick-quote", at: sink.quotePick!.at, proId: "pro_drip" },
    { kind: "approve-booking", at: sink.booking.hostYes!.at, proId: "pro_drip" },
    { kind: "approve-price", at: sink.booking.revisedQuote!.hostYes!.at, proId: "pro_drip", cents: 18000 },
  ];

  it("unchanged fingerprint: the October records build the same month as before the records were kept", () => {
    open = octoberFolder();
    expect(buildMonth(readRecords(open.root), "2026-10", {}).fingerprint).toBe("9a5c8afbed7a805ed31f49edc1b5095cd57e19f7002bd0b58905fc05b500129e");
  });

  it("a step whose live field is still there adds nothing", () => {
    open = octoberFolder();
    const before = factsFrom(readRecords(open.root));
    open.write("fixer.json", { ...fixer, jobs: [{ ...sink, hostSteps: steps }, fixer.jobs[1]] });
    expect(factsFrom(readRecords(open.root))).toEqual(before);
    expect(buildMonth(readRecords(open.root), "2026-10", {}).fingerprint).toBe("9a5c8afbed7a805ed31f49edc1b5095cd57e19f7002bd0b58905fc05b500129e");
  });

  it("a booking yes, a raised-price yes and a quote pick lost to a moved visit come back as the same owner rows", () => {
    open = octoberFolder();
    const before = factsFrom(readRecords(open.root)).filter((fact) => fact.log === "owner" && fact.reference === "Fixer Core job job_sink");
    // The visit was moved: the booking went, with both of the host's yeses on it, and the pick was cleared.
    const { booking: _booking, quotePick: _pick, done: _done, cost: _cost, ...moved } = sink;
    open.write("fixer.json", { ...fixer, jobs: [{ ...moved, state: "contacted", hostSteps: steps }, fixer.jobs[1]] });
    const after = factsFrom(readRecords(open.root)).filter((fact) => fact.log === "owner" && fact.reference === "Fixer Core job job_sink");
    expect(after).toEqual(before);
    expect(after.map((fact) => fact.task)).toEqual([
      "Approved the plumbing repair: Kitchen sink leaks",
      "Picked Drip Plumbing's quote for the plumbing repair: Kitchen sink leaks",
      "Approved Drip Plumbing's booking for the plumbing repair: Kitchen sink leaks",
      "Approved the new price of $180.00 for the plumbing repair: Kitchen sink leaks",
    ]);
  });

  it("a cost and a done the host saved come back after they were replaced", () => {
    open = octoberFolder();
    const gutter = fixer.jobs[1]!;
    open.write("fixer.json", { ...fixer, jobs: [sink, { ...gutter, cost: { cents: 13000, by: "agent", at: "2026-10-17T12:00:00.000Z" }, hostSteps: [{ kind: "record-cost", at: "2026-10-16T12:00:00.000Z", cents: 12000 }, { kind: "confirm-repair", at: "2026-10-16T13:00:00.000Z" }] }] });
    const owner = factsFrom(readRecords(open.root)).filter((fact) => fact.log === "owner" && fact.reference === "Fixer Core job job_gutter");
    expect(owner.map((fact) => [fact.kind, fact.at, fact.task])).toEqual([
      ["record-cost", "2026-10-16T12:00:00.000Z", "Recorded the cost of $120.00 for the gutters repair: Clean the gutters"],
      ["confirm-repair", "2026-10-16T13:00:00.000Z", "Confirmed the gutters repair: Clean the gutters is done"],
    ]);
  });

  it("a cleaning time cleared by a moved date is still the host's, for the checkout it was given for", () => {
    open = octoberFolder();
    open.write("cleaner-job/cleaner-core.json", { ...engine, hostFacts: [], clearedHostFacts: [{ ...engine.hostFacts[0], checkoutDate: "2026-10-03" }] });
    expect(byKind(factsFrom(readRecords(open.root)), "confirm-times")).toEqual([
      expect.objectContaining({ log: "owner", at: "2026-10-03T22:00:00.000Z", task: "Gave the cleaner's checkout time for the 2026-10-03 checkout", reference: "Cleaner Core job job_oct4, host time checkout v1" }),
    ]);
  });

  const unconfirmed = { id: "ord_lost", at: "2026-10-20T14:00:00.000Z", store: "Example Mart", items: [{ itemId: "itm_towels", product: "preferred", qty: 2, unitCents: 2400 }], totalCents: 4800, chargedCents: 4800, source: "schedule", approvedBy: "landlord", status: "unconfirmed" };
  const approval = { id: "apv_lost000001", at: "2026-10-20T14:00:00.000Z", store: "Example Mart", items: [{ itemId: "itm_towels", qty: 2 }], totalCents: 4800, orderId: "ord_lost", orderAt: "2026-10-20T14:00:00.000Z" };

  it("an approval whose order is still there adds nothing", () => {
    open = octoberFolder();
    open.write("supply.json", { ...supply, orders: [...supply.orders, unconfirmed] });
    const before = factsFrom(readRecords(open.root));
    open.write("supply.json", { ...supply, orders: [...supply.orders, unconfirmed], approvals: [approval] });
    expect(factsFrom(readRecords(open.root))).toEqual(before);
  });

  it("removed order: an approval whose unconfirmed order was removed gives back that order's owner fact exactly", () => {
    open = octoberFolder();
    open.write("supply.json", { ...supply, orders: [...supply.orders, unconfirmed] });
    const kept = factsFrom(readRecords(open.root)).filter((fact) => fact.log === "owner" && fact.reference === "Supply Core order ord_lost");
    expect(kept).toHaveLength(1);
    // Removed as not-placed after the host confirmed the month.
    open.write("supply.json", { ...supply, approvals: [approval] });
    const without = factsFrom(readRecords(open.root)).filter((fact) => fact.reference === "Supply Core order ord_lost");
    expect(without).toEqual(kept);
    const withKept = factsFrom(readRecords(open.root), DEFAULT_SOURCES, kept).filter((fact) => fact.log === "owner" && fact.at === approval.at);
    expect(withKept).toEqual(kept);
  });

  it("an approval that never became an order is an owner row that says it wasn't placed", () => {
    open = octoberFolder();
    const { orderId: _o, orderAt: _a, ...closed } = approval;
    open.write("supply.json", { ...supply, approvals: [closed] });
    expect(factsFrom(readRecords(open.root)).filter((fact) => fact.reference === "Supply Core approval apv_lost000001")).toEqual([
      expect.objectContaining({ kind: "approve-order", actor: "host", log: "owner", at: approval.at, task: "Approved a supply order from Example Mart: Paper towels x2, $48.00. It wasn't placed." }),
    ]);
  });

  it("an approved cart still open, or expired but not yet swept, gives no row until it closes", () => {
    open = octoberFolder();
    const { orderId: _o, orderAt: _a, ...pending } = approval;
    const cart = { token: "cart_scratch", fingerprint: "f", cart: { store: "Example Mart", items: [{ itemId: "itm_towels", product: "preferred", qty: 2, unitCents: 2400 }], shippingCents: 0, taxCents: 0, totalCents: 4800 }, status: "approved", holds: [], source: "schedule", deadline: "2026-10-25", approvalId: pending.id };
    // One still in its 30 minutes, and one long expired that no Supply call has swept yet.
    for (const expiresAt of ["2026-12-01T00:00:00.000Z", "2026-10-20T14:30:00.000Z"]) {
      open.write("supply.json", { ...supply, carts: [{ ...cart, expiresAt }], approvals: [pending] });
      expect(factsFrom(readRecords(open.root)).filter((fact) => fact.reference.includes("apv_lost000001"))).toEqual([]);
    }
  });
});
