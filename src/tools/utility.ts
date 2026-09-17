/**
 * Utility tools: wait, screenshot, getConsoleLogs, evaluate, resizeViewport.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTool, textResult, imageResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Where browser-produced files land when no path is given.
 * AGENT_BROWSER_OUT_DIR moves it; the system temp dir is the default.
 */
function outDir(): string {
  return process.env.AGENT_BROWSER_OUT_DIR || tmpdir();
}

/**
 * Wait for a specified time.
 */
export const waitTool: Tool = createTool({
  name: 'browser_wait',
  description: 'Wait for a specified number of milliseconds. Use sparingly - prefer waiting for elements.',
  schema: z.object({
    ms: z.number().min(0).max(30000).describe('Milliseconds to wait (max 30 seconds)'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_wait', { time: params.ms / 1000 });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Wait failed');
    }

    return textResult(`Waited ${params.ms}ms`);
  },
});

/**
 * Take a screenshot of the page.
 */
export const screenshotTool: Tool = createTool({
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current page or a specific element.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference to screenshot'),
    selector: z.string().optional().describe('CSS selector for element to screenshot'),
    fullPage: z.boolean()
      .optional()
      .default(false)
      .describe('Capture the full scrollable page'),
    quality: z.number()
      .min(0)
      .max(100)
      .optional()
      .default(80)
      .describe('JPEG quality (0-100)'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_screenshot', {
      ref: params.ref,
      selector: params.selector,
      fullPage: params.fullPage,
      quality: params.quality,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Screenshot failed');
    }

    // Extension may return {image: "data:image/png;base64,..."} or just the base64 string
    const result = response.result as { image?: string } | string;
    let base64 = typeof result === 'string' ? result : result.image;

    if (!base64) {
      return errorResult('No screenshot data received');
    }

    // Remove data URL prefix if present
    if (base64.startsWith('data:image/')) {
      base64 = base64.replace(/^data:image\/[^;]+;base64,/, '');
    }

    return imageResult(base64, 'image/png');
  },
});

/**
 * Get console logs from the page.
 */
export const getConsoleLogsTool: Tool = createTool({
  name: 'browser_get_console_logs',
  description: 'Get console log messages from the page (log, warn, error, info).',
  schema: z.object({
    types: z.array(z.enum(['log', 'warn', 'error', 'info', 'debug']))
      .optional()
      .describe('Filter by log types'),
    clear: z.boolean()
      .optional()
      .default(false)
      .describe('Clear logs after retrieving'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_get_console_logs', {
      types: params.types,
      clear: params.clear,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Get console logs failed');
    }

    const rawLogs = response.result as Array<{ type: string; text: string; timestamp: number }> | { logs?: Array<{ type: string; text: string; timestamp: number }> };
    const logs = Array.isArray(rawLogs) ? rawLogs : rawLogs.logs ?? [];

    if (logs.length === 0) {
      return textResult('No console logs found');
    }

    const formatted = logs.map(log => {
      const time = new Date(log.timestamp).toISOString();
      return `[${time}] [${log.type.toUpperCase()}] ${log.text}`;
    }).join('\n');

    return textResult(formatted);
  },
});

/**
 * Execute JavaScript code on the page.
 */
export const evaluateTool: Tool = createTool({
  name: 'browser_evaluate',
  description: 'Execute JavaScript code on the page and return the result. The code should be a valid JavaScript expression.',
  schema: z.object({
    code: z.string().describe('JavaScript expression or code to execute (e.g., "document.title", "window.location.href")'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_evaluate', {
      code: params.code,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Evaluation failed');
    }

    const result = response.result;
    const formatted = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);

    return textResult(formatted);
  },
});

/**
 * Resize the browser viewport.
 */
export const resizeViewportTool: Tool = createTool({
  name: 'browser_resize_viewport',
  description: 'Set the browser viewport size (width x height in pixels).',
  schema: z.object({
    width: z.number().int().min(320).max(3840).describe('Viewport width in pixels'),
    height: z.number().int().min(200).max(2160).describe('Viewport height in pixels'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_resize_viewport', {
      width: params.width,
      height: params.height,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Resize failed');
    }

    return textResult(`Viewport resized to ${params.width}x${params.height}`);
  },
});

/**
 * Get page HTML using CDP (CSP-safe, no JS eval required).
 * Use this instead of browser_evaluate for getting page HTML on sites with strict CSP.
 */
export const getHtmlTool: Tool = createTool({
  name: 'browser_get_html',
  description: 'Get the full HTML of the current page using CDP DOM.getOuterHTML. CSP-safe - works on sites that block eval.',
  schema: z.object({}),
  async handle(context) {
    const response = await context.send('browser_get_html', {});

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Get HTML failed');
    }

    const result = response.result as { html: string };
    return textResult(result.html);
  },
});

/**
 * Evaluate JavaScript code inside a same-origin iframe contentWindow.
 */
export const iframeEvalTool: Tool = createTool({
  name: 'browser_iframe_eval',
  description: 'Evaluate JavaScript directly in a same-origin iframe contentWindow.',
  schema: z.object({
    iframeSelector: z.string().describe('CSS selector for the target iframe'),
    code: z.string().describe('JavaScript expression or code to evaluate in the iframe contentWindow'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_iframe_eval', {
      iframeSelector: params.iframeSelector,
      code: params.code,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Iframe evaluation failed');
    }

    const result = response.result;
    const formatted = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    return textResult(formatted);
  },
});

/**
 * Click an element inside a same-origin iframe without translating iframe-relative coordinates.
 */
export const iframeClickTool: Tool = createTool({
  name: 'browser_iframe_click',
  description: 'Click an element inside a same-origin iframe by iframe selector and target selector. Optionally waits for iframe navigation.',
  schema: z.object({
    iframeSelector: z.string().describe('CSS selector for the target iframe'),
    targetSelector: z.string().describe('CSS selector for the element inside the iframe to click'),
    waitForNavigation: z.boolean().optional().default(false).describe('Wait for iframe navigation after the click'),
    timeout: z.number().min(0).max(30000).optional().default(10000).describe('Maximum navigation wait in milliseconds'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_iframe_click', {
      iframeSelector: params.iframeSelector,
      targetSelector: params.targetSelector,
      waitForNavigation: params.waitForNavigation,
      timeout: params.timeout,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Iframe click failed');
    }

    const result = response.result;
    const formatted = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    return textResult(formatted);
  },
});

/**
 * Print the page to a PDF file.
 *
 * It exists because some sites' own "save or print" produces nothing usable (a bank
 * that only opens blank tabs, for one) and the receipt still has to come out. The PDF
 * is written to disk and the tool returns only the path, so it costs no context.
 */
export const pdfTool: Tool = createTool({
  name: 'browser_pdf',
  description: 'Save the current page as a PDF (CDP Page.printToPDF) to a file and return its path. Useful when the site offers no usable download of its own (receipts, confirmations). It does not return the PDF itself, so it costs no tokens.',
  schema: z.object({
    path: z.string().optional().describe('Output file path. Defaults to a timestamped file in the temp dir (or AGENT_BROWSER_OUT_DIR)'),
    landscape: z.boolean().optional().default(false).describe('Landscape orientation'),
    printBackground: z.boolean().optional().default(true).describe('Include background colours and images'),
    scale: z.number().min(0.1).max(2).optional().default(1).describe('Print scale (0.1 to 2)'),
    pageRanges: z.string().optional().describe('Pages to include, e.g. "1-3" or "1,3"'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_pdf', {
      landscape: params.landscape,
      printBackground: params.printBackground,
      scale: params.scale,
      pageRanges: params.pageRanges,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'browser_pdf failed');
    }

    const result = response.result as { pdf?: string } | string;
    const base64 = typeof result === 'string' ? result : result.pdf;
    if (!base64) {
      return errorResult('The extension returned no PDF');
    }

    const target = params.path
      ? (isAbsolute(params.path) ? params.path : resolve(outDir(), params.path))
      : resolve(outDir(), `agent-browser-${Date.now()}.pdf`);

    const bytes = Buffer.from(base64, 'base64');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);

    return textResult(`PDF saved to ${target} (${bytes.length} bytes)`);
  },
});

export const utilityTools: Tool[] = [
  waitTool,
  screenshotTool,
  pdfTool,
  getConsoleLogsTool,
  evaluateTool,
  resizeViewportTool,
  getHtmlTool,
  iframeEvalTool,
  iframeClickTool,
];
