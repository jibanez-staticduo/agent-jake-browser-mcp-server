import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { normalizeIp, parseTrustedProxyIps } from './client-ip.js';
import type { SetupSettings } from './setup-store.js';

export const SETUP_CLIENT_IP_HEADER = 'x-agent-jake-client-ip';
export const setupField = z.string().trim().min(1).max(62).regex(/^[^\p{Cc}]+$/u);
const credential = z.string().regex(/^[\x21-\x7e]+$/);

function endpoint(scheme: 'https:' | 'wss:') {
  return z.url({ protocol: scheme === 'https:' ? /^https$/ : /^wss$/ }).refine((value) => {
    const url = new URL(value);
    return url.protocol === scheme && !url.username && !url.password && !url.hash && !url.search;
  });
}

const configSchema = z.strictObject({
  origin: endpoint('https:').refine((value) => new URL(value).origin === value),
  wsUrl: endpoint('wss:'),
  baseUrl: endpoint('https:'),
  apiKey: credential,
  mcpUrl: endpoint('https:'),
  mcpToken: credential,
  lanCidrs: z.array(z.string()).min(1),
  trustedProxyIps: z.array(z.string()).default([]),
  hostByIp: z.record(z.string(), setupField).default({}),
});

function parseLanCidrs(cidrs: string[]): BlockList {
  const ranges = new BlockList();
  for (const cidr of cidrs) {
    const parts = /^([^/]+)\/([1-9]\d{0,2})$/.exec(cidr);
    if (!parts) throw new Error('Invalid LAN CIDR');
    const ip = normalizeIp(parts[1]);
    const bits = Number(parts[2]);
    const version = ip && isIP(ip);
    // Require mapped IPv4 ranges to use their IPv4 CIDR spelling.
    if (!ip || version !== isIP(parts[1]) || bits > (version === 4 ? 32 : 128)) {
      throw new Error('Invalid LAN CIDR');
    }
    ranges.addSubnet(ip, bits, version === 4 ? 'ipv4' : 'ipv6');
  }
  return ranges;
}

export function readSetupConfig(path: string | undefined) {
  if (!path?.trim()) return null;
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
    const ranges = parseLanCidrs(config.lanCidrs);
    const peers = parseTrustedProxyIps(config.trustedProxyIps.join(','));
    // Each array entry must be an exact IP, never a list or CIDR.
    if (config.trustedProxyIps.some((ip) => !normalizeIp(ip))) throw new Error('Invalid proxy IP');
    const hosts = new Map<string, string>();
    for (const [entry, label] of Object.entries(config.hostByIp)) {
      const ip = normalizeIp(entry);
      if (!ip || hosts.has(ip)) throw new Error('Invalid host hint IP');
      hosts.set(ip, label);
    }
    const settings: SetupSettings = {
      wsUrl: config.wsUrl,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      mcpUrl: config.mcpUrl,
      mcpToken: config.mcpToken,
    };
    return { origin: config.origin, ranges, peers, hosts, settings };
  } catch {
    // Schema failures can include submitted values. Keep configuration out of error output.
    throw new Error('AGENT_BROWSER_SETUP_FILE is unreadable or invalid');
  }
}

export function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

export function setupClientIp(req: IncomingMessage, config: NonNullable<ReturnType<typeof readSetupConfig>>) {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!peer || singleHeader(req, 'host')?.toLowerCase() !== new URL(config.origin).host) return null;
  if (config.peers.size && !config.peers.has(peer)) return null;
  const ip = config.peers.size ? normalizeIp(singleHeader(req, SETUP_CLIENT_IP_HEADER)) : peer;
  return ip && config.ranges.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6') ? ip : null;
}
