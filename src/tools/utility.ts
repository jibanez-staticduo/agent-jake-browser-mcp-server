/**
 * Utility tools: wait, screenshot, getConsoleLogs, evaluate, resizeViewport.
 */
import { z } from 'zod';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPinnedDirectory, pinnedChildPath } from './pinned-directory.js';
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
  description: 'Console messages of the connected tab: console.* calls, uncaught exceptions and browser log entries (network errors, violations). Captured from CDP since the tab was connected. By default only since the last navigation.',
  schema: z.object({
    types: z.array(z.enum(['log', 'warn', 'warning', 'error', 'info', 'debug']))
      .optional()
      .describe('Filter by exact log types'),
    level: z.enum(['error', 'warning', 'info', 'debug'])
      .optional()
      .describe('Minimum severity: that level and the more severe ones'),
    all: z.boolean().optional().default(false).describe('Include messages from before the last navigation'),
    clear: z.boolean()
      .optional()
      .default(false)
      .describe('Clear logs after retrieving'),
    filename: z.string().optional().describe('Write the output to this file instead of returning it'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_get_console_logs', {
      types: params.types,
      level: params.level,
      all: params.all,
      clear: params.clear,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Get console logs failed');
    }

    type LogLine = { type: string; text: string; timestamp: number; location?: string };
    const rawLogs = response.result as LogLine[] | { logs?: LogLine[] };
    const logs = Array.isArray(rawLogs) ? rawLogs : rawLogs.logs ?? [];

    if (logs.length === 0) {
      return textResult('No console logs found');
    }

    const formatted = logs.map(log => {
      const time = new Date(log.timestamp).toISOString();
      return `[${time}] [${log.type.toUpperCase()}] ${log.text}${log.location ? `  @ ${log.location}` : ''}`;
    }).join('\n');

    return outputResult(formatted, params.filename);
  },
});

/**
 * Text result, or written to a file when the caller asked for one: long network or
 * console dumps then cost no tokens.
 */
async function saveOutput(content: string | Buffer, filename: string): Promise<string> {
  await mkdir(outDir(), { recursive: true });
  const { root, handle: rootHandle } = await openPinnedDirectory(outDir());
  try {
    const name = basename(filename);
    if (!name || name === '.' || name === '..' || name.includes('\\') ||
        (!isAbsolute(filename) && filename !== name) ||
        (isAbsolute(filename) && dirname(filename) !== root)) {
      throw new Error('Output filename must be directly inside AGENT_BROWSER_OUT_DIR');
    }
    const target = pinnedChildPath(rootHandle, name);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return join(root, name);
  } finally {
    await rootHandle.close();
  }
}

async function outputResult(text: string, filename?: string) {
  if (!filename) return textResult(text);
  try {
    const target = await saveOutput(text, filename);
    return textResult(`Saved to ${target} (${text.length} chars)`);
  } catch (error) {
    return errorResult(`Cannot save output: ${(error as Error).message}`);
  }
}

function safeNetworkHeaderValue(name: string, value: string): string {
  if (typeof value !== 'string') return '[REDACTED]';
  const trimmed = value.trim();
  switch (name.toLowerCase()) {
    case 'content-type': {
      const mime = /^([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)(?:\s*;.*)?$/i.exec(trimmed);
      return mime?.[1] && trimmed.length <= 256 ? mime[1].toLowerCase() : '[REDACTED]';
    }
    case 'content-length':
      return /^\d{1,20}$/.test(trimmed) ? trimmed : '[REDACTED]';
    case 'cache-control': {
      if (trimmed.length > 256) return '[REDACTED]';
      const directives = trimmed.split(',').map(part => part.trim().toLowerCase());
      const safe = /^(?:no-cache|no-store|public|private|must-revalidate|proxy-revalidate|immutable|(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)=\d{1,12})$/;
      return directives.every(part => safe.test(part)) ? directives.join(', ') : '[REDACTED]';
    }
    default:
      return '[REDACTED]';
  }
}

function redactNetworkUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin : '[opaque URL]';
  } catch {
    return '[unparseable URL]';
  }
}

/**
 * Network requests of the connected tab.
 */
export const networkRequestsTool: Tool = createTool({
  name: 'browser_network_requests',
  description: 'Network requests of the connected tab, numbered [n] (stable: use them with browser_network_request). By default since the last navigation and without static resources (images, fonts, CSS, scripts). Captured from CDP since the tab was connected.',
  schema: z.object({
    includeStatic: z.boolean().optional().default(false).describe('Include images, fonts, stylesheets, scripts and media'),
    all: z.boolean().optional().default(false).describe('Include requests from before the last navigation'),
    filter: z.string().optional().describe('Case-insensitive regex on the URL'),
    filename: z.string().optional().describe('Write the output to this file instead of returning it'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_network_requests', {
      includeStatic: params.includeStatic,
      all: params.all,
      filter: params.filter,
    });
    if (!response.success) {
      return errorResult(response.error?.message ?? 'Network requests failed');
    }
    const { requests = [] } = response.result as {
      requests?: Array<{ index: number; method: string; url: string; resourceType: string; status: number | null; failure: string | null }>;
    };
    if (requests.length === 0) {
      return textResult('No network requests captured');
    }
    const lines = requests.map(r =>
      `[${r.index}] ${r.method} ${r.failure ? `FAILED(${r.failure})` : r.status ?? 'pending'} ${r.resourceType} ${redactNetworkUrl(r.url)}`);
    return outputResult(lines.join('\n'), params.filename);
  },
});

/**
 * One captured request in detail.
 */
export const networkRequestTool: Tool = createTool({
  name: 'browser_network_request',
  description: 'Headers of one request [n] from browser_network_requests. Only common diagnostic header values are visible; other values are redacted. Request and response bodies are returned only when explicitly selected with part; they may contain secrets. Response bodies may be gone after navigation.',
  schema: z.object({
    index: z.number().int().describe('The [n] from browser_network_requests'),
    part: z.enum(['request-headers', 'request-body', 'response-headers', 'response-body'])
      .optional()
      .describe('Only this part'),
    maxBodyChars: z.number().int().min(100).optional().default(20000).describe('Truncate bodies to this length'),
    filename: z.string().optional().describe('Write the output to this file instead of returning it'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_network_request', {
      index: params.index,
      part: params.part,
      maxBodyChars: params.maxBodyChars,
    });
    if (!response.success) {
      return errorResult(response.error?.message ?? 'Network request failed');
    }
    const r = response.result as Record<string, unknown>;
    const headers = (h: unknown) => h && typeof h === 'object'
      ? Object.entries(h as Record<string, string>).map(([k, v]) =>
        `${k}: ${safeNetworkHeaderValue(k, v)}`,
      ).join('\n') || '(none)'
      : '(none)';
    const sections: string[] = [];
    if (!params.part) {
      sections.push(`## general\n${r.method} ${redactNetworkUrl(String(r.url))}\nstatus: ${r.failure ? `FAILED ${r.failure}` : r.status ?? 'pending'}\ntype: ${r.resourceType}`);
    }
    if ((!params.part || params.part === 'request-headers') && 'requestHeaders' in r) {
      sections.push(`## request-headers\n${headers(r.requestHeaders)}`);
    }
    if (params.part === 'request-body' && 'requestBody' in r) sections.push(`## request-body\n${r.requestBody ?? '(empty)'}`);
    if ((!params.part || params.part === 'response-headers') && 'responseHeaders' in r) {
      sections.push(`## response-headers\n${headers(r.responseHeaders)}`);
    }
    if (params.part === 'response-body' && 'responseBody' in r) sections.push(`## response-body\n${r.responseBody ?? '(no response)'}`);
    return outputResult(sections.join('\n\n'), params.filename);
  },
});

/**
 * Node-side code with a CDP handle on the tab. Off unless the operator turns it on.
 */
export const runCodeUnsafeTool: Tool = createTool({
  name: 'browser_run_code_unsafe',
  description: 'UNSAFE — arbitrary JavaScript in the MCP server process (Node), equivalent to remote code execution on that machine. Disabled unless the server runs with AGENT_BROWSER_ALLOW_UNSAFE_CODE=1. Accepts `async (page) => { ... }` or a bare body with `page` in scope. `page.cdp(method, params)` sends a raw CDP command to the connected tab, `page.evaluate(expr)` runs JS in the page, `page.tool(name, payload)` calls any extension tool. Returns whatever the code returns.',
  schema: z.object({
    code: z.string().describe('`async (page) => { ... }` or a function body'),
    filename: z.string().optional().describe('Write the output to this file instead of returning it'),
  }),
  async handle(context, params) {
    if (process.env.AGENT_BROWSER_ALLOW_UNSAFE_CODE !== '1') {
      return errorResult('browser_run_code_unsafe is disabled: start the server with AGENT_BROWSER_ALLOW_UNSAFE_CODE=1 to allow it');
    }
    const call = async (type: string, payload: Record<string, unknown>) => {
      const response = await context.send(type as never, payload);
      if (!response.success) throw new Error(response.error?.message ?? `${type} failed`);
      return response.result;
    };
    const page = {
      cdp: (method: string, cdpParams?: Record<string, unknown>) => call('browser_cdp', { method, params: cdpParams }),
      evaluate: (code: string) => call('browser_evaluate', { code }),
      tool: (name: string, payload: Record<string, unknown> = {}) => call(name, payload),
    };
    const src = params.code.trim();
    const isFunction = /^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(src);
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = isFunction
        ? new Function(`return (${src});`)()
        : new Function('page', `return (async () => { ${src} })();`);
      const result = await fn(page);
      if (result === undefined) return textResult('(ok)');
      return outputResult(typeof result === 'string' ? result : JSON.stringify(result, null, 2), params.filename);
    } catch (error) {
      return errorResult(`run_code failed: ${(error as Error).message}`);
    }
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

    const bytes = Buffer.from(base64, 'base64');
    try {
      const target = await saveOutput(bytes, params.path ?? `agent-browser-${Date.now()}.pdf`);
      return textResult(`PDF saved to ${target} (${bytes.length} bytes)`);
    } catch (error) {
      return errorResult(`Cannot save PDF: ${(error as Error).message}`);
    }
  },
});

export const utilityTools: Tool[] = [
  waitTool,
  screenshotTool,
  pdfTool,
  getConsoleLogsTool,
  networkRequestsTool,
  networkRequestTool,
  runCodeUnsafeTool,
  evaluateTool,
  resizeViewportTool,
  getHtmlTool,
  iframeEvalTool,
  iframeClickTool,
];
