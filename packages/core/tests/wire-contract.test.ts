/** Executable documentation of the M1A wire; keep alongside M1B negotiation tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createWSServer, type WSServer } from '../src/ws-server.js';
import { createTokenStore } from '../src/token-store.js';
import type { ExtensionMessage, ExtensionResponse } from '../src/types.js';

let server: WSServer;
let socket: WebSocket | undefined;
let tempDir: string;
let requests: unknown[];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'ajb-wire-'));
  requests = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('BROWSER_WS_TOKEN', 'wire-contract-local-token');
  vi.stubEnv('BROWSER_ALLOW_PAIRING', 'false');
  server = createWSServer({
    port: 0,
    host: '127.0.0.1',
    tokenStore: createTokenStore(join(tempDir, 'tokens.json')),
  });
  if (!server.server.address()) await once(server.server, 'listening');
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an IP socket');
  socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/?token=wire-contract-local-token&connectionId=wire-fixture`,
  );
  socket.on('message', (data) => requests.push(JSON.parse(data.toString())));
  await once(socket, 'open');
});

afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  try {
    await server?.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

describe('current M1A WebSocket wire contract', () => {
  it('sends only id/type/payload and correlates success/error replies by id', async () => {
    const successRequest: ExtensionMessage = {
      id: 'wire-success', type: 'browser_navigate', payload: { url: 'https://example.test/' },
    };
    const errorRequest: ExtensionMessage = {
      id: 'wire-error', type: 'browser_click', payload: { selector: '#missing' },
    };
    const successPending = server.send(successRequest);
    const errorPending = server.sendTo('wire-fixture', errorRequest);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toStrictEqual([successRequest, errorRequest]);
    for (const request of requests) {
      expect(Object.keys(request as object).sort()).toEqual(['id', 'payload', 'type']);
    }

    const successReply: ExtensionResponse = {
      id: 'wire-success', success: true, result: { url: 'https://example.test/', title: 'Example' },
    };
    const errorReply: ExtensionResponse = {
      id: 'wire-error', success: false,
      error: { code: 'ELEMENT_NOT_FOUND', message: 'No matching element' },
    };
    // Reply in reverse order: correlation is by id, not arrival order. Failed
    // extension operations resolve with their envelope rather than rejecting.
    socket!.send(JSON.stringify(errorReply));
    socket!.send(JSON.stringify(successReply));
    const [success, failure] = await Promise.all([successPending, errorPending]);
    expect(success).toStrictEqual(successReply);
    expect(Object.keys(success).sort()).toEqual(['id', 'result', 'success']);
    expect(failure).toStrictEqual(errorReply);
    expect(Object.keys(failure).sort()).toEqual(['error', 'id', 'success']);
    expect(Object.keys(failure.error!).sort()).toEqual(['code', 'message']);
  });

  it.each([true, false])('preserves absent optional result/error with success=%s', async (success) => {
    const request: ExtensionMessage = {
      id: 'wire-optional', type: 'browser_snapshot', payload: {},
    };
    const pending = server.send(request);
    await vi.waitFor(() => expect(requests).toStrictEqual([request]));
    const reply: ExtensionResponse = { id: request.id, success };
    socket!.send(JSON.stringify(reply));
    const received = await pending;
    expect(received).toStrictEqual(reply);
    expect(Object.keys(received).sort()).toEqual(['id', 'success']);
  });
});
