import { createHash, randomInt } from "node:crypto";
import { isValidTimeZone, localDateOf } from "../core/timezone";
import { askNext } from "../cleaner-core/setupAsk";
import { ConfirmationBook } from "../operator/confirmations";
import { refuseCards } from "./cards";
import type { Mode } from "./gate";
import { nextDates, scheduleProblem, type Schedule } from "./schedule";
import { supplySetupAsk } from "./setupAsk";
import { monthSpentCents, readSupply, writeSupply, type Item, type Product, type SupplyFile } from "./store";

/**
 * Supply Core's desk: every tool's behaviour over one tenant's `supply.json`. One call at a time.
 * It never sees a card detail and never buys anything; Grok shops and reports back.
 */

export interface SupplyReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface SupplyDeps {
  now(): Date;
  /** True for a supplies tenant; false for a cleaning tenant with the add-on. */
  standalone: boolean;
  cleaning?: {
    property(): { name: string; address: string; timeZone: string } | undefined;
    turnovers(): Promise<{ checkoutYmd: string }[]>;
  };
}

export const MAX_ITEMS = 30;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const CARD_REFUSAL = "That looks like a card number. Supply Core never takes card details: keep them in your Vault.";
const APPROVAL_STALE = "That approval has expired or doesn't match this change. Ask the host again.";

export interface ProductInput {
  title: string;
  store: string;
  url: string;
  packSize: string;
  priceCents: number;
}

export interface ItemInput {
  id?: string;
  name?: string;
  qtyPerOrder?: number;
  preferred?: ProductInput;
  backup?: ProductInput | null;
  storeNote?: string;
  schedule?: Schedule;
  confirmation?: string;
  done?: true;
}

export interface SettingsInput {
  property?: { name: string; address: string; timeZone: string };
  mode?: Mode;
  perOrderCapCents?: number | null;
  perMonthCapCents?: number | null;
  priceJumpPct?: number;
  bufferDays?: number;
  checkTime?: string;
  routineCreated?: true;
  confirmation?: string;
}

export function newId(prefix: string, length: number): string {
  return `${prefix}${Array.from({ length }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join("")}`;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ok = (structured: Record<string, unknown>): SupplyReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): SupplyReply => ({ text, isError: true });

const isInt = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
const isText = (s: unknown, max: number): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max;

function productProblem(p: ProductInput | undefined, which: string): string | undefined {
  if (!p) return `The ${which} product is missing.`;
  if (!isText(p.title, 200)) return `The ${which} product needs a title under 200 characters.`;
  if (!isText(p.store, 60)) return `The ${which} product needs a store name under 60 characters.`;
  if (!isText(p.packSize, 60)) return `The ${which} product needs a pack size under 60 characters.`;
  if (typeof p.url !== "string" || p.url.length > 500 || !/^https:\/\/[^\s/]+\.[^\s]+$/.test(p.url)) return `The ${which} product needs an https link.`;
  if (!isInt(p.priceCents, 1, 500_000)) return `The ${which} product's price has to be from 1 cent to $5,000.`;
  return undefined;
}

export class SupplyDesk {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly approvals: ConfirmationBook;

  constructor(
    readonly root: string,
    readonly deps: SupplyDeps,
  ) {
    this.approvals = new ConfirmationBook(10 * 60_000, () => deps.now().getTime());
  }

  /** Runs calls one at a time, so two tools never write the record at once. */
  protected serial<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Every call starts here: card-like input is refused before anything is read or saved. */
  protected guarded(args: unknown, work: () => Promise<SupplyReply> | SupplyReply): Promise<SupplyReply> {
    if (refuseCards(args)) return Promise.resolve(fail(CARD_REFUSAL));
    return this.serial(work);
  }

  protected read(): SupplyFile {
    return readSupply(this.root);
  }

  protected write(file: SupplyFile): void {
    writeSupply(this.root, file);
  }

  protected property(file: SupplyFile): { name: string; address: string; timeZone: string } | undefined {
    return this.deps.standalone ? file.settings.property : this.deps.cleaning?.property();
  }

  protected timeZone(file: SupplyFile): string {
    return this.property(file)?.timeZone ?? "UTC";
  }

  protected today(file: SupplyFile): string {
    const { year, month, day } = localDateOf(this.deps.now(), this.timeZone(file));
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  /**
   * After Activate a change waits for the host's yes: the first call returns the question and a code
   * bound to that exact change, and only the second call, with the code, saves it.
   */
  protected approved(file: SupplyFile, action: string, target: string, input: { confirmation?: string }, question: string): SupplyReply | "go" {
    if (!file.settings.activatedAt) return "go";
    const { confirmation, ...rest } = input;
    const fingerprint = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    if (!confirmation) return ok({ question, confirmation: this.approvals.issue(action, target, fingerprint, question) });
    try {
      this.approvals.redeem(confirmation, action, target, fingerprint);
    } catch {
      return fail(APPROVAL_STALE);
    }
    return "go";
  }

  protected issue(action: string, target: string, fingerprint: string, question: string) {
    return this.approvals.issue(action, target, fingerprint, question);
  }

  protected redeem(code: string, action: string, target: string, fingerprint: string): boolean {
    try {
      this.approvals.redeem(code, action, target, fingerprint);
      return true;
    } catch {
      return false;
    }
  }

  /** One line for the host: on, the item count, and this month's spending against the cap. */
  protected line(file: SupplyFile): string {
    const month = new Intl.DateTimeFormat("en-US", { timeZone: this.timeZone(file), month: "long" }).format(this.deps.now());
    const spent = monthSpentCents(file, this.timeZone(file), this.deps.now());
    const cap = file.settings.perMonthCapCents;
    const count = `${file.items.length} ${file.items.length === 1 ? "item" : "items"}`;
    return `Supplies: on, ${count}. ${month}: ${dollars(spent)}${cap !== undefined ? ` of ${dollars(cap)}` : ""}.`;
  }

  state(): Promise<SupplyReply> {
    return this.serial(() => {
      const file = this.read();
      const ask = supplySetupAsk(file, this.deps.standalone);
      if (ask) return ok({ ask, next: askNext(ask.tool), items: file.items.map((item) => item.name) });
      const tz = this.timeZone(file);
      const now = this.deps.now();
      return ok({
        line: file.offAt ? "Supplies: off." : this.line(file),
        summary: {
          items: file.items.map((item) => ({ itemId: item.id, name: item.name, qtyPerOrder: item.qtyPerOrder, store: item.preferred.store, schedule: item.schedule })),
          mode: file.settings.mode,
          ...(file.settings.perOrderCapCents !== undefined ? { perOrderCapCents: file.settings.perOrderCapCents } : {}),
          ...(file.settings.perMonthCapCents !== undefined ? { perMonthCapCents: file.settings.perMonthCapCents } : {}),
          monthSpentCents: monthSpentCents(file, tz, now),
          checkTime: file.settings.checkTime,
          held: file.carts.filter((cart) => cart.status === "held" && new Date(cart.expiresAt) > now).map((cart) => cart.token),
        },
      });
    });
  }

  saveSettings(input: SettingsInput): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const s = file.settings;
      if (input.property) {
        if (!this.deps.standalone) return fail("This property's details come from Cleaner Core.");
        const p = input.property;
        if (!isText(p.name, 80) || !isText(p.address, 200)) return fail("The property needs a name and a delivery address.");
        if (!isValidTimeZone(p.timeZone)) return fail("That time zone isn't one I know. Use a name like America/New_York.");
      }
      if (input.mode !== undefined && input.mode !== "hands-off" && input.mode !== "checkout") return fail("The mode is hands-off or checkout.");
      if (input.perOrderCapCents !== undefined && input.perOrderCapCents !== null && !isInt(input.perOrderCapCents, 100, 500_000)) return fail("A per-order cap has to be from $1 to $5,000.");
      if (input.perMonthCapCents !== undefined && input.perMonthCapCents !== null && !isInt(input.perMonthCapCents, 100, 2_000_000)) return fail("A monthly cap has to be from $1 to $20,000.");
      if (input.priceJumpPct !== undefined && !isInt(input.priceJumpPct, 5, 100)) return fail("The price-jump check has to be from 5% to 100%.");
      if (input.bufferDays !== undefined && !isInt(input.bufferDays, 0, 14)) return fail("The delivery buffer has to be from 0 to 14 days.");
      if (input.checkTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.checkTime)) return fail("The check time has to be 24-hour HH:MM, like 10:00.");
      const gate = this.approved(file, "supply-settings", "settings", input, "Save these settings?");
      if (gate !== "go") return gate;
      if (input.property) s.property = { name: input.property.name.trim(), address: input.property.address.trim(), timeZone: input.property.timeZone };
      if (input.mode) s.mode = input.mode;
      for (const key of ["perOrderCapCents", "perMonthCapCents"] as const) {
        if (input[key] === null) delete s[key];
        else if (input[key] !== undefined) s[key] = input[key];
      }
      if (input.perOrderCapCents !== undefined || input.perMonthCapCents !== undefined) file.setup.capsDone = true;
      if (input.priceJumpPct !== undefined) s.priceJumpPct = input.priceJumpPct;
      if (input.bufferDays !== undefined) s.bufferDays = input.bufferDays;
      if (input.checkTime) s.checkTime = input.checkTime;
      if (input.routineCreated) file.setup.routineCreated = true;
      this.write(file);
      return ok({ saved: true, ...(supplySetupAsk(file, this.deps.standalone) ? { next: "Call get_supply_state for the next step." } : {}) });
    });
  }

  saveItem(input: ItemInput): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      if (input.done) {
        if (file.items.length === 0) return fail("Add at least one item first.");
        file.setup.itemsDone = true;
        this.write(file);
        return ok({ saved: true, next: "Call get_supply_state for the next step." });
      }
      const existing = input.id ? file.items.find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) return fail("There's no item with that id. Call get_supply_state for the list.");
      if (!existing && file.items.length >= MAX_ITEMS) return fail(`The list holds up to ${MAX_ITEMS} items.`);
      if (!isText(input.name, 60)) return fail("The item needs a name under 60 characters.");
      if (!isInt(input.qtyPerOrder, 1, 50)) return fail("How many per order has to be from 1 to 50.");
      const problem = productProblem(input.preferred, "preferred") ?? (input.backup ? productProblem(input.backup, "backup") : undefined);
      if (problem) return fail(problem);
      if (typeof input.storeNote !== "string" || input.storeNote.length >= 160) return fail("The store note has to be under 160 characters.");
      if (!input.schedule) return fail("The item needs a schedule.");
      const scheduleIssue = scheduleProblem(input.schedule);
      if (scheduleIssue) return fail(scheduleIssue);
      const gate = this.approved(file, "supply-item", existing?.id ?? "new", input, `Save ${input.name}: ${input.qtyPerOrder} × ${input.preferred!.title} from ${input.preferred!.store}?`);
      if (gate !== "go") return gate;
      const now = this.deps.now().toISOString();
      const product = (p: ProductInput, before?: Product): Product => ({
        title: p.title.trim(),
        store: p.store.trim(),
        url: p.url,
        packSize: p.packSize.trim(),
        priceCents: p.priceCents,
        pickedAt: before && before.url === p.url ? before.pickedAt : now,
        // A different product starts its price history over.
        ...(before && before.url === p.url && before.lastPaidCents !== undefined ? { lastPaidCents: before.lastPaidCents } : {}),
      });
      const item: Item = {
        ...(existing ?? {}),
        id: existing?.id ?? newId("it_", 8),
        name: input.name.trim(),
        qtyPerOrder: input.qtyPerOrder,
        preferred: product(input.preferred!, existing?.preferred),
        storeNote: input.storeNote.trim(),
        schedule: input.schedule,
        savedAt: existing?.savedAt ?? now,
      };
      if (input.backup) item.backup = product(input.backup, existing?.backup);
      else delete item.backup;
      if (existing) file.items[file.items.indexOf(existing)] = item;
      else file.items.push(item);
      this.write(file);
      return ok({ saved: true, itemId: item.id, ...(file.settings.activatedAt ? {} : { next: "Ask whether there's anything else to add." }) });
    });
  }

  removeItem(input: { itemId?: string; confirmation?: string }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const item = file.items.find((entry) => entry.id === input.itemId);
      if (!item) return fail("There's no item with that id. Call get_supply_state for the list.");
      const gate = this.approved(file, "supply-remove", item.id, input, `Remove ${item.name} from your list?`);
      if (gate !== "go") return gate;
      file.items = file.items.filter((entry) => entry.id !== item.id);
      file.lowReports = file.lowReports.filter((report) => report.itemId !== item.id);
      this.write(file);
      return ok({ removed: item.name });
    });
  }

  previewSchedule(input: { schedule?: Schedule }): Promise<SupplyReply> {
    return this.guarded(input, async () => {
      if (!input.schedule) return fail("Pass the schedule to preview.");
      const problem = scheduleProblem(input.schedule);
      if (problem) return fail(problem);
      const file = this.read();
      const today = this.today(file);
      const checkouts = input.schedule.kind === "bookings" ? await this.checkouts(file) : [];
      return ok({ nextDates: nextDates(input.schedule, today, today, 3, checkouts) });
    });
  }

  /** Checkout dates: Cleaner Core's turnovers for a cleaning tenant. Standalone sources come in Task 5. */
  protected async checkouts(file: SupplyFile): Promise<string[]> {
    void file;
    if (this.deps.cleaning) return (await this.deps.cleaning.turnovers()).map((turn) => turn.checkoutYmd);
    return [];
  }

  activate(input: Record<string, unknown>): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      if (file.settings.activatedAt) return ok({ active: true, line: this.line(file) });
      if (file.items.length === 0) return fail("Add at least one item first.");
      if (!file.settings.mode) return fail("Choose hands-off or stop at checkout first.");
      if (!file.settings.checkTime) return fail("Choose the daily check time first.");
      if (!this.property(file)) return fail(this.deps.standalone ? "Save the property first." : "Finish Cleaner Core's property step first.");
      file.settings.activatedAt = this.deps.now().toISOString();
      delete file.offAt;
      this.write(file);
      return ok({ active: true, line: this.line(file) });
    });
  }
}

const desks = new Map<string, SupplyDesk>();

/** One desk per tenant folder, so calls for the same tenant run one at a time. */
export function supplyDeskFor(root: string, deps: SupplyDeps): SupplyDesk {
  const existing = desks.get(root);
  if (existing) return existing;
  const desk = new SupplyDesk(root, deps);
  desks.set(root, desk);
  return desk;
}
