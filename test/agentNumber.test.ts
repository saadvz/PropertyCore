import { describe, expect, it } from "vitest";
import type { Property } from "../src/cleaner-core/hosted/properties";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { accountState, type PropertyStates } from "../src/hosted/propertyTools";

/** The host asks Grok for their agent's number: get_state always carries the account's line. 555 numbers only. */

const LINE = "+15555550199";
const flows = { cleaning: { on: false }, supplies: { on: false }, fixer: { on: true } };
const property = (id: string, label: string) => ({ id, label, flows }) as unknown as Property;
const tenant = (properties: Property[]) => ({ id: "tnt_agentnum", label: "Scratch", twilioNumber: LINE, connections: [], invites: [], properties, createdAt: "2026-11-12T00:00:00.000Z" }) as unknown as Tenant;
const ok = (structured: Record<string, unknown>) => ({ text: JSON.stringify(structured), structured, isError: false });
const states: PropertyStates = {
  cleaning: async () => ok({ next: "cleaning" }),
  supplies: async () => ok({ next: "supplies" }),
  fixer: async () => ok({ next: "fixer" }),
  next: async () => "next",
};

describe("the agent's number", () => {
  it("get_state carries agentNumber with no property, one, and several", async () => {
    const none = await accountState(tenant([]), {}, states, "grok");
    const one = await accountState(tenant([property("prp_aaaaaaaaaa", "12 Scratch Lane")]), {}, states, "grok");
    const two = tenant([property("prp_aaaaaaaaaa", "12 Scratch Lane"), property("prp_bbbbbbbbbb", "14 Scratch Lane")]);
    const several = await accountState(two, {}, states, "grok");
    const named = await accountState(two, { property: "prp_bbbbbbbbbb" }, states, "grok");
    for (const reply of [none, one, several, named]) expect(reply.structured!.agentNumber).toBe(LINE);
  });

  it("leaves agentNumber out when the account has no line", async () => {
    const lineless = { ...tenant([property("prp_aaaaaaaaaa", "12 Scratch Lane")]), twilioNumber: "" } as unknown as Tenant;
    const reply = await accountState(lineless, {}, states, "grok");
    expect("agentNumber" in reply.structured!).toBe(false);
  });
});
