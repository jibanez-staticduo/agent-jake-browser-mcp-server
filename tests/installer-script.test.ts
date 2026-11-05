import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installerScript } from '../src/installer.js';

describe('signed installer embedded verifier', () => {
  it('executes Python verification against the published signed bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'ajb-installer-test-'));
    const bin = join(root, 'bin');
    const bundle = join(root, 'bundle');
    const home = join(root, 'home');
    mkdirSync(bin); mkdirSync(home);
    cpSync('/home/staticduo/tmp/agent-jake-upgrade-20261105/release-extension-f2dfc06', bundle, { recursive: true });
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nset -eu\nu=""; for x in "$@"; do case "$x" in https://*) u="$x";; esac; done\nout=""; prev=""; for x in "$@"; do [ "$prev" = "-o" ] && out="$x"; prev="$x"; done\ncase "$u" in *latest.json) f=latest.json;; *artifact.zip) f=agent-jake-browser-extension.zip;; *) exit 1;; esac\ncp "$QA_BUNDLE/$f" "$out"\n', { mode: 0o700 });
    const script = installerScript('https://qa.invalid', 'wss://qa.invalid/ws');
    expect(script).toBeTruthy();
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QA_BUNDLE: bundle } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'Downloads/agent-jake-browser/manifest.json'), 'utf8')).version).toBe('2.7.0.215');
  });
});
