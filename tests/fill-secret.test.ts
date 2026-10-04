/**
 * browser_fill_secret: the secret is read locally, typed through browser_type with the
 * `secret` flag, and never shows up in the result.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllTools } from '../src/tools/index.js';
import { readSecret } from '../src/tools/interaction.js';
import type { Context, ExtensionResponse } from '../src/types.js';

const SECRET = 'hunter2-Sup3r$ecret';

function fakeContext(result: unknown = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const context = {
    async send(type: string, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
      sent.push({ type, payload });
      return { id: 'x', success: true, result } as ExtensionResponse;
    },
    isConnected: () => true,
    listConnections: () => [],
  } as unknown as Context;
  return { context, sent };
}

const tool = getAllTools().find(x => x.schema.name === 'browser_fill_secret')!;

async function fakeOp(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'op-'));
  const bin = join(dir, 'op');
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  process.env.AGENT_BROWSER_OP_BIN = bin;
}

describe('browser_fill_secret', () => {
  afterEach(() => { delete process.env.AGENT_BROWSER_OP_BIN; });

  it('types the secret flagged as secret and keeps it out of the result', async () => {
    await fakeOp(`[ "$1" = read ] && [ "$2" = "op://Private/item/password" ] && printf '%s\\n' '${SECRET}'`);
    const { context, sent } = fakeContext();
    const r = await tool.handle(context, { ref: 'e5', secretRef: 'op://Private/item/password' });
    expect(sent).toEqual([{ type: 'browser_type', payload: { ref: 'e5', selector: undefined, text: SECRET, clear: true, secret: true } }]);
    const out = JSON.stringify(r);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`${SECRET.length} chars`);
  });

  it('fails without typing when the secret cannot be read', async () => {
    await fakeOp('exit 1');
    const { context, sent } = fakeContext();
    const r = await tool.handle(context, { ref: 'e5', secretRef: 'op://Private/item/password' });
    expect(r.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('is an error when the extension reports the field did not end up with the secret', async () => {
    // Regression: a hidden tab got none of the keys and the tool still said "Filled (6 chars)".
    await fakeOp(`printf '%s\\n' '${SECRET}'`);
    const { context } = fakeContext({ typed: SECRET, cleared: true, fieldLength: 0, warning: 'the field holds 0 characters after typing 19' });
    const r = await tool.handle(context, { selector: '#otp', secretRef: 'op://Private/item/password' });
    expect(r.isError).toBe(true);
    const out = JSON.stringify(r);
    expect(out).toContain('the field holds 0 characters after typing 19');
    expect(out).not.toContain(SECRET);
  });
});

describe('browser_fill_secret backend (AGENT_BROWSER_OP_BACKEND)', () => {
  const keys = ['AGENT_BROWSER_OP_BACKEND', 'OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_HOST', 'OP_CONNECT_TOKEN'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) saved[k] = process.env[k]; });
  afterEach(() => {
    delete process.env.AGENT_BROWSER_OP_BIN;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  // The fake op prints which credentials it received, never their values.
  const reportEnv = `printf 'sa=%s host=%s token=%s\\n' "\${OP_SERVICE_ACCOUNT_TOKEN:+1}" "\${OP_CONNECT_HOST:-}" "\${#OP_CONNECT_TOKEN}"`;

  it('connect: drops the service account token and trims the Connect token', async () => {
    await fakeOp(reportEnv);
    Object.assign(process.env, { AGENT_BROWSER_OP_BACKEND: 'connect', OP_SERVICE_ACCOUNT_TOKEN: 'ops_x', OP_CONNECT_HOST: 'http://connect:8080', OP_CONNECT_TOKEN: 'tok\n' });
    expect(await readSecret('op://v/i/f')).toBe('sa= host=http://connect:8080 token=3');
  });

  it('service-account: drops OP_CONNECT_*', async () => {
    await fakeOp(reportEnv);
    Object.assign(process.env, { AGENT_BROWSER_OP_BACKEND: 'service-account', OP_SERVICE_ACCOUNT_TOKEN: 'ops_x', OP_CONNECT_HOST: 'http://connect:8080', OP_CONNECT_TOKEN: 'tok' });
    expect(await readSecret('op://v/i/f')).toBe('sa=1 host= token=0');
  });

  it('unset: passes the environment as it is', async () => {
    await fakeOp(reportEnv);
    delete process.env.AGENT_BROWSER_OP_BACKEND;
    Object.assign(process.env, { OP_SERVICE_ACCOUNT_TOKEN: 'ops_x' });
    delete process.env.OP_CONNECT_HOST; delete process.env.OP_CONNECT_TOKEN;
    expect(await readSecret('op://v/i/f')).toBe('sa=1 host= token=0');
  });

  it('connect without host or token, or an unknown backend, fails without typing', async () => {
    await fakeOp(reportEnv);
    for (const env of [{ AGENT_BROWSER_OP_BACKEND: 'connect' }, { AGENT_BROWSER_OP_BACKEND: 'conect' }, { AGENT_BROWSER_OP_BACKEND: '' }]) {
      delete process.env.OP_CONNECT_HOST; delete process.env.OP_CONNECT_TOKEN;
      Object.assign(process.env, env);
      const { context, sent } = fakeContext();
      const r = await tool.handle(context, { ref: 'e5', secretRef: 'op://v/i/f' });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).toContain('AGENT_BROWSER_OP_BACKEND');
      expect(sent).toEqual([]);
    }
  });
});
