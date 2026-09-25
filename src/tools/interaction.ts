/**
 * Interaction tools: click, type, hover, drag, selectOption, pressKey, uploadFile.
 */
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Click on an element.
 */
export const clickTool: Tool = createTool({
  name: 'browser_click',
  description: 'Click on an element identified by its ref from a snapshot, or by CSS selector. Refs that carry a frame tag ("f3:s1e42") are routed to that iframe automatically.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot (e.g., "e12")'),
    selector: z.string().optional().describe('CSS selector to find the element'),
    button: z.enum(['left', 'right', 'middle'])
      .optional()
      .default('left')
      .describe('Mouse button to click'),
    clickCount: z.number()
      .optional()
      .default(1)
      .describe('Number of clicks (2 for double-click)'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_click', {
      ref: params.ref,
      selector: params.selector,
      button: params.button,
      clickCount: params.clickCount,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Click failed');
    }

    return textResult(`Clicked on ${params.ref ?? params.selector}`);
  },
});

/**
 * Type text into an element.
 */
export const typeTool: Tool = createTool({
  name: 'browser_type',
  description: 'Type text into an input field or text area.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector to find the element'),
    text: z.string().describe('Text to type'),
    clear: z.boolean()
      .optional()
      .default(false)
      .describe('Clear existing text before typing'),
    delay: z.number()
      .optional()
      .describe('Delay between keystrokes in milliseconds'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_type', {
      ref: params.ref,
      selector: params.selector,
      text: params.text,
      clear: params.clear,
      delay: params.delay,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Type failed');
    }

    return textResult(`Typed "${params.text}" into ${params.ref ?? params.selector}`);
  },
});

/**
 * Hover over an element.
 */
export const hoverTool: Tool = createTool({
  name: 'browser_hover',
  description: 'Hover the mouse over an element to trigger hover effects.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector to find the element'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_hover', {
      ref: params.ref,
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Hover failed');
    }

    return textResult(`Hovered over ${params.ref ?? params.selector}`);
  },
});

/**
 * Drag an element to another location.
 */
export const dragTool: Tool = createTool({
  name: 'browser_drag',
  description: 'Drag an element to another element or position.',
  schema: z.object({
    sourceRef: z.string().optional().describe('Source element reference'),
    sourceSelector: z.string().optional().describe('Source CSS selector'),
    targetRef: z.string().optional().describe('Target element reference'),
    targetSelector: z.string().optional().describe('Target CSS selector'),
  }).refine(
    data => data.sourceRef || data.sourceSelector,
    { message: 'Source ref or selector must be provided' }
  ).refine(
    data => data.targetRef || data.targetSelector,
    { message: 'Target ref or selector must be provided' }
  ),
  async handle(context, params) {
    // The extension's wire format is start*/end* (see its schemas.ts); the MCP
    // surface keeps source*/target* so existing callers do not break.
    const response = await context.send('browser_drag', {
      startRef: params.sourceRef,
      startSelector: params.sourceSelector,
      endRef: params.targetRef,
      endSelector: params.targetSelector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Drag failed');
    }

    return textResult('Drag completed');
  },
});

/**
 * Select an option from a dropdown.
 */
export const selectOptionTool: Tool = createTool({
  name: 'browser_select_option',
  description: 'Select an option from a <select> dropdown element.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the select element'),
    value: z.string().optional().describe('Value attribute of the option to select'),
    label: z.string().optional().describe('Visible text of the option to select'),
    index: z.number().optional().describe('Index of the option to select (0-based)'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ).refine(
    data => data.value !== undefined || data.label !== undefined || data.index !== undefined,
    { message: 'One of value, label, or index must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_select_option', {
      ref: params.ref,
      selector: params.selector,
      value: params.value,
      label: params.label,
      index: params.index,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Select option failed');
    }

    return textResult(`Selected option in ${params.ref ?? params.selector}`);
  },
});

/**
 * Press a keyboard key.
 */
export const pressKeyTool: Tool = createTool({
  name: 'browser_press_key',
  description: 'Press a keyboard key or key combination (e.g., "Enter", "Tab", "Control+A").',
  schema: z.object({
    key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "Control+A")'),
    ref: z.string().optional().describe('Element to focus before pressing key'),
    selector: z.string().optional().describe('CSS selector for element to focus'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_press_key', {
      key: params.key,
      ref: params.ref,
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Press key failed');
    }

    return textResult(`Pressed key: ${params.key}`);
  },
});

/**
 * Upload a file through a file input element.
 */
export const uploadFileTool: Tool = createTool({
  name: 'browser_upload_file',
  description: 'Upload one or more files. The target is the <input type=file> (hidden ones too; with no ref or selector the first file input is used) or any element that opens the file chooser, like a styled "Upload" button. Paths are read by Chrome, so they must exist on the machine running the browser.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the file input or the button that opens the chooser'),
    filePath: z.string().optional().describe('Absolute path to the file to upload'),
    filePaths: z.array(z.string()).optional().describe('Absolute paths, for multiple files'),
  }).refine(
    data => data.filePath || data.filePaths?.length,
    { message: 'filePath or filePaths must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_upload_file', {
      ref: params.ref,
      selector: params.selector,
      filePath: params.filePath,
      filePaths: params.filePaths,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Upload failed');
    }

    const files = [...(params.filePaths ?? []), ...(params.filePath ? [params.filePath] : [])];
    return textResult(`File${files.length > 1 ? 's' : ''} uploaded: ${files.join(', ')}`);
  },
});

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
  xml: 'application/xml', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
};

const MAX_DROP_FILES = 8;
const MAX_DROP_BYTES = 10 * 1024 * 1024;

async function readDropFile(input: string, root: string, remaining: number) {
  const name = basename(input);
  if (name === '.' || name === '..' || name === '' || (!isAbsolute(input) && input !== name) ||
      (isAbsolute(input) && dirname(input) !== root) || name.includes('\\')) {
    throw new Error('Drop files must be direct children of AGENT_BROWSER_DROP_DIR');
  }
  const target = join(root, name);
  const pathStat = await lstat(target);
  if (!pathStat.isFile()) throw new Error('Drop path is not a regular file');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error('Drop path changed before it could be read');
    }
    if (stat.size > remaining) throw new Error('Drop files exceed the 10 MiB total limit');
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > remaining) throw new Error('Drop files exceed the 10 MiB total limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return {
      file: { name, mimeType: MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream', base64: Buffer.concat(chunks, size).toString('base64') },
      size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Drop files or data on an element, as if dragged in from outside the page.
 */
export const dropTool: Tool = createTool({
  name: 'browser_drop',
  description: 'Drop files and/or MIME-typed data onto an element. Files must be direct children of the operator-configured AGENT_BROWSER_DROP_DIR; at most 8 files and 10 MiB total. Data-only drops need no directory. Reports whether the target accepted the drag.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector of the drop target'),
    paths: z.array(z.string()).max(MAX_DROP_FILES).optional().describe('File names or absolute paths directly inside AGENT_BROWSER_DROP_DIR'),
    data: z.record(z.string(), z.string()).optional().describe('MIME type → value, e.g. {"text/plain": "hello"}'),
  }).refine(d => d.ref || d.selector, { message: 'Either ref or selector must be provided' })
    .refine(d => d.paths?.length || (d.data && Object.keys(d.data).length), { message: 'paths or data must be provided' }),
  async handle(context, params) {
    let files: Array<{ name: string; mimeType: string; base64: string }> = [];
    try {
      if ((params.paths?.length ?? 0) > MAX_DROP_FILES) throw new Error('Drop accepts at most 8 files');
      if (params.paths?.length) {
        const configuredRoot = process.env.AGENT_BROWSER_DROP_DIR;
        if (!configuredRoot) throw new Error('AGENT_BROWSER_DROP_DIR must be configured for file drops');
        const root = await realpath(configuredRoot);
        let remaining = MAX_DROP_BYTES;
        for (const path of params.paths) {
          const { file, size } = await readDropFile(path, root, remaining);
          files.push(file);
          remaining -= size;
        }
      }
    } catch (error) {
      return errorResult(`Cannot read file: ${(error as Error).message}`);
    }
    const response = await context.send('browser_drop', {
      ref: params.ref,
      selector: params.selector,
      files,
      data: params.data ?? {},
    });
    if (!response.success) {
      return errorResult(response.error?.message ?? 'Drop failed');
    }
    const r = response.result as { dropped?: string[]; accepted?: boolean };
    return textResult(`Dropped: ${(r.dropped ?? []).join(', ')}${r.accepted === false ? ' (the target did not accept the drag: no dragover handler cancelled it)' : ''}`);
  },
});

/**
 * Fill several form fields in one call.
 */
export const fillFormTool: Tool = createTool({
  name: 'browser_fill_form',
  description: 'Fill several form fields in one call. Each field: {ref|selector, value, type?}; type (textbox|checkbox|radio|combobox|slider) is inferred when missing. checkbox/radio take true/false, combobox takes the option label or value. Values are set through the native setter plus input/change events, so framework-controlled inputs (React) pick them up. Reports ok/failure per field.',
  schema: z.object({
    fields: z.array(z.object({
      ref: z.string().optional().describe('Element reference from snapshot'),
      selector: z.string().optional().describe('CSS selector'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to set'),
      type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).optional(),
    }).refine(f => f.ref || f.selector, { message: 'Each field needs ref or selector' })).min(1),
  }),
  async handle(context, params) {
    const response = await context.send('browser_fill_form', { fields: params.fields });
    if (!response.success) {
      return errorResult(response.error?.message ?? 'Fill form failed');
    }
    const { results = [] } = response.result as {
      results?: Array<{ field: string; ok: boolean; kind?: string; error?: string }>;
    };
    const failed = results.filter(r => !r.ok).length;
    const lines = results.map(r => r.ok ? `ok ${r.field} (${r.kind})` : `FAILED ${r.field}: ${r.error}`);
    return textResult(lines.join('\n'), failed === results.length && results.length > 0);
  },
});

export const interactionTools: Tool[] = [
  clickTool,
  typeTool,
  hoverTool,
  dragTool,
  selectOptionTool,
  pressKeyTool,
  uploadFileTool,
  dropTool,
  fillFormTool,
];
