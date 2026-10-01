/**
 * WebSocket server for Chrome extension communication.
 *
 * Several browsers can be connected at the same time: every socket is stored in
 * a registry keyed by the connectionId the extension sends in the handshake, and
 * each tool call targets one of them (explicit id, most recently used, or the
 * single open one).
 */
import { WebSocketServer, WebSocket } from 'ws';
import { timingSafeEqual } from 'crypto';
import { logger } from './utils/logger.js';
import { getSharedTokenStore, type TokenStore } from './token-store.js';
import { ConnectionRegistry, type ManagedConnection } from './connection-registry.js';
import type { BrowserConnectionInfo, ExtensionMessage, ExtensionResponse } from './types.js';

export interface WSServerOptions {
  port: number;
  host?: string;
  tokenStore?: TokenStore;
  onConnection?: (ws: WebSocket, connectionId: string) => void;
  onDisconnection?: (connectionId: string) => void;
  onMessage?: (message: ExtensionResponse) => void;
}

export interface HandshakeParams {
  token: string | null;
  connectionId: string | null;
  label: string | null;
}

export interface WSServer {
  server: WebSocketServer;
  registry: ConnectionRegistry;
  getConnection(connectionId?: string): WebSocket | null;
  listConnectionInfos(): BrowserConnectionInfo[];
  /** Send and await the extension response, targeting one connection. */
  sendTo(connectionId: string | undefined, message: ExtensionMessage): Promise<ExtensionResponse>;
  /** Back-compatible alias used by the stdio path. */
  send(message: ExtensionMessage, connectionId?: string): Promise<ExtensionResponse>;
  close(): Promise<void>;
}

/**
 * Auth is on when a static token is configured or pairing tokens are accepted.
 * With neither, the socket stays open (LAN / ssh-tunnel compatibility).
 */
export function isAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BROWSER_WS_TOKEN || '') !== '' || env.BROWSER_ALLOW_PAIRING === 'true';
}

export function parseHandshakeParams(reqUrl: string, hostHeader?: string): HandshakeParams {
  try {
    const url = new URL(reqUrl || '/', `http://${hostHeader || 'localhost'}`);
    return {
      token: url.searchParams.get('token'),
      connectionId: url.searchParams.get('connectionId'),
      label: url.searchParams.get('label'),
    };
  } catch {
    return { token: null, connectionId: null, label: null };
  }
}

/** Constant-time compare so the shared token does not leak through timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isAuthorizedToken(
  token: string | null,
  tokenStore: TokenStore,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!token) return false;
  const staticToken = env.BROWSER_WS_TOKEN || '';
  if (staticToken && safeEqual(token, staticToken)) return true;
  return tokenStore.isValid(token);
}

/**
 * Create a WebSocket server for extension communication.
 */
export function createWSServer(options: WSServerOptions): WSServer {
  const { port, onConnection, onDisconnection, onMessage } = options;
  const tokenStore = options.tokenStore ?? getSharedTokenStore();
  const registry = new ConnectionRegistry();
  const pendingRequests = new Map<string, {
    resolve: (response: ExtensionResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  // SECURITY: this used to listen on 0.0.0.0 with no auth and no origin check —
  // anyone on the LAN could impersonate the extension and pilot the browser.
  // Now: loopback by default, and a token (static BROWSER_WS_TOKEN or one issued
  // by the pairing page) is required whenever auth is enabled.
  const host = options.host || process.env.BROWSER_WS_HOST || '127.0.0.1';

  function authorize(token: string | null): boolean {
    if (!isAuthEnabled()) return true;
    return isAuthorizedToken(token, tokenStore);
  }

  const server = new WebSocketServer({
    port,
    host,
    // Reject at the HANDSHAKE (401), not after accepting: a connection without
    // a valid token never opens, so the client cannot mistake it for a live one.
    verifyClient: (info, done) => {
      const params = parseHandshakeParams(
        info.req.url || '/',
        info.req.headers.host || 'localhost',
      );
      if (authorize(params.token)) return done(true);
      logger.warn('Handshake rejected: missing or invalid token');
      return done(false, 401, 'unauthorized');
    },
  });

  logger.info(
    `WebSocket server listening on ws://${host}:${port}${
      isAuthEnabled() ? ' (token required)' : ' (NO TOKEN)'
    }`,
  );

  server.on('connection', (ws, req) => {
    const params = parseHandshakeParams(req.url || '/', req.headers.host || 'localhost');

    // Defense in depth: verifyClient already gated the upgrade, but a proxy that
    // replays or a future refactor must not turn the socket into a live session.
    if (!authorize(params.token)) {
      logger.warn('Connection rejected: missing or invalid token');
      ws.close(4401, 'unauthorized');
      return;
    }

    const connectionId = params.connectionId?.trim() || registry.nextAnonymousId();
    const { added, replaced } = registry.add({
      connectionId,
      ws,
      label: params.label?.trim() || undefined,
      userAgent: req.headers['user-agent'],
    });

    if (replaced) {
      logger.warn(
        `Connection ${connectionId} reconnected: closing stale socket (was open for ${Math.round(
          (Date.now() - replaced.connectedAt) / 1000,
        )}s)`,
      );
      try {
        replaced.ws.close(1000, 'Replaced by newer connection with the same id');
      } catch {
        // the stale socket is already gone; the registry entry is replaced anyway
      }
    }

    logger.info(
      `Extension connected (${connectionId})${added.label ? ` label=${added.label}` : ''} — ${
        registry.openIds().length
      } connection(s) active`,
    );
    onConnection?.(ws, connectionId);

    ws.on('message', (data) => {
      registry.touch(connectionId);
      try {
        const dataStr = data.toString();
        logger.info('[WS] Raw message received, length:', dataStr.length);

        const rawMessage = JSON.parse(dataStr);
        if ((rawMessage as { type?: string })?.type === 'heartbeat') {
          logger.debug('[WS] Heartbeat received');
          return;
        }

        const message = rawMessage as ExtensionResponse;
        logger.info('[WS] Parsed message id:', message.id, 'success:', message.success);
        logger.info('[WS] Pending request IDs:', Array.from(pendingRequests.keys()));

        // Handle response to a pending request
        if (message.id && pendingRequests.has(message.id)) {
          logger.info('[WS] Found matching pending request, resolving');
          const pending = pendingRequests.get(message.id)!;
          clearTimeout(pending.timeout);
          pendingRequests.delete(message.id);
          pending.resolve(message);
        } else {
          logger.warn('[WS] No matching pending request for id:', message.id);
        }

        onMessage?.(message);
      } catch {
        logger.error('Failed to parse WebSocket message');
      }
    });

    ws.on('close', () => {
      if (registry.remove(connectionId, ws)) {
        logger.info(`Extension disconnected (${connectionId})`);
        onDisconnection?.(connectionId);
      } else {
        logger.debug(`Stale socket closed for ${connectionId}, registry kept`);
      }
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', err);
    });
  });

  server.on('error', (err) => {
    logger.error('WebSocket server error', err);
  });

  function targetSocket(connectionId?: string): { ws: WebSocket; connectionId: string } | null {
    const resolved = registry.resolve(connectionId);
    if (!resolved.ok) return null;
    const conn = registry.get(resolved.connectionId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return null;
    return { ws: conn.ws, connectionId: resolved.connectionId };
  }

  function resolutionError(connectionId?: string): Error {
    const resolved = registry.resolve(connectionId);
    if (resolved.ok) return new Error('No extension connected');
    const ids = resolved.openIds.join(', ');
    // An explicit id that cannot be targeted always deserves the list hint.
    if (connectionId) {
      return new Error(
        `No browser connection with id "${connectionId}" (open: ${ids || 'none'}). Call browser_list_connections to see the current ones.`,
      );
    }
    switch (resolved.reason) {
      case 'ambiguous':
        return new Error(
          `Multiple browser connections open (${ids}); pass the "connection" argument. Call browser_list_connections to see them.`,
        );
      default:
        return new Error('No extension connected');
    }
  }

  function sendTo(
    connectionId: string | undefined,
    message: ExtensionMessage,
  ): Promise<ExtensionResponse> {
    return new Promise((resolve, reject) => {
      const target = targetSocket(connectionId);
      if (!target) {
        reject(resolutionError(connectionId));
        return;
      }

      logger.info(
        `[WS] Sending message id: ${message.id}, type: ${message.type} -> ${target.connectionId}`,
      );

      const timeout = setTimeout(() => {
        logger.error(`[WS] TIMEOUT for id: ${message.id}, type: ${message.type}`);
        pendingRequests.delete(message.id);
        reject(new Error(`Request timed out: ${message.type}`));
      }, 30000);

      pendingRequests.set(message.id, { resolve, reject, timeout });
      registry.markUsed(target.connectionId);
      registry.touch(target.connectionId);

      const jsonStr = JSON.stringify(message);
      logger.info('[WS] Sending JSON length:', jsonStr.length);
      target.ws.send(jsonStr);
    });
  }

  return {
    server,
    registry,

    getConnection(connectionId?: string) {
      return targetSocket(connectionId)?.ws ?? null;
    },

    listConnectionInfos() {
      return registry.list();
    },

    sendTo,

    send(message: ExtensionMessage, connectionId?: string) {
      return sendTo(connectionId, message);
    },

    /**
     * Gracefully close the server.
     *
     * Waits for pending requests to complete (up to timeout) before
     * forcibly closing every connection.
     */
    async close(): Promise<void> {
      logger.info(`[WS] Closing server, ${pendingRequests.size} pending requests`);

      // If there are pending requests, wait for them (up to 5s)
      if (pendingRequests.size > 0) {
        const pendingPromises = Array.from(pendingRequests.entries()).map(
          ([, pending]) =>
            new Promise<void>((resolve) => {
              // Wrap the original resolve/reject to also resolve our wait
              const originalResolve = pending.resolve;
              const originalReject = pending.reject;

              pending.resolve = (response) => {
                originalResolve(response);
                resolve();
              };
              pending.reject = (error) => {
                originalReject(error);
                resolve();
              };
            })
        );

        // Wait for all pending requests or timeout after 5s
        await Promise.race([
          Promise.all(pendingPromises),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);

        logger.info(`[WS] Graceful wait complete, ${pendingRequests.size} requests remaining`);
      }

      // Clear any remaining pending requests
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Server closing'));
        pendingRequests.delete(id);
      }

      // Close every live connection
      const sockets: ManagedConnection[] = registry.all();
      for (const conn of sockets) {
        conn.ws.close();
      }
      pendingRequests.clear();

      // Close server
      return new Promise((resolve) => {
        server.close(() => {
          logger.info('WebSocket server closed');
          resolve();
        });
      });
    },
  };
}
