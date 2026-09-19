/**
 * Pairing token store persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenStore } from '../src/token-store.ts';

let tempDir: string;
let file: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ajb-tokens-'));
  file = join(tempDir, 'nested', 'tokens.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('token store', () => {
  it('issues random tokens and validates them', () => {
    const store = createTokenStore(file);
    const token = store.issueToken({ label: 'chrome-casa' });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.isValid(token)).toBe(true);
    expect(store.isValid('nope')).toBe(false);
    expect(store.isValid('')).toBe(false);
    expect(store.list()[0].label).toBe('chrome-casa');
    expect(store.issueToken()).not.toBe(token);
  });

  it('creates the directory and survives a restart', () => {
    const store = createTokenStore(file);
    const token = store.issueToken();
    expect(existsSync(file)).toBe(true);

    const reloaded = createTokenStore(file);
    reloaded.load();
    expect(reloaded.isValid(token)).toBe(true);
    expect(reloaded.list()[0].token).toBe(token);
  });

  it('adds an existing token once', () => {
    const store = createTokenStore(file);
    expect(store.addToken('legacy-shared-secret')).toBe(true);
    expect(store.addToken('legacy-shared-secret')).toBe(false);
    expect(store.isValid('legacy-shared-secret')).toBe(true);
  });

  it('reads hand-written and array-style files', () => {
    const handwritten = join(tempDir, 'handwritten.json');
    writeFileSync(handwritten, JSON.stringify([{ token: 'array-style', createdAt: 'x' }]));

    const store = createTokenStore(handwritten);
    expect(store.load().map((r) => r.token)).toContain('array-style');
    expect(store.isValid('array-style')).toBe(true);
  });

  it('starts empty when the file is missing or corrupt', () => {
    expect(existsSync(file)).toBe(false);
    expect(createTokenStore(file).load()).toEqual([]);

    const broken = join(tempDir, 'broken.json');
    writeFileSync(broken, '{not json');
    expect(createTokenStore(broken).load()).toEqual([]);
  });

  it('does not expose the internal records', () => {
    const store = createTokenStore(file);
    const token = store.issueToken();
    const listed = store.list();
    listed[0].token = 'mutated';
    expect(store.isValid(token)).toBe(true);
  });

  it('persists into a directory it did not create when the path already exists', () => {
    mkdirSync(join(tempDir, 'existing'), { recursive: true });
    const store = createTokenStore(join(tempDir, 'existing', 'deep', 'tokens.json'));
    const token = store.issueToken();
    expect(existsSync(join(tempDir, 'existing', 'deep', 'tokens.json'))).toBe(true);
    expect(createTokenStore(join(tempDir, 'existing', 'deep', 'tokens.json')).isValid(token)).toBe(true);
  });
});
