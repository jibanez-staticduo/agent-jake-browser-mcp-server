/**
 * SC-1652 C1: browser_fill_secret resolves op-personal://vault/item/field through AGENT_BROWSER_OPP_BIN
 * (op-mcp-personal's bridge in production). The field gets the value; the agent gets only the fixed
 * confirmation; the value is in no result and no server log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fillSecretTool } from '../src/tools/interaction.js';
import { fakeContext } from './helpers/fake-context.js';

const SENTINEL = 'SENTINEL-' + 'oppQ4r7Lx';

/** A fake bridge that records its argv (one per line) and prints `body`'s output. */
async function fakeOpp(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'opp-'));
  const bin = join(dir, 'op-mcp-ssh');
  const argv = join(dir, 'argv');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n${body}\n`);
  await chmod(bin, 0o755);
  vi.stubEnv('AGENT_BROWSER_OPP_BIN', bin);
  return { argv: async () => (await readFile(argv, 'utf8')).trim().split('\n') };
}

describe('browser_fill_secret op-personal:// (AGENT_BROWSER_OPP_BIN)', () => {
  const logged: string[] = [];
  beforeEach(() => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'true');
    vi.stubEnv('AGENT_BROWSER_OPP_ARGS', '--client agent-jake');
    vi.stubEnv('AGENT_BROWSER_OP_BIN', '/nonexistent/op');
    logged.length = 0;
    // The server logger writes to stderr through console.error; capture every line.
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('C1: types the bridge value into the field; result and logs carry only the fixed confirmation', async () => {
    const opp = await fakeOpp(`printf '%s\\n' '${SENTINEL}'`);
    const { context, sent } = fakeContext({ typed: true, verified: true });
    const r = await fillSecretTool.handle(context, { selector: '#password', secretRef: 'op-personal://Skirmshop/proveedor-x/password' });
    expect(await opp.argv()).toEqual(['--client', 'agent-jake', 'resolve-for-fill', 'op://Skirmshop/proveedor-x/password']);
    expect(sent).toEqual([{ type: 'browser_type', payload: { ref: undefined, selector: '#password', text: SENTINEL, clear: true, secret: true } }]);
    expect(r.isError).not.toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'Filled and verified the target field.' }]);
    expect(JSON.stringify(r).split(SENTINEL).length - 1).toBe(0);
    expect(logged.join('\n').split(SENTINEL).length - 1).toBe(0);
  });

  it('TOTP by field id keeps ?attribute=otp in the op:// reference handed to the bridge', async () => {
    const opp = await fakeOpp(`printf '%s\\n' '123456'`);
    const { context } = fakeContext({ typed: true, verified: true });
    const r = await fillSecretTool.handle(context, { ref: 'e7', secretRef: 'op-personal://Private/tienda-y/TOTP_abc?attribute=otp' });
    expect(r.isError).not.toBe(true);
    expect((await opp.argv()).at(-1)).toBe('op://Private/tienda-y/TOTP_abc?attribute=otp');
  });

  it('a refusal from the Mac (policy_denied, grant_required…) types nothing and echoes neither its stdout nor the reference', async () => {
    await fakeOpp(`printf '%s\\n' '{"code":"grant_required","message":"${SENTINEL}"}'; printf '${SENTINEL}' >&2; exit 1`);
    const { context, sent } = fakeContext({ typed: true, verified: true });
    const r = await fillSecretTool.handle(context, { ref: 'e5', secretRef: 'op-personal://llavero/tienda/password' });
    expect(r.isError).toBe(true);
    expect(sent).toEqual([]);
    const out = JSON.stringify(r);
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain('llavero/tienda');
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('without AGENT_BROWSER_OPP_BIN it fails closed and never falls back to op', async () => {
    vi.stubEnv('AGENT_BROWSER_OPP_BIN', '');
    const dir = await mkdtemp(join(tmpdir(), 'op-'));
    const op = join(dir, 'op');
    await writeFile(op, `#!/bin/sh\ntouch '${dir}/called'\nprintf '%s\\n' '${SENTINEL}'\n`);
    await chmod(op, 0o755);
    vi.stubEnv('AGENT_BROWSER_OP_BIN', op);
    const { context, sent } = fakeContext({ typed: true, verified: true });
    const r = await fillSecretTool.handle(context, { ref: 'e5', secretRef: 'op-personal://llavero/tienda/password' });
    expect(r.isError).toBe(true);
    expect(sent).toEqual([]);
    await expect(readFile(join(dir, 'called'))).rejects.toThrow();
  });

  it('op:// keeps its reader (AGENT_BROWSER_OP_BIN read <ref>) and never runs the op-personal bridge', async () => {
    const opp = await fakeOpp(`printf '%s\\n' 'wrong-reader'`);
    const dir = await mkdtemp(join(tmpdir(), 'op-'));
    const op = join(dir, 'op');
    await writeFile(op, `#!/bin/sh\n[ "$1" = read ] && [ "$2" = "op://Private/item/password" ] && printf '%s\\n' '${SENTINEL}'\n`);
    await chmod(op, 0o755);
    vi.stubEnv('AGENT_BROWSER_OP_BIN', op);
    const { context, sent } = fakeContext({ typed: true, verified: true });
    const r = await fillSecretTool.handle(context, { ref: 'e5', secretRef: 'op://Private/item/password' });
    expect(r.isError).not.toBe(true);
    expect(sent[0].payload.text).toBe(SENTINEL);
    await expect(opp.argv()).rejects.toThrow();
  });

  it.each(['op-personal://', 'op-personal://llavero/tienda', 'op-personal://llavero//password', 'op-personal://llavero/ /password', 'op-personal://llavero/tienda/pass\nword', 'op-personals://llavero/tienda/password', 'opp://llavero/tienda/password'])(
    'rejects malformed reference %j before running the bridge',
    async secretRef => {
      const opp = await fakeOpp(`printf '%s\\n' '${SENTINEL}'`);
      const { context, sent } = fakeContext({ typed: true, verified: true });
      const r = await fillSecretTool.handle(context, { ref: 'e5', secretRef });
      expect(r.isError).toBe(true);
      expect(sent).toEqual([]);
      await expect(opp.argv()).rejects.toThrow();
    },
  );
});
