import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { getClientIpInfo, normalizeIp, parseTrustedProxyIps } from '../src/client-ip.js';

function request(peer: string | undefined, headers: Record<string, string | string[]> = {}, rawHeaders?: string[]): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers, rawHeaders: rawHeaders ?? Object.entries(headers).flatMap(([key, value]) => [key, String(value)]) } as unknown as IncomingMessage;
}
const trusted = parseTrustedProxyIps('127.0.0.1,2001:db8::1');

describe('client IP attribution', () => {
  it('normalizes IP literals and rejects ports, CIDR, zones and invalid input', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('0:0:0:0:0:ffff:c000:201')).toBe('192.0.2.1');
    expect(normalizeIp('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    for (const value of ['127.0.0.1:80', '127.0.0.1/32', 'host', 'fe80::1%eth0', '[::1]', '']) expect(normalizeIp(value)).toBeNull();
  });

  it('fails closed for an invalid proxy policy', () => {
    expect(parseTrustedProxyIps(undefined).size).toBe(0);
    for (const config of ['127.0.0.1,host', '127.0.0.1,', '127.0.0.1/32']) expect(parseTrustedProxyIps(config).size).toBe(0);
  });

  it('ignores forged forwarded headers for a direct client', () => {
    expect(getClientIpInfo(request('192.0.2.1', { 'x-real-ip': '203.0.113.1' }), trusted)).toEqual({ clientIp: '192.0.2.1', peerIp: '192.0.2.1', clientIpSource: 'socket' });
    expect(getClientIpInfo(request(undefined), trusted).clientIp).toBeNull();
  });

  it('uses a single real-IP header from a trusted IPv4 or IPv6 peer', () => {
    expect(getClientIpInfo(request('::ffff:127.0.0.1', { 'x-real-ip': '2001:0db8::2' }), trusted)).toEqual({ clientIp: '2001:db8::2', peerIp: '127.0.0.1', clientIpSource: 'x-real-ip' });
    expect(getClientIpInfo(request('2001:0db8::1', { 'x-real-ip': '192.0.2.2' }), trusted).clientIp).toBe('192.0.2.2');
  });

  it('prefers the rightmost forwarded IP over a client-supplied real-IP', () => {
    expect(getClientIpInfo(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 192.0.2.2', 'x-real-ip': '203.0.113.99' }), trusted)).toEqual({ clientIp: '192.0.2.2', peerIp: '127.0.0.1', clientIpSource: 'x-forwarded-for' });
  });

  it('falls back for malformed, duplicate and array headers', () => {
    for (const headers of [
      { 'x-real-ip': '192.0.2.1,192.0.2.2' },
      { 'x-real-ip': '192.0.2.2', 'x-forwarded-for': 'invalid' },
      { 'x-real-ip': ['192.0.2.1'] },
      { 'x-forwarded-for': 'invalid,192.0.2.2' },
      { 'x-forwarded-for': '192.0.2.1,' },
    ]) expect(getClientIpInfo(request('127.0.0.1', headers), trusted).clientIpSource).toBe('socket');
    expect(getClientIpInfo(request('127.0.0.1', { 'x-real-ip': '192.0.2.1' }, ['X-Real-IP', '192.0.2.1', 'x-real-ip', '192.0.2.1']), trusted).clientIpSource).toBe('socket');
  });
});
