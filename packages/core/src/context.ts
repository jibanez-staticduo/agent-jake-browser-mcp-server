/**
 * Context manager for WebSocket communication with the extension.
 *
 * The context is also the per-call handle: `forConnection(id)` binds a tool call
 * to one browser, so concurrent connections do not bleed into each other.
 */
import { randomUUID } from 'crypto';
import { createWSServer, type WSServer } from './ws-server.js';
import type { TokenStore } from './token-store.js';
import { logger } from './utils/logger.js';
import type { BrowserConnectionInfo, Context, ToolName, ExtensionResponse } from './types.js';

export interface ContextOptions {
  port: number;
  host?: string;
  tokenStore?: TokenStore;
}

export interface ContextManager extends Context {
  wsServer: WSServer;
  /** Bind a tool call to one browser connection (undefined = most recently used). */
  forConnection(connectionId?: string): Context;
  listConnections(): BrowserConnectionInfo[];
  waitForConnection(timeout?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a context manager for tool execution.
 */
export function createContext(options: ContextOptions): ContextManager {
  const { port } = options;

  let connectionPromise: Promise<void> | null = null;
  let connectionResolve: (() => void) | null = null;

  const wsServer = createWSServer({
    port,
    host: options.host,
    tokenStore: options.tokenStore,
    onConnection: (_ws, connectionId) => {
      if (connectionResolve) {
        connectionResolve();
        connectionResolve = null;
        connectionPromise = null;
      }
      logger.info(`Connection ${connectionId} available for tool calls`);
    },
    onDisconnection: (connectionId) => {
      logger.warn(`Extension ${connectionId} disconnected, waiting for reconnection...`);
    },
  });

  function isConnectedFor(connectionId?: string): boolean {
    return wsServer.getConnection(connectionId) !== null;
  }

  function sendFor(
    connectionId: string | undefined,
    type: ToolName,
    payload: Record<string, unknown> = {},
  ): Promise<ExtensionResponse> {
    const id = randomUUID();
    return wsServer.sendTo(connectionId, { id, type, payload });
  }

  function waitForAnyConnection(timeout: number = 30000): Promise<void> {
    if (isConnectedFor()) {
      return Promise.resolve();
    }

    if (connectionPromise) {
      return connectionPromise;
    }

    connectionPromise = new Promise((resolve, reject) => {
      connectionResolve = resolve;

      const timer = setTimeout(() => {
        connectionResolve = null;
        connectionPromise = null;
        reject(new Error('Timeout waiting for extension connection'));
      }, timeout);

      // Clear timeout if a connection succeeds
      const originalResolve = connectionResolve;
      connectionResolve = () => {
        clearTimeout(timer);
        originalResolve?.();
      };
    });

    return connectionPromise;
  }

  const manager: ContextManager = {
    wsServer,

    isConnected(connectionId?: string): boolean {
      return isConnectedFor(connectionId);
    },

    listConnections(): BrowserConnectionInfo[] {
      return wsServer.listConnectionInfos();
    },

    send(type: ToolName, payload: Record<string, unknown> = {}, connectionId?: string) {
      return sendFor(connectionId, type, payload);
    },

    forConnection(connectionId?: string): Context {
      return {
        send: (type, payload = {}) => sendFor(connectionId, type, payload),
        isConnected: (id?: string) => isConnectedFor(id ?? connectionId),
        listConnections: () => wsServer.listConnectionInfos(),
        waitForConnection: (timeout?: number) => waitForAnyConnection(timeout),
      };
    },

    waitForConnection(timeout?: number): Promise<void> {
      return waitForAnyConnection(timeout);
    },

    async close(): Promise<void> {
      await wsServer.close();
    },
  };

  return manager;
}
