import type { z } from "zod";
import type { OperatorTool, ToolContext, ToolKind } from "./tools";

/**
 * One operator tool, with run's input typed by its own schema. Only type
 * imports, so every tool file can import it without a runtime cycle through
 * tools.ts.
 */
export function tool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<Record<string, unknown>>;
}): OperatorTool {
  return def;
}
