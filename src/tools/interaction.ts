/**
 * Interaction tools: click, type, hover, drag, selectOption, pressKey, uploadFile.
 */
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPinnedDirectory, pinnedChildPath } from './pinned-directory.js';
import { createTool, textResult, errorResult } from './types.js';
import { planSave, requireSaveSecretConfigured, saveError, SaveError } from '../onepassword-connect.js';
import { RE2JS } from 're2js';
import { logger } from '../utils/logger.js';
import type { ExtensionResponse, Tool } from '../types.js';

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
 * The extension checks the field after typing and reports a length mismatch as `warning`
 * (lengths only, never the value). Without surfacing it, a type that never reached the page
 * — a hidden tab, a field that lost focus — came back as a plain success.
 */
function fieldWarning(result: unknown): string | undefined {
  const warning = (result as { warning?: unknown } | undefined)?.warning;
  return typeof warning === 'string' && warning ? warning : undefined;
}

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

    const warning = fieldWarning(response.result);
    const target = params.ref ?? params.selector;
    return textResult(warning
      ? `Typed "${params.text}" into ${target}, but ${warning}: check the field before going on`
      : `Typed "${params.text}" into ${target}`);
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
const MAX_DROP_DATA_BYTES = 1024 * 1024;

async function readDropFile(input: string, root: string, rootHandle: FileHandle, remaining: number) {
  const name = basename(input);
  if (name === '.' || name === '..' || name === '' || (!isAbsolute(input) && input !== name) ||
      (isAbsolute(input) && dirname(input) !== root) || name.includes('\\')) {
    throw new Error('Drop files must be direct children of AGENT_BROWSER_DROP_DIR');
  }
  const target = pinnedChildPath(rootHandle, name);
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
  description: 'Drop files and/or MIME-typed data onto an element. Files must be direct children of the operator-configured AGENT_BROWSER_DROP_DIR; at most 8 files and 10 MiB total. MIME data is limited to 1 MiB. Data-only drops need no directory. Reports whether the target accepted the drag.',
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
      const dataBytes = Object.entries(params.data ?? {}).reduce(
        (total, [type, value]) => total + Buffer.byteLength(type) + Buffer.byteLength(value), 0);
      if (dataBytes > MAX_DROP_DATA_BYTES) throw new Error('Drop MIME data exceeds the 1 MiB limit');
      if ((params.paths?.length ?? 0) > MAX_DROP_FILES) throw new Error('Drop accepts at most 8 files');
      if (params.paths?.length) {
        const configuredRoot = process.env.AGENT_BROWSER_DROP_DIR;
        if (!configuredRoot) throw new Error('AGENT_BROWSER_DROP_DIR must be configured for file drops');
        const { root, handle } = await openPinnedDirectory(configuredRoot);
        try {
          let remaining = MAX_DROP_BYTES;
          for (const path of params.paths) {
            const { file, size } = await readDropFile(path, root, handle, remaining);
            files.push(file);
            remaining -= size;
          }
        } finally {
          await handle.close();
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

/**
 * Treat extension warnings as failure signals, never as safe text to return to the caller.
 */
function hasFieldWarning(result: unknown): boolean {
  const warning = (result as { warning?: unknown } | undefined)?.warning;
  return typeof warning === 'string' && warning.length > 0;
}

/**
 * Where `op` reads from, chosen with AGENT_BROWSER_OP_BACKEND:
 *   unset            the environment as it is (service account token, Connect, or the desktop app)
 *   connect          a 1Password Connect server (OP_CONNECT_HOST + OP_CONNECT_TOKEN); the service
 *                    account token is removed, so the read never spends its daily quota
 *   service-account  OP_SERVICE_ACCOUNT_TOKEN; OP_CONNECT_* are removed (op refuses both at once)
 * Any other value is an error: there is no silent fallback to the service account.
 */
export function opEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const raw = env.AGENT_BROWSER_OP_BACKEND;
  if (raw === undefined) return env;
  const backend = raw.trim().toLowerCase();
  const out: NodeJS.ProcessEnv = { ...env };
  if (backend === 'connect') {
    // A token pasted with its trailing newline breaks the Authorization header.
    const host = (env.OP_CONNECT_HOST ?? '').trim();
    const token = (env.OP_CONNECT_TOKEN ?? '').trim();
    if (!host || !token) throw new Error('AGENT_BROWSER_OP_BACKEND=connect needs OP_CONNECT_HOST and OP_CONNECT_TOKEN');
    out.OP_CONNECT_HOST = host;
    out.OP_CONNECT_TOKEN = token;
    delete out.OP_SERVICE_ACCOUNT_TOKEN;
    return out;
  }
  if (backend === 'service-account') {
    if (!env.OP_SERVICE_ACCOUNT_TOKEN?.trim()) {
      throw new Error('AGENT_BROWSER_OP_BACKEND=service-account needs OP_SERVICE_ACCOUNT_TOKEN');
    }
    delete out.OP_CONNECT_HOST;
    delete out.OP_CONNECT_TOKEN;
    return out;
  }
  throw new Error(`AGENT_BROWSER_OP_BACKEND must be connect or service-account, not '${raw}'`);
}

/**
 * Read a secret from 1Password ON THE SERVER MACHINE. The reader is `op read <ref>`;
 * AGENT_BROWSER_OP_BIN points to another binary with the same contract (e.g. a wrapper that
 * unlocks through the desktop app, or one that picks the backend itself).
 */
export async function readSecret(ref: string): Promise<string> {
  const bin = process.env.AGENT_BROWSER_OP_BIN || 'op';
  const { stdout } = await promisify(execFile)(bin, ['read', ref], { timeout: 60000, env: opEnv() });
  return stdout.replace(/\r?\n$/, '');
}

/**
 * Type a secret from 1Password into a field. The value never reaches the model: it is not in
 * the tool arguments or the result. A compatible extension must honor `secret` and redact
 * both request and response logs; older extensions are not safe for this operation.
 */
const fillSecret = createTool({
  name: 'browser_fill_secret',
  description: 'Type a secret from 1Password (op://vault/item/field) into a field. The value is read on the server and omitted from this tool result. Requires a secret-aware extension that redacts request and response logs. Use it for passwords AND for 2FA/TOTP codes, never browser_type. TOTP: reference the OTP field of the item BY ITS FIELD ID with ?attribute=otp (op://vault/item/TOTP_xxxx?attribute=otp) and it types the current code; the field label changes with the app language. Without ?attribute=otp it would type the otpauth:// seed.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from browser_state/snapshot'),
    selector: z.string().optional().describe('CSS selector to find the element'),
    secretRef: z.string()
      .regex(/^op:\/\/[^/?#]+\/[^/?#]+\/(?:[^/?#]+\/)?[^/?#]+(?:\?[^#]+)?$/, 'secretRef must be a complete op://vault/item/field reference')
      .regex(/^[^\x00-\x1f\x7f]+$/, 'secretRef must not contain control characters')
      .refine(ref => ref.slice(5).split('?')[0].split('/').every(part => part.trim().length > 0), 'secretRef components must not be blank')
      .describe('1Password secret reference, op://vault/item/field. TOTP code: op://vault/item/<OTP field id>?attribute=otp'),
    clear: z.boolean().optional().default(true).describe('Clear existing text before typing'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    let value: string;
    try {
      value = await (context.readSecret ?? readSecret)(params.secretRef);
    } catch {
      // A configurable reader may put secrets in stderr or its exception message.
      return errorResult('Could not read the secret. Check the configured 1Password reader, credentials and AGENT_BROWSER_OP_BACKEND on the server.');
    }
    if (typeof value !== 'string' || !value) return errorResult('The configured reader returned an empty secret.');
    let response: ExtensionResponse;
    try {
      response = await context.send('browser_type', {
        ref: params.ref,
        selector: params.selector,
        text: value,
        clear: params.clear,
        secret: true,
      });
    } catch {
      return errorResult('Could not deliver the secret to the browser. Check the connection and target field before retrying.');
    }
    if (response?.success !== true) {
      return errorResult('Could not fill the target field. Check the field before retrying.');
    }
    if (hasFieldWarning(response.result) ||
        (response.result as { typed?: unknown } | undefined)?.typed !== true ||
        (response.result as { verified?: unknown } | undefined)?.verified !== true) {
      // An error, not a success with a note: submitting a field without the secret (a 2FA code
      // above all) burns an attempt.
      return errorResult('Did not fill the target field as expected. Check the field before retrying or submitting.');
    }
    return textResult('Filled and verified the target field.');
  },
});

export const fillSecretTool: Tool = {
  schema: fillSecret.schema,
  handle: async (context, params) => {
    if (process.env.AGENT_BROWSER_FILL_SECRET_ENABLED !== 'true') {
      return errorResult('Secret filling is disabled on this server.');
    }
    return fillSecret.handle(context, params);
  },
};

/** What the extension may say about browser_read_secret: a closed set, with texts that carry no page content. */
const SECRET_TEXT: Record<string, string> = {
  SECRET_NO_MATCH: 'No element matches the selector',
  SECRET_AMBIGUOUS: 'Multiple elements match the selector',
  SECRET_EMPTY: 'The element has no text',
  SECRET_REGEX_INVALID: 'The regex is not valid or has no capture group',
  SECRET_REGEX_NO_MATCH: 'The regex did not match',
  SECRET_TOO_LARGE: 'The text is too large',
};

/** The value of a browser_read_secret answer, or the SaveError for what went wrong. Never the extension's own message. */
function capturedValue(response: ExtensionResponse): string {
  if (!response.success) {
    const { code = '', message = '' } = response.error ?? {};
    // Like browser_passkey: an extension that predates the message answers UNKNOWN_TOOL.
    if (code === 'UNKNOWN_TOOL' || /Unknown tool/.test(message)) throw saveError('SAVE_SECRET_EXTENSION_TOO_OLD');
    if (Object.hasOwn(SECRET_TEXT, code)) throw new SaveError(code, SECRET_TEXT[code]);
    throw saveError('SAVE_SECRET_EXTENSION_ERROR');
  }
  const value = (response.result as { value?: unknown } | undefined)?.value;
  if (typeof value !== 'string' || !value) throw saveError('SAVE_SECRET_EXTENSION_ERROR');
  if (value.length > 4096) throw saveError('SAVE_SECRET_VALUE_TOO_LARGE');
  return value;
}

const saveDestination = z.object({
  vault: z.string().describe('1Password vault, by name or id. Must be one the server allows (AGENT_BROWSER_SAVE_VAULTS)'),
  item: z.string().describe('Item title, or its 26-character id. Created when no item has that title'),
  field: z.string().describe('Field label (or id) that receives the value'),
});

function validateOtp(value: string): void {
  const base32 = (seed: string) => /^[A-Z2-7]{16,128}(?:={1,6})?$/.test(seed) && [0, 2, 4, 5, 7].includes(seed.replace(/=+$/, '').length % 8);
  if (!value.startsWith('otpauth://')) {
    if (!base32(value)) throw saveError('SAVE_SECRET_VALUE_NOT_BASE32');
    return;
  }
  try {
    const uri = new URL(value);
    const params = uri.searchParams;
    const seed = params.get('secret') ?? '';
    if (uri.hostname !== 'totp' || uri.username || uri.password || uri.port || uri.hash || uri.pathname.length < 2 || !base32(seed.toUpperCase()) || params.getAll('secret').length !== 1) throw new Error();
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new Error();
    if (params.has('algorithm') && !['SHA1', 'SHA256', 'SHA512'].includes(params.get('algorithm')!)) throw new Error();
    if (params.has('digits') && !['6', '8'].includes(params.get('digits')!)) throw new Error();
    if (params.has('period') && !/^[1-9]\d{0,5}$/.test(params.get('period')!)) throw new Error();
  } catch { throw saveError('SAVE_SECRET_VALUE_NOT_BASE32'); }
}

const saveSecret = createTool({
  name: 'browser_save_secret',
  description: 'Copy a value shown on the page into a 1Password field without returning the value or its length. Available only with an explicitly configured Connect write token and vault ID allowlist. Pick ref/selector and/or an RE2 regex whose first capture group is the value (lookaround and backreferences are unsupported). destination: {vault, item, field}; creates an absent item. type "otp" accepts base32 seeds or valid otpauth://totp URIs. template is fixed text containing {value} exactly once, never a secret. Existing values require overwrite=true. Connect writes retain the current item version; rejected writes are not retried. Other browser reading tools can still reveal page content.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from browser_state/snapshot'),
    selector: z.string().optional().describe('CSS selector; it must match exactly one element'),
    regex: z.string().min(1).max(256).optional().describe('Regex (no flags) whose capture group 1 is the value, applied to the element text (or the page text without ref/selector)'),
    destination: saveDestination,
    type: z.enum(['concealed', 'otp']).optional().default('concealed').describe('Kind of 1Password field'),
    template: z.string().max(512).optional().describe('Fixed text around the value, with {value} once. Never put a secret in it'),
    overwrite: z.boolean().optional().default(false).describe('Replace a field that already has a value'),
  }).refine(
    data => data.ref || data.selector || data.regex,
    { message: 'ref, selector or regex must be provided' }
  ),
  async handle(context, params) {
    const { vault, item, field } = params.destination;
    try {
      // Plan §2 order: validate, configuration and allowlist, resolve vault and item (reads only), THEN read the page.
      if (params.template !== undefined && params.template.split('{value}').length !== 2) throw saveError('SAVE_SECRET_TEMPLATE_INVALID');
      if (params.regex !== undefined) {
        try {
          if (RE2JS.compile(params.regex).groupCount() < 1) throw new Error();
        } catch { throw new SaveError('SECRET_REGEX_INVALID', SECRET_TEXT.SECRET_REGEX_INVALID); }
      }
      const plan = await planSave(params.destination, { type: params.type === 'otp' ? 'OTP' : 'CONCEALED', overwrite: params.overwrite });
      const captured = capturedValue(await context.send('browser_read_secret', { ref: params.ref, selector: params.selector, regex: params.regex }));
      let value = captured;
      if (params.type === 'otp' && !value.startsWith('otpauth://')) {
        // Seeds are shown in groups of four, sometimes lowercase; saving them as typed would give wrong codes without a warning.
        value = value.replace(/[\s-]/g, '').toUpperCase();
      }
      // split/join, never String.replace: it would read `$&` or `$1` inside the value.
      const stored = params.template === undefined ? value : params.template.split('{value}').join(value);
      if (stored.length > 4096) throw saveError('SAVE_SECRET_VALUE_TOO_LARGE');
      if (params.type === 'otp') validateOtp(stored);
      await plan.write(stored);
      logger.info(`[save_secret] vault=${vault} item=${item} field=${field}`);
      return textResult(JSON.stringify({ saved: true, destination: { vault, item, field } }));
    } catch (error) {
      if (error instanceof SaveError) return errorResult(`${error.code}: ${error.message}`);
      return errorResult(`SAVE_SECRET_EXTENSION_ERROR: ${saveError('SAVE_SECRET_EXTENSION_ERROR').message}`);
    }
  },
});

export const saveSecretTool: Tool = {
  schema: saveSecret.schema,
  // A destination that is missing or malformed gets the same code as every other bad destination.
  handle: async (context, params) => {
    try { requireSaveSecretConfigured(); }
    catch (error) {
      const e = error as SaveError;
      return errorResult(`${e.code}: ${e.message}`);
    }
    return saveDestination.safeParse(params?.destination).success
      ? saveSecret.handle(context, params)
      : errorResult(`SAVE_SECRET_INVALID_DESTINATION: ${saveError('SAVE_SECRET_INVALID_DESTINATION').message}`);
  },
};

/**
 * browser_passkey (INFRA-585): clicks the element that starts a passkey ceremony. The extension
 * lifts its WebAuthn guard for that ceremony only, with the agent's own passkey for the tab
 * host (use) or creating one (enroll), and keeps the key in the browser: nothing here ever sees it.
 */
export const passkeyTool: Tool = createTool({
  name: 'browser_passkey',
  description: 'Sign in to a site with a passkey, or give the agent a passkey for it. Agent tabs refuse every WebAuthn request; this clicks the element that starts ONE passkey ceremony and lifts that refusal only while it lasts. mode "use": click the site\'s "sign in with passkey" button and the agent\'s own passkey for that host signs in. mode "enroll": signed in, click the site\'s "add a passkey" button and the site creates the agent\'s passkey for that host (once per site). The key stays in the browser extension and never reaches this result. Waits up to 20 s for the site to ask.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from browser_state/snapshot of the button that starts the passkey ceremony'),
    selector: z.string().optional().describe('CSS selector of that button'),
    mode: z.enum(['enroll', 'use']).describe('"use" signs in with the agent passkey enrolled for the tab host; "enroll" creates it (the site must be signed in)'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_passkey', {
      ref: params.ref,
      selector: params.selector,
      mode: params.mode,
    });
    if (!response.success) {
      const message = response.error?.message ?? 'Passkey click failed';
      return errorResult(/Unknown tool/.test(message)
        ? 'The browser extension does not know browser_passkey yet: it updates itself (or reload it), then try again.'
        : message);
    }
    const passkey = (response.result as { passkey?: PasskeyOutcome } | undefined)?.passkey;
    if (!passkey) {
      return errorResult('The browser extension answered without a passkey report: it is too old for browser_passkey. Nothing was signed.');
    }
    const report = `Clicked on ${params.ref ?? params.selector}. ${describePasskey(passkey)}`;
    if (passkey.guardRestored === false) {
      return errorResult(`${report} The WebAuthn guard could not be put back on this tab: close it (browser_close_tab) before visiting any other site.`);
    }
    return textResult(report);
  },
});

/** What the extension reports about a passkey ceremony: never the key nor the user handle. */
interface PasskeyOutcome {
  mode: 'enroll' | 'use';
  host: string;
  ceremony: 'completed' | 'timeout';
  passkeys: Array<{ rpId: string; enrolledAt: string }>;
  guardRestored?: false;
}

export function describePasskey(p: PasskeyOutcome): string {
  const which = p.passkeys.map((k) => k.rpId).join(', ') || 'none';
  if (p.ceremony === 'timeout') {
    return `Passkey ${p.mode} on ${p.host}: the site asked for no passkey within the wait (passkeys for this host: ${which}).`;
  }
  return p.mode === 'enroll'
    ? `Passkey enrolled on ${p.host} (rpId ${which}).`
    : `Signed in with the agent passkey for ${which} on ${p.host}.`;
}

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
  fillSecretTool,
  saveSecretTool,
  passkeyTool,
];
