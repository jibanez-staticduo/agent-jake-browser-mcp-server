/**
 * Integration tests for the HTTP surface of http-server.js: the `connection`
 * annotation, per-browser routing, the pairing web, the download route and the
 * connection listing. The server runs as a real child process, exactly like the
 * container entrypoint, and is driven over HTTP and WebSocket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';

const repoRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));

const httpPort = 21500 + Math.floor(Math.random() * 300);
const wsPort = httpPort + 1;
const httpBase = `http://127.0.0.1:${httpPort}`;
const wsBase = `ws://127.0.0.1:${wsPort}`;

let child: ChildProcess;
let tempDir: string;
let tokenStoreFile: string;
let zipFile: string;
let sessionId: string | null = null;
let pairedToken = '';

interface FakeExtension {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
}

async function request(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; raw?: boolean } = {},
): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const res = await fetch(`${httpBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html / zip / plain text responses
  }
  return { status: res.status, text, json, headers: res.headers };
}

/** The streamable transport may answer with JSON or with an SSE frame. */
function mcpPayload(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLine = trimmed
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data:'));
  return dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : null;
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await request('POST', '/mcp', {
    headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  });
  return mcpPayload(res.text)?.result ?? mcpPayload(res.text)?.error;
}

async function waitForHealth(timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpBase}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`http-server did not become healthy: ${lastError}`);
}

function connectExtension(
  token: string,
  connectionId: string,
  label?: string,
): Promise<FakeExtension> {
  const query = new URLSearchParams({ token, connectionId });
  if (label) query.set('label', label);
  const socket = new WebSocket(`${wsBase}/?${query.toString()}`);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    socket.send(JSON.stringify({ id: message.id, success: true, result: 'paged' }));
  });
  return new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.on('open', () => resolve({ socket, messages }));
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'ajb-http-'));
  tokenStoreFile = join(tempDir, 'data', 'tokens.json');
  zipFile = join(tempDir, 'agent-jake-browser-extension.zip');
  writeFileSync(zipFile, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));

  child = spawn(process.execPath, ['--import', 'tsx', 'http-server.js'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MCP_HTTP_PORT: String(httpPort),
      MCP_HTTP_HOST: '127.0.0.1',
      BROWSER_WS_PORT: String(wsPort),
      BROWSER_WS_HOST: '127.0.0.1',
      BROWSER_ALLOW_PAIRING: 'true',
      BROWSER_TOKEN_STORE: tokenStoreFile,
      BROWSER_EXTENSION_ZIP: zipFile,
    },
  });

  await waitForHealth();
}, 40000);

afterAll(async () => {
  child?.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(tempDir, { recursive: true, force: true });
});

describe('tools/list annotation', () => {
  it('advertises the optional connection argument on every tool', async () => {
    const res = await request('POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.status).toBe(200);
    const tools = res.json.result.tools as Array<{ name: string; inputSchema: any }>;
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((t) => t.name)).toContain('browser_list_connections');
    for (const tool of tools) {
      expect(tool.inputSchema.properties.connection, tool.name).toEqual({
        type: 'string',
        description:
          'Browser connection id to target; defaults to the most recently used. See browser_list_connections.',
      });
    }
  });
});

describe('pairing web', () => {
  it('rejects malformed codes', async () => {
    const res = await request('POST', '/pair/start', { body: { otp: 'x' } });
    expect(res.status).toBe(400);
  });

  it('answers CORS preflights', async () => {
    const res = await request('OPTIONS', '/pair/approve');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('starts pending, approves once and reports status', async () => {
    const start = await request('POST', '/pair/start', {
      body: { otp: 'HTTPOTP42', connectionId: 'chrome-http', label: 'integracion' },
    });
    expect(start.status).toBe(201);
    expect(start.json.state).toBe('pending');
    expect(start.json.approveUrl).toContain('/pair?otp=HTTPOTP42');

    const statusBefore = await request('GET', '/pair/status?otp=HTTPOTP42');
    expect(statusBefore.json).toMatchObject({
      state: 'pending',
      connectionId: 'chrome-http',
      label: 'integracion',
    });

    const page = await request('GET', '/pair?otp=HTTPOTP42');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Parear un navegador');

    const approve = await request('POST', '/pair/approve', { body: { otp: 'HTTPOTP42' } });
    expect(approve.status).toBe(200);
    expect(approve.json.token).toMatch(/^[0-9a-f]{64}$/);
    expect(approve.json.wsUrl).toBe(`${wsBase}/`);
    pairedToken = approve.json.token;

    // The token must be on disk so it survives a container restart.
    await expect.poll(() => existsSync(tokenStoreFile)).toBe(true);
    expect(readFileSync(tokenStoreFile, 'utf-8')).toContain(pairedToken);

    const statusAfter = await request('GET', '/pair/status?otp=HTTPOTP42');
    expect(statusAfter.json).toMatchObject({ state: 'approved', token: pairedToken });

    const second = await request('POST', '/pair/approve', { body: { otp: 'HTTPOTP42' } });
    expect(second.status).toBe(410);

    const unknown = await request('POST', '/pair/approve', { body: { otp: 'NEVERSTARTED' } });
    expect(unknown.status).toBe(410);
  });
});

describe('browser connections over the running server', () => {
  it('accepts the paired token and rejects a request without one', async () => {
    await expect(connectExtension('00000000000000000000000000000000', 'chrome-nope')).rejects.toThrow(
      /401/,
    );
    const extension = await connectExtension(pairedToken, 'chrome-http', 'integracion');
    expect(extension.socket.readyState).toBe(WebSocket.OPEN);

    const listing = await request('GET', '/connections');
    expect(listing.json.authEnabled).toBe(true);
    expect(listing.json.connections).toHaveLength(1);
    expect(listing.json.connections[0]).toMatchObject({
      connectionId: 'chrome-http',
      label: 'integracion',
      open: true,
      active: true,
    });

    extension.socket.close();
    // The server must drop it from the registry so it stops being a target.
    await expect
      .poll(async () => ((await request('GET', '/connections')).json.connections as unknown[]).length)
      .toBe(0);
  });
});

describe('tools/call through an MCP session', () => {
  beforeAll(async () => {
    const init = await request('POST', '/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1' },
        },
      },
    });
    sessionId = init.headers.get('mcp-session-id');
    expect(sessionId, JSON.stringify(init.json)).toBeTruthy();

    await request('POST', '/mcp', {
      headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
  }, 30000);

  it('lists connections without a browser and without waiting for one', async () => {
    const result = await mcpCall('browser_list_connections', {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it('routes to the requested browser and keeps connection out of the payload', async () => {
    const extension = await connectExtension(pairedToken, 'chrome-http');
    await expect
      .poll(() => {
        return (request('GET', '/connections').then((r) => r.json) as any).then(
          (data: any) => data.connections.length,
        );
      })
      .toBe(1);

    const result = await mcpCall('browser_navigate', {
      url: 'https://example.com',
      connection: 'chrome-http',
    });
    expect(result.isError).toBeUndefined();
    expect(extension.messages).toHaveLength(1);
    expect(extension.messages[0]).toMatchObject({
      type: 'browser_navigate',
      payload: { url: 'https://example.com' },
    });
    expect(JSON.stringify(extension.messages[0])).not.toContain('connection');

    // Without an explicit id the single open connection is targeted.
    await mcpCall('browser_reload', {});
    expect(extension.messages).toHaveLength(2);

    extension.socket.close();
  }, 30000);

  it('reports an unknown connection id instead of guessing', async () => {
    const result = await mcpCall('browser_navigate', {
      url: 'https://example.com',
      connection: 'chrome-ghost',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('browser_list_connections');
  });
});

describe('download and landing page', () => {
  it('serves the extension zip and explains when it is missing', async () => {
    const download = await request('GET', '/download');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/zip');
    expect(download.headers.get('cache-control')).toContain('max-age');
    expect(download.headers.get('content-disposition')).toContain('agent-jake-browser-extension.zip');

    rmSync(zipFile);
    const missing = await request('GET', '/download');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('BROWSER_EXTENSION_ZIP');
  });

  it('links download and pairing from the landing page', async () => {
    const page = await request('GET', '/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('href="/download"');
    expect(page.text).toContain('href="/pair"');
    expect(page.headers.get('cache-control')).toContain('max-age');
  });
});
