/**
 * Persistent store for browser tokens issued through the pairing web.
 *
 * Each install gets its own long-lived token: the pairing page issues it, the
 * extension stores it, and the WebSocket handshake accepts it. The JSON file
 * makes the tokens survive a container restart.
 */
import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from './utils/logger.js';

export interface TokenRecord {
  token: string;
  createdAt: string;
  label?: string;
  connectionId?: string;
}

export interface TokenStore {
  readonly filePath: string;
  /** Re-read the backing file (also performed lazily on construction). */
  load(): TokenRecord[];
  /** Generate a new random token and persist it. */
  issueToken(meta?: { label?: string; connectionId?: string }): string;
  /** Register an existing token (idempotent). Returns false when already present. */
  addToken(token: string, meta?: { label?: string; connectionId?: string }): boolean;
  isValid(token: string): boolean;
  list(): TokenRecord[];
}

export const DEFAULT_TOKEN_STORE_PATH = '/app/data/tokens.json';

/**
 * Create a token store backed by a JSON file.
 */
export function createTokenStore(
  filePath: string = process.env.BROWSER_TOKEN_STORE || DEFAULT_TOKEN_STORE_PATH,
): TokenStore {
  let records: TokenRecord[] = [];

  function load(): TokenRecord[] {
    records = [];
    if (!existsSync(filePath)) return records;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      const items = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { tokens?: unknown })?.tokens)
          ? (raw as { tokens: unknown[] }).tokens
          : [];
      for (const item of items) {
        const record = item as Partial<TokenRecord>;
        if (record && typeof record.token === 'string' && record.token.length > 0) {
          records.push({
            token: record.token,
            createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
            ...(typeof record.label === 'string' ? { label: record.label } : {}),
            ...(typeof record.connectionId === 'string' ? { connectionId: record.connectionId } : {}),
          });
        }
      }
      logger.info(`[tokens] Loaded ${records.length} token(s) from ${filePath}`);
    } catch (err) {
      logger.error(`[tokens] Failed to read ${filePath}, starting empty`, err);
      records = [];
    }
    return records;
  }

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify({ tokens: records }, null, 2)}\n`, 'utf-8');
    } catch (err) {
      logger.error(`[tokens] Failed to persist ${filePath}`, err);
    }
  }

  // Read the backing file up front: tokens must survive a container restart
  // without every caller remembering to call load().
  load();

  return {
    filePath,
    load,
    issueToken(meta) {
      const token = randomBytes(32).toString('hex');
      records.push({
        token,
        createdAt: new Date().toISOString(),
        ...(meta?.label ? { label: meta.label } : {}),
        ...(meta?.connectionId ? { connectionId: meta.connectionId } : {}),
      });
      persist();
      return token;
    },
    addToken(token, meta) {
      if (!token || records.some((r) => r.token === token)) return false;
      records.push({
        token,
        createdAt: new Date().toISOString(),
        ...(meta?.label ? { label: meta.label } : {}),
        ...(meta?.connectionId ? { connectionId: meta.connectionId } : {}),
      });
      persist();
      return true;
    },
    isValid(token) {
      if (!token) return false;
      return records.some((r) => r.token === token);
    },
    list() {
      return records.map((r) => ({ ...r }));
    },
  };
}

let shared: TokenStore | null = null;

/**
 * Process-wide store used by the WebSocket handshake and the pairing routes.
 */
export function getSharedTokenStore(): TokenStore {
  if (!shared) {
    shared = createTokenStore();
  }
  return shared;
}
