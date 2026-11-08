import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { negotiatedProtocolVersion } from "./protocol";
import { annotationsFor } from "./annotations";
import { mcpInstructions } from "../playbooks/instructions";
import { reportedClientFromInitialize } from "../playbooks/select";
import { callOperatorTool, UnknownToolError, type ToolContext } from "../operator/tools";
import { catalog, connectorRefusal, knownOperatorTool, toolsForConnector } from "./scopes";

/**
 * A thin MCP bridge (Streamable HTTP, stateless, JSON responses) over Tour
 * Core's operator tool contract, for agent hosts such as Grok Bot that
 * connect to tools through a remote MCP server. Transport only: it lists the
 * tools, validates JSON-RPC, and hands every call to callOperatorTool.
 * When the request names a connector, the list and the call stay inside that
 * connector. An unset connector is the full engine catalog.
 */

export { MCP_PATH } from "./paths";
export { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol";
const SERVER_INFO = { name: "tour-core", title: "Tour Core", version: "0.2.0" };

type JsonRpcId = string | number | null;
interface Reply {
  status: number;
  body?: unknown;
}

const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const rpcError = (id: JsonRpcId, code: number, message: string): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });
const rpcResult = (id: JsonRpcId, result: unknown): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

export function mcpToolList(ctx?: ToolContext) {
  const tools = ctx?.connector ? toolsForConnector(ctx.connector, ctx) : catalog(ctx);
  return tools.map((t) => {
    const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, title: t.title, description: t.description, inputSchema, annotations: { title: t.title, ...annotationsFor(t) } };
  });
}

/** One JSON-RPC message in, one reply out. Notifications get 202 with no body. */
export async function handleMcpMessage(ctx: ToolContext, message: unknown): Promise<Reply> {
  if (Array.isArray(message)) return rpcError(null, -32600, "Batched requests aren't supported.");
  const parsed = Request.safeParse(message);
  if (!parsed.success) return rpcError(null, -32600, "That isn't a valid JSON-RPC request.");
  const { id, method, params } = parsed.data;
  const reported = reportedClientFromInitialize(message);
  if (reported) ctx.client = reported;
  if (id === undefined) return { status: 202 };

  switch (method) {
    case "initialize": {
      const protocolVersion = negotiatedProtocolVersion(params?.protocolVersion);
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: SERVER_INFO, instructions: mcpInstructions(ctx.connector) });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: mcpToolList(ctx) });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      if (ctx.connector) {
        const allowed = new Set(toolsForConnector(ctx.connector, ctx).map((tool) => tool.name));
        if (!allowed.has(name)) {
          if (knownOperatorTool(name)) return rpcError(id, -32602, connectorRefusal(ctx.connector));
        }
      }
      try {
        const outcome = await callOperatorTool(ctx, name, params?.arguments ?? {});
        if (!outcome.ok) return rpcResult(id, { content: [{ type: "text", text: outcome.error }], isError: true });
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outcome.result) }], structuredContent: outcome.result, isError: false });
      } catch (err) {
        if (err instanceof UnknownToolError) return rpcError(id, -32602, err.message);
        return rpcError(id, -32603, "Tour Core couldn't run that tool.");
      }
    }
    default:
      return rpcError(id, -32601, `Tour Core doesn't support "${method}".`);
  }
}

/** Constant-time bearer-token check. No token configured means the connector is off. */
export function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
