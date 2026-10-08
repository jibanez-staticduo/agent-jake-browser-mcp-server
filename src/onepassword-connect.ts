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

/** Unmeasured: that this Connect accepts CONCEALED/OTP fields in a SECURE_NOTE. If the POST is rejected, this is the only line to change. */
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
  SAVE_SECRET_EXTENSION_TOO_OLD: 'The browser extension does not know browser_save_secret yet: it updates itself (or reload it), then try again.',
  SAVE_SECRET_EXTENSION_ERROR: 'The browser extension could not read the value from the page.',
};

export class SaveError extends Error {
  constructor(readonly code: string, text: string = (TEXT as Record<string, string>)[code]) {
    super(text);
  }
}

export const saveError = (code: keyof typeof TEXT) => new SaveError(code);

interface RawField { id?: string; label?: string; type?: string; value?: string; [key: string]: unknown }
interface RawItem { id: string; fields?: RawField[]; [key: string]: unknown }

/**
 * Everything that can be known without the value: validates the destination, resolves vault and
 * item (reads only), and refuses a field that already has a value unless `overwrite`. Nothing is
 * written until `write(value)`.
 */
export async function planSave(dest: Destination, opts: SaveOptions): Promise<{ write(value: string): Promise<void> }> {
  const { vault, item, field } = dest;
  // These three travel inside a Connect filter and into the audit line.
  if ([vault, item, field].some((s) => !s || /["\\\u0000-\u001f\u007f]/.test(s))) throw saveError('SAVE_SECRET_INVALID_DESTINATION');
  const host = (process.env.OP_CONNECT_HOST ?? '').trim().replace(/\/+$/, '');
  const token = (process.env.OP_CONNECT_WRITE_TOKEN ?? '').trim(); // a trailing \n breaks the header
  const allowed = (process.env.AGENT_BROWSER_SAVE_VAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!host || !token || !allowed.length) throw saveError('SAVE_SECRET_NOT_CONFIGURED');

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
    if (res.status >= 500) throw saveError('SAVE_SECRET_UNAVAILABLE');
    if (!res.ok) throw new SaveError('SAVE_SECRET_REJECTED', `Connect rejected the request (HTTP ${res.status}).`);
    if (!wanted) return undefined;
    try { return await res.json(); } catch { throw saveError('SAVE_SECRET_UNAVAILABLE'); }
  };

  const vaults: Array<{ id: string; name: string }> = await call('GET', '/vaults');
  const v = vaults.find((x) => x.id === vault || x.name === vault);
  if (!v) throw saveError('SAVE_SECRET_VAULT_NOT_FOUND');
  if (!allowed.includes(v.id) && !allowed.includes(v.name)) throw saveError('SAVE_SECRET_INVALID_DESTINATION');

  const base = `/vaults/${v.id}/items`;
  let found: RawItem | undefined;
  if (/^[a-z0-9]{26}$/.test(item)) found = await call('GET', `${base}/${item}`, undefined, true);
  if (!found) {
    const list: RawItem[] = await call('GET', `${base}?filter=${encodeURIComponent(`title eq "${item}"`)}`);
    if (list.length > 1) throw saveError('SAVE_SECRET_ITEM_AMBIGUOUS');
    if (list[0]) found = await call('GET', `${base}/${list[0].id}`);
  }
  const named = (f: RawField) => f.label === field || f.id === field;
  if (!opts.overwrite && found?.fields?.find(named)?.value) throw saveError('SAVE_SECRET_FIELD_EXISTS');

  return {
    async write(value: string): Promise<void> {
      if (!found) {
        await call('POST', base, { vault: { id: v.id }, title: item, category: NEW_ITEM_CATEGORY, fields: [{ label: field, type: opts.type, value }] });
        return;
      }
      // Connect lags behind its own writes and the item may have changed while the page was read.
      const fresh: RawItem = await call('GET', `${base}/${found.id}`);
      const fields = fresh.fields ?? [];
      const current = fields.find(named);
      if (!opts.overwrite && current?.value) throw saveError('SAVE_SECRET_FIELD_EXISTS');
      const put = { label: field, type: opts.type, value };
      await call('PUT', `${base}/${fresh.id}`, { ...fresh, fields: current ? fields.map((f) => (f === current ? { ...f, type: opts.type, value } : f)) : [...fields, put] });
    },
  };
}
