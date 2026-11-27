import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createSetupStore } from '../src/setup-store.js';
import { createTokenStore } from '../src/token-store.js';

const hostname = 'setup.example.test';
const origin = `https://${hostname}`;
const settings = {
  wsUrl: `wss://${hostname}/ws`, baseUrl: 'https://models.example.test/v1',
  mcpUrl: 'https://mcp.example.test/mcp', apiKey: 'local-test-api-key', mcpToken: 'local-test-mcp-token',
};
const extension = { origin: `chrome-extension://${'a'.repeat(32)}` };
const verified = { 'x-agent-jake-client-ip': '192.0.2.7' };
const approval = { origin, 'sec-fetch-site': 'same-origin' };
const navigation = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const httpPort = 25500 + Math.floor(Math.random() * 1000) * 2;
const tokenFilePath = join(mkdtempSync(join(tmpdir(), 'ajb-setup-')), 'tokens.json');
const configFilePath = join(tokenFilePath, '..', 'setup.json');
const oldId = randomUUID();
const legacyToken = 'existing-test-token';
const staticToken = 'static-test-token';
let child: ChildProcess | undefined;

async function http(path: string, options: {
  body?: unknown; headers?: Record<string, string | string[]>; method?: string; from?: string;
} = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<{ status: number; text: string; headers: Record<string, unknown>; json: any }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: httpPort, path, localAddress: options.from,
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { host: hostname, ...(body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => {
        let json;
        if (res.headers['content-type']?.startsWith('application/json')) json = JSON.parse(text);
        resolve({ status: res.statusCode!, text, headers: res.headers, json });
      });
    });
    req.on('error', reject).end(body);
  });
}

function start(body: object = {}, headers = verified) {
  return http('/setup/start', { body, headers: { ...extension, ...headers } });
}

function approve(code: string, details: object = {}) {
  return http('/setup/approve', { body: { code, ...details }, headers: { ...approval, ...verified } });
}

function status(pollSecret: string) {
  return http('/setup/status', { body: { pollSecret }, headers: { ...extension, ...verified } });
}

async function openSocket(params: { connectionId: string; label?: string; token?: string }) {
  const query = new URLSearchParams(params);
  return new Promise<WebSocket | number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${httpPort + 1}/?${query}`);
    socket.on('error', reject);
    socket.once('open', () => { resolve(socket); });
    socket.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); });
  });
}

async function connect(params: Parameters<typeof openSocket>[0]) {
  const socket = await openSocket(params);
  if (typeof socket === 'number') return socket;
  socket.close();
  await once(socket, 'close');
  return 101;
}

function writeConfig(overrides: Partial<typeof settings> = {}, file = configFilePath) {
  writeFileSync(file, JSON.stringify({
    origin, ...settings, ...overrides, trustedProxyIps: ['127.0.0.1'], lanCidrs: ['192.0.2.0/24', 'fd00:1234::/64'],
    hostByIp: { '192.0.2.7': 'Workstation' },
  }));
}

function spawnServer(setupFile = configFilePath) {
  return spawn(process.execPath, ['dist/http-server.js'], {
    env: { ...process.env, MCP_HTTP_PORT: String(httpPort), MCP_HTTP_HOST: '127.0.0.1',
      BROWSER_WS_PORT: String(httpPort + 1), BROWSER_WS_HOST: '127.0.0.1',
      AGENT_BROWSER_SETUP_FILE: setupFile, BROWSER_TOKEN_STORE: tokenFilePath, BROWSER_WS_TOKEN: staticToken,
      BROWSER_ALLOW_PAIRING: 'false', AGENT_BROWSER_DEFAULT_CONNECTION: 'Reserved - Default',
      AGENT_BROWSER_CONNECTION_LABELS: JSON.stringify({ [oldId]: 'Reserved - Alias' }) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function startServer() {
  child = spawnServer();
  let stderr = '';
  child.stderr?.on('data', (s) => { stderr += s; });
  for (let retry = 0; retry < 100; retry++) {
    if (await http('/healthz').then((r) => r.status === 200).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(stderr);
}

async function stopServer() {
  if (child?.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}

beforeAll(async () => {
  writeConfig();
  createTokenStore(tokenFilePath).addToken(legacyToken, { connectionId: oldId, label: ' Old - Chrome ' });
  await startServer();
});

afterAll(async () => {
  await stopServer();
  rmSync(join(tokenFilePath, '..'), { recursive: true, force: true });
});

describe('LAN provisioning', () => {
  it('requires the configured authority, proxy peer and one verified LAN address', async () => {
    for (const options of [
      { headers: { ...extension, ...verified, host: 'outside.example.test' } },
      { headers: { ...extension, ...verified }, from: '127.0.0.2' },
      { headers: { ...extension, 'x-forwarded-for': verified['x-agent-jake-client-ip'] } },
      { headers: { ...extension, 'x-agent-jake-client-ip': [verified['x-agent-jake-client-ip'], '192.0.2.8'] } },
      { headers: { ...extension, 'x-agent-jake-client-ip': '203.0.113.7' } },
    ]) {
      const reply = await http('/setup/start', { ...options, body: {} });
      expect(reply.status).toBe(403);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect((await start({}, { 'x-agent-jake-client-ip': 'fd00:1234::ab' })).status).toBe(201);
    expect((await http('/SETUP/start', { body: {}, headers: { ...extension, ...verified } })).status).toBe(404);
    expect((await http('/pair/start', { body: { otp: 'legacy' }, headers: { ...extension, ...verified } })).status).toBe(404);
    expect((await http('/pair/approve', { body: { otp: 'legacy' }, headers: { ...approval, ...verified } })).status).toBe(404);
    expect((await http('/pair/status?otp=legacy', { headers: { ...extension, ...verified } })).status).toBe(404);
  });

  it('isolates navigation, approval and polling origins', async () => {
    const fresh = (await start()).json;
    const pageUrl = `/setup?code=${fresh.approvalCode}`;
    const page = await http(pageUrl, { headers: { ...navigation, ...verified } });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-frame-options']).toBe('DENY');
    for (const secret of [settings.apiKey, settings.mcpToken, fresh.pollSecret, fresh.approvalCode]) {
      expect(page.text).not.toContain(secret);
    }
    expect(page.text).toContain("if (/^[A-Za-z0-9_-]{43}$/.test(code || '')) void approve()");
    expect((await http(pageUrl, { headers: { ...navigation, ...verified, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await http('/setup/approve', { body: { code: fresh.approvalCode }, headers: { ...verified, ...extension } })).status).toBe(403);
    expect((await http('/setup/approve', {
      body: { code: fresh.approvalCode }, headers: { ...verified, ...approval, 'content-type': 'text/plain' },
    })).status).toBe(415);
    expect((await http('/setup/status', { body: { pollSecret: fresh.pollSecret }, headers: { ...verified, ...approval } })).status).toBe(403);
    const preflight = await http('/setup/start', { method: 'OPTIONS', headers: { ...extension, ...verified } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(extension.origin);
  });

  it('lets the user correct invalid approval details and recovers one persisted credential set', async () => {
    const initial = await start({ connectionId: oldId });
    expect(initial.status).toBe(201);
    const { approvalCode, pollSecret } = initial.json;
    expect(approvalCode).toMatch(/^[\w-]{43}$/);
    expect(pollSecret).toMatch(/^[\w-]{43}$/);
    expect(approvalCode).not.toBe(pollSecret);
    expect((await status(approvalCode)).json).toEqual({ state: 'expired' });
    expect((await status(pollSecret)).json).toEqual({ state: 'pending' });
    const need = await approve(approvalCode);
    expect(need.status).toBe(422);
    expect(need.json).toEqual({ state: 'pending', missing: ['profile'] });
    const invalid = await approve(approvalCode, { profile: '   ' });
    expect(invalid.status).toBe(400);
    expect(invalid.json.invalid).toEqual(['profile']);
    expect((await status(pollSecret)).json).toEqual({ state: 'pending' });
    expect((await approve(approvalCode, { profile: 'Chrome', host: 'ignored' })).json).toEqual({ state: 'approved' });
    expect((await approve(approvalCode, { profile: 'ignored' })).json).toEqual({ state: 'approved' });
    expect(JSON.parse(readFileSync(tokenFilePath, 'utf8')).tokens).toHaveLength(1);
    const polls = (await Promise.all([status(pollSecret), status(pollSecret)])).map((reply) => reply.json);
    expect(polls.map((result) => result.state)).toEqual(['approved', 'approved']);
    expect(polls[0]).toEqual(polls[1]);
    const config = polls[0].config;
    expect(config).toEqual({ ...settings, connectionId: expect.any(String), label: 'Workstation - Chrome', token: expect.any(String) });
    expect(config.connectionId).not.toBe(oldId);
    expect((await approve(approvalCode)).status).toBe(410);
    expect(JSON.parse(readFileSync(tokenFilePath, 'utf8')).tokens).toHaveLength(2);
    expect(await connect({ connectionId: oldId, label: 'Old - Chrome', token: legacyToken })).toBe(101);
    expect(await connect({ connectionId: config.connectionId, label: config.label })).toBe(401);
    expect(await connect({ connectionId: oldId, label: config.label, token: config.token })).toBe(401);
    expect(await connect({ connectionId: config.connectionId, label: 'other label', token: legacyToken })).toBe(401);
    expect(await connect({ connectionId: config.connectionId, label: 'Renamed locally', token: config.token })).toBe(101);

    await stopServer();
    await startServer();
    expect((await status(pollSecret)).json).toEqual({ state: 'expired' });
    expect(await connect({ connectionId: config.connectionId, token: config.token })).toBe(101);
  });

  it('reserves existing routing names and issues distinct IDs across multiple approvals', async () => {
    for (const [host, profile] of [['old', 'chrome'], ['reserved', 'alias'], ['reserved', 'default']]) {
      const { approvalCode } = (await start({ host, profile })).json;
      const reply = await approve(approvalCode);
      expect(reply.status).toBe(422);
      expect(reply.json).toEqual({ state: 'pending', missing: ['profile'], conflict: true });
    }
    const one = (await start({ host: 'Test Lab', profile: 'Firefox', connectionId: oldId })).json;
    const two = (await start({ host: 'TEST LAB', profile: 'firefox', connectionId: oldId })).json;
    expect((await approve(one.approvalCode)).status).toBe(200);
    for (const token of [legacyToken, staticToken]) {
      expect(await connect({ connectionId: ' TEST LAB - firefox ', token })).toBe(401);
    }
    expect((await approve(two.approvalCode)).status).toBe(422);
    expect((await approve(two.approvalCode, { profile: 'Chrome' })).status).toBe(200);
    const winnerOne = (await status(one.pollSecret)).json.config;
    const winnerTwo = (await status(two.pollSecret)).json.config;
    expect(new Set([oldId, winnerOne.connectionId, winnerTwo.connectionId]).size).toBe(3);
    for (const token of [legacyToken, staticToken]) {
      expect(await connect({ connectionId: ' TEST LAB - firefox ', token })).toBe(401);
      expect(await connect({ connectionId: oldId, label: winnerOne.label, token })).toBe(401);
      expect(await connect({ connectionId: oldId, label: winnerOne.connectionId.toUpperCase(), token })).toBe(401);
    }
  });

  it('reserves the routing names of already connected browsers', async () => {
    const socket = await openSocket({
      connectionId: 'Example - Old ID', label: 'Example - Old Label', token: staticToken,
    });
    expect(socket).toBeInstanceOf(WebSocket);
    if (typeof socket === 'number') return;
    try {
      for (const profile of ['old id', 'old label']) {
        const exchange = (await start({ host: 'example', profile })).json;
        const reply = await approve(exchange.approvalCode);
        expect(reply.status).toBe(422);
        expect(reply.json).toEqual({ state: 'pending', missing: ['profile'], conflict: true });
        expect((await status(exchange.pollSecret)).json).toEqual({ state: 'pending' });
      }
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
      await once(socket, 'close');
    }
  });

  it.each(['apiKey', 'mcpToken'] as const)('rejects an invalid %s at startup without logging its value', async (field) => {
    const invalid = 'invalid-credential ';
    const file = join(tokenFilePath, '..', `invalid-${field}.json`);
    writeConfig({ [field]: invalid }, file);
    const invalidProcess = spawnServer(file);
    let stderr = '';
    invalidProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    expect((await once(invalidProcess, 'close'))[0]).toBe(1);
    expect(stderr).toContain('AGENT_BROWSER_SETUP_FILE is unreadable or invalid');
    expect(stderr).not.toContain(invalid.trim());
  });

  it('bounds memory, expires approved requests and retries failed persistence', () => {
    let clock = 0;
    let available = false;
    const store = createSetupStore(settings, () => {
      if (!available) throw new Error('persistence unavailable');
      return 'local-test-token';
    }, { now: () => clock, ttlMs: 10, capacity: 1 });
    const first = store.start({ host: 'a', profile: 'b' })!;
    expect(store.start({})).toBeNull();
    expect(store.approve(first.approvalCode, {})).toEqual({ state: 'approved' });
    expect(() => store.status(first.pollSecret)).toThrow('persistence unavailable');
    clock = 10;
    expect(store.status(first.pollSecret)).toEqual({ state: 'expired' });
    const second = store.start({})!;
    expect(store.approve(second.approvalCode, {})).toEqual({ state: 'pending', missing: ['host', 'profile'] });
    store.approve(second.approvalCode, { host: 'c', profile: 'd' });
    expect(() => store.status(second.pollSecret)).toThrow();
    available = true;
    expect(store.status(second.pollSecret)).toMatchObject({ state: 'approved', config: { label: 'c - d' } });
  });

  it('keeps approval pending if the token storage check fails', () => {
    let supportedStorage = false;
    const store = createSetupStore(settings, () => 'issued-once', {
      checkApproval: () => {
        if (!supportedStorage) throw new Error('unsupported storage');
      },
    });
    const exchange = store.start({ host: 'A', profile: 'B' })!;
    expect(() => store.approve(exchange.approvalCode, {})).toThrow('unsupported storage');
    expect(store.isReserved('A - B')).toBe(false);
    expect(store.status(exchange.pollSecret)).toEqual({ state: 'pending' });
    supportedStorage = true;
    expect(store.approve(exchange.approvalCode, {})).toEqual({ state: 'approved' });
    expect(store.status(exchange.pollSecret)).toMatchObject({ state: 'approved', config: { token: 'issued-once' } });
  });

  it('holds delivery to the original TTL and does not reissue a revoked credential', () => {
    let clock = 0;
    let issued = 0;
    let valid = true;
    const store = createSetupStore(settings, () => `token-${++issued}`, {
      now: () => clock, ttlMs: 10, isTokenValid: () => valid,
    });
    const expiring = store.start({ host: 'A', profile: 'B' })!;
    const revoking = store.start({ host: 'C', profile: 'D' })!;
    clock = 7;
    store.approve(expiring.approvalCode, {});
    store.approve(revoking.approvalCode, {});
    const firstDelivery = store.status(expiring.pollSecret);
    expect(firstDelivery.state).toBe('approved');
    expect(store.status(revoking.pollSecret).state).toBe('approved');
    clock = 9;
    expect(store.status(expiring.pollSecret)).toEqual(firstDelivery);
    valid = false;
    expect(store.status(revoking.pollSecret)).toEqual({ state: 'expired' });
    valid = true;
    expect(store.status(revoking.pollSecret)).toEqual({ state: 'expired' });
    clock = 10;
    expect(store.status(expiring.pollSecret)).toEqual({ state: 'expired' });
    expect(issued).toBe(2);
  });
});
