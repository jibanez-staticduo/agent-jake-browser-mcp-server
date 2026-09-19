/**
 * In-memory pairing requests (one-time OTPs issued by the extension).
 *
 * Flow: extension POSTs /pair/start with a random OTP, the human opens the
 * approval page, approving issues a browser token from the token store and the
 * extension picks it up by polling /pair/status.
 */
export type PairingState = 'pending' | 'approved' | 'expired';

export interface PairingRecord {
  otp: string;
  connectionId?: string;
  label?: string;
  state: PairingState;
  createdAt: number;
  expiresAt: number;
  token?: string;
}

export interface PairingStatus {
  state: PairingState;
  token?: string;
  connectionId?: string;
  label?: string;
}

export interface PairingStore {
  readonly ttlMs: number;
  start(otp: string, meta?: { connectionId?: string; label?: string }): PairingRecord;
  approve(otp: string): { ok: true; token: string; record: PairingRecord } | { ok: false; reason: 'unknown' | 'expired' | 'used' };
  status(otp: string): PairingStatus;
  pending(): PairingRecord[];
}

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Create a pairing store. `issueToken` is injected so tests stay deterministic.
 */
export function createPairingStore(options: {
  ttlMs?: number;
  now?: () => number;
  issueToken?: (record: PairingRecord) => string;
} = {}): PairingStore {
  const ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  const now = options.now ?? Date.now;
  const issueToken =
    options.issueToken ??
    (() => {
      throw new Error('pairing store: issueToken is not configured');
    });

  const records = new Map<string, PairingRecord>();

  function prune(): void {
    if (records.size < 200) return;
    const current = now();
    for (const [otp, record] of records) {
      if (record.expiresAt < current) records.delete(otp);
    }
  }

  function effectiveState(record: PairingRecord): PairingState {
    if (record.state === 'approved') return 'approved';
    if (record.expiresAt <= now()) return 'expired';
    return 'pending';
  }

  return {
    ttlMs,
    start(otp, meta) {
      prune();
      const createdAt = now();
      const record: PairingRecord = {
        otp,
        ...(meta?.connectionId ? { connectionId: meta.connectionId } : {}),
        ...(meta?.label ? { label: meta.label } : {}),
        state: 'pending',
        createdAt,
        expiresAt: createdAt + ttlMs,
      };
      records.set(otp, record);
      return { ...record };
    },
    approve(otp) {
      const record = records.get(otp);
      if (!record) return { ok: false as const, reason: 'unknown' as const };
      const state = effectiveState(record);
      if (state === 'expired') {
        record.state = 'expired';
        return { ok: false as const, reason: 'expired' as const };
      }
      if (record.state === 'approved') {
        // One-time use: a second approval must not mint a second token.
        return { ok: false as const, reason: 'used' as const };
      }
      record.state = 'approved';
      record.token = issueToken(record);
      return { ok: true as const, token: record.token, record: { ...record } };
    },
    status(otp) {
      const record = records.get(otp);
      if (!record) return { state: 'expired' as const };
      const state = effectiveState(record);
      return {
        state,
        ...(record.token ? { token: record.token } : {}),
        ...(record.connectionId ? { connectionId: record.connectionId } : {}),
        ...(record.label ? { label: record.label } : {}),
      };
    },
    pending() {
      const out: PairingRecord[] = [];
      for (const record of records.values()) {
        if (effectiveState(record) === 'pending') out.push({ ...record });
      }
      return out;
    },
  };
}
