/**
 * Registry of live extension connections.
 *
 * More than one browser can be attached at the same time, so the server keeps a
 * Map keyed by the connectionId the extension sends in the handshake instead of
 * a single socket. The registry is pure bookkeeping (no sockets are created
 * here) so the targeting rules can be unit tested.
 */
import { WebSocket } from 'ws';
import type { BrowserConnectionInfo } from './types.js';

export interface ManagedConnection {
  connectionId: string;
  ws: WebSocket;
  label: string;
  userAgent: string;
  connectedAt: number;
  lastActiveAt: number;
}

export type ResolveResult =
  | { ok: true; connectionId: string }
  | { ok: false; reason: 'none' | 'unknown' | 'ambiguous'; openIds: string[] };

export class ConnectionRegistry {
  private connections = new Map<string, ManagedConnection>();
  private usedIds: string[] = [];
  private anonymousCounter = 0;

  /** Id for clients that do not send their own connectionId (legacy builds). */
  nextAnonymousId(): string {
    this.anonymousCounter += 1;
    return `anon-${this.anonymousCounter}`;
  }

  /**
   * Register a connection. When an entry with the same id already exists it is
   * returned as `replaced` so the caller can close the stale socket: a
   * reconnect of the same browser wins over its previous self.
   */
  add(input: {
    connectionId: string;
    ws: WebSocket;
    label?: string;
    userAgent?: string;
    now?: number;
  }): { added: ManagedConnection; replaced: ManagedConnection | null } {
    const at = input.now ?? Date.now();
    const added: ManagedConnection = {
      connectionId: input.connectionId,
      ws: input.ws,
      label: input.label || '',
      userAgent: input.userAgent || '',
      connectedAt: at,
      lastActiveAt: at,
    };
    const previous = this.connections.get(input.connectionId);
    const replaced =
      previous && previous.ws !== input.ws && previous.ws.readyState === WebSocket.OPEN ? previous : null;
    this.connections.set(input.connectionId, added);
    this.markUsed(input.connectionId);
    return { added, replaced };
  }

  /** Remove an entry, but only when it still points at the given socket. */
  remove(connectionId: string, ws: WebSocket): boolean {
    const existing = this.connections.get(connectionId);
    if (!existing || existing.ws !== ws) return false;
    this.connections.delete(connectionId);
    this.usedIds = this.usedIds.filter((id) => id !== connectionId);
    return true;
  }

  get(connectionId: string): ManagedConnection | null {
    return this.connections.get(connectionId) ?? null;
  }

  isOpen(connectionId: string): boolean {
    const existing = this.connections.get(connectionId);
    return existing?.ws.readyState === WebSocket.OPEN;
  }

  openIds(): string[] {
    return Array.from(this.connections.values())
      .filter((c) => c.ws.readyState === WebSocket.OPEN)
      .map((c) => c.connectionId);
  }

  /**
   * Target resolution: explicit id, then most recently used, then the single
   * open connection. Ambiguity is reported instead of guessed.
   */
  resolve(connectionId?: string): ResolveResult {
    const openIds = this.openIds();

    if (connectionId) {
      if (this.isOpen(connectionId)) return { ok: true, connectionId };
      return { ok: false, reason: openIds.length === 0 ? 'none' : 'unknown', openIds };
    }

    if (openIds.length === 0) return { ok: false, reason: 'none', openIds };
    if (openIds.length === 1) return { ok: true, connectionId: openIds[0] };

    for (const id of [...this.usedIds].reverse()) {
      if (openIds.includes(id)) return { ok: true, connectionId: id };
    }
    return { ok: false, reason: 'ambiguous', openIds };
  }

  markUsed(connectionId: string): void {
    this.usedIds = this.usedIds.filter((id) => id !== connectionId);
    this.usedIds.push(connectionId);
  }

  touch(connectionId: string, now?: number): void {
    const existing = this.connections.get(connectionId);
    if (existing) existing.lastActiveAt = now ?? Date.now();
  }

  get lastUsedConnectionId(): string | null {
    const open = [...this.usedIds].reverse().find((id) => this.isOpen(id));
    return open ?? null;
  }

  get size(): number {
    return this.connections.size;
  }

  all(): ManagedConnection[] {
    return Array.from(this.connections.values());
  }

  list(now?: number): BrowserConnectionInfo[] {
    const activeId = this.lastUsedConnectionId;
    const at = now ?? Date.now();
    return Array.from(this.connections.values())
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map((c) => ({
        connectionId: c.connectionId,
        label: c.label,
        userAgent: c.userAgent,
        connectedAt: c.connectedAt,
        lastActiveAt: c.lastActiveAt,
        open: c.ws.readyState === WebSocket.OPEN,
        active: c.connectionId === activeId,
        secondsSinceLastActivity: Math.max(0, Math.round((at - c.lastActiveAt) / 1000)),
      }));
  }
}
