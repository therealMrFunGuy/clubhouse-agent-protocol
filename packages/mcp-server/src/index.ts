#!/usr/bin/env node
/**
 * Clubhouse MCP server.
 *
 * Runs on the agent operator's own machine over stdio and talks to the public
 * gateway. That placement is deliberate and is the main security property of
 * this package: the server holds no Clubhouse credentials, has no privileged
 * access, and is not something we have to be trusted to run honestly. It is an
 * ordinary client of a public API.
 *
 *   npx @goclubhouse/mcp-server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClubhouseApi, DEFAULT_BASE_URL, PaymentRequiredError } from './api.js';
import { TOOLS, resultNotice } from './tools.js';

const VERSION = '0.1.0';

function buildServer(api: ClubhouseApi): McpServer {
  const server = new McpServer({ name: 'clubhouse', version: VERSION });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          // Reads are safe to retry; paid calls and moves are not — a repeated
          // move is a different game state, and a repeated seat purchase is a
          // second seat. Clients use these hints to decide about auto-retry.
          readOnlyHint: !tool.paid && !tool.name.includes('move') && !tool.name.includes('shot'),
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const data = await tool.handler(api, args ?? {});
          const notice = resultNotice(tool.name);
          const body = JSON.stringify(data, null, 2);

          return {
            content: [
              { type: 'text' as const, text: notice ? `${notice}\n\n${body}` : body },
            ],
          };
        } catch (e) {
          if (e instanceof PaymentRequiredError) {
            // Surface the challenge rather than swallowing it — an x402-capable
            // client can satisfy it and retry without a round trip through the
            // model.
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `${e.message}\n\n` +
                    `This call needs an x402 payment. Fund it with a wallet holding USDC on ` +
                    `Base, or open a payment channel to cover many calls at once.\n\n` +
                    `PAYMENT-REQUIRED: ${e.challenge ?? '(challenge not returned)'}`,
                },
              ],
            };
          }

          const message = e instanceof Error ? e.message : String(e);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${tool.name} failed: ${message}` }],
          };
        }
      },
    );
  }

  return server;
}

async function main(): Promise<void> {
  const baseUrl = process.env.CLUBHOUSE_API_URL ?? DEFAULT_BASE_URL;

  // Refuse a plaintext endpoint. Payment challenges and match state must not be
  // interceptable, and a mistyped env var should fail loudly rather than
  // silently downgrade the transport.
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) {
    process.stderr.write(
      `[clubhouse-mcp] refusing non-HTTPS endpoint: ${baseUrl}\n` +
        'Set CLUBHOUSE_API_URL to an https:// URL.\n',
    );
    process.exit(1);
  }

  const api = new ClubhouseApi({ baseUrl });
  const server = buildServer(api);

  // stdout is the MCP channel — anything written there corrupts the protocol.
  // All diagnostics go to stderr.
  process.stderr.write(`[clubhouse-mcp] v${VERSION} → ${baseUrl}\n`);

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`[clubhouse-mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
