import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createWSServer, type WSServer } from '../src/ws-server.js';
import { createTokenStore } from '../src/token-store.js';

let server: WSServer;
let directory: string;
const clients: WebSocket[] = [];
const request = (id: string) => ({ id, type: 'browser_read_secret' as const, payload: {} });
const reply = (id: string, value: string) => JSON.stringify({ id, success: true, result: { value } });

async function connect(connectionId: string): Promise<WebSocket> {
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?connectionId=${connectionId}&token=review-token`);
  clients.push(socket);
  await once(socket, 'open');
  return socket;
}

beforeEach(async () => {
  vi.stubEnv('BROWSER_WS_TOKEN', 'review-token');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  directory = mkdtempSync(join(tmpdir(), 'ajb-binding-'));
  server = createWSServer({ port: 0, host: '127.0.0.1', tokenStore: createTokenStore(join(directory, 'tokens.json')) });
  await once(server.server, 'listening');
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.terminate();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('secret response origin', () => {
  it('ignores another authenticated browser even when its response has the pending id', async () => {
    const intended = await connect('intended');
    const other = await connect('other');
    const observed = once(intended, 'message');
    const pending = server.sendTo('intended', request('secret-read'));
    let settled = false;
    void pending.then(() => { settled = true; });
    await observed;
    const processed = once(server.getConnection('other')!, 'message');
    other.send(reply('secret-read', 'SYNTHETIC-WRONG-ORIGIN'));
    await processed;
    await Promise.resolve();
    expect(settled).toBe(false);
    intended.send(reply('secret-read', 'SYNTHETIC-EXPECTED'));
    expect((await pending).result).toEqual({ value: 'SYNTHETIC-EXPECTED' });
    const unsolicited = once(server.getConnection('other')!, 'message');
    other.send(reply('SYNTHETIC-UNTRUSTED-ID', 'SYNTHETIC-UNSOLICITED'));
    await unsolicited;
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).not.toContain('SYNTHETIC-');
    expect(logged).not.toMatch(/(?:JSON|message received),? length/);
  });

  it('rejects replaced pending reads and ignores late frames from the old socket', async () => {
    const old = await connect('browser');
    const oldServerSocket = server.getConnection('browser')!;
    const observedOld = once(old, 'message');
    const oldOutcome = server.sendTo('browser', request('reused-id')).catch(error => error);
    await observedOld;
    const replacement = await connect('browser');
    expect(await oldOutcome).toMatchObject({ message: 'Extension connection replaced' });
    const observedNew = once(replacement, 'message');
    const pending = server.sendTo('browser', request('reused-id'));
    let settled = false;
    void pending.then(() => { settled = true; });
    await observedNew;
    // A frame already buffered before the close handshake must not resolve a new epoch.
    oldServerSocket.emit('message', Buffer.from(reply('reused-id', 'SYNTHETIC-STALE')));
    await Promise.resolve();
    expect(settled).toBe(false);
    replacement.send(reply('reused-id', 'SYNTHETIC-NEW-EPOCH'));
    expect((await pending).result).toEqual({ value: 'SYNTHETIC-NEW-EPOCH' });
  });

  it('rejects only requests of the disconnected socket and keeps other reads working', async () => {
    const a = await connect('a');
    const b = await connect('b');
    const aObserved = once(a, 'message');
    const bObserved = once(b, 'message');
    const aOutcome = server.sendTo('a', request('a-id')).catch(error => error);
    const bPending = server.sendTo('b', request('b-id'));
    await Promise.all([aObserved, bObserved]);
    a.close();
    expect(await aOutcome).toMatchObject({ message: 'Extension disconnected' });
    b.send(reply('b-id', 'SYNTHETIC-B'));
    expect((await bPending).result).toEqual({ value: 'SYNTHETIC-B' });
  });
});
