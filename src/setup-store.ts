import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeConnectionName } from './connection-target.js';

export interface SetupIdentity {
  host?: string;
  profile?: string;
}

export interface SetupSettings {
  wsUrl: string;
  baseUrl: string;
  apiKey: string;
  mcpUrl: string;
  mcpToken: string;
}

type Field = 'host' | 'profile';
type ApprovedIdentity = { connectionId: string; label: string };
type SetupResult = SetupSettings & ApprovedIdentity & { token: string };
type SetupRecord = SetupIdentity & {
  pollSecret: string;
  expiresAt: number;
  approved?: ApprovedIdentity;
  delivery?: SetupResult;
};

export function createSetupStore(
  settings: SetupSettings,
  issueToken: (identity: ApprovedIdentity) => string,
  {
    now = Date.now,
    ttlMs = 5 * 60_000,
    capacity = 256,
    isNameTaken = (_name: string) => false,
    checkApproval = () => {},
    isTokenValid = (_config: SetupResult) => true,
  } = {},
) {
  const records = new Map<string, SetupRecord>();
  const codesBySecret = new Map<string, string>();

  function remove(code: string, record: SetupRecord) {
    codesBySecret.delete(record.pollSecret);
    records.delete(code);
  }

  function prune() {
    const current = now();
    for (const [code, record] of records) {
      if (record.expiresAt <= current) remove(code, record);
    }
  }

  function isReserved(name: string): boolean {
    const wanted = normalizeConnectionName(name);
    return [...records.values()].some(({ approved }) => approved &&
      (normalizeConnectionName(approved.connectionId) === wanted || normalizeConnectionName(approved.label) === wanted));
  }

  return {
    isReserved(name: string) {
      prune();
      return isReserved(name);
    },
    start(identity: SetupIdentity) {
      prune();
      if (records.size >= capacity) return null;
      const approvalCode = randomBytes(32).toString('base64url');
      const pollSecret = randomBytes(32).toString('base64url');
      records.set(approvalCode, { ...identity, pollSecret, expiresAt: now() + ttlMs });
      codesBySecret.set(pollSecret, approvalCode);
      return { approvalCode, pollSecret };
    },
    approve(code: string, supplied: Partial<Record<Field, string>>) {
      prune();
      const record = records.get(code);
      if (!record || record.delivery) return { state: 'expired' } as const;
      if (record.approved) return { state: 'approved' } as const;
      const host = record.host ?? supplied.host;
      const profile = record.profile ?? supplied.profile;
      if (!host || !profile) {
        const missing: Field[] = [];
        if (!host) missing.push('host');
        if (!profile) missing.push('profile');
        return { state: 'pending', missing } as const;
      }
      const label = `${host} - ${profile}`;
      if (isNameTaken(label) || isReserved(label)) {
        record.host = host;
        delete record.profile;
        return { state: 'pending', missing: ['profile'] as Field[], conflict: true } as const;
      }
      checkApproval();
      let connectionId: string;
      do {
        connectionId = randomUUID();
      } while (isNameTaken(connectionId) || isReserved(connectionId));
      record.approved = { connectionId, label };
      return { state: 'approved' } as const;
    },
    status(pollSecret: string) {
      prune();
      const code = codesBySecret.get(pollSecret);
      const record = code && records.get(code);
      if (!code || !record) return { state: 'expired' } as const;
      if (!record.approved) return { state: 'pending' } as const;
      if (record.delivery) {
        if (isTokenValid(record.delivery)) return { state: 'approved', config: record.delivery } as const;
        remove(code, record);
        return { state: 'expired' } as const;
      }
      if (isNameTaken(record.approved.label) || isNameTaken(record.approved.connectionId)) {
        remove(code, record);
        return { state: 'expired' } as const;
      }
      // Persist once before returning. If persistence throws, the same poll can retry.
      const token = issueToken(record.approved);
      record.delivery = { ...settings, ...record.approved, token };
      return { state: 'approved', config: record.delivery } as const;
    },
  };
}
