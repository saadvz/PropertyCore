import { describe, expect, it } from "vitest";
import type { LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/protocol";

// saadvz/PropertyCore#215 follow-up: Cleaner Core's own MCP server answered every initialize with
// "2025-03-26". It now agrees a version the way the touring front door and the operator bridge do.

async function versionFor(params?: Record<string, unknown>): Promise<unknown> {
  // initialize never touches the desk.
  const reply = await handleCleanerMcpMessage({} as LiveDesk, { jsonrpc: "2.0", id: 1, method: "initialize", ...(params ? { params } : {}) });
  return (reply.body as { result: { protocolVersion: unknown } }).result.protocolVersion;
}

describe("Cleaner Core's initialize", () => {
  it("answers with the client's version when it's one this server speaks", async () => {
    for (const asked of SUPPORTED_PROTOCOL_VERSIONS) expect(await versionFor({ protocolVersion: asked })).toBe(asked);
  });

  it("answers with the newest version it speaks otherwise", async () => {
    expect(await versionFor({ protocolVersion: "1999-01-01" })).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(await versionFor({ protocolVersion: 20250618 })).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(await versionFor()).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });
});
