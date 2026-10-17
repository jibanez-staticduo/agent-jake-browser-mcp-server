/**
 * What the extension CI published: latest.json (read by the installed extensions' update
 * check) and the zip /download serves.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionZipPath, readPublishedVersion, PUBLISHED_ZIP_NAME } from '../src/published-extension.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'ajb-pub-'));
const LATEST = { version: '2.4.0.119', build: 119, sha: '1e729af', publishedAt: '2026-10-03T10:00:00Z' };

describe('readPublishedVersion', () => {
  it('reads a published build', () => {
    const d = dir();
    writeFileSync(join(d, 'latest.json'), JSON.stringify({ ...LATEST, extra: 'ignored' }));
    expect(readPublishedVersion(d)).toEqual(LATEST);
  });

  it('reads nothing when nothing or garbage was published', () => {
    expect(readPublishedVersion(dir())).toBeNull();
    const d = dir();
    writeFileSync(join(d, 'latest.json'), '{not json');
    expect(readPublishedVersion(d)).toBeNull();
    writeFileSync(join(d, 'latest.json'), JSON.stringify({ ...LATEST, build: '119' }));
    expect(readPublishedVersion(d)).toBeNull();
  });
});

describe('extensionZipPath', () => {
  it('prefers an explicit BROWSER_EXTENSION_ZIP, then the published zip, then the image one', () => {
    const d = dir();
    expect(extensionZipPath({ BROWSER_EXTENSION_ZIP: '/x.zip' }, d)).toBe('/x.zip');
    expect(extensionZipPath({}, d)).toBe('/app/extension/agent-jake-browser-extension.zip');
    writeFileSync(join(d, PUBLISHED_ZIP_NAME), 'zip');
    expect(extensionZipPath({}, d)).toBe(join(d, PUBLISHED_ZIP_NAME));
  });
});
