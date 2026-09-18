/**
 * Integration tests for the HTTP surface of http-server.js: the `connection`
 * annotation, per-browser routing, the pairing web, the connection listing and the
 * download route (including config.json injection from BROWSER_PUBLIC_WS_URL).
 * The server runs as a real child process, exactly like the container entrypoint,
 * and is driven over HTTP and WebSocket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import AdmZip from 'adm-zip';
import { configEntryName, extensionConfigJson, patchZipConfig } from '../src/extension-zip.ts';

const repoRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));

const basePort = 21500 + Math.floor(Math.random() * 300) * 4;
const httpPort = basePort;
const wsPort = basePort + 1;
const dlHttpPort = basePort + 2;
const dlWsPort = basePort + 3;

/** Value chosen to differ from anything the server could derive from a request. */
const DOWNLOAD_WS_URL = 'wss://download.test/ws';

let tempDir: string;
let tokenStoreFile: string;
let zipFile: string;
let dlZipFile: string;
let primary: RunningServer;
let downloader: RunningServer;
let sessionId: string | null = null;
let pairedToken = '';

interface RunningServer {
  child: ChildProcess;
  httpBase: string;
  wsBase: string;
  stderr: () => string;
}

interface FakeExtension {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
}

function templateZipBuffer(options: { withStaleConfig?: boolean } = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ manifest_version: 3, name: 'ajb-test', version: '1.0.0' })),
  );
  zip.addFile('service-worker-loader.js', Buffer.from('import "./assets/index.js";'));
  zip.addFile('assets/index.js', Buffer.from('console.log("extension");'.repeat(40)));
  zip.addFile('.vite/manifest.json', Buffer.from(JSON.stringify({ src: { file: 'assets/index.js' } })));
  if (options.withStaleConfig) {
    zip.addFile('config.json', Buffer.from(JSON.stringify({ version: 1, wsUrl: 'ws://stale.invalid/' })));
  }
  return zip.toBuffer();
}

async function startServer(options: {
  httpPort: number;
  wsPort: number;
  zipPath: string;
  tokenStore: string;
  publicWsUrl?: string;
}): Promise<RunningServer> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    MCP_HTTP_PORT: String(options.httpPort),
    MCP_HTTP_HOST: '127.0.0.1',
    BROWSER_WS_PORT: String(options.wsPort),
    BROWSER_WS_HOST: '127.0.0.1',
    BROWSER_ALLOW_PAIRING: 'true',
    BROWSER_TOKEN_STORE: options.tokenStore,
    BROWSER_EXTENSION_ZIP: options.zipPath,
  };
  delete env.BROWSER_PUBLIC_WS_URL;
  if (options.publicWsUrl) env.BROWSER_PUBLIC_WS_URL = options.publicWsUrl;

  const child = spawn(process.execPath, ['--import', 'tsx', 'http-server.js'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();

  const httpBase = `http://127.0.0.1:${options.httpPort}`;
  const deadline = Date.now() + 25000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpBase}/healthz`);
      if (res.ok) {
        return {
          child,
          httpBase,
          wsBase: `ws://127.0.0.1:${options.wsPort}`,
          stderr: () => stderr,
        };
      }
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`http-server did not become healthy: ${lastError}\n${stderr}`);
}

async function request(
  server: RunningServer,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; json: any; headers: Headers; buffer: Buffer }> {
  const res = await fetch(`${server.httpBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf-8');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html / zip / plain text responses
  }
  return { status: res.status, text, json, headers: res.headers, buffer };
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
  const res = await request(primary, 'POST', '/mcp', {
    headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  });
  return mcpPayload(res.text)?.result ?? mcpPayload(res.text)?.error;
}

function configInZip(buffer: Buffer): { entryName: string; content: string } {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((candidate) => candidate.entryName.endsWith('config.json'));
  if (!entry) throw new Error('config.json missing from the served zip');
  return { entryName: entry.entryName, content: zip.readAsText(entry) };
}

function connectExtension(
  server: RunningServer,
  token: string,
  connectionId: string,
  label?: string,
): Promise<FakeExtension> {
  const query = new URLSearchParams({ token, connectionId });
  if (label) query.set('label', label);
  const socket = new WebSocket(`${server.wsBase}/?${query.toString()}`);
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
  dlZipFile = join(tempDir, 'mount', 'agent-jake-browser-extension.zip');
  writeFileSync(zipFile, templateZipBuffer());

  primary = await startServer({
    httpPort,
    wsPort,
    zipPath: zipFile,
    tokenStore: tokenStoreFile,
  });
}, 40000);

afterAll(async () => {
  for (const server of [primary, downloader]) {
    server?.child.kill('SIGKILL');
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(tempDir, { recursive: true, force: true });
});

describe('tools/list annotation', () => {
  it('advertises the optional connection argument on every tool', async () => {
    const res = await request(primary, 'POST', '/mcp', {
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
    const res = await request(primary, 'POST', '/pair/start', { body: { otp: 'x' } });
    expect(res.status).toBe(400);
  });

  it('answers CORS preflights', async () => {
    const res = await request(primary, 'OPTIONS', '/pair/approve');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('starts pending, approves once and reports status', async () => {
    const start = await request(primary, 'POST', '/pair/start', {
      body: { otp: 'HTTPOTP42', connectionId: 'chrome-http', label: 'integracion' },
    });
    expect(start.status).toBe(201);
    expect(start.json.state).toBe('pending');
    expect(start.json.approveUrl).toContain('/pair?otp=HTTPOTP42');

    const statusBefore = await request(primary, 'GET', '/pair/status?otp=HTTPOTP42');
    expect(statusBefore.json).toMatchObject({
      state: 'pending',
      connectionId: 'chrome-http',
      label: 'integracion',
    });

    const page = await request(primary, 'GET', '/pair?otp=HTTPOTP42');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Parear un navegador');

    const approve = await request(primary, 'POST', '/pair/approve', { body: { otp: 'HTTPOTP42' } });
    expect(approve.status).toBe(200);
    expect(approve.json.token).toMatch(/^[0-9a-f]{64}$/);
    expect(approve.json.wsUrl).toBe(`${primary.wsBase}/`);
    pairedToken = approve.json.token;

    // The token must be on disk so it survives a container restart.
    await expect.poll(() => existsSync(tokenStoreFile)).toBe(true);
    expect(readFileSync(tokenStoreFile, 'utf-8')).toContain(pairedToken);

    const statusAfter = await request(primary, 'GET', '/pair/status?otp=HTTPOTP42');
    expect(statusAfter.json).toMatchObject({ state: 'approved', token: pairedToken });

    const second = await request(primary, 'POST', '/pair/approve', { body: { otp: 'HTTPOTP42' } });
    expect(second.status).toBe(410);

    const unknown = await request(primary, 'POST', '/pair/approve', { body: { otp: 'NEVERSTARTED' } });
    expect(unknown.status).toBe(410);
  });
});

describe('browser connections over the running server', () => {
  it('accepts the paired token and rejects a request without one', async () => {
    await expect(
      connectExtension(primary, '00000000000000000000000000000000', 'chrome-nope'),
    ).rejects.toThrow(/401/);
    const extension = await connectExtension(primary, pairedToken, 'chrome-http', 'integracion');
    expect(extension.socket.readyState).toBe(WebSocket.OPEN);

    const listing = await request(primary, 'GET', '/connections');
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
      .poll(
        async () => ((await request(primary, 'GET', '/connections')).json.connections as unknown[]).length,
      )
      .toBe(0);
  });
});

describe('tools/call through an MCP session', () => {
  beforeAll(async () => {
    const init = await request(primary, 'POST', '/mcp', {
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

    await request(primary, 'POST', '/mcp', {
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
    const extension = await connectExtension(primary, pairedToken, 'chrome-http');
    await expect
      .poll(async () => ((await request(primary, 'GET', '/connections')).json.connections as unknown[]).length)
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

describe('download without BROWSER_PUBLIC_WS_URL', () => {
  it('serves the template byte for byte and keeps the headers', async () => {
    const source = readFileSync(zipFile);
    const download = await request(primary, 'GET', '/download');

    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/zip');
    expect(download.headers.get('content-disposition')).toContain('agent-jake-browser-extension.zip');
    expect(download.headers.get('cache-control')).toContain('max-age');
    expect(Number(download.headers.get('content-length'))).toBe(source.length);
    expect(download.buffer.equals(source)).toBe(true);

    const zip = new AdmZip(download.buffer);
    expect(zip.getEntries().map((entry) => entry.entryName)).not.toContain('config.json');
    expect(primary.stderr()).not.toContain('config.json');
  });

  it('links download and pairing from the landing page', async () => {
    const page = await request(primary, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('href="/download"');
    expect(page.text).toContain('href="/pair"');
    expect(page.headers.get('cache-control')).toContain('max-age');
  });
});

describe('download with BROWSER_PUBLIC_WS_URL', () => {
  beforeAll(async () => {
    mkdirSync(dirname(dlZipFile), { recursive: true });
    writeFileSync(dlZipFile, templateZipBuffer());
    downloader = await startServer({
      httpPort: dlHttpPort,
      wsPort: dlWsPort,
      zipPath: dlZipFile,
      tokenStore: join(tempDir, 'dl-tokens.json'),
      publicWsUrl: DOWNLOAD_WS_URL,
    });
  }, 40000);

  afterAll(async () => {
    downloader?.child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it('injects config.json with the exact wsUrl, next to manifest.json', async () => {
    const source = readFileSync(dlZipFile);
    const download = await request(downloader, 'GET', '/download');

    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/zip');
    expect(download.headers.get('content-disposition')).toContain('agent-jake-browser-extension.zip');
    expect(Number(download.headers.get('content-length'))).toBe(download.buffer.length);
    expect(download.buffer.equals(source)).toBe(false);

    const config = configInZip(download.buffer);
    expect(config.entryName).toBe('config.json');
    expect(config.content).toBe(extensionConfigJson(DOWNLOAD_WS_URL));
    expect(config.content).toBe(`{"version":1,"wsUrl":"${DOWNLOAD_WS_URL}"}`);
    expect(JSON.parse(config.content)).toEqual({ version: 1, wsUrl: DOWNLOAD_WS_URL });

    // The extension payload itself must survive untouched.
    const zip = new AdmZip(download.buffer);
    const names = zip.getEntries().map((entry) => entry.entryName);
    expect(names).toContain('manifest.json');
    expect(names).toContain('service-worker-loader.js');
    expect(names).toContain('.vite/manifest.json');
    expect(zip.readAsText('assets/index.js')).toContain('console.log("extension")');
    expect(zip.readAsText('manifest.json')).toContain('ajb-test');
  });

  it('caches the patched archive across requests', async () => {
    const first = await request(downloader, 'GET', '/download');
    const second = await request(downloader, 'GET', '/download');

    expect(second.buffer.equals(first.buffer)).toBe(true);
    const injections = downloader.stderr().match(/config\.json ->/g) ?? [];
    expect(injections).toHaveLength(1);
  });

  it('re-injects and updates a config.json that already exists in the template', async () => {
    writeFileSync(dlZipFile, templateZipBuffer({ withStaleConfig: true }));

    const download = await request(downloader, 'GET', '/download');
    const config = configInZip(download.buffer);
    expect(config.content).toBe(`{"version":1,"wsUrl":"${DOWNLOAD_WS_URL}"}`);

    const zip = new AdmZip(download.buffer);
    expect(zip.getEntries().filter((entry) => entry.entryName === 'config.json')).toHaveLength(1);
    expect(downloader.stderr()).toContain('updated config.json');
  });
});

describe('download failures', () => {
  it('explains a missing template and never writes over it', async () => {
    const before = readFileSync(zipFile);
    rmSync(zipFile);

    const missing = await request(primary, 'GET', '/download');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('BROWSER_EXTENSION_ZIP');
    expect(existsSync(zipFile)).toBe(false);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('patchZipConfig helpers', () => {
  it('keeps config.json at the zip root when manifest.json is at the root', () => {
    expect(configEntryName(['manifest.json', '.vite/manifest.json', 'assets/index.js'])).toBe(
      'config.json',
    );
  });

  it('follows a nested manifest.json but ignores the vite one', () => {
    expect(configEntryName(['dist/manifest.json', 'dist/assets/a.js'])).toBe('dist/config.json');
    expect(configEntryName(['.vite/manifest.json'])).toBe('config.json');
    expect(configEntryName(['assets/a.js'])).toBe('config.json');
  });

  it('adds or updates the entry and leaves the rest alone', () => {
    const template = templateZipBuffer();
    const added = patchZipConfig(template, 'wss://nas.example/ws');
    expect(added.entryName).toBe('config.json');
    expect(added.replaced).toBe(false);

    const withConfig = new AdmZip(added.buffer);
    expect(withConfig.readAsText('config.json')).toBe('{"version":1,"wsUrl":"wss://nas.example/ws"}');

    const updated = patchZipConfig(added.buffer, 'wss://otro.example/ws');
    expect(updated.replaced).toBe(true);
    const reloaded = new AdmZip(updated.buffer);
    expect(reloaded.readAsText('config.json')).toBe('{"version":1,"wsUrl":"wss://otro.example/ws"}');
    expect(reloaded.getEntries().filter((e) => e.entryName === 'config.json')).toHaveLength(1);
    expect(reloaded.readAsText('manifest.json')).toContain('ajb-test');

    // The input buffer is never mutated and no token ever lands in the config.
    expect(new AdmZip(template).getEntries().map((e) => e.entryName)).not.toContain('config.json');
    expect(updated.buffer.length).toBeGreaterThan(0);
    expect(extensionConfigJson('wss://x/ws')).not.toMatch(/token/i);
  });
});
