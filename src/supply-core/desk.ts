import { createHash, randomInt } from "node:crypto";
import { isValidTimeZone, localDateOf } from "../core/timezone";
import { askNext } from "../cleaner-core/setupAsk";
import { ConfirmationBook } from "../operator/confirmations";
import { refuseCards } from "./cards";
import { cartFingerprint, checkCart, type CartInput, type GateContext, type Hold, type Mode } from "./gate";
import { deadlineFor, dueOn, nextDates, scheduleProblem, type Schedule } from "./schedule";
import { supplySetupAsk } from "./setupAsk";
import { monthSpentCents, onItsWay, readSupply, writeSupply, type Cart, type Item, type Order, type Product, type SupplyFile } from "./store";

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
export const CART_MINUTES = 30;
const CART_EXPIRED = "That cart expired. Check it again.";
const NO_GO = "No go answer or landlord approval for that order. Check the cart again.";
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface DueItem {
  itemId: string;
  name: string;
  why: "schedule" | "report";
  deadline: string;
  qtyPerOrder: number;
  preferred: Product;
  backup?: Product;
  lastPaidCents?: number;
}

export type ProblemReason = "store-blocked" | "listing-changed" | "out-of-stock" | "misses-deadline" | "not-placed";

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

  /** A local date for an instant, in the property's time zone. */
  protected ymd(file: SupplyFile, iso: string): string {
    const { year, month, day } = localDateOf(new Date(iso), this.timeZone(file));
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  /**
   * Expired carts: a go or approved cart nobody recorded becomes an unconfirmed order, so its items
   * stay on their way until Grok checks its own order history. A held cart just closes.
   */
  protected sweep(file: SupplyFile): void {
    const now = this.deps.now();
    const open: Cart[] = [];
    for (const cart of file.carts) {
      if (cart.status === "recorded") continue;
      if (new Date(cart.expiresAt) > now) {
        open.push(cart);
        continue;
      }
      if (cart.status === "go" || cart.status === "approved") {
        file.orders.push({
          id: newId("ord_", 8),
          at: new Date(new Date(cart.expiresAt).getTime() - CART_MINUTES * 60_000).toISOString(),
          store: cart.cart.store,
          items: cart.cart.items.map((line) => ({ ...line })),
          totalCents: cart.cart.totalCents,
          // Counted at the checked total until Grok confirms or rules it out.
          chargedCents: cart.cart.totalCents,
          deadline: cart.deadline,
          source: cart.source,
          approvedBy: cart.status === "approved" ? "landlord" : "rules",
          status: "unconfirmed",
        });
      }
    }
    file.carts = open;
  }

  protected openCartItems(file: SupplyFile): Set<string> {
    const now = this.deps.now();
    return new Set(file.carts.filter((cart) => cart.status !== "recorded" && new Date(cart.expiresAt) > now).flatMap((cart) => cart.cart.items.map((line) => line.itemId)));
  }

  /** Every item due today, with its deadline. */
  protected async dueItems(file: SupplyFile): Promise<Map<string, { item: Item; why: "schedule" | "report"; deadline: string }>> {
    const today = this.today(file);
    const checkouts = await this.checkouts(file);
    const nextCleaningYmd = this.deps.cleaning ? checkouts.filter((day) => day >= today).sort()[0] : undefined;
    const activated = file.settings.activatedAt ? this.ymd(file, file.settings.activatedAt) : today;
    const out = new Map<string, { item: Item; why: "schedule" | "report"; deadline: string }>();
    for (const item of file.items) {
      const anchors = [item.lastOrderedAt, item.skippedAt].filter((at): at is string => Boolean(at)).map((at) => this.ymd(file, at)).sort();
      const saved = this.ymd(file, item.savedAt);
      const due = dueOn({
        schedule: item.schedule,
        ...(anchors.length > 0 ? { anchorYmd: anchors[anchors.length - 1]! } : {}),
        startYmd: saved > activated ? saved : activated,
        todayYmd: today,
        checkouts,
        lowReported: file.lowReports.some((report) => report.itemId === item.id),
      });
      if (!due.due) continue;
      const deadline = deadlineFor({ todayYmd: today, bufferDays: file.settings.bufferDays, ...(due.occurrenceYmd ? { occurrenceYmd: due.occurrenceYmd } : {}), ...(nextCleaningYmd ? { nextCleaningYmd } : {}) });
      out.set(item.id, { item, why: due.why!, deadline });
    }
    return out;
  }

  checkSupplies(input: { googleEvents?: unknown }): Promise<SupplyReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      if (!file.settings.activatedAt || file.offAt) return fail("Supply Core isn't active yet. Call get_supply_state.");
      this.sweep(file);
      const now = this.deps.now();
      const away = onItsWay(file, now);
      const inCart = this.openCartItems(file);
      const due: DueItem[] = [];
      for (const { item, why, deadline } of (await this.dueItems(file)).values()) {
        if (away.has(item.id) || inCart.has(item.id)) continue;
        due.push({
          itemId: item.id,
          name: item.name,
          why,
          deadline,
          qtyPerOrder: item.qtyPerOrder,
          preferred: item.preferred,
          ...(item.backup ? { backup: item.backup } : {}),
          ...(item.preferred.lastPaidCents !== undefined ? { lastPaidCents: item.preferred.lastPaidCents } : {}),
        });
      }
      const today = this.today(file);
      const late = file.orders.filter((order) => order.status === "placed" && !order.deliveredAt && !order.lateTold && order.deadline !== undefined && order.deadline < today);
      for (const order of late) order.lateTold = true;
      this.write(file);
      return ok({
        due,
        unconfirmed: file.orders.filter((order) => order.status === "unconfirmed"),
        held: file.carts.filter((cart) => cart.status === "held").map((cart) => ({ cartToken: cart.token, store: cart.cart.store, totalCents: cart.cart.totalCents, holds: cart.holds })),
        late: late.map((order) => ({ orderId: order.id, store: order.store, deadline: order.deadline, ...(order.expectedBy ? { expectedBy: order.expectedBy } : {}) })),
        monthSpentCents: monthSpentCents(file, this.timeZone(file), now),
        ...(file.settings.perOrderCapCents !== undefined ? { perOrderCapCents: file.settings.perOrderCapCents } : {}),
        ...(file.settings.perMonthCapCents !== undefined ? { perMonthCapCents: file.settings.perMonthCapCents } : {}),
      });
    });
  }

  reportLow(input: { itemIds?: string[]; source?: "cleaner" | "host"; jobId?: string }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      if (input.source !== "cleaner" && input.source !== "host") return fail("Say who reported it: cleaner or host.");
      const ids = input.itemIds ?? [];
      if (ids.length === 0) return fail("Pass the item ids that are low.");
      const unknown = ids.filter((id) => !file.items.some((item) => item.id === id));
      if (unknown.length > 0) return fail("Only items on the list can be marked low. Ask the host whether to add anything else.");
      if (input.jobId !== undefined && !isText(input.jobId, 80)) return fail("That job id isn't one I know.");
      const at = this.deps.now().toISOString();
      for (const itemId of new Set(ids)) {
        file.lowReports = file.lowReports.filter((report) => report.itemId !== itemId);
        file.lowReports.push({ itemId, source: input.source, at, ...(input.jobId ? { jobId: input.jobId } : {}) });
      }
      this.write(file);
      return ok({ due: ids.map((id) => file.items.find((item) => item.id === id)!.name), next: "Call check_supplies to order them." });
    });
  }

  private cartProblem(cart: Partial<CartInput>): string | undefined {
    if (!isText(cart.store, 60)) return "Name the store.";
    if (!Array.isArray(cart.items) || cart.items.length === 0 || cart.items.length > 30) return "The cart needs 1 to 30 items.";
    for (const line of cart.items) {
      if (!line || typeof line.itemId !== "string" || (line.product !== "preferred" && line.product !== "backup")) return "Each line needs an item id and preferred or backup.";
      if (!isInt(line.qty, 1, 50)) return "Each quantity has to be from 1 to 50.";
      if (!isInt(line.unitCents, 1, 500_000)) return "Each price has to be from 1 cent to $5,000.";
    }
    if (new Set(cart.items.map((line) => line.itemId)).size !== cart.items.length) return "List each item once.";
    for (const key of ["shippingCents", "taxCents", "totalCents"] as const) if (!isInt(cart[key], 0, 2_000_000)) return "Shipping, tax, and the total are whole cents.";
    if (typeof cart.deliveryBy !== "string" || !YMD.test(cart.deliveryBy)) return "The delivery date has to be YYYY-MM-DD.";
    return undefined;
  }

  private holdText(file: SupplyFile, cart: CartInput, hold: Hold): string {
    const name = (id?: string) => file.items.find((item) => item.id === id)?.name ?? "An item";
    if (hold.reason === "price-jump") return `${name(hold.itemId)} went from ${dollars(hold.wasCents!)} to ${dollars(hold.nowCents!)}`;
    if (hold.reason === "over-order-cap") return `it's over your ${dollars(file.settings.perOrderCapCents!)} per-order cap`;
    if (hold.reason === "over-month-cap") return `it would put this month over your ${dollars(file.settings.perMonthCapCents!)} cap`;
    if (hold.reason === "misses-deadline") return `it arrives ${cart.deliveryBy}, after it's needed`;
    return "you asked me to stop at checkout";
  }

  checkCart(input: CartInput & { source?: Order["source"] }): Promise<SupplyReply> {
    return this.guarded(input, async () => {
      const problem = this.cartProblem(input);
      if (problem) return fail(problem);
      const file = this.read();
      if (!file.settings.activatedAt || file.offAt) return fail("Supply Core isn't active yet. Call get_supply_state.");
      this.sweep(file);
      const now = this.deps.now();
      const due = await this.dueItems(file);
      const ctx: GateContext = {
        mode: file.settings.mode ?? "checkout",
        ...(file.settings.perOrderCapCents !== undefined ? { perOrderCapCents: file.settings.perOrderCapCents } : {}),
        ...(file.settings.perMonthCapCents !== undefined ? { perMonthCapCents: file.settings.perMonthCapCents } : {}),
        priceJumpPct: file.settings.priceJumpPct,
        monthSpentCents: monthSpentCents(file, this.timeZone(file), now),
        items: new Map(file.items.map((item) => [item.id, { name: item.name, baseline: { preferred: item.preferred.lastPaidCents ?? item.preferred.priceCents, ...(item.backup ? { backup: item.backup.lastPaidCents ?? item.backup.priceCents } : {}) } }])),
        due: new Map([...due].map(([id, entry]) => [id, { deadline: entry.deadline }])),
        onItsWay: onItsWay(file, now),
        inOpenCart: this.openCartItems(file),
      };
      const cart: CartInput = { store: input.store, items: input.items.map((l) => ({ itemId: l.itemId, product: l.product, qty: l.qty, unitCents: l.unitCents })), shippingCents: input.shippingCents, taxCents: input.taxCents, totalCents: input.totalCents, deliveryBy: input.deliveryBy };
      const answer = checkCart(cart, ctx);
      if (answer.verdict === "refused") {
        this.write(file);
        return ok({ verdict: "refused", remove: answer.remove, next: "Take those items out of the cart and check it again." });
      }
      const reports = file.lowReports.filter((report) => cart.items.some((line) => line.itemId === report.itemId));
      const source = input.source ?? (reports.some((r) => r.source === "cleaner") ? "cleaner" : reports.length > 0 ? "host" : "schedule");
      const token = newId("cart_", 10);
      file.carts.push({
        token,
        fingerprint: cartFingerprint(cart),
        cart,
        status: answer.verdict,
        holds: answer.holds.map((hold) => this.holdText(file, cart, hold)),
        expiresAt: new Date(now.getTime() + CART_MINUTES * 60_000).toISOString(),
        source,
        deadline: cart.items.map((line) => due.get(line.itemId)!.deadline).sort()[0]!,
      });
      this.write(file);
      const jumps = answer.holds.filter((hold) => hold.reason === "price-jump");
      const question =
        answer.holds.length > 0 && jumps.length === answer.holds.length
          ? jumps.map((hold) => `${this.holdText(file, cart, hold)}. Buy anyway, switch to your backup, or skip?`).join(" ")
          : undefined;
      return ok({
        verdict: answer.verdict,
        cartToken: token,
        expiresInMinutes: CART_MINUTES,
        ...(answer.holds.length > 0 ? { holds: answer.holds } : {}),
        ...(question ? { question } : {}),
        next: answer.verdict === "go" ? "Place the order, then call record_order with this cartToken." : "Stop before Place Order. Show the host the cart and why, and call approve_cart.",
      });
    });
  }

  approveCart(input: { cartToken?: string; confirmation?: string }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      this.sweep(file);
      this.write(file);
      const cart = file.carts.find((entry) => entry.token === input.cartToken);
      if (!cart) return fail(CART_EXPIRED);
      if (cart.status !== "held") return fail(cart.status === "go" ? "That cart doesn't need approval. Place it and call record_order." : "That cart is already approved.");
      const names = cart.cart.items.map((line) => `${file.items.find((item) => item.id === line.itemId)?.name ?? line.itemId}${line.qty > 1 ? ` ×${line.qty}` : ""}`).join(", ");
      const question = `Place this order from ${cart.cart.store}: ${names}, ${dollars(cart.cart.totalCents)}? ${cart.holds.map((h) => h.charAt(0).toUpperCase() + h.slice(1)).join(". ")}.`;
      if (!input.confirmation) return ok({ question, confirmation: this.issue("supply-cart", cart.token, cart.fingerprint, question) });
      if (!this.redeem(input.confirmation, "supply-cart", cart.token, cart.fingerprint)) return fail(APPROVAL_STALE);
      cart.status = "approved";
      cart.expiresAt = new Date(this.deps.now().getTime() + CART_MINUTES * 60_000).toISOString();
      this.write(file);
      return ok({ approved: true, expiresInMinutes: CART_MINUTES, next: "Place the order now, then call record_order with this cartToken." });
    });
  }

  private orderLine(file: SupplyFile, order: Order): string {
    const names = order.items.map((line) => `${file.items.find((item) => item.id === line.itemId)?.name ?? "an item"}${line.qty > 1 ? ` ×${line.qty}` : ""}`).join(", ");
    let when = "";
    if (order.expectedBy && YMD.test(order.expectedBy)) {
      const [y, m, d] = order.expectedBy.split("-").map(Number);
      when = `, arriving ${WEEKDAY_NAMES[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]}`;
    }
    return `Ordered from ${order.store}: ${names}. ${dollars(order.chargedCents)}${when}.`;
  }

  /** Marks the order's items ordered: last order, last price paid, store-blocked count reset, low reports cleared. */
  private noteOrdered(file: SupplyFile, order: Order): void {
    for (const line of order.items) {
      const item = file.items.find((entry) => entry.id === line.itemId);
      if (!item) continue;
      item.lastOrderedAt = order.at;
      item.blockedRuns = 0;
      const product = line.product === "backup" ? item.backup : item.preferred;
      if (product) product.lastPaidCents = line.unitCents;
    }
    file.lowReports = file.lowReports.filter((report) => !order.items.some((line) => line.itemId === report.itemId));
  }

  recordOrder(input: { cartToken?: string; orderId?: string; orderNumber?: string; chargedCents?: number; expectedBy?: string; approvedBy?: "grok-card" }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      if (!isInt(input.chargedCents, 0, 2_000_000)) return fail("Pass the amount charged, in whole cents.");
      if (input.orderNumber !== undefined && !isText(input.orderNumber, 80)) return fail("The order number has to be under 80 characters.");
      if (input.expectedBy !== undefined && !YMD.test(input.expectedBy)) return fail("The expected delivery date has to be YYYY-MM-DD.");
      const file = this.read();
      this.sweep(file);
      let order: Order;
      if (input.orderId) {
        const found = file.orders.find((entry) => entry.id === input.orderId && entry.status === "unconfirmed");
        if (!found) return fail(NO_GO);
        order = found;
        order.status = "placed";
        order.chargedCents = input.chargedCents;
      } else {
        const cart = file.carts.find((entry) => entry.token === input.cartToken);
        if (!cart || (cart.status !== "go" && cart.status !== "approved")) {
          this.write(file);
          return fail(NO_GO);
        }
        order = {
          id: newId("ord_", 8),
          at: this.deps.now().toISOString(),
          store: cart.cart.store,
          items: cart.cart.items.map((line) => ({ ...line })),
          totalCents: cart.cart.totalCents,
          chargedCents: input.chargedCents,
          deadline: cart.deadline,
          source: cart.source,
          approvedBy: cart.status === "approved" ? "landlord" : input.approvedBy === "grok-card" ? "grok-card" : "rules",
          status: "placed",
        };
        cart.status = "recorded";
        file.carts = file.carts.filter((entry) => entry !== cart);
        file.orders.push(order);
      }
      if (input.orderNumber) order.orderNumber = input.orderNumber;
      if (input.expectedBy) order.expectedBy = input.expectedBy;
      this.noteOrdered(file, order);
      this.write(file);
      const chargedMore = order.chargedCents > order.totalCents;
      return ok({ orderId: order.id, line: this.orderLine(file, order), ...(chargedMore ? { chargedMore: true, next: `Tell the host the charge was ${dollars(order.chargedCents)}, more than the ${dollars(order.totalCents)} checked.` } : {}) });
    });
  }

  recordProblem(input: { reason?: ProblemReason; itemIds?: string[]; orderId?: string }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const reasons: ProblemReason[] = ["store-blocked", "listing-changed", "out-of-stock", "misses-deadline", "not-placed"];
      if (!input.reason || !reasons.includes(input.reason)) return fail("Name the problem: store-blocked, listing-changed, out-of-stock, misses-deadline, or not-placed.");
      const file = this.read();
      this.sweep(file);
      if (input.reason === "not-placed") {
        const order = file.orders.find((entry) => entry.id === input.orderId && entry.status === "unconfirmed");
        if (!order) return fail("Pass the id of an unconfirmed order.");
        file.orders = file.orders.filter((entry) => entry !== order);
        this.write(file);
        return ok({ freed: order.items.map((line) => line.itemId) });
      }
      const ids = input.itemIds ?? [];
      const items = ids.map((id) => file.items.find((item) => item.id === id));
      if (ids.length === 0 || items.some((item) => !item)) return fail("Pass the ids of the items on the list that hit the problem.");
      let suggestOtherStore = false;
      if (input.reason === "store-blocked") {
        for (const item of items) {
          item!.blockedRuns = (item!.blockedRuns ?? 0) + 1;
          if (item!.blockedRuns >= 2) suggestOtherStore = true;
        }
      }
      this.write(file);
      const next =
        input.reason === "listing-changed"
          ? "Ask the host to pick the product again with product cards, then save_supply_item."
          : suggestOtherStore
            ? "Suggest the backup's store or another store to the host."
            : "Tell the host what happened and what you'll try next.";
      return ok({ noted: input.reason, tellHost: true, ...(suggestOtherStore ? { suggestOtherStore: true } : {}), next });
    });
  }

  skipItem(input: { itemId?: string }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const item = file.items.find((entry) => entry.id === input.itemId);
      if (!item) return fail("There's no item with that id.");
      item.skippedAt = this.deps.now().toISOString();
      file.lowReports = file.lowReports.filter((report) => report.itemId !== item.id);
      this.write(file);
      return ok({ skipped: item.name });
    });
  }

  markDelivered(input: { orderId?: string }): Promise<SupplyReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const order = file.orders.find((entry) => entry.id === input.orderId);
      if (!order) return fail("There's no order with that id.");
      order.status = "delivered";
      order.deliveredAt = this.deps.now().toISOString();
      this.write(file);
      return ok({ delivered: order.id });
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
