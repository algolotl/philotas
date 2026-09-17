// SPDX-License-Identifier: Apache-2.0
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient } from './client.mjs';
import { TOOLS, createHandlers, textResult } from './tools.mjs';

function toZodShape(inputSchema) {
  const shape = {};
  for (const [key, spec] of Object.entries(inputSchema || {})) {
    let zodType;
    if (spec.type === 'enum') zodType = z.enum(spec.values);
    else if (spec.type === 'number') zodType = z.number();
    else zodType = z.string();
    if (spec.description) zodType = zodType.describe(spec.description);
    if (!spec.required) zodType = zodType.optional();
    shape[key] = zodType;
  }
  return shape;
}

export function createServer(options = {}) {
  const client = options.client || createClient();
  const name = options.name || 'philotas-mcp';
  const version = options.version || '0.1.0';
  const handlers = createHandlers({ client, cwd: options.cwd, spawnImpl: options.spawnImpl });
  const server = new McpServer({ name, version });

  for (const tool of TOOLS) {
    const handler = handlers[tool.name];
    server.registerTool(
      tool.name,
      {
        title: tool.title || tool.name,
        description: tool.description,
        inputSchema: toZodShape(tool.inputSchema),
      },
      async (args) => {
        try {
          return await handler(args);
        } catch (err) {
          return textResult(tool.name + ' failed: ' + (err && err.message ? err.message : err), { isError: true });
        }
      },
    );
  }

  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
