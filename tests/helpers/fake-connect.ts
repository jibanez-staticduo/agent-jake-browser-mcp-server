/**
 * Stand-in for a 1Password Connect server: just the endpoints browser_save_secret uses
 * (vaults, items by title filter, item GET/POST/PUT), with state in memory.
 * In tests: `startFakeConnect()`. Alone, for qa:
 *   npx tsx tests/helpers/fake-connect.ts --port 0     # first line printed = the port
 *   OP_CONNECT_HOST=http://127.0.0.1:PORT OP_CONNECT_WRITE_TOKEN=x AGENT_BROWSER_SAVE_VAULTS=jl5w33zmwcgl4ypvle7chbxu5i,wfovwhcnq22jzbhaaupp24fb2y ...
 * GET /__requests lists what it has received (method, path, headers, body).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export const EXISTING_SECRET = 'EXISTING-SECRET-1B2C';
/** Body of every error status, so a test can prove it never comes back to the agent. */
export const DECOY_BODY = 'DECOY-CONNECT-BODY';

const id26 = (name: string) => (name + '0'.repeat(26)).slice(0, 26);
export interface Recorded { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }
interface Field { id: string; label: string; type: string; value?: string }
export interface Item { id: string; title: string; category: string; vault: { id: string }; fields: Field[] }

export interface FakeConnect {
  port: number;
  url: string;
  vaults: Array<{ id: string; name: string }>;
  items: Item[];
  requests: Recorded[];
  /** Return an HTTP status to fail that request, 'hang' to never answer it, or nothing to serve it. */
  respond?: (request: Recorded) => number | 'hang' | undefined;
  close(): Promise<void>;
}

export async function startFakeConnect(port = 0): Promise<FakeConnect> {
  // The two allowed vaults carry their real Connect ids (SC-2102 C2: the allowlist is
  // compared by id, so the suite must pin the ids H3 will deploy). 'otro' stays outside
  // the allowlist to test the refusal.
  const vaults = [
    { id: 'jl5w33zmwcgl4ypvle7chbxu5i', name: 'llavero' },
    { id: 'wfovwhcnq22jzbhaaupp24fb2y', name: 'k8s-pocharlies' },
    { id: id26('otro'), name: 'otro' },
  ];
  const item = (n: string, title: string, fields: Field[]): Item => ({ id: id26(n), title, category: 'SECURE_NOTE', vault: { id: vaults[0].id }, fields });
  const items: Item[] = [
    item('existente', 'Existente', [
      { id: 'f1', label: 'password', type: 'CONCEALED', value: EXISTING_SECRET },
      { id: 'f2', label: 'vacio', type: 'CONCEALED' },
      { id: 'f3', label: 'usuario', type: 'STRING', value: 'jake' },
    ]),
    item('dup1', 'Duplicado', []),
    item('dup2', 'Duplicado', []),
  ];
  const fake: FakeConnect = { port: 0, url: '', vaults, items, requests: [], close: async () => {} };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const request: Recorded = { method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...(status >= 300 && status < 400 ? { Location: '/elsewhere' } : {}) });
        res.end(JSON.stringify(body));
      };
      if (request.path === '/__requests') return send(200, fake.requests);
      fake.requests.push(request);
      const forced = fake.respond?.(request);
      if (forced === 'hang') return;
      if (forced) return send(forced, { status: forced, message: DECOY_BODY });
      if (!/^Bearer \S+$/.test(String(req.headers.authorization))) return send(401, { message: DECOY_BODY });

      const url = new URL(request.path, 'http://fake');
      const [, , , vaultId, , itemId] = url.pathname.split('/');
      const body = request.body ? JSON.parse(request.body) : undefined;
      if (url.pathname === '/v1/vaults' && request.method === 'GET') return send(200, vaults);
      if (!vaults.some((v) => v.id === vaultId)) return send(404, { message: DECOY_BODY });
      const mine = items.filter((i) => i.vault.id === vaultId);
      if (!itemId && request.method === 'GET') {
        const title = /^title eq "(.*)"$/.exec(url.searchParams.get('filter') ?? '')?.[1];
        return send(200, mine.filter((i) => title === undefined || i.title === title).map(({ fields: _, ...overview }) => overview));
      }
      if (!itemId && request.method === 'POST') {
        const created = { ...body, id: id26(`new${items.length}`) };
        items.push(created);
        return send(200, created);
      }
      const current = mine.find((i) => i.id === itemId);
      if (!current) return send(404, { message: DECOY_BODY });
      if (request.method === 'GET') return send(200, current);
      // Measured on the real Connect: the PUT must repeat the id and the vault of the URL.
      if (request.method === 'PUT' && body?.id === itemId && body?.vault?.id === vaultId) {
        items[items.indexOf(current)] = body;
        return send(200, body);
      }
      return send(request.method === 'PUT' ? 400 : 405, { message: DECOY_BODY });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  fake.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  console.log((await startFakeConnect(at > 0 ? Number(process.argv[at + 1]) : 0)).port);
}
