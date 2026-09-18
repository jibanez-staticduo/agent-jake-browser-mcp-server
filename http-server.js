import express from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createContext } from './src/context.ts';
import { getAllTools } from './src/tools/index.ts';
import { getSharedTokenStore } from './src/token-store.ts';
import { createPairingStore } from './src/pairing-store.ts';

const PORT = Number(process.env.MCP_HTTP_PORT || 8000);
const WS_PORT = Number(process.env.BROWSER_WS_PORT || 8765);
const HTTP_HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const EXTENSION_ZIP =
  process.env.BROWSER_EXTENSION_ZIP || '/app/extension/agent-jake-browser-extension.zip';
const WS_PATH = process.env.BROWSER_WS_PATH || '/';

const CONNECTION_FIELD = {
  type: 'string',
  description:
    'Browser connection id to target; defaults to the most recently used. See browser_list_connections.',
};

const app = express();
app.use(express.json());

const transports = new Map();
const servers = new Map();
const context = createContext({ port: WS_PORT });
const tokenStore = getSharedTokenStore();
const allTools = getAllTools();
const toolMap = new Map(allTools.map((tool) => [tool.schema.name, tool]));

const pairing = createPairingStore({
  issueToken: (record) =>
    tokenStore.issueToken({
      label: record.label || 'pairing',
      ...(record.connectionId ? { connectionId: record.connectionId } : {}),
    }),
});

/**
 * Advertise the optional `connection` argument on every tool without touching the
 * ~30 zod schemas: the annotation happens here, and the field is stripped before
 * the tool runs so zod never sees it.
 */
function annotateToolSchema(tool) {
  const annotated = structuredClone(tool);
  if (!annotated.inputSchema || typeof annotated.inputSchema !== 'object') {
    annotated.inputSchema = { type: 'object', properties: {} };
  }
  if (!annotated.inputSchema.properties || typeof annotated.inputSchema.properties !== 'object') {
    annotated.inputSchema.properties = {};
  }
  annotated.inputSchema.properties.connection ??= { ...CONNECTION_FIELD };
  return annotated;
}

function toolsListPayload() {
  return allTools.map((tool) => annotateToolSchema(tool.schema));
}

function textContent(text, isError) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

/**
 * Resolve the target browser, run the tool against that connection and keep
 * `connection` out of the arguments sent to the extension.
 */
async function callTool(name, rawArgs) {
  const tool = toolMap.get(name);
  if (!tool) return textContent(`Unknown tool: ${name}`, true);

  const args = { ...(rawArgs ?? {}) };
  const connection =
    typeof args.connection === 'string' && args.connection.trim() ? args.connection.trim() : undefined;
  delete args.connection;

  if (tool.serverSide) {
    return tool.handle(context, args);
  }

  if (connection && !context.isConnected(connection)) {
    const open = context.listConnections().map((c) => c.connectionId).join(', ') || 'none';
    return textContent(
      `No browser connection with id "${connection}" (open: ${open}). Call browser_list_connections to see the current ones.`,
      true,
    );
  }

  if (!context.isConnected(connection)) {
    try {
      await context.waitForConnection(10000);
    } catch {
      return textContent(
        'Extension not connected. Please ensure the Chrome extension is running and connected.',
        true,
      );
    }
  }

  return tool.handle(context.forConnection(connection), args);
}

function createMcpServer() {
  const server = new Server(
    { name: 'agent-jake-browser-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsListPayload(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments),
  );

  return server;
}

function listToolsResult() {
  return { jsonrpc: '2.0', id: null, result: { tools: toolsListPayload() } };
}

/**
 * The browser talks to this server from another origin (the extension popup, the
 * pairing page), so the pairing and download routes answer CORS preflights.
 */
function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  next();
}

app.use((req, res, next) => {
  if (req.path === '/download' || req.path === '/connections' || req.path === '/pair' || req.path.startsWith('/pair/')) {
    return cors(req, res, next);
  }
  return next();
});

/**
 * ws(s) URL handed to the extension: behind a reverse proxy the forwarded
 * headers are authoritative, and BROWSER_PUBLIC_WS_URL wins over both.
 */
function publicWsUrl(req) {
  if (process.env.BROWSER_PUBLIC_WS_URL) return process.env.BROWSER_PUBLIC_WS_URL;

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean);
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').trim();
  const proto = forwardedProto || req.protocol || 'http';
  const isSecured = proto === 'https' || proto === 'wss';

  // Behind a reverse proxy the public host and the WS path are the proxy's
  // business: the extension must use the address the proxy advertises.
  if (forwardedProto || forwardedHost) {
    const host = forwardedHost || String(req.headers.host || 'localhost');
    return `${isSecured ? 'wss' : 'ws'}://${host}${WS_PATH}`;
  }

  // Direct access: the extension reaches the WebSocket on its own port, which is
  // not the HTTP port that served this response.
  const hostname = String(req.headers.host || '127.0.0.1').split(':')[0] || '127.0.0.1';
  return `${isSecured ? 'wss' : 'ws'}://${hostname}:${WS_PORT}${WS_PATH}`;
}

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.get('/connections', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    authEnabled:
      (process.env.BROWSER_WS_TOKEN || '') !== '' || process.env.BROWSER_ALLOW_PAIRING === 'true',
    wsUrl: publicWsUrl(req),
    connections: context.listConnections(),
  });
});

app.get('/download', async (_req, res) => {
  try {
    const info = await stat(EXTENSION_ZIP);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(EXTENSION_ZIP)}"`,
    );
    res.setHeader('Content-Length', String(info.size));
    createReadStream(EXTENSION_ZIP).pipe(res);
  } catch {
    res.status(404).type('text/plain; charset=utf-8').send(
      `Extension zip not found on the server at ${EXTENSION_ZIP}.\n` +
        'Set BROWSER_EXTENSION_ZIP to the built extension archive, or load the extension unpacked from a local checkout.\n' +
        'Build it in agent-jake-browser-mcp-extension with: npm run build && zip -r dist/extension.zip dist',
    );
  }
});

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.type('html').send(INDEX_HTML);
});

app.get('/pair', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(PAIR_HTML);
});

app.post('/pair/start', (req, res) => {
  const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
  if (!/^[\w:-]{4,128}$/.test(otp)) {
    res.status(400).json({ error: 'otp must be a 4-128 character code (letters, digits, - or _)' });
    return;
  }
  const connectionId =
    typeof req.body?.connectionId === 'string' && req.body.connectionId.trim()
      ? req.body.connectionId.trim().slice(0, 128)
      : undefined;
  const label =
    typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 128)
      : undefined;

  const record = pairing.start(otp, { connectionId, label });
  res.status(201).json({
    state: 'pending',
    otp,
    expiresAt: new Date(record.expiresAt).toISOString(),
    approveUrl: `${publicOrigin(req)}/pair?otp=${encodeURIComponent(otp)}`,
  });
});

app.post('/pair/approve', (req, res) => {
  const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
  const result = pairing.approve(otp);
  if (!result.ok) {
    res.status(410).json({
      error:
        result.reason === 'used'
          ? 'This pairing code was already used. Ask the extension to start a new pairing.'
          : 'This pairing code is expired or unknown. Ask the extension to start a new pairing.',
    });
    return;
  }
  res.json({ token: result.token, wsUrl: publicWsUrl(req) });
});

app.get('/pair/status', (req, res) => {
  const otp = typeof req.query.otp === 'string' ? req.query.otp.trim() : '';
  const status = pairing.status(otp);
  res.setHeader('Cache-Control', 'no-store');
  res.json(status);
});

function publicOrigin(req) {
  if (process.env.BROWSER_PUBLIC_ORIGIN) return process.env.BROWSER_PUBLIC_ORIGIN.replace(/\/$/, '');
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`);
  return `${forwardedProto || req.protocol || 'http'}://${host}`;
}

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

const INDEX_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Jake Browser MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 2rem 1.25rem; max-width: 48rem; }
  h1 { font-size: 1.3rem; margin-bottom: .25rem; }
  .muted { opacity: .7; }
  ul { padding-left: 1.1rem; }
  code { font-family: ui-monospace, monospace; font-size: .9em; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid rgba(127,127,127,.3); font-size: .9rem; }
  .badge { border: 1px solid rgba(127,127,127,.5); border-radius: 999px; padding: .05rem .5rem; font-size: .8rem; }
  .active { border-color: #2e7d32; }
</style>
</head>
<body>
<h1>Agent Jake Browser MCP</h1>
<p class="muted">Servidor MCP que pilota los navegadores conectados por extensión.</p>
<ul>
  <li><a href="/download">Descargar la extensión</a> (zip con esta URL y token embebidos si usas el flujo de pairing)</li>
  <li><a href="/pair">Aprobar un código de pairing</a></li>
  <li><code>/mcp</code> — endpoint MCP (streamable HTTP)</li>
</ul>
<h2>Conexiones ahora mismo</h2>
<div id="connections" class="muted">Cargando…</div>
<script>
async function load() {
  const box = document.getElementById('connections');
  try {
    const res = await fetch('/connections', { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!data.connections || data.connections.length === 0) {
      box.textContent = 'Ninguna conexión abierta. Instala la extensión y páreala con un código.';
      return;
    }
    const rows = data.connections.map((c) => '<tr><td><code>' + c.connectionId + '</code></td><td>' +
      (c.label || '') + '</td><td>' + (c.open ? 'abierta' : 'cerrada') + '</td><td>' +
      Math.round(c.secondsSinceLastActivity) + 's</td><td>' + (c.active ? '<span class="badge active">activa</span>' : '') +
      '</td></tr>').join('');
    box.innerHTML = '<table><thead><tr><th>connectionId</th><th>label</th><th>estado</th><th>última actividad</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table><p class="muted">Auth: ' + (data.authEnabled ? 'token requerido' : 'sin token') +
      ' · WS: <code>' + data.wsUrl + '</code></p>';
  } catch (err) {
    box.textContent = 'No se pudo leer /connections: ' + err;
  }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;

const PAIR_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parear navegador · Agent Jake Browser</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 2rem 1.25rem; max-width: 34rem; }
  label { display: block; margin-top: 1rem; }
  input { width: 100%; padding: .5rem; font: inherit; }
  button { margin-top: 1rem; padding: .6rem 1rem; font: inherit; cursor: pointer; }
  pre { background: rgba(127,127,127,.15); padding: .75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .muted { opacity: .7; }
  .error { color: #b3261e; }
</style>
</head>
<body>
<h1>Parear un navegador</h1>
<p class="muted">Introduce el código que muestra el popup de la extensión. Al aprobarse se emite un token de un solo uso para esa instalación.</p>
<form id="form">
  <label for="otp">Código de pairing
    <input id="otp" autocomplete="one-time-code" placeholder="ABC123" maxlength="128">
  </label>
  <button type="submit">Aprobar y emitir token</button>
</form>
<p id="message" class="muted"></p>
<pre id="result" hidden></pre>
<script>
  const params = new URLSearchParams(location.search);
  const otpInput = document.getElementById('otp');
  const message = document.getElementById('message');
  const result = document.getElementById('result');
  if (params.get('otp')) otpInput.value = params.get('otp');

  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const otp = otpInput.value.trim();
    message.className = 'muted';
    message.textContent = 'Aprobando…';
    try {
      const res = await fetch('/pair/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.className = 'error';
        message.textContent = data.error || ('Error ' + res.status);
        result.hidden = true;
        return;
      }
      message.className = 'muted';
      message.textContent = 'Aprobado. Configura la extensión con estos datos:';
      result.hidden = false;
      result.textContent = 'URL del servidor: ' + data.wsUrl + '\\nToken: ' + data.token;
    } catch (err) {
      message.className = 'error';
      message.textContent = 'Fallo la petición: ' + err;
    }
  });
</script>
</body>
</html>`;

// SECURITY: the MCP endpoint has no auth of its own, so it binds to loopback
// only. Remote use goes through an ssh tunnel or a reverse proxy that adds the
// auth — never by exposing the port directly.
app.listen(PORT, HTTP_HOST, () => {
  console.error(`Agent Jake Browser MCP HTTP endpoint on ${HTTP_HOST}:${PORT}/mcp`);
  console.error(`Agent Jake Browser extension WebSocket on ${process.env.BROWSER_WS_HOST || '127.0.0.1'}:${WS_PORT}`);
  console.error(`Extension download: ${EXTENSION_ZIP} (served at /download)`);
});
