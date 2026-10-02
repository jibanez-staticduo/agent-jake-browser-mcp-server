/**
 * browser_fill_secret: the secret is read locally, typed through browser_type with the
 * `secret` flag, and never shows up in the result.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllTools } from '../src/tools/index.js';
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

describe('browser_type', () => {
  const type = getAllTools().find(x => x.schema.name === 'browser_type')!;

  it('passes the field-length warning on instead of a bare success', async () => {
    const { context } = fakeContext({ typed: 'abc', cleared: true, fieldLength: 0, warning: 'the field holds 0 characters after typing 3' });
    const r = await type.handle(context, { selector: '#nota', text: 'abc', clear: true });
    expect(JSON.stringify(r)).toContain('the field holds 0 characters after typing 3');
  });
});
