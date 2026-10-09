/**
 * Integration tests for the multi-connection WebSocket server.
 * These drive a real WebSocketServer and real ws clients.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createWSServer, parseHandshakeParams, type WSServer } from '../src/ws-server.js';
import { createTokenStore } from '../src/token-store.js';
import type { ExtensionMessage } from '../src/types.js';

interface FakeExtension {
  socket: WebSocket;
  messages: ExtensionMessage[];
  closeCode: Promise<number | undefined>;
}

let tempDir: string;
let server: WSServer | null = null;
const clients: WebSocket[] = [];

function serverPort(srv: WSServer): Promise<number> {
  const wss = srv.server as unknown as {
    httpServer?: http.Server;
    _server?: http.Server;
  };
  const httpServer = wss.httpServer ?? wss._server;
  if (!httpServer) throw new Error('WebSocket server has no http server');
  const address = httpServer.address();
  if (typeof address === 'object' && address !== null) {
    return Promise.resolve((address as AddressInfo).port);
  }
  // port 0: the OS assigns it and the socket is not listening yet.
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.once('listening', () => {
      const bound = httpServer.address();
      if (typeof bound === 'object' && bound !== null) resolve((bound as AddressInfo).port);
      else reject(new Error('WebSocket server is not listening'));
    });
  });
}

function connect(
  port: number,
  params: { token?: string; connectionId?: string; label?: string },
  autoReply = true,
  headers?: Record<string, string | string[]>,
): Promise<FakeExtension> {
  const query = new URLSearchParams();
  if (params.token) query.set('token', params.token);
  if (params.connectionId) query.set('connectionId', params.connectionId);
  if (params.label) query.set('label', params.label);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/${query.toString() ? `?${query}` : ''}`, { headers });
  clients.push(socket);

  const messages: ExtensionMessage[] = [];
  const closeCode = new Promise<number | undefined>((resolve) => {
    socket.on('close', (code) => resolve(code));
  });

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ExtensionMessage;
    messages.push(message);
    if (autoReply) {
      socket.send(JSON.stringify({ id: message.id, success: true, result: 'ok' }));
    }
  });

  return new Promise((resolve, reject) => {
    socket.on('unexpected-response', (_req, response) =>
      reject(new Error(`handshake rejected: HTTP ${response.statusCode}`)),
    );
    socket.on('error', (err) => reject(err));
    socket.on('open', () => resolve({ socket, messages, closeCode }));
  });
}

function message(type = 'browser_navigate'): ExtensionMessage {
  return { id: `msg-${Math.random().toString(36).slice(2)}`, type: type as never, payload: {} };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ajb-ws-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  for (const client of clients) {
    try {
      client.terminate();
    } catch {
      // already gone
    }
  }
  clients.length = 0;
  await server?.close().catch(() => {});
  server = null;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.BROWSER_WS_TOKEN;
  delete process.env.BROWSER_ALLOW_PAIRING;
  delete process.env.BROWSER_TRUSTED_PROXY_IPS;
  delete process.env.BROWSER_TRUST_PROXY;
  vi.restoreAllMocks();
});

describe('multi-connection registry', () => {
  beforeEach(() => {
    server = createWSServer({
      port: 0,
      host: '127.0.0.1',
      tokenStore: createTokenStore(join(tempDir, 'tokens.json')),
    });
  });

  it('normalizes incoming labels before storing them', async () => {
    const port = await serverPort(server!);
    await connect(port, { connectionId: 'labelled', label: '  Equipo\n\u0000\u007f\u0085 / navegador  ' });
    expect(server!.listConnectionInfos()[0]!.label).toBe('Equipo / navegador');
  });

  it('limits labels and omits empty labels in handshake parsing', () => {
    const query = new URLSearchParams({ label: '  ' + 'x'.repeat(200) + '  ' });
    expect(parseHandshakeParams('/?' + query).label).toBe('x'.repeat(128));
    expect(parseHandshakeParams('/?label=%00%0A%20').label).toBeNull();
    expect(parseHandshakeParams('/').label).toBeNull();
  });

  it('does not log response payloads from the extension', async () => {
    const port = await serverPort(server!);
    const extension = await connect(port, { connectionId: 'chrome-a' }, false);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = server!.send(message('browser_network_request'));
    await vi.waitFor(() => expect(extension.messages).toHaveLength(1));
    extension.socket.send(JSON.stringify({
      id: extension.messages[0]!.id,
      success: true,
      result: { responseHeaders: { 'Set-Cookie': 'test-secret' } },
    }));
    await pending;
    expect(stderr.mock.calls.flat().join(' ')).not.toContain('test-secret');
  });

  it('keeps two connectionIds open at the same time and routes per id', async () => {
    const port = await serverPort(server!);
    const a = await connect(port, { connectionId: 'chrome-a', label: 'casa' });
    const b = await connect(port, { connectionId: 'chrome-b' });

    expect(server!.listConnectionInfos().map((c) => c.connectionId).sort()).toEqual([
      'chrome-a',
      'chrome-b',
    ]);

    const infoA = server!.listConnectionInfos().find((c) => c.connectionId === 'chrome-a')!;
    expect(infoA.label).toBe('casa');
    expect(infoA.open).toBe(true);

    // Explicit target: only chrome-b receives the message.
    await server!.sendTo('chrome-b', message());
    expect(b.messages).toHaveLength(1);
    expect(a.messages).toHaveLength(0);

    await server!.sendTo('chrome-a', message());
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
  });

  it('targets the most recently used connection when no id is given', async () => {
    const port = await serverPort(server!);
    const a = await connect(port, { connectionId: 'chrome-a' });
    const b = await connect(port, { connectionId: 'chrome-b' });

    // chrome-b registered last, so it is the default target.
    await server!.sendTo(undefined, message());
    expect(b.messages).toHaveLength(1);
    expect(a.messages).toHaveLength(0);

    // Targeting chrome-a explicitly makes it the new default.
    await server!.sendTo('chrome-a', message());
    await server!.sendTo(undefined, message());
    expect(a.messages).toHaveLength(2);
    expect(b.messages).toHaveLength(1);
  });

  it('replaces an open connection that reconnects with the same id', async () => {
    const port = await serverPort(server!);
    const first = await connect(port, { connectionId: 'chrome-a' });
    const second = await connect(port, { connectionId: 'chrome-a' });

    // The stale socket is closed by the server with a normal close code.
    expect(await first.closeCode).toBe(1000);
    expect(server!.registry.size).toBe(1);
    expect(server!.getConnection('chrome-a')).not.toBeNull();

    await server!.sendTo('chrome-a', message());
    expect(first.messages).toHaveLength(0);
    expect(second.messages).toHaveLength(1);
  });

  it('keeps an anonymous id for clients without connectionId', async () => {
    const port = await serverPort(server!);
    await connect(port, {});
    const ids = server!.listConnectionInfos().map((c) => c.connectionId);
    expect(ids).toEqual(['anon-1']);
  });

  it('rejects when no browser is open and when an unknown id is targeted', async () => {
    await expect(server!.sendTo(undefined, message())).rejects.toThrow(/No extension connected/);
    await expect(server!.sendTo('ghost', message())).rejects.toThrow(/browser_list_connections/);

    const port = await serverPort(server!);
    const a = await connect(port, { connectionId: 'chrome-a' });
    await expect(server!.sendTo('chrome-b', message())).rejects.toThrow(/chrome-a/);
    expect(a.messages).toHaveLength(0);
  });

  it('isConnected reports the target of a call', async () => {
    expect(server!.getConnection()).toBeNull();
    const port = await serverPort(server!);
    await connect(port, { connectionId: 'chrome-a' });
    expect(server!.getConnection()).not.toBeNull();
    expect(server!.getConnection('chrome-a')).not.toBeNull();
    expect(server!.getConnection('chrome-z')).toBeNull();
  });
});

describe('connection IP metadata over real WebSockets', () => {
  beforeEach(() => { delete process.env.BROWSER_TRUST_PROXY; });
  async function start(trusted?: string) {
    if (trusted) process.env.BROWSER_TRUSTED_PROXY_IPS = trusted;
    else delete process.env.BROWSER_TRUSTED_PROXY_IPS;
    server = createWSServer({ port: 0, host: '127.0.0.1', tokenStore: createTokenStore(join(tempDir, 'tokens.json')) });
    return serverPort(server);
  }

  it('ignores forged headers by default for a legacy connection', async () => {
    const port = await start();
    await connect(port, {}, false, { 'X-Real-IP': '203.0.113.9', 'X-Forwarded-For': '203.0.113.10' });
    expect(server!.listConnectionInfos()[0]).toMatchObject({ connectionId: 'anon-1', label: '', clientIp: '127.0.0.1', peerIp: '127.0.0.1', clientIpSource: 'socket' });
  });

  it('retains manual labels and validated IPv6 metadata from an explicitly trusted peer', async () => {
    const port = await start('::ffff:127.0.0.1');
    await connect(port, { label: 'Equipo', connectionId: 'labelled' }, false, { 'X-Real-IP': '2001:0db8::2' });
    expect(server!.listConnectionInfos()[0]).toMatchObject({ label: 'Equipo', clientIp: '2001:db8::2', peerIp: '127.0.0.1', clientIpSource: 'x-real-ip' });
  });

  it('accepts the last XFF address and falls back for invalid and duplicate headers', async () => {
    const port = await start('127.0.0.1');
    await connect(port, { connectionId: 'xff' }, false, { 'X-Forwarded-For': '203.0.113.9, 192.0.2.2', 'X-Real-IP': '203.0.113.99' });
    await connect(port, { connectionId: 'bad' }, false, { 'X-Real-IP': '192.0.2.2', 'X-Forwarded-For': 'invalid' });
    await connect(port, { connectionId: 'duplicate' }, false, { 'X-Real-IP': ['192.0.2.1', '192.0.2.2'] });
    const infos = server!.listConnectionInfos();
    expect(infos.find((c) => c.connectionId === 'xff')).toMatchObject({ clientIp: '192.0.2.2', clientIpSource: 'x-forwarded-for' });
    for (const id of ['bad', 'duplicate']) expect(infos.find((c) => c.connectionId === id)).toMatchObject({ clientIp: '127.0.0.1', clientIpSource: 'socket' });
  });

  it('trusts forwarded metadata with the dynamic proxy flag and static authentication', async () => {
    process.env.BROWSER_TRUST_PROXY = 'true';
    process.env.BROWSER_WS_TOKEN = 'test-token';
    const port = await start('invalid');
    await expect(connect(port, {}, false, { 'X-Real-IP': '192.0.2.2' })).rejects.toThrow(/401/);
    await connect(port, { token: 'test-token', connectionId: 'valid' }, false, { 'X-Real-IP': '192.0.2.2' });
    await connect(port, { token: 'test-token', connectionId: 'invalid' }, false, { 'X-Real-IP': '192.0.2.2,203.0.113.9' });
    expect(server!.listConnectionInfos().find((c) => c.connectionId === 'valid')).toMatchObject({ clientIp: '192.0.2.2', clientIpSource: 'x-real-ip' });
    expect(server!.listConnectionInfos().find((c) => c.connectionId === 'invalid')).toMatchObject({ clientIp: '127.0.0.1', clientIpSource: 'socket' });
  });

  it('trusts the dynamic proxy flag with pairing authentication', async () => {
    process.env.BROWSER_TRUST_PROXY = 'true';
    process.env.BROWSER_ALLOW_PAIRING = 'true';
    await start();
    const token = createTokenStore(join(tempDir, 'tokens.json')).issueToken({ label: 'paired' });
    // Use the same store instance as the server, whose tokens are held in memory.
    await server!.close();
    server = createWSServer({ port: 0, host: '127.0.0.1', tokenStore: createTokenStore(join(tempDir, 'tokens.json')) });
    await connect(await serverPort(server), { token }, false, { 'X-Forwarded-For': '203.0.113.9, 192.0.2.2', 'X-Real-IP': '203.0.113.99' });
    expect(server!.listConnectionInfos()[0]).toMatchObject({ clientIp: '192.0.2.2', clientIpSource: 'x-forwarded-for' });
  });

  it('ignores the dynamic proxy flag without authentication', async () => {
    process.env.BROWSER_TRUST_PROXY = 'true';
    const port = await start();
    await connect(port, {}, false, { 'X-Real-IP': '192.0.2.2' });
    expect(server!.listConnectionInfos()[0]).toMatchObject({ clientIp: '127.0.0.1', clientIpSource: 'socket' });
  });

  it('disables all trust when one configured entry is invalid', async () => {
    const port = await start('127.0.0.1,invalid');
    await connect(port, {}, false, { 'X-Real-IP': '192.0.2.2' });
    expect(server!.listConnectionInfos()[0]).toMatchObject({ clientIp: '127.0.0.1', clientIpSource: 'socket' });
  });
});

describe('handshake auth', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects a handshake without the static token and accepts the right one', async () => {
    process.env.BROWSER_WS_TOKEN = 's3cret';
    server = createWSServer({
      port: 0,
      host: '127.0.0.1',
      tokenStore: createTokenStore(join(tempDir, 'tokens.json')),
    });
    const port = await serverPort(server!);

    await expect(connect(port, {})).rejects.toThrow(/401/);
    await expect(connect(port, { token: 'wrong' })).rejects.toThrow(/401/);

    const client = await connect(port, { token: 's3cret', connectionId: 'chrome-a' });
    expect(server!.listConnectionInfos()).toHaveLength(1);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('accepts a pairing-issued token when pairing is allowed', async () => {
    process.env.BROWSER_ALLOW_PAIRING = 'true';
    delete process.env.BROWSER_WS_TOKEN;
    const store = createTokenStore(join(tempDir, 'tokens.json'));
    const token = store.issueToken({ label: 'chrome' });

    server = createWSServer({ port: 0, host: '127.0.0.1', tokenStore: store });
    const port = await serverPort(server!);

    await expect(connect(port, {})).rejects.toThrow(/401/);
    const client = await connect(port, { token, connectionId: 'chrome-a' });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('stays open when neither a static token nor pairing is configured', async () => {
    delete process.env.BROWSER_WS_TOKEN;
    delete process.env.BROWSER_ALLOW_PAIRING;
    server = createWSServer({
      port: 0,
      host: '127.0.0.1',
      tokenStore: createTokenStore(join(tempDir, 'tokens.json')),
    });
    const client = await connect(await serverPort(server!), { connectionId: 'chrome-a' });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});
