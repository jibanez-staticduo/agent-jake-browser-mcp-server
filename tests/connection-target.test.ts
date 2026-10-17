import { describe, it, expect } from 'vitest';
import { parseLabels, resolveTarget, findConnection } from '../src/connection-target.js';

const MAC = { connectionId: '259bc3e6-a078', label: '' };
const X86 = { connectionId: '7f00aa11-bb22', label: '' };
const labels = parseLabels('{"259bc3e6-a078":"mac","7f00aa11-bb22":"x86"}');

describe('resolveTarget', () => {
  it('uses the configured default when the session has not chosen', () => {
    expect(resolveTarget({ open: [MAC, X86], labels, configuredDefault: 'mac' }))
      .toEqual({ ok: true, connectionId: MAC.connectionId, sticky: false });
  });

  it('an explicit name wins and sticks for the session', () => {
    expect(resolveTarget({ requested: 'X86', open: [MAC, X86], labels, configuredDefault: 'mac' }))
      .toEqual({ ok: true, connectionId: X86.connectionId, sticky: true });
  });

  it('the session choice beats the configured default while that browser is connected', () => {
    expect(resolveTarget({ open: [MAC, X86], labels, sessionDefault: X86.connectionId, configuredDefault: 'mac' }))
      .toMatchObject({ ok: true, connectionId: X86.connectionId });
    expect(resolveTarget({ open: [MAC], labels, sessionDefault: X86.connectionId, configuredDefault: 'mac' }))
      .toMatchObject({ ok: true, connectionId: MAC.connectionId });
  });

  it('never guesses between several browsers', () => {
    const r = resolveTarget({ open: [MAC, X86], labels });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('mac (259bc3e6-a078)');
  });

  it('with one browser and no default, uses it; unknown names fail', () => {
    expect(resolveTarget({ open: [X86], labels })).toMatchObject({ ok: true, connectionId: X86.connectionId });
    expect(resolveTarget({ requested: 'ipad', open: [MAC], labels }).ok).toBe(false);
  });

  it('matches ids, names and handshake labels', () => {
    expect(findConnection('259bc3e6-a078', [MAC], labels)).toBe(MAC);
    expect(findConnection('work', [{ connectionId: 'z', label: 'work' }], {})?.connectionId).toBe('z');
    expect(parseLabels('not json')).toEqual({});
  });
});
