/**
 * Large results have to leave the conversation somehow.
 *
 * The HTML of a page, the text of a big element or the JSON an evaluate returns used to come back in
 * full: one call could take the whole context with it, and there was no way to ask for less or for the
 * file instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConsoleLogsTool, getHtmlTool, evaluateTool } from '../src/tools/utility.ts';
import { getTextTool } from '../src/tools/queries.ts';
import type { Context } from '../src/types.ts';

let outDir: string;
const previousOutDir = process.env.AGENT_BROWSER_OUT_DIR;

function contextReturning(result: unknown): Context {
  return { send: async () => ({ id: '1', success: true, result }) } as unknown as Context;
}

function textOf(result: Awaited<ReturnType<typeof getHtmlTool.handle>>): string {
  return (result.content[0] as { text: string }).text;
}

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'ajb-out-'));
  process.env.AGENT_BROWSER_OUT_DIR = outDir;
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
  if (previousOutDir === undefined) delete process.env.AGENT_BROWSER_OUT_DIR;
  else process.env.AGENT_BROWSER_OUT_DIR = previousOutDir;
});

describe('a result the caller can size', () => {
  const page = '<html>' + 'a'.repeat(250_000) + '</html>';

  it('caps inline HTML and says how much is missing', async () => {
    const text = textOf(await getHtmlTool.handle(contextReturning({ html: page }), {}));
    expect(text).toContain(`showing 200000 of ${page.length} chars`);
    expect(text.length).toBeLessThan(page.length);
  });

  it('returns all of it when asked for, and none of it past a chosen size', async () => {
    const all = textOf(await getHtmlTool.handle(contextReturning({ html: page }), { maxChars: 0 }));
    expect(all).toBe(page);
    const ten = textOf(await getHtmlTool.handle(contextReturning({ html: page }), { maxChars: 10 }));
    expect(ten.startsWith(page.slice(0, 10))).toBe(true);
    expect(ten).toContain(`showing 10 of ${page.length} chars`);
  });

  it('writes the whole result to a file when the caller names one', async () => {
    const result = await getHtmlTool.handle(contextReturning({ html: page }), { filename: 'page.html' });
    expect(textOf(result)).toContain(`Saved to ${join(outDir, 'page.html')} (${page.length} chars)`);
    expect(readFileSync(join(outDir, 'page.html'), 'utf-8')).toBe(page);
  });

  it('sizes the text of an element and the result of an evaluate the same way', async () => {
    const text = textOf(await getTextTool.handle(contextReturning({ text: page }), { ref: 'e1', maxChars: 20 }));
    expect(text).toContain(`showing 20 of ${page.length} chars`);

    const evaluate = await evaluateTool.handle(contextReturning({ items: ['a'.repeat(300_000)] }), {
      code: 'items',
      filename: 'items.json',
    });
    expect(textOf(evaluate)).toContain('Saved to');
    expect(readFileSync(join(outDir, 'items.json'), 'utf-8')).toContain('"items"');
  });

  it('advertises the two arguments on the tools that return a large result', () => {
    for (const tool of [getHtmlTool, getTextTool, evaluateTool]) {
      const properties = tool.schema.inputSchema.properties as Record<string, unknown>;
      expect(properties, tool.schema.name).toHaveProperty('filename');
      expect(properties, tool.schema.name).toHaveProperty('maxChars');
    }
  });
});

describe('console output', () => {
  const logs = [
    { type: 'log', text: 'a'.repeat(250_000), timestamp: 0 },
    { type: 'info', text: 'last line', timestamp: 0 },
  ];
  const formatted = logs.map(log => `[1970-01-01T00:00:00.000Z] [${log.type.toUpperCase()}] ${log.text}`).join('\n');

  /** Model the extension's single read-and-clear call. */
  function consoleContext(): Context {
    let captured = logs;
    return {
      async send(_type: string, payload: { clear?: boolean }) {
        const result = { logs: captured };
        if (payload.clear) captured = [];
        return { id: '1', success: true, result };
      },
    } as unknown as Context;
  }

  it('caps ordinary console reads by default and allows the caller to ask for the rest', async () => {
    const context = consoleContext();
    const capped = textOf(await getConsoleLogsTool.handle(context, {}));
    expect(capped).toContain(`showing 200000 of ${formatted.length} chars`);
    expect(capped).not.toContain('last line');
    const shorter = textOf(await getConsoleLogsTool.handle(context, { maxChars: 10 }));
    expect(shorter).toContain(`showing 10 of ${formatted.length} chars`);
    expect(textOf(await getConsoleLogsTool.handle(context, { maxChars: 0 }))).toBe(formatted);
  });

  it('returns every retrieved line when clearing, regardless of the inline limit', async () => {
    const context = consoleContext();
    const result = await getConsoleLogsTool.handle(context, { clear: true, maxChars: 10 });
    expect(textOf(result)).toBe(formatted);
    expect(textOf(await getConsoleLogsTool.handle(context, {}))).toBe('No console logs found');
  });

  it('writes the complete result to a file when clearing with a filename', async () => {
    const context = consoleContext();
    const result = await getConsoleLogsTool.handle(context, { clear: true, filename: 'console.txt', maxChars: 10 });
    expect(textOf(result)).toContain(`Saved to ${join(outDir, 'console.txt')}`);
    expect(readFileSync(join(outDir, 'console.txt'), 'utf-8')).toBe(formatted);
  });

  it('includes every cleared line in the response if the file cannot be written', async () => {
    const filename = 'console.txt';
    writeFileSync(join(outDir, filename), 'existing file');
    const context = consoleContext();
    const result = await getConsoleLogsTool.handle(context, { clear: true, filename });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Cannot save output');
    expect(result.content[1]).toEqual({ type: 'text', text: formatted });
    expect(readFileSync(join(outDir, filename), 'utf-8')).toBe('existing file');
    expect(textOf(await getConsoleLogsTool.handle(context, {}))).toBe('No console logs found');
  });
});
