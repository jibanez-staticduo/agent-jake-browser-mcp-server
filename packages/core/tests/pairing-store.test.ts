/**
 * Pairing OTP state machine.
 */
import { describe, it, expect } from 'vitest';
import { createPairingStore, DEFAULT_PAIRING_TTL_MS } from '../src/pairing-store.ts';

function clock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('pairing store', () => {
  it('goes start -> approve -> status approved with one token', () => {
    const time = clock();
    let minted = 0;
    const store = createPairingStore({
      now: time.now,
      issueToken: () => `token-${(minted += 1)}`,
    });

    const record = store.start('ABC123', { connectionId: 'chrome-a', label: 'casa' });
    expect(record.state).toBe('pending');
    expect(record.expiresAt - record.createdAt).toBe(DEFAULT_PAIRING_TTL_MS);
    expect(store.status('ABC123')).toEqual({
      state: 'pending',
      connectionId: 'chrome-a',
      label: 'casa',
    });

    const approved = store.approve('ABC123');
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.token).toBe('token-1');

    expect(store.status('ABC123')).toEqual({
      state: 'approved',
      token: 'token-1',
      connectionId: 'chrome-a',
      label: 'casa',
    });
    expect(store.pending()).toEqual([]);
  });

  it('mints only one token per code', () => {
    const time = clock();
    let minted = 0;
    const store = createPairingStore({ now: time.now, issueToken: () => `token-${(minted += 1)}` });

    store.start('ABC123');
    expect(store.approve('ABC123').ok).toBe(true);
    expect(store.approve('ABC123')).toEqual({ ok: false, reason: 'used' });
    expect(minted).toBe(1);
  });

  it('expires pending codes after the TTL', () => {
    const time = clock();
    const store = createPairingStore({ now: time.now, issueToken: () => 'token-1' });

    store.start('ABC123');
    time.advance(DEFAULT_PAIRING_TTL_MS + 1);

    expect(store.status('ABC123').state).toBe('expired');
    expect(store.approve('ABC123')).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports unknown codes as expired', () => {
    const store = createPairingStore({ issueToken: () => 'token-1' });
    expect(store.status('never-started')).toEqual({ state: 'expired' });
    expect(store.approve('never-started')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('restarts a code with the same otp and keeps the newest request pending', () => {
    const time = clock();
    const store = createPairingStore({ now: time.now, issueToken: () => 'token-1' });

    store.start('ABC123', { label: 'first' });
    time.advance(60_000);
    store.start('ABC123', { label: 'second' });

    expect(store.status('ABC123').label).toBe('second');
    expect(store.pending()).toHaveLength(1);
  });
});
