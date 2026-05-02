/**
 * MCP Server setup and request handlers.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createContext, type ContextManager } from './context.js';
import { getAllTools } from './tools/index.js';
import { logger } from './utils/logger.js';
import type { Tool, ToolResult } from './types.js';

export interface ServerOptions {
  port: number;
}

export interface MCPServer {
  server: Server;
  context: ContextManager;
  close(): Promise<void>;
}

/**
 * Create and configure the MCP server.
 */
export async function createServer(options: ServerOptions): Promise<MCPServer> {
  const { port } = options;

  // Create context for WebSocket communication
  const context = createContext({ port });

  // Get all available tools
  const tools = getAllTools();
  const toolMap = new Map<string, Tool>();
  for (const tool of tools) {
    toolMap.set(tool.schema.name, tool);
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'agent-jake-browser-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tools/list request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Handling tools/list request');
    return {
      tools: tools.map(t => t.schema),
    };
  });

  // Handle tools/call request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info(`Calling tool: ${name}`, args);

    const tool = toolMap.get(name);
    if (!tool) {
      logger.error(`Unknown tool: ${name}`);
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      // Check if connected
      if (!context.isConnected()) {
        logger.warn('Extension not connected, waiting...');
        try {
          await context.waitForConnection(10000);
        } catch {
          return {
            content: [{
              type: 'text',
              text: 'Extension not connected. Please ensure the Chrome extension is running and connected.',
            }],
            isError: true,
          };
        }
      }

      return (await tool.handle(context, args as Record<string, unknown>)) as any;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Tool error: ${name}`, message);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  logger.info('MCP server created');

  return {
    server,
    context,

    async close(): Promise<void> {
      await context.close();
      await server.close();
      logger.info('MCP server closed');
    },
  };
}
