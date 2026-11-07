import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { installerScript } from '../src/installer.js';

describe('signed installer embedded verifier', () => {
  function makeBundle(root: string) {
    const bundle = join(root, 'bundle');
    mkdirSync(bundle);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const files = { version: '0.0.1', build: 1, sha: 'test', files: [] as Array<{ path: string; sha256: string; size: number }> };
    const zip = new AdmZip();
    const manifest = Buffer.from(JSON.stringify({ manifest_version: 3, name: 'test', version: files.version }));
    zip.addFile('manifest.json', manifest);
    const stale = Buffer.from(JSON.stringify({ version: 1, wsUrl: 'wss://stale.invalid/ws' }));
    zip.addFile('config.json', stale);
    files.files.push({ path: 'manifest.json', sha256: createHash('sha256').update(manifest).digest('hex'), size: manifest.length });
    files.files.push({ path: 'config.json', sha256: createHash('sha256').update(stale).digest('hex'), size: stale.length });
    const listing = Buffer.from(JSON.stringify(files));
    zip.addFile('update-files.json', listing);
    zip.addFile('update-files.json.sig', Buffer.from(sign(null, listing, privateKey).toString('base64')));
    writeFileSync(join(bundle, 'agent-jake-browser-extension.zip'), zip.toBuffer());
    writeFileSync(join(bundle, 'latest.json'), JSON.stringify({ version: files.version, build: files.build, sha: files.sha, publishedAt: 'now' }));
    return { bundle, publicDer, version: files.version };
  }

  function mockCurl(bin: string) {
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nset -eu\nu=""; for x in "$@"; do case "$x" in https://*) u="$x";; esac; done\nout=""; prev=""; for x in "$@"; do [ "$prev" = "-o" ] && out="$x"; prev="$x"; done\ncase "$u" in *latest.json) f=latest.json;; *artifact.zip) f=agent-jake-browser-extension.zip;; *) exit 1;; esac\ncp "$QA_BUNDLE/$f" "$out"\n', { mode: 0o700 });
  }

  it('executes Python verification against an ephemeral signed bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'ajb-installer-test-'));
    const bin = join(root, 'bin'); const home = join(root, 'home');
    mkdirSync(bin); mkdirSync(home);
    const { bundle, publicDer, version } = makeBundle(root); mockCurl(bin);
    const script = installerScript('https://qa.invalid', 'wss://qa.invalid/ws', { publicKeyDerB64: publicDer });
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QA_BUNDLE: bundle } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'Downloads/agent-jake-browser/manifest.json'), 'utf8')).version).toBe(version);
    expect(readFileSync(join(home, 'Downloads/agent-jake-browser/config.json',), 'utf8')).toBe('{"version":1,"wsUrl":"wss://qa.invalid/ws"}');
  });

  it.each(['nas', 'fedora', 'ari'])('installs isolated %s folder and preserves its config', (instance) => {
    const root = mkdtempSync(join(tmpdir(), `ajb-${instance}-`));
    const bin = join(root, 'bin'); const home = join(root, 'home'); mkdirSync(bin); mkdirSync(home);
    const { bundle, publicDer } = makeBundle(root); mockCurl(bin);
    const dest = join(home, 'Downloads/agent-jake-browser', instance); mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'existing' }));
    writeFileSync(join(dest, 'config.json'), JSON.stringify({ version: 1, wsUrl: `wss://${instance}.local/ws`, installInstance: instance, custom: true }));
    const result = spawnSync('bash', ['-s'], { input: installerScript('https://qa.invalid', 'wss://qa.invalid/ws', { publicKeyDerB64: publicDer, installInstance: instance }), encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QA_BUNDLE: bundle } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf8'))).toMatchObject({ wsUrl: `wss://${instance}.local/ws`, installInstance: instance, custom: true });
    expect(existsSync(join(home, 'Downloads/agent-jake-browser', instance, 'config.json'))).toBe(true);
  });

  it('upgrades missing identity, rejects wrong identity, and protects legacy parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ajb-identity-')); const bin = join(root, 'bin'); const home = join(root, 'home'); mkdirSync(bin); mkdirSync(home);
    const { bundle, publicDer } = makeBundle(root); mockCurl(bin);
    const base = join(home, 'Downloads/agent-jake-browser'); const fedora = join(base, 'fedora'); mkdirSync(fedora, { recursive: true });
    writeFileSync(join(fedora, 'config.json'), JSON.stringify({ version: 1, wsUrl: 'wss://old/ws', custom: 'kept' }));
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QA_BUNDLE: bundle };
    writeFileSync(join(fedora, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'existing' }));
    const upgrade = spawnSync('bash', ['-s'], { input: installerScript('https://qa.invalid', 'wss://qa.invalid/ws', { publicKeyDerB64: publicDer, installInstance: 'fedora' }), encoding: 'utf8', env });
    expect(upgrade.status, upgrade.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fedora, 'config.json'), 'utf8'))).toMatchObject({ installInstance: 'fedora', custom: 'kept' });
    writeFileSync(join(fedora, 'config.json'), JSON.stringify({ version: 1, wsUrl: 'wss://bad/ws', installInstance: 'ari' }));
    const wrong = spawnSync('bash', ['-s'], { input: installerScript('https://qa.invalid', 'wss://qa.invalid/ws', { publicKeyDerB64: publicDer, installInstance: 'fedora' }), encoding: 'utf8', env });
    expect(wrong.status).not.toBe(0);
    writeFileSync(join(base, 'manifest.json'), '{}'); mkdirSync(join(base, 'nas')); mkdirSync(join(base, 'ari'));
    const legacy = spawnSync('bash', ['-s'], { input: installerScript('https://qa.invalid', 'wss://qa.invalid/ws', { publicKeyDerB64: publicDer }), encoding: 'utf8', env });
    expect(legacy.status).not.toBe(0); expect(readdirSync(home + '/Downloads').some((name) => name.startsWith('agent-jake-browser.backup.'))).toBe(false); expect(existsSync(join(base, 'nas'))).toBe(true);
  });
});
