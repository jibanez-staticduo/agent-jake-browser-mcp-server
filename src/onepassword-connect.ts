/**
 * Writer of browser_save_secret (SC-2102): puts one value into one field of a 1Password item
 * through the REST API of a 1Password Connect server. Plain `fetch`: no subprocess, no file,
 * no verb that removes anything, no retry, no read-back.
 *
 * Measured against the real Connect (see connect-client.js in k8s-agentgateway-pocharlies):
 * the PUT needs `id` and `vault` equal to the URL's, so it sends the raw GET body with only the
 * field changed; and the server answers from a cache that lags 1-3 s behind a write.
 *
 * Every error is a SaveError with a fixed text: never a Connect body, never the message of
 * `fetch`, never the value. The GET of an item returns the values of ALL its fields; they stay
 * in this module's memory and go nowhere.
 */

import { z } from 'zod';

/** Connect REST API 1.8.1: SECURE_NOTE supports custom CONCEALED and OTP fields. */
export const NEW_ITEM_CATEGORY = 'SECURE_NOTE';

export type FieldType = 'CONCEALED' | 'OTP';
export interface Destination { vault: string; item: string; field: string }
export interface SaveOptions { type: FieldType; overwrite: boolean }

const TEXT = {
  SAVE_SECRET_NOT_CONFIGURED: 'browser_save_secret is not configured on this server (Connect host, write token or allowed vaults missing).',
  SAVE_SECRET_INVALID_DESTINATION: 'The destination is not valid, or its vault is not one this tool may write to.',
  SAVE_SECRET_VAULT_NOT_FOUND: 'The vault does not exist.',
  SAVE_SECRET_ITEM_AMBIGUOUS: 'More than one item has that title in the vault.',
  SAVE_SECRET_FIELD_EXISTS: 'The field already has a value and overwrite is false.',
  SAVE_SECRET_VALUE_NOT_BASE32: 'The value is neither an otpauth:// URI nor a base32 seed.',
  SAVE_SECRET_TEMPLATE_INVALID: 'The template must contain {value} exactly once.',
  SAVE_SECRET_VALUE_TOO_LARGE: 'The value is larger than 4096 characters.',
  SAVE_SECRET_DENIED: 'Connect refused the write token (401 or 403).',
  SAVE_SECRET_UNAVAILABLE: 'Connect could not be reached, timed out or failed (network, timeout or 5xx).',
  SAVE_SECRET_CONFLICT: 'The item changed during the write. Read its current state before trying again.',
  SAVE_SECRET_FIELD_AMBIGUOUS: 'More than one field matches the destination.',
  SAVE_SECRET_EXTENSION_TOO_OLD: 'The browser extension does not know browser_save_secret yet: it updates itself (or reload it), then try again.',
  SAVE_SECRET_EXTENSION_ERROR: 'The browser extension could not read the value from the page.',
};

export class SaveError extends Error {
  constructor(readonly code: string, text: string = (TEXT as Record<string, string>)[code]) {
    super(text);
  }
}

export const saveError = (code: keyof typeof TEXT) => new SaveError(code);

const id = z.string().regex(/^[a-z0-9]{26}$/);
const fieldSchema = z.object({ id: z.string().optional(), label: z.string().optional(), type: z.string().optional(), value: z.string().optional() }).passthrough();
const itemSchema = z.object({ id, vault: z.object({ id }).passthrough(), version: z.number().int().positive(), fields: z.array(fieldSchema).optional() }).passthrough();
type RawItem = z.infer<typeof itemSchema>;
const writeQueues = new Map<string, Promise<void>>();
// Retain only metadata, never values. Exhaustion fails closed rather than forgetting stale writes.
const writtenVersions = new Map<string, number>();
const createdTitles = new Set<string>();
async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => hold);
  writeQueues.set(key, tail);
  await previous;
  try { return await run(); }
  finally { release(); if (writeQueues.get(key) === tail) writeQueues.delete(key); }
}

function configuration() {
  const host = (process.env.OP_CONNECT_HOST ?? '').trim();
  const token = (process.env.OP_CONNECT_WRITE_TOKEN ?? '').trim();
  const allowed = (process.env.AGENT_BROWSER_SAVE_VAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!host || !token || !allowed.length) throw saveError('SAVE_SECRET_NOT_CONFIGURED');
  try {
    const url = new URL(host);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^[\x21-\x7e]+$/.test(token)) throw new Error();
    if (allowed.some((v) => !id.safeParse(v).success)) throw saveError('SAVE_SECRET_INVALID_DESTINATION');
    return { host: url.origin, token, allowed };
  } catch (error) {
    if (error instanceof SaveError) throw error;
    throw saveError('SAVE_SECRET_NOT_CONFIGURED');
  }
}

export function isSaveSecretConfigured(): boolean {
  try { configuration(); return true; } catch { return false; }
}

export function requireSaveSecretConfigured(): void { configuration(); }

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw saveError('SAVE_SECRET_UNAVAILABLE');
  return parsed.data;
}

/**
 * Everything that can be known without the value: validates the destination, resolves vault and
 * item (reads only), and refuses a field that already has a value unless `overwrite`. Nothing is
 * written until `write(value)`.
 */
export async function planSave(dest: Destination, opts: SaveOptions): Promise<{ write(value: string): Promise<void> }> {
  const { vault, item, field } = dest;
  // These three travel inside a Connect filter and into the audit line.
  if ([vault, item, field].some((s) => !s.trim() || s.length > 512 || /["\\\u0000-\u001f\u007f]/.test(s))) throw saveError('SAVE_SECRET_INVALID_DESTINATION');
  const { host, token, allowed } = configuration();

  const call = async (method: string, path: string, body?: unknown, soft404 = false): Promise<any> => {
    let res: Response;
    try {
      res = await fetch(`${host}/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw saveError('SAVE_SECRET_UNAVAILABLE');
    }
    const wanted = res.ok && method === 'GET';
    if (!wanted) await res.body?.cancel(); // an error body, or the echo of a write: never read, never shown
    if (res.status === 404 && soft404) return undefined;
    if (res.status === 401 || res.status === 403) throw saveError('SAVE_SECRET_DENIED');
    if (res.status === 409 || res.status === 412) throw saveError('SAVE_SECRET_CONFLICT');
    if (res.status >= 500) throw saveError('SAVE_SECRET_UNAVAILABLE');
    if (!res.ok) throw new SaveError('SAVE_SECRET_REJECTED', `Connect rejected the request (HTTP ${res.status}).`);
    if (!wanted) return undefined;
    // A full item contains other secrets too: bound its memory use and never expose parse errors.
    const reader = res.body?.getReader();
    if (!reader) throw saveError('SAVE_SECRET_UNAVAILABLE');
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw saveError('SAVE_SECRET_UNAVAILABLE'); }
    finally { await reader.cancel().catch(() => {}); }
  };

  const vaults = checked(z.array(z.object({ id, name: z.string() })), await call('GET', '/vaults'));
  const matches = vaults.filter((x) => x.id === vault || x.name === vault);
  if (matches.length > 1) throw saveError('SAVE_SECRET_INVALID_DESTINATION');
  const v = matches[0];
  if (!v) throw saveError('SAVE_SECRET_VAULT_NOT_FOUND');
  if (!allowed.includes(v.id)) throw saveError('SAVE_SECRET_INVALID_DESTINATION'); // C2 (security): the wall is the vault id, never the name

  const base = `/vaults/${v.id}/items`;
  const readItem = async (itemId: string, soft404 = false): Promise<RawItem | undefined> => {
    const body = await call('GET', `${base}/${itemId}`, undefined, soft404);
    if (body === undefined) return undefined;
    const result = checked(itemSchema, body);
    if (result.id !== itemId || result.vault.id !== v.id) throw saveError('SAVE_SECRET_UNAVAILABLE');
    return result;
  };
  let found: RawItem | undefined;
  if (id.safeParse(item).success) found = await readItem(item, true);
  if (!found) {
    const list = checked(z.array(z.object({ id, title: z.literal(item), vault: z.object({ id: z.literal(v.id) }) })), await call('GET', `${base}?filter=${encodeURIComponent(`title eq "${item}"`)}`));
    if (list.length > 1) throw saveError('SAVE_SECRET_ITEM_AMBIGUOUS');
    if (list[0]) found = await readItem(list[0].id);
  }
  const targetField = (source: RawItem) => {
    const matches = (source.fields ?? []).filter((f) => f.label === field || f.id === field);
    if (matches.length > 1) throw saveError('SAVE_SECRET_FIELD_AMBIGUOUS');
    if (!opts.overwrite && matches[0]?.value) throw saveError('SAVE_SECRET_FIELD_EXISTS');
    return matches[0];
  };
  if (found) targetField(found);

  return {
    async write(value: string): Promise<void> {
      if (value.length > 4096) throw saveError('SAVE_SECRET_VALUE_TOO_LARGE');
      await exclusive(`${host}/${v.id}`, async () => {
        if (writtenVersions.size + createdTitles.size >= 1000) throw saveError('SAVE_SECRET_UNAVAILABLE');
        if (!found) {
          const titleKey = JSON.stringify([host, v.id, item]);
          if (createdTitles.has(titleKey)) throw saveError('SAVE_SECRET_CONFLICT');
          // A timeout may occur after Connect commits: remember attempts as well as successes.
          createdTitles.add(titleKey);
          await call('POST', base, { vault: { id: v.id }, title: item, category: NEW_ITEM_CATEGORY, fields: [{ label: field, type: opts.type, value }] });
          return;
        }
        // Connect lags behind its own writes and the item may have changed while the page was read.
        const fresh = (await readItem(found.id))!;
        const itemKey = `${host}/${v.id}/${fresh.id}`;
        if (fresh.version <= (writtenVersions.get(itemKey) ?? 0)) throw saveError('SAVE_SECRET_CONFLICT');
        const fields = fresh.fields ?? [];
        const current = targetField(fresh);
        const put = { label: field, type: opts.type, value };
        writtenVersions.set(itemKey, fresh.version);
        await call('PUT', `${base}/${fresh.id}`, { ...fresh, fields: current ? fields.map((f) => (f === current ? { ...f, type: opts.type, value } : f)) : [...fields, put] });
      });
    },
  };
}
