import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createContext } from './src/context.ts';
import { getAllTools } from './src/tools/index.ts';

const PORT = Number(process.env.MCP_HTTP_PORT || 8000);
const WS_PORT = Number(process.env.BROWSER_WS_PORT || 8765);

const app = express();
app.use(express.json());

const transports = new Map();
const servers = new Map();
const context = createContext({ port: WS_PORT });

function createMcpServer() {
  const tools = getAllTools();
  const toolMap = new Map(tools.map((tool) => [tool.schema.name, tool]));
  const server = new Server(
    { name: 'agent-jake-browser-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => tool.schema),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    if (!context.isConnected()) {
      try {
        await context.waitForConnection(10000);
      } catch {
        return {
          content: [{ type: 'text', text: 'Extension not connected. Please ensure the Chrome extension is running and connected.' }],
          isError: true,
        };
      }
    }
    return tool.handle(context, args ?? {});
  });

  return server;
}

function listToolsResult() {
  const tools = getAllTools();
  return { jsonrpc: '2.0', id: null, result: { tools: tools.map((tool) => tool.schema) } };
}

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.post('/mcp', async (req, res) => {
  try {
    if (!req.headers['mcp-session-id'] && req.body?.method === 'tools/list') {
      res.json({ ...listToolsResult(), id: req.body?.id ?? null });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => transports.set(newSessionId, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          servers.delete(transport.sessionId);
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
      transport._agentJakeServer = server;
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: req.body?.id ?? null });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP POST failed', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: req.body?.id ?? null });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: null });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: req.body?.id ?? null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, '0.0.0.0', () => {
  console.error(`Agent Jake Browser MCP HTTP endpoint on 0.0.0.0:${PORT}/mcp`);
  console.error(`Agent Jake Browser extension WebSocket on 0.0.0.0:${WS_PORT}`);
});
