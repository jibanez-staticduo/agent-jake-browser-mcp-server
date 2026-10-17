import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function install({ native = 'x86_64', target = '', version = '2.39.0', tamper = false, cliVersion = '2.39.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'install-op-test-'));
  temporary.push(root);
  const bin = join(root, 'bin');
  const output = join(root, 'installed');
  const log = join(root, 'commands');
  mkdirSync(bin);
  const command = (name: string, source: string) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${source}\n`, { mode: 0o755 });
  command('uname', 'printf "%s\\n" "$MOCK_NATIVE"');
  command('curl', 'printf "curl %s\\n" "$*" >> "$MOCK_LOG"\nwhile [ "$1" != "--output" ]; do shift; done\nshift\nprintf zip > "$1"');
  // Check the selected pinned digest as well as verification preceding extraction.
  command('sha256sum', `read -r digest archive
printf 'checksum %s\\n' "$digest" >> "$MOCK_LOG"
case "$MOCK_NATIVE" in
  x86_64|amd64) expected=6fba7f376b6c6dec49f41b06408930a43ad064cce103c6a2ce5b3d0413a86434 ;;
  *) expected=829baeff1c07e055cfa132031b1d9f2282ccdf5076258e482caf2fda70aea5d0 ;;
esac
[ "$digest" = "$expected" ]
[ "$MOCK_TAMPER" = false ]`);
  command('unzip', `printf 'unzip\\n' >> "$MOCK_LOG"
[ "$1" = -q ] && [ "$3" = op ] && [ "$4" = -d ]
printf '#!/bin/sh\\nprintf "%%s\\\\n" "%s"\\n' "$MOCK_CLI_VERSION" > "$5/op"`);
  const result = spawnSync('/bin/sh', [resolve('scripts/install-op.sh'), version, target, output], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root,
      MOCK_NATIVE: native, MOCK_LOG: log, MOCK_TAMPER: String(tamper), MOCK_CLI_VERSION: cliVersion },
  });
  return { ...result, commands: existsSync(log) ? readFileSync(log, 'utf8') : '', installed: existsSync(join(output, 'op')) };
}

describe('verified op installation', () => {
  it.each(['x86_64', 'amd64', 'aarch64', 'arm64'])('derives native architecture %s without a build argument', native => {
    const result = install({ native });
    expect(result.status, result.stderr).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.commands).toContain(native === 'x86_64' || native === 'amd64' ? 'op_linux_amd64' : 'op_linux_arm64');
    expect(result.commands.indexOf('checksum')).toBeLessThan(result.commands.indexOf('unzip'));
  });
  it.each([['x86_64', 'amd64'], ['amd64', 'x86_64'], ['aarch64', 'arm64'], ['arm64', 'aarch64']])('accepts matching %s / %s', (native, target) => {
    expect(install({ native, target }).status).toBe(0);
  });
  it.each([['x86_64', 'arm64'], ['aarch64', 'amd64'], ['x86_64', 'ppc64le'], ['riscv64', '']])('rejects %s / %s before download', (native, target) => {
    const result = install({ native, target });
    expect(result.status).not.toBe(0);
    expect(result.commands).toBe('');
    expect(result.installed).toBe(false);
  });
  it('rejects an unknown version before download', () => {
    const result = install({ version: '2.40.0' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No verified op checksum');
    expect(result.commands).toBe('');
  });
  it('rejects a modified archive before extraction or installation', () => {
    const result = install({ tamper: true });
    expect(result.status).not.toBe(0);
    expect(result.commands).toContain('checksum');
    expect(result.commands).not.toContain('unzip');
    expect(result.installed).toBe(false);
  });
  it('rejects a CLI that cannot report the pinned version', () => {
    const result = install({ cliVersion: 'unexpected' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unexpected op CLI version');
    expect(result.installed).toBe(false);
  });
});
