/**
 * Tool schemas for direct LLM API use, for callers not going through MCP.
 *
 * The tool set and its safety policy are identical; only the wire format of
 * the declarations differs.
 */

import { zodToJsonSchema } from "./schema.js";
import { TOOLS } from "./tools.js";

/** Tool definitions in Anthropic Messages API shape. */
export function anthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.schema),
  }));
}

/** Tool definitions in OpenAI chat-completions shape. */
export function openaiTools(): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.schema),
    },
  }));
}
