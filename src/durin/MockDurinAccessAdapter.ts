import { formatTime } from "../core/timezone";
import type {
  DurinAccessAdapter,
  DurinAccessRequest,
  DurinAccessResult,
  DurinHealth,
  DurinRevokeRequest,
} from "./DurinAccessAdapter";

export interface MockDurinOptions {
  /** Tour Core door id -> display name. Doors not listed are unknown to the mock. */
  doorNames: Record<string, string>;
  /** Only used to print readable times. */
  timeZone?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Durin demo mode: same Durin Access Platform contract, without opening real doors. Prints what it would do. */
export class MockDurinAccessAdapter implements DurinAccessAdapter {
  readonly calls = { requestAccess: [] as DurinAccessRequest[], revokeAccess: [] as DurinRevokeRequest[] };
  private healthy = true;
  private healthDetail: string | undefined;
  private nextFailure: string | undefined;
  private grantsByKey = new Map<string, string>();
  private counter = 0;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: MockDurinOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  setHealthy(healthy: boolean, detail?: string): void {
    this.healthy = healthy;
    this.healthDetail = detail;
  }

  failNextRequest(reason: string): void {
    this.nextFailure = reason;
  }

  async getHealth(): Promise<DurinHealth> {
    return { healthy: this.healthy, checkedAt: this.now().toISOString(), detail: this.healthDetail };
  }

  async requestAccess(request: DurinAccessRequest): Promise<DurinAccessResult> {
    this.calls.requestAccess.push(request);
    const doorName = this.options.doorNames[request.doorId];

    if (this.nextFailure) {
      const reason = this.nextFailure;
      this.nextFailure = undefined;
      this.print("Access FAILED", doorName ?? request.doorId, reason);
      return { ok: false, reason };
    }
    if (!doorName) {
      this.print("Access denied", request.doorId, "unknown door");
      return { ok: false, reason: "unknown door" };
    }

    let grantRef = this.grantsByKey.get(request.idempotencyKey);
    if (!grantRef) {
      grantRef = `demo_grant_${++this.counter}`;
      this.grantsByKey.set(request.idempotencyKey, grantRef);
    }
    this.print("Access granted", doorName, `grant ${grantRef}, until ${formatTime(new Date(request.validUntil), this.options.timeZone ?? "UTC")}`);
    return { ok: true, grantRef };
  }

  async revokeAccess(request: DurinRevokeRequest): Promise<void> {
    this.calls.revokeAccess.push(request);
    this.print("Access revoked", this.options.doorNames[request.doorId] ?? request.doorId, `grant ${request.grantRef}`);
  }

  private print(title: string, door: string, detail: string): void {
    this.log(`    [DOOR ACCESS DEMO] ${title}: ${door} (${detail})`);
  }
}
