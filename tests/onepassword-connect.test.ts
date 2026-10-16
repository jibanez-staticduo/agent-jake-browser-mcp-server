/**
 * src/onepassword-connect.ts (SC-2102 H2): the Connect REST writer behind browser_save_secret,
 * against a fake Connect that records every request.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planSave, SaveError, type Destination } from '../src/onepassword-connect.js';
import { startFakeConnect, DECOY_BODY, EXISTING_SECRET, type FakeConnect } from './helpers/fake-connect.js';

const CANARY = 'CANARY-SEED-7F3A9C21';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ENV = ['OP_CONNECT_HOST', 'OP_CONNECT_TOKEN', 'OP_CONNECT_WRITE_TOKEN', 'AGENT_BROWSER_SAVE_VAULTS'];

let fake: FakeConnect;
beforeEach(async () => {
  fake = await startFakeConnect();
  process.env.OP_CONNECT_HOST = fake.url;
  process.env.OP_CONNECT_TOKEN = 'READ-TOKEN-NOT-FOR-WRITES';
  process.env.OP_CONNECT_WRITE_TOKEN = 'write-token\n'; // the trailing newline of a secret seeded with echo
  process.env.AGENT_BROWSER_SAVE_VAULTS = 'jl5w33zmwcgl4ypvle7chbxu5i,wfovwhcnq22jzbhaaupp24fb2y';
});
afterEach(async () => {
  await fake.close();
  for (const k of ENV) delete process.env[k];
  vi.restoreAllMocks();
});

const dest = (over: Partial<Destination> = {}): Destination => ({ vault: 'llavero', item: 'Nuevo', field: 'seed', ...over });
const concealed = { type: 'CONCEALED' as const, overwrite: false };
const writes = () => fake.requests.filter((r) => r.method !== 'GET');
const codeOf = (p: Promise<unknown>) => p.then(() => 'no error', (e: SaveError) => e.code);
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('did not fail'); }, (e: SaveError) => e);

describe('planSave: create and update', () => {
  it('fails closed on a repeated absent title after an uncertain failed create', async () => {
    fake.respond = (r) => r.method === 'POST' ? 500 : undefined;
    await (await planSave(dest(), concealed)).write(CANARY).catch(() => {});
    fake.respond = undefined;
    expect(await codeOf((await planSave(dest(), concealed)).write(CANARY))).toBe('SAVE_SECRET_CONFLICT');
    expect(writes()).toHaveLength(1);
  });
  it('serializes parallel writes and preserves both fields with advancing Connect versions', async () => {
    const one = await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed);
    const two = await planSave(dest({ item: 'Existente', field: 'new-field' }), concealed);
    await Promise.all([one.write(CANARY), two.write('SECOND-CANARY')]);
    expect(fake.items[0].fields.find((f) => f.label === 'vacio')?.value).toBe(CANARY);
    expect(fake.items[0].fields.find((f) => f.label === 'new-field')?.value).toBe('SECOND-CANARY');
    expect(writes().map((r) => JSON.parse(r.body).version)).toEqual([1, 2]);
  });

  it('refuses a cached item version already used by this process instead of losing its earlier write', async () => {
    const stale = structuredClone(fake.items[0]);
    await (await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed)).write(CANARY);
    fake.items[0] = stale;
    const plan = await planSave(dest({ item: 'Existente', field: 'other' }), concealed);
    expect(await codeOf(plan.write('SECOND-CANARY'))).toBe('SAVE_SECRET_CONFLICT');
    expect(writes()).toHaveLength(1);
  });

  it('does not create duplicate items when two plans resolved the same absent title', async () => {
    const one = await planSave(dest(), concealed);
    const two = await planSave(dest(), concealed);
    const results = await Promise.all([codeOf(one.write(CANARY)), codeOf(two.write(CANARY))]);
    expect(results.sort()).toEqual(['SAVE_SECRET_CONFLICT', 'no error']);
    expect(writes()).toHaveLength(1);
  });

  it('preserves the submitted version and sanitizes a provider conflict without retry', async () => {
    fake.respond = (r) => {
      if (r.method === 'PUT') fake.items[0].version++;
      return undefined;
    };
    const error = await failure((await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed)).write(CANARY));
    expect(error.code).toBe('SAVE_SECRET_CONFLICT');
    expect(error.message).not.toContain(DECOY_BODY);
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0].body).version).toBe(1);
    expect(fake.items[0].fields[1].value).toBeUndefined();
  });
  it('creates the item with a POST when no item has that title', async () => {
    await (await planSave(dest(), concealed)).write(CANARY);
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([`POST /v1/vaults/${fake.vaults[0].id}/items`]);
    expect(JSON.parse(writes()[0].body)).toEqual({
      vault: { id: fake.vaults[0].id }, title: 'Nuevo', category: 'SECURE_NOTE',
      fields: [{ label: 'seed', type: 'CONCEALED', value: CANARY }],
    });
  });

  it('updates with a fresh GET right before a PUT whose body keeps every other field', async () => {
    const plan = await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed);
    fake.requests.length = 0;
    await plan.write(CANARY);
    const id = fake.items[0].id;
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /v1/vaults/${fake.vaults[0].id}/items/${id}`,
      `PUT /v1/vaults/${fake.vaults[0].id}/items/${id}`,
    ]);
    const put = JSON.parse(fake.requests[1].body);
    expect(put.id).toBe(id);
    expect(put.vault.id).toBe(fake.vaults[0].id);
    expect(put.fields).toEqual([
      { id: 'f1', label: 'password', type: 'CONCEALED', value: EXISTING_SECRET },
      { id: 'f2', label: 'vacio', type: 'CONCEALED', value: CANARY },
      { id: 'f3', label: 'usuario', type: 'STRING', value: 'jake' },
    ]);
  });

  it('adds the field when the item does not have it', async () => {
    await (await planSave(dest({ item: 'Existente', field: 'semilla' }), { type: 'OTP', overwrite: false })).write(CANARY);
    expect(JSON.parse(writes()[0].body).fields.at(-1)).toEqual({ label: 'semilla', type: 'OTP', value: CANARY });
    expect(JSON.parse(writes()[0].body).fields).toHaveLength(4);
  });

  it('finds the item by id and the field by id', async () => {
    await (await planSave(dest({ item: fake.items[0].id, field: 'f2' }), concealed)).write(CANARY);
    expect(fake.requests.some((r) => r.path.includes('filter='))).toBe(false);
    expect(fake.items[0].fields[1]).toMatchObject({ id: 'f2', value: CANARY });
  });

  it('sends the exact value (checked by sha256, never printed)', async () => {
    await (await planSave(dest(), concealed)).write(CANARY);
    expect(sha(JSON.parse(writes()[0].body).fields[0].value)).toBe(sha(CANARY));
  });
});

describe('planSave: a field that already has a value', () => {
  it('is FIELD_EXISTS without overwrite, before anything is written', async () => {
    expect(await codeOf(planSave(dest({ item: 'Existente', field: 'password' }), concealed))).toBe('SAVE_SECRET_FIELD_EXISTS');
    expect(writes()).toEqual([]);
  });

  it('is replaced with overwrite, and only that field changes', async () => {
    await (await planSave(dest({ item: 'Existente', field: 'password' }), { type: 'CONCEALED', overwrite: true })).write(CANARY);
    expect(fake.items[0].fields.map((f) => f.value)).toEqual([CANARY, undefined, 'jake']);
  });

  it('is checked again on the fresh GET: it may have been filled while the page was read', async () => {
    const plan = await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed);
    fake.items[0].fields[1].value = 'FILLED-IN-THE-MEANTIME';
    expect(await codeOf(plan.write(CANARY))).toBe('SAVE_SECRET_FIELD_EXISTS');
    expect(writes()).toEqual([]);
  });
});

describe('planSave: destination and configuration', () => {
  it.each(['file:///tmp/connect', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?x=1', 'https://example.test/#frag'])('rejects unsafe base URL %s before requests', async (url) => {
    process.env.OP_CONNECT_HOST = url;
    expect(await codeOf(planSave(dest(), concealed))).toBe('SAVE_SECRET_NOT_CONFIGURED');
    expect(fake.requests).toEqual([]);
  });

  it('refuses ambiguous destination field labels', async () => {
    fake.items[0].fields.push({ id: 'other', label: 'vacio', type: 'CONCEALED' });
    expect(await codeOf(planSave(dest({ item: 'Existente', field: 'vacio' }), concealed))).toBe('SAVE_SECRET_FIELD_AMBIGUOUS');
    expect(writes()).toEqual([]);
  });

  it('refuses malformed returned IDs before they form an item URL', async () => {
    fake.items[0].id = '../bad';
    expect(await codeOf(planSave(dest({ item: 'Existente' }), concealed))).toBe('SAVE_SECRET_UNAVAILABLE');
    expect(fake.requests.some((r) => r.path.includes('../bad'))).toBe(false);
  });

  it('rejects absent item versions rather than doing an unversioned replacement', async () => {
    delete (fake.items[0] as Partial<typeof fake.items[0]>).version;
    expect(await codeOf(planSave(dest({ item: 'Existente' }), concealed))).toBe('SAVE_SECRET_UNAVAILABLE');
    expect(writes()).toEqual([]);
  });
  it('two items with the same title are ambiguous', async () => {
    expect(await codeOf(planSave(dest({ item: 'Duplicado' }), concealed))).toBe('SAVE_SECRET_ITEM_AMBIGUOUS');
  });

  it('a vault that does not exist is VAULT_NOT_FOUND', async () => {
    process.env.AGENT_BROWSER_SAVE_VAULTS = 'fantasma';
    expect(await codeOf(planSave(dest({ vault: 'fantasma' }), concealed))).toBe('SAVE_SECRET_INVALID_DESTINATION');
  });

  it('a vault outside AGENT_BROWSER_SAVE_VAULTS is refused by id, and an allowed id works', async () => {
    expect(await codeOf(planSave(dest({ vault: 'otro' }), concealed))).toBe('SAVE_SECRET_INVALID_DESTINATION');
    expect(await codeOf(planSave(dest({ vault: fake.vaults[2].id }), concealed))).toBe('SAVE_SECRET_INVALID_DESTINATION');
    process.env.AGENT_BROWSER_SAVE_VAULTS = ` ${fake.vaults[2].id} , ${fake.vaults[0].id}`;
    await planSave(dest({ vault: 'llavero' }), concealed);
    await planSave(dest({ vault: 'otro' }), concealed);
    expect(writes()).toEqual([]);
  });

  it('an allowlist of names alone is no allowlist: the id decides (C2)', async () => {
    process.env.AGENT_BROWSER_SAVE_VAULTS = 'llavero,k8s-pocharlies';
    expect(await codeOf(planSave(dest(), concealed))).toBe('SAVE_SECRET_INVALID_DESTINATION');
    expect(writes()).toEqual([]);
  });

  it.each(['OP_CONNECT_HOST', 'OP_CONNECT_WRITE_TOKEN', 'AGENT_BROWSER_SAVE_VAULTS'])('without %s nothing is asked of Connect', async (name) => {
    delete process.env[name];
    expect(await codeOf(planSave(dest(), concealed))).toBe('SAVE_SECRET_NOT_CONFIGURED');
    process.env[name] = '  ';
    expect(await codeOf(planSave(dest(), concealed))).toBe('SAVE_SECRET_NOT_CONFIGURED');
    expect(fake.requests).toEqual([]);
  });

  it.each(['"', 'a"b', 'a\\b', 'a\nb', 'a\u0000b', ''])('refuses %j in vault, item or field without calling Connect', async (bad) => {
    for (const key of ['vault', 'item', 'field'] as const) {
      expect(await codeOf(planSave(dest({ [key]: bad }), concealed))).toBe('SAVE_SECRET_INVALID_DESTINATION');
    }
    expect(fake.requests).toEqual([]);
  });
});

describe('planSave: what goes over the wire', () => {
  it('uses the trimmed write token and JSON headers on every request, never the read token', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await (await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed)).write(CANARY);
    expect(fake.requests.length).toBeGreaterThanOrEqual(5);
    for (const r of fake.requests) {
      expect(r.headers.authorization).toBe('Bearer write-token');
      expect(r.headers['content-type']).toBe('application/json');
    }
    expect(JSON.stringify(fake.requests)).not.toContain('READ-TOKEN-NOT-FOR-WRITES');
    expect(timeout).toHaveBeenCalledWith(30000);
  });

  it('never sends anything but GET, POST and PUT, not even when everything fails', async () => {
    await (await planSave(dest(), concealed)).write(CANARY);
    await (await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed)).write(CANARY);
    fake.respond = () => 500;
    await planSave(dest(), concealed).catch(() => {});
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(new Set(fake.requests.map((r) => r.method)).has('DELETE')).toBe(false);
    expect([...new Set(fake.requests.map((r) => r.method))].sort()).toEqual(['GET', 'POST', 'PUT']);
  });
});

describe('planSave: Connect failures', () => {
  const statuses: Array<[number, string]> = [
    [401, 'SAVE_SECRET_DENIED'], [403, 'SAVE_SECRET_DENIED'],
    [400, 'SAVE_SECRET_REJECTED'], [404, 'SAVE_SECRET_REJECTED'], [406, 'SAVE_SECRET_REJECTED'],
    [500, 'SAVE_SECRET_UNAVAILABLE'], [503, 'SAVE_SECRET_UNAVAILABLE'],
  ];

  it.each(statuses)('a %i on the write maps to %s, with no echo of the body and a single attempt', async (status, code) => {
    fake.respond = (r) => (r.method === 'PUT' ? status : undefined);
    const plan = await planSave(dest({ item: 'Existente', field: 'vacio' }), concealed);
    const error = await failure(plan.write(CANARY));
    expect(error.code).toBe(code);
    if (code === 'SAVE_SECRET_REJECTED') expect(error.message).toContain(String(status));
    expect(JSON.stringify({ code: error.code, message: error.message })).not.toContain(DECOY_BODY);
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it.each(statuses)('a %i on the create maps to %s and does not retry', async (status, code) => {
    fake.respond = (r) => (r.method === 'POST' ? status : undefined);
    const error = await failure((await planSave(dest(), concealed)).write(CANARY));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(DECOY_BODY);
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it.each(statuses)('a %i while resolving the vault maps to %s', async (status, code) => {
    fake.respond = () => status;
    const error = await failure(planSave(dest(), concealed));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(DECOY_BODY);
    expect(fake.requests).toHaveLength(1);
  });

  it('a request that times out is UNAVAILABLE after one attempt', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(100));
    fake.respond = (r) => (r.method === 'POST' ? 'hang' : undefined);
    const error = await failure((await planSave(dest(), concealed)).write(CANARY));
    expect(error.code).toBe('SAVE_SECRET_UNAVAILABLE');
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('a Connect that is not there is UNAVAILABLE and the message of fetch does not come back', async () => {
    await fake.close();
    const error = await failure(planSave(dest(), concealed));
    expect(error.code).toBe('SAVE_SECRET_UNAVAILABLE');
    expect(error.message).not.toMatch(/ECONNREFUSED|fetch failed|127\.0\.0\.1/);
    fake = await startFakeConnect(); // afterEach closes it
  });

  it('a redirect is not followed', async () => {
    fake.respond = () => 301;
    expect(await codeOf(planSave(dest(), concealed))).toBe('SAVE_SECRET_UNAVAILABLE');
    expect(fake.requests).toHaveLength(1);
  });
});

describe('tests/helpers/fake-connect.ts run alone (what qa uses)', () => {
  it('prints its port first and serves the vaults', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/fake-connect.ts', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('fake-connect exited')));
        child.stdout.once('data', (chunk) => resolve(Number(String(chunk).split('\n')[0])));
      });
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/v1/vaults`, { headers: { Authorization: 'Bearer x' } });
      expect((await res.json()).map((v: { name: string }) => v.name)).toEqual(['llavero', 'k8s-pocharlies', 'otro']);
    } finally {
      child.kill();
    }
  }, 30000);
});
