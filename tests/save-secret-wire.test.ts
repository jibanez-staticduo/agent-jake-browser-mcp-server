/**
 * browser_save_secret over the real WebSocket path: the context of the server (createContext ->
 * createWSServer) talks to a `ws` client that plays the extension, and 1Password is a fake Connect.
 * Same promise as save-secret.test.ts, now with the server's own logging in the loop.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, type ContextManager } from '../src/context.js';
import { createTokenStore } from '../src/token-store.js';
import { getAllTools } from '../src/tools/index.js';
import type { ExtensionMessage, ExtensionResponse } from '../src/types.js';
import { startFakeConnect, DECOY_BODY, EXISTING_SECRET, type FakeConnect } from './helpers/fake-connect.js';

const CANARY = 'CANARY-SEED-7F3A9C21';
const DECOY_EXT = 'DECOY-EXTENSION-MESSAGE';
const tool = getAllTools().find((x) => x.schema.name === 'browser_save_secret')!;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const destination = { vault: 'llavero', item: 'Existente', field: 'vacio' };
const ENV = ['OP_CONNECT_HOST', 'OP_CONNECT_WRITE_TOKEN', 'AGENT_BROWSER_SAVE_VAULTS'];

let tmp: string;
let fake: FakeConnect;
let context: ContextManager;
let extension: WebSocket;
let received: ExtensionMessage[];
let answer: (message: ExtensionMessage) => Partial<ExtensionResponse>;
let output: string[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ajb-save-'));
  fake = await startFakeConnect();
  process.env.OP_CONNECT_HOST = fake.url;
  process.env.OP_CONNECT_WRITE_TOKEN = 'write-token';
  process.env.AGENT_BROWSER_SAVE_VAULTS = 'jl5w33zmwcgl4ypvle7chbxu5i,wfovwhcnq22jzbhaaupp24fb2y';
  output = [];
  const capture = (...args: unknown[]) => { output.push(args.map(String).join(' ')); return true; };
  for (const m of ['error', 'warn', 'log', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);

  context = createContext({ port: 0, host: '127.0.0.1', tokenStore: createTokenStore(join(tmp, 'tokens.json')) });
  const wss = context.wsServer.server;
  if (!wss.address()) await new Promise((resolve) => wss.once('listening', resolve));
  received = [];
  answer = () => ({ success: true, result: { value: CANARY } });
  extension = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/?connectionId=ext`);
  extension.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ExtensionMessage;
    received.push(message);
    extension.send(JSON.stringify({ id: message.id, ...answer(message) }));
  });
  await vi.waitFor(() => expect(context.isConnected()).toBe(true));
});

afterEach(async () => {
  extension.terminate();
  await context.close();
  await fake.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV) delete process.env[k];
  vi.restoreAllMocks();
});

const save = (params: Record<string, unknown> = {}) => tool.handle(context.forConnection(undefined), { selector: '#semilla', destination, ...params });
const writes = () => fake.requests.filter((r) => r.method !== 'GET');

describe('browser_save_secret through the WebSocket server', () => {
  it('asks the extension only for the value, and the value reaches 1Password and nothing else', async () => {
    const r = await save();
    expect(text(r)).toBe(JSON.stringify({ saved: true, destination, length: CANARY.length }));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('browser_read_secret');
    expect(received[0].payload).toEqual({ selector: '#semilla' }); // the destination and the template never reach the browser
    expect(writes().map((r) => r.method)).toEqual(['PUT']);
    expect(JSON.parse(writes()[0].body).fields.find((f: { label: string }) => f.label === 'vacio').value).toBe(CANARY);
    const logged = output.join('\n');
    expect(logged).toContain('[save_secret] vault=llavero item=Existente field=vacio');
    for (const secret of [CANARY, EXISTING_SECRET, DECOY_BODY]) expect(logged).not.toContain(secret);
  });

  it.each([
    ['SECRET_NO_MATCH', 'No element matches the selector'],
    ['SECRET_AMBIGUOUS', '3 elements match the selector'],
    ['SECRET_EMPTY', 'The element has no text'],
    ['SECRET_REGEX_INVALID', 'The regex is not valid or has no capture group'],
    ['SECRET_REGEX_NO_MATCH', 'The regex did not match'],
    ['SECRET_TOO_LARGE', 'The text is too large'],
  ])('%s from the extension comes back as its fixed text, with nothing written or logged', async (code, message) => {
    answer = () => ({ success: false, error: { code, message } });
    expect(text(await save())).toBe(`Error: ${code}: ${message}`);
    expect(writes()).toEqual([]);
    expect(output.join('\n')).not.toContain(CANARY);
  });

  it('an extension that answers with a message of its own is not echoed', async () => {
    answer = () => ({ success: false, error: { code: 'SECRET_EMPTY', message: `${DECOY_EXT} ${CANARY}` } });
    const out = text(await save());
    expect(out).toBe('Error: SECRET_EMPTY: The element has no text');
    expect(out + output.join('\n')).not.toContain(DECOY_EXT);
  });

  it('an extension without the message answers UNKNOWN_TOOL: too old, one message, nothing else', async () => {
    answer = (message) => ({ success: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${message.type}` } });
    expect(text(await save())).toMatch(/^Error: SAVE_SECRET_EXTENSION_TOO_OLD: The browser extension does not know browser_save_secret yet/);
    expect(received.map((m) => m.type)).toEqual(['browser_read_secret']);
    expect(writes()).toEqual([]);
  });

  it('a vault outside the allowlist, or a missing token, never reaches the extension', async () => {
    expect(text(await save({ destination: { ...destination, vault: 'otro' } }))).toMatch(/^Error: SAVE_SECRET_INVALID_DESTINATION: /);
    delete process.env.OP_CONNECT_WRITE_TOKEN;
    expect(text(await save())).toMatch(/^Error: SAVE_SECRET_NOT_CONFIGURED: /);
    expect(received).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('a value shown by the page and a Connect that refuses: the error is fixed and the value is nowhere', async () => {
    fake.respond = (r) => (r.method === 'PUT' ? 401 : undefined);
    expect(text(await save())).toMatch(/^Error: SAVE_SECRET_DENIED: /);
    expect(output.join('\n')).not.toContain(CANARY);
    expect(output.join('\n')).not.toContain(EXISTING_SECRET);
  });
});
