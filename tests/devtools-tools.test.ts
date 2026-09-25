/**
 * Console / network / run_code / drop / fill_form tools: what they send and how they render.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
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
  afterEach(() => {
    delete process.env.AGENT_BROWSER_ALLOW_UNSAFE_CODE;
    delete process.env.AGENT_BROWSER_DROP_DIR;
    delete process.env.AGENT_BROWSER_OUT_DIR;
  });

  it('lists network requests with stable indexes and failures', async () => {
    const { context, sent } = fakeContext(() => ({ requests: [
      { index: 4, method: 'POST', url: 'https://x.test/api', resourceType: 'Fetch', status: 201, failure: null },
      { index: 7, method: 'GET', url: 'https://x.test/down', resourceType: 'XHR', status: null, failure: 'net::ERR_FAILED' },
    ] }));
    const r = await tool('browser_network_requests').handle(context, { filter: 'x\\.test' });
    expect(sent[0]).toEqual({ type: 'browser_network_requests', payload: { includeStatic: false, all: false, filter: 'x\\.test' } });
    expect(text(r)).toBe('[4] POST 201 Fetch https://x.test\n[7] GET FAILED(net::ERR_FAILED) XHR https://x.test');
  });

  it('shows only the origin of network URLs, including token-bearing paths', async () => {
    const { context } = fakeContext(() => ({ requests: [
      { index: 1, method: 'GET', url: 'https://user:password@x.test/reset/test-secret?token=test-secret#access_token=test-secret', resourceType: 'XHR', status: 200, failure: null },
    ] }));
    const result = await tool('browser_network_requests').handle(context, {});
    expect(text(result)).toBe('[1] GET 200 XHR https://x.test');
    expect(text(result)).not.toContain('test-secret');
    expect(text(result)).not.toContain('password');
  });

  it.skipIf(process.platform !== 'linux')('renders one request and can write it to a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devtools-'));
    const { context } = fakeContext(() => ({
      index: 4, method: 'POST', url: 'https://x.test/api', resourceType: 'Fetch', status: 201, failure: null,
      requestHeaders: { 'content-type': 'application/json', Authorization: 'Bearer test-secret', Cookie: 'session=test-secret' }, requestBody: '{"password":"test-secret"}',
      responseHeaders: { 'Set-Cookie': 'session=test-secret', 'X-API-Key': 'test-secret' }, responseBody: '{"token":"test-secret"}',
    }));
    const file = join(dir, 'req.txt');
    process.env.AGENT_BROWSER_OUT_DIR = dir;
    const r = await tool('browser_network_request').handle(context, { index: 4, filename: file });
    expect(text(r)).toMatch(/^Saved to /);
    const out = await readFile(file, 'utf8');
    expect(out).toContain('## request-headers\ncontent-type: application/json');
    expect(out).toContain('Authorization: [REDACTED]');
    expect(out).toContain('Cookie: [REDACTED]');
    expect(out).toContain('Set-Cookie: [REDACTED]');
    expect(out).toContain('X-API-Key: [REDACTED]');
    expect(out).not.toContain('test-secret');
    expect(out).not.toContain('## request-body');
    expect(out).not.toContain('## response-body');
    const body = await tool('browser_network_request').handle(context, { index: 4, part: 'response-body' });
    expect(text(body)).toBe('## response-body\n{"token":"test-secret"}');
  });

  it('redacts network headers and omits bodies by default', async () => {
    const { context } = fakeContext(() => ({
      method: 'GET', url: 'https://x.test/reset/test-secret?token=test-secret', status: 200, resourceType: 'XHR',
      requestHeaders: { Authorization: 'Bearer test-secret', Cookie: 'test-secret', 'X-Session-ID': 'test-secret', X_AuthToken: 'test-secret', Referer: 'https://x.test/reset/test-secret', 'Content-Type': 'text/html; boundary=test-secret', 'Content-Length': '123' },
      responseHeaders: { 'Set-Cookie': 'test-secret', 'X-Access-Key': 'test-secret', Location: 'https://x.test/reset/test-secret', 'X-Client-Secret': 'test-secret', 'Cache-Control': 'public, max-age=60' },
      requestBody: 'test-secret', responseBody: 'test-secret',
    }));
    const result = await tool('browser_network_request').handle(context, { index: 1 });
    expect(text(result)).toContain('Authorization: [REDACTED]');
    expect(text(result)).toContain('Cookie: [REDACTED]');
    expect(text(result)).toContain('Set-Cookie: [REDACTED]');
    expect(text(result)).toContain('X-Session-ID: [REDACTED]');
    expect(text(result)).toContain('X_AuthToken: [REDACTED]');
    expect(text(result)).toContain('X-Access-Key: [REDACTED]');
    expect(text(result)).toContain('Referer: [REDACTED]');
    expect(text(result)).toContain('Location: [REDACTED]');
    expect(text(result)).toContain('X-Client-Secret: [REDACTED]');
    expect(text(result)).toContain('Content-Type: text/html');
    expect(text(result)).toContain('Content-Length: 123');
    expect(text(result)).toContain('Cache-Control: public, max-age=60');
    expect(text(result)).toContain('GET https://x.test');
    expect(text(result)).not.toContain('test-secret');
    expect(text(result)).not.toContain('## request-body');
    expect(text(result)).not.toContain('## response-body');
  });

  it('redacts unsafe values even under diagnostic header names', async () => {
    const { context } = fakeContext(() => ({
      requestHeaders: {
        'Content-Type': 'test-secret',
        'Content-Length': '12; test-secret',
        'Cache-Control': 'private="test-secret"',
      },
    }));
    const result = await tool('browser_network_request').handle(context, { index: 1, part: 'request-headers' });
    expect(text(result)).toContain('Content-Type: [REDACTED]');
    expect(text(result)).toContain('Content-Length: [REDACTED]');
    expect(text(result)).toContain('Cache-Control: [REDACTED]');
    expect(text(result)).not.toContain('test-secret');
  });

  it.skipIf(process.platform !== 'linux')('keeps filename writes inside the output directory and does not overwrite files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'out-'));
    process.env.AGENT_BROWSER_OUT_DIR = dir;
    const { context } = fakeContext(() => ({ logs: [{ type: 'log', text: 'ok', timestamp: 0 }] }));
    const outside = join(await mkdtemp(join(tmpdir(), 'private-')), 'secret.txt');
    await writeFile(outside, 'private');
    for (const filename of [outside, '../escape.txt', 'subdir/escape.txt']) {
      const r = await tool('browser_get_console_logs').handle(context, { filename });
      expect(r.isError).toBe(true);
    }
    expect(await readFile(outside, 'utf8')).toBe('private');
    const target = join(dir, 'linked.txt');
    await symlink(outside, target);
    const linked = await tool('browser_get_console_logs').handle(context, { filename: target });
    expect(linked.isError).toBe(true);
    const first = await tool('browser_get_console_logs').handle(context, { filename: 'result.txt' });
    expect(first.isError).toBeFalsy();
    const second = await tool('browser_get_console_logs').handle(context, { filename: 'result.txt' });
    expect(second.isError).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('applies the same output boundary to PDFs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-'));
    process.env.AGENT_BROWSER_OUT_DIR = dir;
    const { context } = fakeContext(() => ({ pdf: Buffer.from('%PDF-1.7').toString('base64') }));
    const outside = join(await mkdtemp(join(tmpdir(), 'private-')), 'receipt.pdf');
    const denied = await tool('browser_pdf').handle(context, { path: outside });
    expect(denied.isError).toBe(true);
    const allowed = await tool('browser_pdf').handle(context, { path: 'receipt.pdf' });
    expect(allowed.isError).toBeFalsy();
    expect(await readFile(join(dir, 'receipt.pdf'), 'utf8')).toBe('%PDF-1.7');
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

  it.skipIf(process.platform !== 'linux')('sends dropped files as content read by the server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drop-'));
    process.env.AGENT_BROWSER_DROP_DIR = dir;
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

  it('rejects file drops outside the configured directory and through symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drop-'));
    const privateDir = await mkdtemp(join(tmpdir(), 'private-'));
    const secret = join(privateDir, 'secret.txt');
    await writeFile(secret, 'do not send');
    const link = join(dir, 'linked.txt');
    await symlink(secret, link);
    const { context, sent } = fakeContext(() => ({ dropped: [] }));

    const disabled = await tool('browser_drop').handle(context, { ref: '3', paths: [secret] });
    expect(disabled.isError).toBe(true);
    process.env.AGENT_BROWSER_DROP_DIR = dir;
    for (const path of [secret, '../secret.txt', 'nested/secret.txt', link]) {
      const r = await tool('browser_drop').handle(context, { ref: '3', paths: [path] });
      expect(r.isError).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });

  it('enforces file count and byte limits while allowing data-only drops', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drop-'));
    process.env.AGENT_BROWSER_DROP_DIR = dir;
    const large = join(dir, 'large.txt');
    await writeFile(large, Buffer.alloc(10 * 1024 * 1024 + 1));
    const { context, sent } = fakeContext(() => ({ dropped: ['text/plain'] }));
    const tooLarge = await tool('browser_drop').handle(context, { ref: '3', paths: [large] });
    expect(tooLarge.isError).toBe(true);
    const tooMany = await tool('browser_drop').handle(context, { ref: '3', paths: Array(9).fill('large.txt') });
    expect(tooMany.isError).toBe(true);
    const tooMuchData = await tool('browser_drop').handle(context, { ref: '3', data: { 'text/plain': 'x'.repeat(1024 * 1024) } });
    expect(tooMuchData.isError).toBe(true);
    delete process.env.AGENT_BROWSER_DROP_DIR;
    const dataOnly = await tool('browser_drop').handle(context, { ref: '3', data: { 'text/plain': 'hello' } });
    expect(dataOnly.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.files).toEqual([]);
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
