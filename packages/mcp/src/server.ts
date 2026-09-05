/**
 * The Kryon MCP server (stdio).
 *
 * Run it from an MCP client — Claude Code, Claude Desktop, or anything else
 * that speaks the protocol:
 *
 *   {
 *     "mcpServers": {
 *       "kryon": {
 *         "command": "npx",
 *         "args": ["-y", "@kryon/mcp"],
 *         "env": { "KRYON_NETWORK": "testnet", "KRYON_SECRET": "S..." }
 *       }
 *     }
 *   }
 *
 * Read-only if KRYON_SECRET is unset, which is a reasonable way to start.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./schema.js";
import { KeypairSigner, KryonClient } from "@kryon/sdk";
import { PolicyEnforcer, PolicyViolation, policyFromEnv } from "./policy.js";
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from "./tools.js";

async function main(): Promise<void> {
  const policy = policyFromEnv();
  const enforcer = new PolicyEnforcer(policy);

  const secret = process.env["KRYON_SECRET"];
  const client = new KryonClient({
    network: policy.network,
    ...(secret ? { signer: new KeypairSigner(secret) } : {}),
  });

  const context: ToolContext = { client, enforcer };

  const server = new Server(
    { name: "kryon", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
      // Hide the trading tools entirely when there is no key, rather than
      // offering them and failing: a tool that cannot work should not be in
      // the model's menu at all.
      .filter((tool) => !tool.mutating || client.canSign)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.schema),
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS_BY_NAME.get(request.params.name);
    if (!tool) {
      return errorResult(`Unknown tool "${request.params.name}".`);
    }
    if (tool.mutating && !client.canSign) {
      return errorResult(
        "This server is running read-only (no KRYON_SECRET is configured), so it cannot trade.",
      );
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        `Invalid arguments for ${tool.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      );
    }

    try {
      const text = await tool.run(parsed.data as Record<string, unknown>, context);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      if (error instanceof PolicyViolation) {
        enforcer.record({
          tool: tool.name,
          arguments: args,
          outcome: "refused",
          detail: error.message,
        });
        return errorResult(`Refused by this server's safety policy: ${error.message}`);
      }
      return errorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  // stdout carries the protocol, so every human-readable line goes to stderr.
  const mode = client.canSign ? `trading as ${client.address}` : "read-only";
  console.error(
    `kryon mcp: ${policy.network} (${mode})\n` +
      `  limits: ${policy.maxOrderNotionalUsd} USD/order, ` +
      `${policy.maxSessionNotionalUsd} USD/session, ` +
      `${policy.maxOrdersPerSession} orders/session\n` +
      `  confirmation ${policy.requireConfirm ? "required" : "DISABLED"}` +
      (policy.network === "mainnet" ? "\n  MAINNET — real funds" : ""),
  );

  await server.connect(new StdioServerTransport());
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

main().catch((error: unknown) => {
  console.error(`kryon mcp failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
