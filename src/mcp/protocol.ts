/** The MCP protocol versions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** initialize's answer: the client's version when it's one this server speaks, otherwise the newest it does (MCP lifecycle). */
export function negotiatedProtocolVersion(asked: unknown): string {
  return typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0]!;
}
