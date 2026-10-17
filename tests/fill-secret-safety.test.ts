import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillSecretTool } from '../src/tools/interaction.js';
import { getAllTools } from '../src/tools/index.js';
import { fakeContext } from './helpers/fake-context.js';

afterEach(() => vi.unstubAllEnvs());

const reference = 'op://vault/item/password';
const canary = 'canary-value-that-must-stay-private';

describe('fill secret safety with an injected reader', () => {
  it('uses the injected reader and returns only a fixed confirmation', async () => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'true');
    const { context, sent } = fakeContext({ typed: true, verified: true });
    context.readSecret = vi.fn(async () => canary);
    const result = await fillSecretTool.handle(context, { selector: '#secret', secretRef: reference });
    expect(context.readSecret).toHaveBeenCalledExactlyOnceWith(reference);
    expect(sent[0].payload).toMatchObject({ text: canary, secret: true, clear: true });
    expect(result.content).toEqual([{ type: 'text', text: 'Filled and verified the target field.' }]);
    expect(result.isError).not.toBe(true);
  });

  it('blocks direct invocation before parsing or reading when disabled', async () => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'false');
    const { context, sent } = fakeContext();
    context.readSecret = vi.fn(async () => canary);
    const result = await fillSecretTool.handle(context, { secretRef: reference });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('disabled');
    expect(JSON.stringify(result)).not.toContain(reference);
    expect(context.readSecret).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('sanitizes an injected reader failure', async () => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'true');
    const { context, sent } = fakeContext();
    context.readSecret = async () => { throw new Error(`${canary} ${reference}`); };
    const result = await fillSecretTool.handle(context, { ref: 'e5', secretRef: reference });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain(reference);
    expect(sent).toEqual([]);
  });
});

describe('secret fill catalog gate preserves upstream capabilities', () => {
  it('preserves browser_type field warning reporting', async () => {
    const tool = getAllTools().find(candidate => candidate.schema.name === 'browser_type')!;
    const { context } = fakeContext({ warning: 'the field holds 0 characters after typing 3' });
    const result = await tool.handle(context, { selector: '#note', text: 'abc', clear: true });
    expect(JSON.stringify(result)).toContain('the field holds 0 characters after typing 3');
  });

  it.each([undefined, '', 'false', '1', 'TRUE', ' true', 'true '])('omits fill for %j while preserving passkeys', gate => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', gate);
    const names = getAllTools().map(tool => tool.schema.name);
    expect(names).not.toContain('browser_fill_secret');
    expect(names).toContain('browser_passkey');
  });

  it('adds only fill and keeps configured save_secret and passkeys', () => {
    vi.stubEnv('OP_CONNECT_HOST', 'http://connect.invalid:8080');
    vi.stubEnv('OP_CONNECT_WRITE_TOKEN', 'fake-write-token');
    vi.stubEnv('AGENT_BROWSER_SAVE_VAULTS', 'jl5w33zmwcgl4ypvle7chbxu5i');
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'false');
    const baseline = getAllTools().map(tool => tool.schema.name);
    expect(baseline).toContain('browser_save_secret');
    expect(baseline).toContain('browser_passkey');
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'true');
    const enabled = getAllTools().map(tool => tool.schema.name);
    expect(enabled.filter(name => name === 'browser_fill_secret')).toHaveLength(1);
    expect(enabled.filter(name => name !== 'browser_fill_secret')).toEqual(baseline);
  });
});
