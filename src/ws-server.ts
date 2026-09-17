/**
 * WebSocket server for Chrome extension communication.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from './utils/logger.js';
import type { ExtensionMessage, ExtensionResponse } from './types.js';

export interface WSServerOptions {
  port: number;
  onConnection?: (ws: WebSocket) => void;
  onDisconnection?: () => void;
  onMessage?: (message: ExtensionResponse) => void;
}

export interface WSServer {
  server: WebSocketServer;
  getConnection(): WebSocket | null;
  send(message: ExtensionMessage): Promise<ExtensionResponse>;
  close(): Promise<void>;
}

/**
 * Create a WebSocket server for extension communication.
 */
export function createWSServer(options: WSServerOptions): WSServer {
  const { port, onConnection, onDisconnection, onMessage } = options;

  let connection: WebSocket | null = null;
  const pendingRequests = new Map<string, {
    resolve: (response: ExtensionResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  // SECURITY: this used to listen on 0.0.0.0 with no auth and no origin check —
  // anyone on the LAN could impersonate the extension and pilot the browser.
  // Now: loopback by default, and a shared token (BROWSER_WS_TOKEN) is required.
  const host = process.env.BROWSER_WS_HOST || '127.0.0.1';
  const token = process.env.BROWSER_WS_TOKEN || '';
  const server = new WebSocketServer({
    port,
    host,
    // Reject at the HANDSHAKE (401), not after accepting: a connection without
    // the token never opens, so the client cannot mistake it for a live one.
    verifyClient: (info, done) => {
      if (!token) return done(true);
      try {
        const url = new URL(info.req.url || '/', `http://${info.req.headers.host || 'localhost'}`);
        if (url.searchParams.get('token') === token) return done(true);
      } catch {
        // fall through to rejection
      }
      logger.warn('Handshake rejected: missing or invalid token');
      return done(false, 401, 'unauthorized');
    },
  });

  logger.info(`WebSocket server listening on ws://${host}:${port}${token ? ' (token required)' : ' (NO TOKEN)'}`);

  server.on('connection', (ws, req) => {
    if (token) {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.searchParams.get('token') !== token) {
        logger.warn('Connection rejected: missing or invalid token');
        ws.close(4401, 'unauthorized');
        return;
      }
    }
    logger.info('Extension connected');

    if (connection && connection.readyState === WebSocket.OPEN) {
      logger.warn('Existing extension connection is still open; closing newer duplicate connection');
      ws.close(1000, 'Existing connection active');
      return;
    }

    connection = ws;
    onConnection?.(ws);

    ws.on('message', (data) => {
      try {
        const dataStr = data.toString();
        logger.info('[WS] Raw message received, length:', dataStr.length);
        logger.info('[WS] Message preview:', dataStr.substring(0, 200));

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
      } catch (err) {
        logger.error('Failed to parse message', err);
      }
    });

    ws.on('close', () => {
      logger.info('Extension disconnected');
      if (connection === ws) {
        connection = null;
      }
      onDisconnection?.();
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', err);
    });
  });

  server.on('error', (err) => {
    logger.error('WebSocket server error', err);
  });

  return {
    server,

    getConnection() {
      return connection;
    },

    send(message: ExtensionMessage): Promise<ExtensionResponse> {
      return new Promise((resolve, reject) => {
        if (!connection || connection.readyState !== WebSocket.OPEN) {
          reject(new Error('No extension connected'));
          return;
        }

        logger.info(`[WS] Sending message id: ${message.id}, type: ${message.type}`);

        const timeout = setTimeout(() => {
          logger.error(`[WS] TIMEOUT for id: ${message.id}, type: ${message.type}`);
          pendingRequests.delete(message.id);
          reject(new Error(`Request timed out: ${message.type}`));
        }, 30000);

        pendingRequests.set(message.id, { resolve, reject, timeout });

        const jsonStr = JSON.stringify(message);
        logger.info('[WS] Sending JSON length:', jsonStr.length);
        connection.send(jsonStr);
      });
    },

    /**
     * Gracefully close the server.
     *
     * Waits for pending requests to complete (up to timeout) before
     * forcibly closing connections.
     */
    async close(): Promise<void> {
      logger.info(`[WS] Closing server, ${pendingRequests.size} pending requests`);

      // If there are pending requests, wait for them (up to 5s)
      if (pendingRequests.size > 0) {
        const pendingPromises = Array.from(pendingRequests.entries()).map(
          ([id, pending]) =>
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

      // Close connection
      if (connection) {
        connection.close();
        connection = null;
      }

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
