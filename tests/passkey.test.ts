/**
 * browser_passkey (INFRA-585): mode and target reach the extension, the result reports the
 * ceremony without key material (the extension never sends it), and every way the extension
 * can fall short is an error, never a silent plain click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllTools } from '../src/tools/index.js';
import { fakeContext } from './helpers/fake-context.js';
import type { Context, ExtensionResponse } from '../src/types.js';

const tool = getAllTools().find(x => x.schema.name === 'browser_passkey')!;
const click = getAllTools().find(x => x.schema.name === 'browser_click')!;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const shopify = (extra: Record<string, unknown> = {}) => ({
  clicked: 'e3',
  passkey: { mode: 'use', host: 'accounts.shopify.com', ceremony: 'completed',
    passkeys: [{ rpId: 'accounts.shopify.com', enrolledAt: '2026-10-05T17:00:00Z' }], ...extra },
});

describe('browser_passkey', () => {
  it('browser_click has no passkey parameter', async () => {
    const { context, sent } = fakeContext({ clicked: 'e1' });
    await click.handle(context, { ref: 'e1', passkey: 'use' });
    expect(sent[0].payload).not.toHaveProperty('passkey');
  });

  it('use: forwards mode and target and reports the sign-in', async () => {
    const { context, sent } = fakeContext(shopify());
    const r = await tool.handle(context, { ref: 'e3', mode: 'use' });
    expect(sent).toEqual([{
      type: 'browser_passkey',
      payload: { ref: 'e3', selector: undefined, mode: 'use', source: 'agent', rpIds: [] },
    }]);
    expect(isError(r)).toBe(false);
    expect(text(r)).toBe('Clicked on e3. Signed in with the agent passkey for accounts.shopify.com on accounts.shopify.com.');
  });

  it('enroll that the site never started is reported as a timeout', async () => {
    const { context } = fakeContext({
      clicked: 'e9',
      passkey: { mode: 'enroll', host: 'accounts.shopify.com', ceremony: 'timeout', passkeys: [] },
    });
    const r = await tool.handle(context, { ref: 'e9', mode: 'enroll' });
    expect(text(r)).toContain('the site asked for no passkey within the wait (passkeys for this host: none)');
  });

  it('is an error when the guard could not be put back', async () => {
    const { context } = fakeContext(shopify({ guardRestored: false }));
    const r = await tool.handle(context, { ref: 'e3', mode: 'use' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('close it (browser_close_tab)');
  });

  it('is an error when the extension answers without a passkey report', async () => {
    const { context } = fakeContext({ clicked: 'e3' });
    const r = await tool.handle(context, { ref: 'e3', mode: 'use' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('too old for browser_passkey');
  });

  it('is an error when the extension does not know the tool', async () => {
    const context = {
      async send(): Promise<ExtensionResponse> {
        return { id: 'x', success: false, error: { message: 'Unknown tool: browser_passkey' } } as ExtensionResponse;
      },
      isConnected: () => true,
      listConnections: () => [],
    } as unknown as Context;
    const r = await tool.handle(context, { ref: 'e3', mode: 'use' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('does not know browser_passkey yet');
  });

  it('rejects a missing or unknown mode without clicking', async () => {
    for (const params of [{ ref: 'e1' }, { ref: 'e1', mode: 'steal' }]) {
      const { context, sent } = fakeContext();
      const r = await tool.handle(context, params);
      expect(sent).toEqual([]);
      expect(isError(r)).toBe(true);
    }
  });
});

/**
 * INFRA-374: source "1password" — the passkey of Dani's 1Password signs in the page. The server
 * never sees a key: it refuses what is not allowed, hands the extension the rpIds it allows, and
 * records one audit line per ceremony.
 */
describe('browser_passkey with source "1password" (INFRA-374)', () => {
  const signedIn = {
    clicked: 'e7',
    passkey: {
      mode: 'use', host: 'accounts.google.com', ceremony: 'completed', passkeys: [],
      source: '1password', rpId: 'google.com', landedOn: 'https://user:secret@admin.google.com/login?code=CANARIO#fragment',
      // Canary: whatever the extension answers, none of this belongs in the log line.
      privateKey: 'CANARIO-PKCS8', userHandle: 'CANARIO-HANDLE',
    },
  };

  beforeEach(() => { process.env.AGENT_BROWSER_1P_PASSKEY_RPIDS = 'google.com, shopify.com'; });
  afterEach(() => { delete process.env.AGENT_BROWSER_1P_PASSKEY_RPIDS; });

  it('refuses enroll before anything reaches the extension', async () => {
    const { context, sent } = fakeContext(signedIn);
    const r = await tool.handle(context, { ref: 'e7', mode: 'enroll', source: '1password' });
    expect(sent).toEqual([]);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('PASSKEY_1PASSWORD_ENROLL_REFUSED');
  });

  it('is off when the server lists no rpId', async () => {
    delete process.env.AGENT_BROWSER_1P_PASSKEY_RPIDS;
    const { context, sent } = fakeContext(signedIn);
    const r = await tool.handle(context, { ref: 'e7', mode: 'use', source: '1password' });
    expect(sent).toEqual([]);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('PASSKEY_1PASSWORD_DISABLED');
  });

  it('forwards source and the allowed rpIds, and reports the sign-in', async () => {
    const { context, sent } = fakeContext(signedIn);
    const r = await tool.handle(context, { ref: 'e7', mode: 'use', source: '1password' });
    expect(sent).toEqual([{
      type: 'browser_passkey',
      payload: { ref: 'e7', selector: undefined, mode: 'use', source: '1password', rpIds: ['google.com', 'shopify.com'] },
    }]);
    expect(isError(r)).toBe(false);
    expect(text(r)).toBe('Clicked on e7. Signed in with the 1Password passkey for google.com on accounts.google.com; the page moved on to https://admin.google.com/login.');
  });

  it('a timeout of a 1Password ceremony does not talk about the agent vault', async () => {
    const { context } = fakeContext({
      clicked: 'e7',
      passkey: { mode: 'use', host: 'accounts.google.com', ceremony: 'timeout', passkeys: [], source: '1password', rpId: 'google.com' },
    });
    const r = await tool.handle(context, { ref: 'e7', mode: 'use', source: '1password' });
    expect(text(r)).toContain('the page never moved');
    expect(text(r)).not.toContain('passkeys for this host');
  });

  it('logs one line per ceremony, without key material', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context } = fakeContext(signedIn);
    await tool.handle(context, { ref: 'e7', mode: 'use', source: '1password' });
    const line = logged.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[passkey]'));
    expect(line).toBeDefined();
    expect(line).toContain('host=accounts.google.com');
    expect(line).toContain('rpId=google.com');
    expect(line).toContain('mode=use');
    expect(line).toContain('source=1password');
    expect(line).toContain('result=completed');
    expect(line).toContain('landedOn=https://admin.google.com/login');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('code=');
    expect(line).not.toContain('CANARIO');
    logged.mockRestore();
  });

  it('agent stays agent: no rpIds leave the server and the report is the old one', async () => {
    const { context, sent } = fakeContext(shopify());
    await tool.handle(context, { ref: 'e3', mode: 'use' });
    expect(sent[0].payload.rpIds).toEqual([]);
    expect(sent[0].payload.source).toBe('agent');
  });
});
