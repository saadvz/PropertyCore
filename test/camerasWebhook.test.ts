import { describe, expect, it } from "vitest";
import { fakeCameraProvider } from "../src/cameras/fake";
import { memoryLog, type EventLog } from "../src/cameras/lines";
import { ingestWebhook } from "../src/cameras/webhook";

const places = [{ tenantId: "t1", propertyId: "lake", cameras: [{ deviceId: "dev-aaa", name: "Front door", outdoor: true as const, pickedAt: "x" }] }];
const event = { id: "req-1", at: "2026-11-20T03:14:00.000Z", deviceId: "dev-aaa", kind: "motion" as const, label: "human" };

function setup() {
  const provider = fakeCameraProvider();
  const logs = new Map<string, EventLog>();
  const logFor = (tenantId: string, propertyId: string) => {
    const key = `${tenantId}/${propertyId}`;
    if (!logs.has(key)) logs.set(key, memoryLog());
    return logs.get(key)!;
  };
  return { provider, logs, logFor };
}

describe("ingesting a webhook", () => {
  it("stores a signed event for a picked camera once, under the host's camera name", () => {
    const { provider, logs, logFor } = setup();
    const delivery = provider.webhook(event, "acct-1");
    const first = ingestWebhook({ provider, places, logFor, rawBody: delivery.body, headers: delivery.headers });
    expect(first).toMatchObject({ status: 200, stored: { tenantId: "t1", propertyId: "lake", line: { type: "camera", id: "req-1", device: "Front door", deviceId: "dev-aaa", provider: "fake", kind: "motion", label: "human" } } });
    const again = ingestWebhook({ provider, places, logFor, rawBody: delivery.body, headers: delivery.headers });
    expect(again).toEqual({ status: 200 });
    expect(logs.get("t1/lake")!.read()).toHaveLength(1);
  });

  it("refuses an unsigned delivery and stores nothing", () => {
    const { provider, logs, logFor } = setup();
    const delivery = provider.webhook(event);
    expect(ingestWebhook({ provider, places, logFor, rawBody: delivery.body, headers: {} })).toEqual({ status: 401 });
    expect(logs.size).toBe(0);
  });

  it("drops an event from a camera nobody picked, unstored", () => {
    const { provider, logs, logFor } = setup();
    const delivery = provider.webhook({ ...event, deviceId: "dev-indoor" });
    expect(ingestWebhook({ provider, places, logFor, rawBody: delivery.body, headers: delivery.headers })).toEqual({ status: 200 });
    expect(logs.size).toBe(0);
  });

  it("passes on the host removing the app", () => {
    const { provider, logFor } = setup();
    const delivery = provider.webhook({ unlinked: "acct-1" });
    expect(ingestWebhook({ provider, places, logFor, rawBody: delivery.body, headers: delivery.headers })).toEqual({ status: 200, unlinked: "acct-1" });
  });
});
