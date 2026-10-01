import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe('compiled product entrypoints', () => {
  it('keeps loopback binding when the HTTP host environment value is empty and closes cleanly', async () => {
    const previous = process.env.MCP_HTTP_HOST;
    process.env.MCP_HTTP_HOST = '';
    const { createHttpServer } = await import('@agent-jake-browser/core');
    const server = createHttpServer({ port: 0, wsPort: 0 });
    try {
      const listener = await server.listen();
      const address = listener.address();
      expect(address && typeof address !== 'string' ? address.address : null).toBe('127.0.0.1');
      if (address && typeof address !== 'string') {
        expect(await (await fetch(`http://127.0.0.1:${address.port}/healthz`)).text()).toBe('ok');
      }
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.MCP_HTTP_HOST;
      else process.env.MCP_HTTP_HOST = previous;
    }
  });

  it('imports the core and house packages without opening listeners or timers', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createServer, createHttpServer } from '@agent-jake-browser/core';
      import { house as staticduo } from '@agent-jake-browser/house-staticduo';
      import { house as pocharlies } from '@agent-jake-browser/house-pocharlies';
      if (typeof createServer !== 'function' || typeof createHttpServer !== 'function') process.exit(2);
      if (staticduo.id !== 'staticduo' || pocharlies.id !== 'pocharlies') process.exit(3);
      console.log('imported');
    `], { cwd: root, timeout: 5000, encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('imported');
  });

  it('runs stdio initialize and tools/list with the existing CLI arguments', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/index.js', '--port', String(port)], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER_WS_HOST: '127.0.0.1' },
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'm1a-test', version: '1' },
      } }) + '\n');
      const deadline = Date.now() + 10000;
      while (!output.includes('"id":1') && Date.now() < deadline && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      while (!output.includes('"id":2') && Date.now() < deadline && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const replies = output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(replies.find((r) => r.id === 1)?.result.serverInfo.name, stderr).toBe('agent-jake-browser-mcp');
      expect(replies.find((r) => r.id === 2)?.result.tools.map((t: { name: string }) => t.name), stderr)
        .toContain('browser_list_connections');
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }, 15000);
});
