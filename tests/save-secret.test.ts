/**
 * browser_save_secret (SC-2102 H2): the value goes page -> extension -> server -> 1Password and
 * never into the result, the logs, a subprocess or a file. The page is read only after the
 * destination was resolved, and every error is a fixed text.
 */
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllTools } from '../src/tools/index.js';
import { fakeContext } from './helpers/fake-context.js';
import { startFakeConnect, DECOY_BODY, EXISTING_SECRET, type FakeConnect } from './helpers/fake-connect.js';

// browser_fill_secret reads with `op`; saving must never start a process.
vi.mock('node:child_process', () => {
  const boom = () => { throw new Error('a subprocess was started'); };
  return { exec: boom, execFile: boom, execFileSync: boom, execSync: boom, spawn: boom, spawnSync: boom, fork: boom };
});

const CANARY = 'CANARY-SEED-7F3A9C21';
const DECOY_EXT = 'DECOY-EXTENSION-MESSAGE';
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const tool = getAllTools().find((x) => x.schema.name === 'browser_save_secret')!;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const destination = { vault: 'llavero', item: 'Nuevo', field: 'seed' };
const ENV = ['OP_CONNECT_HOST', 'OP_CONNECT_WRITE_TOKEN', 'AGENT_BROWSER_SAVE_VAULTS'];

let fake: FakeConnect;
let output: string[];
beforeEach(async () => {
  fake = await startFakeConnect();
  process.env.OP_CONNECT_HOST = fake.url;
  process.env.OP_CONNECT_WRITE_TOKEN = 'write-token';
  // C2 (security): the allowlist is compared by vault id — the suite pins the ids H3 will deploy.
  process.env.AGENT_BROWSER_SAVE_VAULTS = 'jl5w33zmwcgl4ypvle7chbxu5i,wfovwhcnq22jzbhaaupp24fb2y';
  output = [];
  const capture = (...args: unknown[]) => { output.push(args.map(String).join(' ')); return true; };
  for (const m of ['error', 'warn', 'log', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
  for (const k of ENV) delete process.env[k];
});

const written = () => fake.requests.filter((r) => r.method !== 'GET');
const stored = () => JSON.parse(written()[0].body);

describe('browser_save_secret: result', () => {
  it('answers exactly {saved, destination, length}: no value, no base64, no hash prefix', async () => {
    const { context, sent } = fakeContext({ value: CANARY });
    const r = await tool.handle(context, { selector: '#semilla', destination });
    expect(isError(r)).toBe(false);
    expect(text(r)).toBe(JSON.stringify({ saved: true, destination, length: CANARY.length }));
    for (const leak of [CANARY, Buffer.from(CANARY).toString('base64'), createHash('sha256').update(CANARY).digest('hex').slice(0, 8)]) {
      expect(JSON.stringify(r)).not.toContain(leak);
    }
    expect(sent).toEqual([{ type: 'browser_read_secret', payload: { selector: '#semilla' } }]);
    expect(written().map((x) => x.method)).toEqual(['POST']);
    expect(stored().fields).toEqual([{ label: 'seed', type: 'CONCEALED', value: CANARY }]);
  });

  it('passes ref and regex through and ignores nothing else the page needs', async () => {
    const { context, sent } = fakeContext({ value: CANARY });
    await tool.handle(context, { ref: 'e5', regex: 'seed: (\\w+)', destination });
    expect(sent[0].payload).toEqual({ ref: 'e5', regex: 'seed: (\\w+)' });
  });

  it('needs ref, selector or regex, and a destination with the code', async () => {
    const { context, sent } = fakeContext({ value: CANARY });
    expect(isError(await tool.handle(context, { destination }))).toBe(true);
    for (const bad of [undefined, {}, { vault: 'llavero' }, { vault: 1, item: 'a', field: 'b' }]) {
      const r = await tool.handle(context, { selector: '#s', destination: bad });
      expect(text(r)).toMatch(/^Error: SAVE_SECRET_INVALID_DESTINATION: /);
    }
    expect(sent).toEqual([]);
  });
});

describe('browser_save_secret: nothing is read from the page unless it can be written', () => {
  const cases: Array<[string, () => void, Record<string, unknown>, string]> = [
    ['no write token', () => { delete process.env.OP_CONNECT_WRITE_TOKEN; }, {}, 'SAVE_SECRET_NOT_CONFIGURED'],
    ['empty allowlist', () => { process.env.AGENT_BROWSER_SAVE_VAULTS = ''; }, {}, 'SAVE_SECRET_NOT_CONFIGURED'],
    ['vault outside the allowlist', () => {}, { destination: { ...destination, vault: 'otro' } }, 'SAVE_SECRET_INVALID_DESTINATION'],
    ['allowlist of names only (C2: the id decides)', () => { process.env.AGENT_BROWSER_SAVE_VAULTS = 'llavero'; }, {}, 'SAVE_SECRET_INVALID_DESTINATION'],
    ['quote in the item', () => {}, { destination: { ...destination, item: 'a"b' } }, 'SAVE_SECRET_INVALID_DESTINATION'],
    ['vault that does not exist', () => { process.env.AGENT_BROWSER_SAVE_VAULTS = 'fantasma'; }, { destination: { ...destination, vault: 'fantasma' } }, 'SAVE_SECRET_VAULT_NOT_FOUND'],
    ['two items with that title', () => {}, { destination: { ...destination, item: 'Duplicado' } }, 'SAVE_SECRET_ITEM_AMBIGUOUS'],
    ['field that already has a value', () => {}, { destination: { ...destination, item: 'Existente', field: 'password' } }, 'SAVE_SECRET_FIELD_EXISTS'],
    ['template without {value}', () => {}, { template: 'fixed' }, 'SAVE_SECRET_TEMPLATE_INVALID'],
    ['template with two {value}', () => {}, { template: '{value}{value}' }, 'SAVE_SECRET_TEMPLATE_INVALID'],
    ['Connect refuses the token', () => { fake.respond = () => 403; }, {}, 'SAVE_SECRET_DENIED'],
    ['Connect is down', () => { fake.respond = () => 503; }, {}, 'SAVE_SECRET_UNAVAILABLE'],
  ];
  it.each(cases)('%s: fixed error and the extension is not asked', async (_name, arrange, params, code) => {
    arrange();
    const { context, sent } = fakeContext({ value: CANARY });
    const r = await tool.handle(context, { selector: '#s', destination, ...params });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(new RegExp(`^Error: ${code}: .+`));
    expect(text(r)).not.toContain(DECOY_BODY);
    expect(sent).toEqual([]);
    expect(written()).toEqual([]);
  });
});

describe('browser_save_secret: what the extension can answer', () => {
  const fixed: Array<[string, string, string]> = [
    ['SECRET_NO_MATCH', 'No element matches the selector', 'No element matches the selector'],
    ['SECRET_AMBIGUOUS', '2 elements match the selector', '2 elements match the selector'],
    ['SECRET_EMPTY', 'The element has no text', 'The element has no text'],
    ['SECRET_REGEX_INVALID', 'The regex is not valid or has no capture group', 'The regex is not valid or has no capture group'],
    ['SECRET_REGEX_NO_MATCH', 'The regex did not match', 'The regex did not match'],
    ['SECRET_TOO_LARGE', 'The text is too large', 'The text is too large'],
  ];
  it.each(fixed)('%s is forwarded with its fixed text and nothing is written', async (code, message, expected) => {
    const { context, sent } = fakeContext({}, { code, message });
    const r = await tool.handle(context, { selector: '#s', destination });
    expect(text(r)).toBe(`Error: ${code}: ${expected}`);
    expect(isError(r)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(written()).toEqual([]);
  });

  it.each(fixed)('%s never echoes a message of the extension that is not the fixed one', async (code) => {
    const { context } = fakeContext({}, { code, message: `${DECOY_EXT} ${CANARY}` });
    const out = text(await tool.handle(context, { selector: '#s', destination }));
    expect(out).toMatch(new RegExp(`^Error: ${code}: `));
    expect(out).not.toContain(DECOY_EXT);
    expect(out).not.toContain(CANARY);
  });

  it('UNKNOWN_TOOL means the extension is too old, after a single message and no other command', async () => {
    for (const error of [{ code: 'UNKNOWN_TOOL', message: DECOY_EXT }, { message: 'Unknown tool: browser_read_secret' }]) {
      const { context, sent } = fakeContext({}, error);
      const r = await tool.handle(context, { selector: '#s', destination });
      expect(text(r)).toBe('Error: SAVE_SECRET_EXTENSION_TOO_OLD: The browser extension does not know browser_save_secret yet: it updates itself (or reload it), then try again.');
      expect(sent.map((m) => m.type)).toEqual(['browser_read_secret']);
    }
    expect(written()).toEqual([]);
  });

  it('any other failure is a fixed text; only a code-shaped code is shown, never the message', async () => {
    let r = text(await tool.handle(fakeContext({}, { code: 'TAB_GONE', message: DECOY_EXT }).context, { selector: '#s', destination }));
    expect(r).toBe('Error: SAVE_SECRET_EXTENSION_ERROR: The browser extension could not read the value from the page (TAB_GONE).');
    r = text(await tool.handle(fakeContext({}, { code: `bad ${DECOY_EXT}`, message: DECOY_EXT }).context, { selector: '#s', destination }));
    expect(r).toBe('Error: SAVE_SECRET_EXTENSION_ERROR: The browser extension could not read the value from the page.');
  });

  it.each([undefined, {}, { value: '' }, { value: 42 }])('a success without a usable value (%j) is an error and writes nothing', async (result) => {
    const r = await tool.handle(fakeContext(result).context, { selector: '#s', destination });
    expect(text(r)).toMatch(/^Error: SAVE_SECRET_EXTENSION_ERROR: /);
    expect(written()).toEqual([]);
  });

  it('a value of more than 4096 characters is refused', async () => {
    const r = await tool.handle(fakeContext({ value: 'x'.repeat(4097) }).context, { selector: '#s', destination });
    expect(text(r)).toMatch(/^Error: SAVE_SECRET_VALUE_TOO_LARGE: /);
    expect(written()).toEqual([]);
  });
});

describe('browser_save_secret: normalisation and template', () => {
  const save = (value: string, params: Record<string, unknown> = {}) =>
    tool.handle(fakeContext({ value }).context, { selector: '#s', destination, ...params });

  it('puts the value in the template literally: $& and $1 in the value are not patterns', async () => {
    const value = `a$&b$1$$${CANARY}`;
    const r = await save(value, { template: 'pre-{value}-post' });
    expect(stored().fields[0].value).toBe(`pre-${value}-post`);
    expect(JSON.parse(text(r)).length).toBe(value.length); // the length is the value's, before the template
  });

  it('concealed keeps the value as it is, spaces and all', async () => {
    await save('abcd efgh-ijkl');
    expect(stored().fields[0]).toEqual({ label: 'seed', type: 'CONCEALED', value: 'abcd efgh-ijkl' });
  });

  it('otp turns a seed shown in lowercase groups into base32', async () => {
    const r = await save('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', { type: 'otp' });
    expect(stored().fields[0]).toEqual({ label: 'seed', type: 'OTP', value: RFC_SEED });
    expect(JSON.parse(text(r)).length).toBe(32);
  });

  it('otp refuses what is not base32, and keeps an otpauth:// URI as it is', async () => {
    const r = await save('not a seed!!', { type: 'otp' });
    expect(text(r)).toMatch(/^Error: SAVE_SECRET_VALUE_NOT_BASE32: /);
    expect(text(await save('GEZDGNBV', { type: 'otp' }))).toMatch(/SAVE_SECRET_VALUE_NOT_BASE32/); // too short
    expect(written()).toEqual([]);
    await save('otpauth://totp/x?secret=abc', { type: 'otp' });
    expect(stored().fields[0].value).toBe('otpauth://totp/x?secret=abc');
  });

  it('RFC 6238: the seed stored through the template gives 287082 at t=59', async () => {
    await save(RFC_SEED, { type: 'otp', template: 'otpauth://totp/prueba?secret={value}&issuer=prueba' });
    const field = stored().fields[0];
    expect(field.type).toBe('OTP');
    expect(totp(new URL(field.value).searchParams.get('secret')!, 59)).toBe('287082');
  });
});

describe('browser_save_secret: nothing leaks out of the process', () => {
  it('no log line has the value or any other value of the item; one audit line per save, without the value', async () => {
    const save = (item: string, field: string, value = CANARY) =>
      tool.handle(fakeContext({ value }).context, { selector: '#s', destination: { vault: 'llavero', item, field } });
    await save('Nuevo', 'seed'); // create
    await save('Existente', 'vacio'); // update: the GET returns EXISTING-SECRET-1B2C
    await save('Existente', 'password'); // refused: it already has a value
    fake.respond = (r) => (r.method === 'PUT' ? 500 : undefined);
    await save('Existente', 'otro'); // Connect fails
    expect(fake.requests.some((r) => r.method === 'GET' && r.path.includes(fake.items[0].id))).toBe(true);
    const logged = output.join('\n');
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain(EXISTING_SECRET);
    expect(logged).not.toContain(DECOY_BODY);
    expect(output.filter((l) => l.includes('[save_secret]')).map((l) => l.replace(/^\[[^\]]+\] \[INFO\] /, ''))).toEqual([
      `[save_secret] vault=llavero item=Nuevo field=seed length=${CANARY.length}`,
      `[save_secret] vault=llavero item=Existente field=vacio length=${CANARY.length}`,
    ]);
  });

  it('starts no subprocess (child_process is mocked to throw and the whole flow passes)', async () => {
    const r = await tool.handle(fakeContext({ value: CANARY }).context, { selector: '#s', destination });
    expect(isError(r)).toBe(false);
  });
});

/** RFC 6238 over HMAC-SHA1, six digits: what any authenticator does with the stored seed. */
function totp(base32: string, seconds: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[19] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
