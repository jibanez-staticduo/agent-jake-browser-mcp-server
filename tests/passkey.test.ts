/**
 * browser_passkey (INFRA-585): mode and target reach the extension, the result reports the
 * ceremony without key material (the extension never sends it), and every way the extension
 * can fall short is an error, never a silent plain click.
 */
import { describe, it, expect } from 'vitest';
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
    expect(sent).toEqual([{ type: 'browser_passkey', payload: { ref: 'e3', selector: undefined, mode: 'use' } }]);
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
