/**
 * Which browser a tool call drives.
 *
 * Several browsers can be attached at once (one extension per Chrome). The old default,
 * "the most recently used", is global to the server: one MCP client choosing a browser
 * silently moved every other client onto it. Here the choice belongs to the MCP session:
 *
 *   1. `connection` in the call (an id or a friendly name) wins, and becomes this session's
 *      default for the calls that follow.
 *   2. Otherwise the session's own default, if that browser is still connected.
 *   3. Otherwise the configured default (AGENT_BROWSER_DEFAULT_CONNECTION, id or name).
 *   4. Otherwise the only connected browser.
 *   5. Otherwise an error listing the choices — never a guess.
 *
 * Friendly names come from AGENT_BROWSER_CONNECTION_LABELS ({"<connectionId>": "mac"}) or
 * from the label the extension sent in the handshake.
 */

export interface OpenConnection {
  connectionId: string;
  label?: string;
}

export type TargetResult =
  | { ok: true; connectionId: string; sticky: boolean }
  | { ok: false; error: string };

type ConnectionMatch =
  | { status: 'found'; connection: OpenConnection }
  | { status: 'ambiguous'; error: string }
  | { status: 'missing' };

export function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => [k, (v as string).trim()]),
    );
  } catch {
    return {};
  }
}

export function nameOf(c: OpenConnection, labels: Record<string, string>): string {
  return (Object.hasOwn(labels, c.connectionId) && labels[c.connectionId]) || c.label || '';
}

export function normalizeConnectionName(name: string): string {
  return name.trim().toLowerCase();
}

/** Prefer an exact id, then match ids and friendly names case-insensitively. */
export function findConnection(
  wanted: string,
  open: OpenConnection[],
  labels: Record<string, string>,
): ConnectionMatch {
  const exact = open.find((c) => c.connectionId === wanted);
  if (exact) return { status: 'found', connection: exact };

  const w = normalizeConnectionName(wanted);
  const ids = open.filter((c) => normalizeConnectionName(c.connectionId) === w);
  const matches = ids.length ? ids : open.filter((c) => normalizeConnectionName(nameOf(c, labels)) === w);
  if (matches.length === 1) return { status: 'found', connection: matches[0] };
  if (!matches.length) return { status: 'missing' };

  const choices = matches.map((c) => c.connectionId).sort().join(', ');
  return { status: 'ambiguous', error: `Browser connection "${wanted}" is ambiguous. Specify an exact connection ID: ${choices}.` };
}

function describe(open: OpenConnection[], labels: Record<string, string>): string {
  if (!open.length) return 'none';
  return open.map((c) => (nameOf(c, labels) ? `${nameOf(c, labels)} (${c.connectionId})` : c.connectionId)).join(', ');
}

export function resolveTarget(input: {
  requested?: string;
  sessionDefault?: string;
  configuredDefault?: string;
  open: OpenConnection[];
  labels: Record<string, string>;
}): TargetResult {
  const { requested, sessionDefault, configuredDefault, open, labels } = input;

  if (requested) {
    const hit = findConnection(requested, open, labels);
    if (hit.status === 'found') return { ok: true, connectionId: hit.connection.connectionId, sticky: true };
    if (hit.status === 'ambiguous') return { ok: false, error: hit.error };
    return {
      ok: false,
      error: `No browser connection "${requested}" (open: ${describe(open, labels)}). Call browser_list_connections to see the current ones.`,
    };
  }

  if (sessionDefault && open.some((c) => c.connectionId === sessionDefault)) {
    return { ok: true, connectionId: sessionDefault, sticky: false };
  }

  if (configuredDefault) {
    const hit = findConnection(configuredDefault, open, labels);
    if (hit.status === 'found') return { ok: true, connectionId: hit.connection.connectionId, sticky: false };
    if (hit.status === 'ambiguous') return { ok: false, error: hit.error };
  }

  if (open.length === 1) return { ok: true, connectionId: open[0].connectionId, sticky: false };

  if (!open.length) return { ok: false, error: 'No browser connected.' };
  return {
    ok: false,
    error: `Several browsers are connected; pick one with "connection": ${describe(open, labels)}. The choice sticks for this session.`,
  };
}
