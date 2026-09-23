/**
 * Console / network / run_code / drop / fill_form tools: what they send and how they render.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllTools } from '../src/tools/index.js';
import type { Context, ExtensionResponse } from '../src/types.js';

function fakeContext(answer: (type: string, payload: Record<string, unknown>) => unknown) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const context = {
    async send(type: string, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
      sent.push({ type, payload });
      return { id: 'x', success: true, result: answer(type, payload) } as ExtensionResponse;
    },
    isConnected: () => true,
    listConnections: () => [],
  } as unknown as Context;
  return { context, sent };
}

const tool = (name: string) => {
  const t = getAllTools().find(x => x.schema.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? '';

describe('devtools tools', () => {
  afterEach(() => { delete process.env.AGENT_BROWSER_ALLOW_UNSAFE_CODE; });

  it('lists network requests with stable indexes and failures', async () => {
    const { context, sent } = fakeContext(() => ({ requests: [
      { index: 4, method: 'POST', url: 'https://x.test/api', resourceType: 'Fetch', status: 201, failure: null },
      { index: 7, method: 'GET', url: 'https://x.test/down', resourceType: 'XHR', status: null, failure: 'net::ERR_FAILED' },
    ] }));
    const r = await tool('browser_network_requests').handle(context, { filter: 'x\\.test' });
    expect(sent[0]).toEqual({ type: 'browser_network_requests', payload: { includeStatic: false, all: false, filter: 'x\\.test' } });
    expect(text(r)).toBe('[4] POST 201 Fetch https://x.test/api\n[7] GET FAILED(net::ERR_FAILED) XHR https://x.test/down');
  });

  it('renders one request and can write it to a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devtools-'));
    const { context } = fakeContext(() => ({
      index: 4, method: 'POST', url: 'https://x.test/api', resourceType: 'Fetch', status: 201, failure: null,
      requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}',
      responseHeaders: {}, responseBody: '{"ok":true}',
    }));
    const file = join(dir, 'req.txt');
    const r = await tool('browser_network_request').handle(context, { index: 4, filename: file });
    expect(text(r)).toMatch(/^Saved to /);
    const out = await readFile(file, 'utf8');
    expect(out).toContain('## request-headers\ncontent-type: application/json');
    expect(out).toContain('## response-headers\n(none)');
    expect(out).toContain('## response-body\n{"ok":true}');
  });

  it('forwards level and all to the console capture', async () => {
    const { context, sent } = fakeContext(() => ({ logs: [{ type: 'error', text: 'boom', timestamp: 0, location: 'a.js:3' }] }));
    const r = await tool('browser_get_console_logs').handle(context, { level: 'warning' });
    expect(sent[0].payload).toMatchObject({ level: 'warning', all: false, clear: false });
    expect(text(r)).toContain('[ERROR] boom  @ a.js:3');
  });

  it('refuses run_code_unsafe unless the operator enables it', async () => {
    const { context, sent } = fakeContext(() => null);
    const r = await tool('browser_run_code_unsafe').handle(context, { code: 'return 1' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('AGENT_BROWSER_ALLOW_UNSAFE_CODE=1');
    expect(sent).toHaveLength(0);
  });

  it('runs both code forms with a CDP handle when enabled', async () => {
    process.env.AGENT_BROWSER_ALLOW_UNSAFE_CODE = '1';
    const { context, sent } = fakeContext((type) => (type === 'browser_cdp' ? { frameTree: { frame: { url: 'https://x.test/' } } } : 'Title'));
    const fnForm = await tool('browser_run_code_unsafe').handle(context, {
      code: 'async (page) => (await page.cdp("Page.getFrameTree")).frameTree.frame.url',
    });
    expect(text(fnForm)).toBe('https://x.test/');
    expect(sent[0]).toEqual({ type: 'browser_cdp', payload: { method: 'Page.getFrameTree', params: undefined } });
    const body = await tool('browser_run_code_unsafe').handle(context, { code: 'return { t: await page.evaluate("document.title") }' });
    expect(JSON.parse(text(body))).toEqual({ t: 'Title' });
  });

  it('sends dropped files as content read by the server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drop-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, 'hola');
    const { context, sent } = fakeContext(() => ({ dropped: ['a.txt', 'text/plain'], accepted: true }));
    const r = await tool('browser_drop').handle(context, { ref: '3', paths: [file], data: { 'text/plain': 'x' } });
    expect(sent[0].payload).toEqual({
      ref: '3', selector: undefined,
      files: [{ name: 'a.txt', mimeType: 'text/plain', base64: Buffer.from('hola').toString('base64') }],
      data: { 'text/plain': 'x' },
    });
    expect(text(r)).toBe('Dropped: a.txt, text/plain');
  });

  it('reports fill_form per field', async () => {
    const { context } = fakeContext(() => ({ results: [
      { field: '1', ok: true, kind: 'textbox' },
      { field: '#nope', ok: false, error: 'Element not found' },
    ] }));
    const r = await tool('browser_fill_form').handle(context, { fields: [{ ref: '1', value: 'a' }, { selector: '#nope', value: true }] });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('ok 1 (textbox)\nFAILED #nope: Element not found');
  });

  it('keeps browser_upload_file compatible with a single filePath', async () => {
    const { context, sent } = fakeContext(() => ({ uploaded: true }));
    const r = await tool('browser_upload_file').handle(context, { filePath: '/tmp/a.png' });
    expect(sent[0].payload).toMatchObject({ filePath: '/tmp/a.png' });
    expect(text(r)).toBe('File uploaded: /tmp/a.png');
  });
});
