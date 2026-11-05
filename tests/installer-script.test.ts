import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { installerScript } from '../src/installer.js';

describe('signed installer embedded verifier', () => {
  it('executes Python verification against an ephemeral signed bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'ajb-installer-test-'));
    const bin = join(root, 'bin'); const bundle = join(root, 'bundle'); const home = join(root, 'home');
    mkdirSync(bin); mkdirSync(bundle); mkdirSync(home);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const files = { version: '0.0.1', build: 1, sha: 'test', files: [] as Array<{ path: string; sha256: string; size: number }> };
    const zip = new AdmZip();
    const manifest = Buffer.from(JSON.stringify({ manifest_version: 3, name: 'test', version: files.version }));
    zip.addFile('manifest.json', manifest);
    files.files.push({ path: 'manifest.json', sha256: createHash('sha256').update(manifest).digest('hex'), size: manifest.length });
    const listing = Buffer.from(JSON.stringify(files));
    zip.addFile('update-files.json', listing);
    zip.addFile('update-files.json.sig', Buffer.from(sign(null, listing, privateKey).toString('base64')));
    writeFileSync(join(bundle, 'agent-jake-browser-extension.zip'), zip.toBuffer());
    writeFileSync(join(bundle, 'latest.json'), JSON.stringify({ version: files.version, build: files.build, sha: files.sha, publishedAt: 'now' }));
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nset -eu\nu=""; for x in "$@"; do case "$x" in https://*) u="$x";; esac; done\nout=""; prev=""; for x in "$@"; do [ "$prev" = "-o" ] && out="$x"; prev="$x"; done\ncase "$u" in *latest.json) f=latest.json;; *artifact.zip) f=agent-jake-browser-extension.zip;; *) exit 1;; esac\ncp "$QA_BUNDLE/$f" "$out"\n', { mode: 0o700 });
    const script = installerScript('https://qa.invalid', 'wss://qa.invalid/ws', { publicKeyDerB64: publicDer });
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QA_BUNDLE: bundle } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'Downloads/agent-jake-browser/manifest.json'), 'utf8')).version).toBe(files.version);
  });
});
