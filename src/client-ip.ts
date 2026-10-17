import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export interface ClientIpInfo {
  clientIp: string | null;
  peerIp: string | null;
  clientIpSource: 'socket' | 'x-real-ip' | 'x-forwarded-for';
}

export function normalizeIp(value: string | undefined): string | null {
  if (!value || value.includes('%') || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}

export function parseTrustedProxyIps(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim()) return new Set();
  const addresses = value.split(',').map((entry) => normalizeIp(entry.trim()));
  // A typo must not leave part of an invalid trust policy enabled.
  if (addresses.some((address) => address === null)) return new Set();
  return new Set(addresses as string[]);
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const count = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === name).length;
  return typeof value === 'string' && count <= 1 ? value : undefined;
}

export function getClientIpInfo(req: IncomingMessage, trusted: ReadonlySet<string>, trustAuthenticatedProxy = false): ClientIpInfo {
  const peerIp = normalizeIp(req.socket.remoteAddress);
  const fallback: ClientIpInfo = { clientIp: peerIp, peerIp, clientIpSource: 'socket' };
  if (!peerIp || (!trustAuthenticatedProxy && !trusted.has(peerIp))) return fallback;

  if (req.headers['x-forwarded-for'] !== undefined) {
    const forwarded = singleHeader(req, 'x-forwarded-for');
    if (forwarded === undefined) return fallback;
    const chain = forwarded.split(',').map((entry) => normalizeIp(entry.trim()));
    if (chain.some((entry) => entry === null)) return fallback;
    // One trusted edge proxy appends its observed client; earlier entries are untrusted.
    const clientIp = chain.at(-1);
    return clientIp ? { clientIp, peerIp, clientIpSource: 'x-forwarded-for' } : fallback;
  }
  const real = singleHeader(req, 'x-real-ip');
  const clientIp = real === undefined ? null : normalizeIp(real.trim());
  return clientIp ? { clientIp, peerIp, clientIpSource: 'x-real-ip' } : fallback;
}
