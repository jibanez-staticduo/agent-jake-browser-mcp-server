import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function connect(params: { connectionId: string; label: string; token?: string }) {
  const query = new URLSearchParams(params);
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${httpPort + 1}/?${query}`);
    socket.on('error', reject);
    socket.once('open', () => { socket.close(); resolve(101); });
    socket.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); });
  });
}

beforeAll(async () => {
  writeFileSync(configFilePath, JSON.stringify({
    origin, ...settings, trustedProxyIps: ['127.0.0.1'], lanCidrs: ['192.0.2.0/24', 'fd00:1234::/64'],
    hostByIp: { '192.0.2.7': 'Workstation' },
  }));
  createTokenStore(tokenFilePath).addToken('existing-test-token', { connectionId: oldId, label: 'Old - Chrome' });
  child = spawn(process.execPath, ['dist/http-server.js'], {
    env: { ...process.env, MCP_HTTP_PORT: String(httpPort), MCP_HTTP_HOST: '127.0.0.1',
      BROWSER_WS_PORT: String(httpPort + 1), BROWSER_WS_HOST: '127.0.0.1',
      AGENT_BROWSER_SETUP_FILE: configFilePath, BROWSER_TOKEN_STORE: tokenFilePath, BROWSER_WS_TOKEN: '',
      BROWSER_ALLOW_PAIRING: 'false', AGENT_BROWSER_DEFAULT_CONNECTION: 'Reserved - Default',
      AGENT_BROWSER_CONNECTION_LABELS: JSON.stringify({ [oldId]: 'Reserved - Alias' }) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (s) => { stderr += s; });
  for (let retry = 0; retry < 100; retry++) {
    if (await http('/healthz').then((r) => r.status === 200).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(stderr);
});

afterAll(async () => {
  if (child?.exitCode === null) {
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child.kill();
    await exited;
  }
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

  it('asks for missing fields and releases exactly one credential set with a fresh identity', async () => {
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
    expect((await approve(approvalCode, { profile: 'Chrome', host: 'ignored' })).json).toEqual({ state: 'approved' });
    expect((await approve(approvalCode, { profile: 'ignored' })).json).toEqual({ state: 'approved' });
    expect(JSON.parse(readFileSync(tokenFilePath, 'utf8')).tokens).toHaveLength(1);
    const polls = (await Promise.all([status(pollSecret), status(pollSecret)])).map((reply) => reply.json);
    expect(polls.map((result) => result.state).sort()).toEqual(['approved', 'expired']);
    const config = polls.find((result) => result.state === 'approved').config;
    expect(config).toEqual({ ...settings, connectionId: expect.any(String), label: 'Workstation - Chrome', token: expect.any(String) });
    expect(config.connectionId).not.toBe(oldId);
    expect((await approve(approvalCode)).status).toBe(410);
    expect(JSON.parse(readFileSync(tokenFilePath, 'utf8')).tokens).toHaveLength(2);
    expect(await connect({ connectionId: oldId, label: 'Old - Chrome', token: 'existing-test-token' })).toBe(101);
    expect(await connect({ connectionId: config.connectionId, label: config.label })).toBe(401);
    expect(await connect({ connectionId: oldId, label: config.label, token: config.token })).toBe(401);
    expect(await connect({ connectionId: config.connectionId, label: 'other label', token: 'existing-test-token' })).toBe(401);
    expect(await connect({ connectionId: config.connectionId, label: 'Renamed locally', token: config.token })).toBe(101);
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
    expect((await approve(two.approvalCode)).status).toBe(422);
    expect((await approve(two.approvalCode, { profile: 'Chrome' })).status).toBe(200);
    const winnerOne = (await status(one.pollSecret)).json.config;
    const winnerTwo = (await status(two.pollSecret)).json.config;
    expect(new Set([oldId, winnerOne.connectionId, winnerTwo.connectionId]).size).toBe(3);
    expect(await connect({ connectionId: oldId, label: winnerOne.label, token: 'existing-test-token' })).toBe(401);
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
});
