/**
 * Each MCP session works in its own tab, even when several share one browser.
 *
 * The extension follows one tab at a time per browser. Before this, a second session on the
 * same browser sent its commands to whatever tab the first one had connected: a click meant
 * for one tab landed in another session's page. Now:
 *
 *   - the session's tab is the one it opened (browser_new_tab) or picked (browser_switch_tab);
 *   - every other command carries it as `targetTabId`, and the extension connects to it first
 *     (without activating it) — agent-browser-extension routeToTargetTab;
 *   - commands to one browser run one at a time, so two sessions never interleave inside a
 *     command (the extension handles messages concurrently);
 *   - a session without a tab of its own may not act while the connected tab is another
 *     session's — also one whose session already ended (a payment tab held open for Dani's tap
 *     with keepOpenMinutes): it gets an error asking it to open or pick one;
 *   - the server's own calls (the tab reaper closing idle tabs) go through the same queue via
 *     `system`, and their closes are seen too.
 */
import type { Context, ExtensionResponse, ToolName } from './types.js';
import { logger } from './utils/logger.js';

/** Commands that choose or list tabs themselves, or do not touch one. */
const NOT_ROUTED = new Set<ToolName>([
  'browser_new_tab',
  'browser_switch_tab',
  'browser_list_tabs',
  'browser_wait',
  'browser_reload_extension',
] as ToolName[]);

/** Commands that do not use the tab and need not wait for the browser's queue. */
const NOT_QUEUED = new Set<ToolName>(['browser_wait'] as ToolName[]);

export interface SessionTabs {
  route(context: Context, sessionId: string | undefined, connectionId: string): Context;
  /** The server's own calls to a browser (tab reaper): queued like the sessions', closes observed. */
  system(context: Context, connectionId: string): Context;
  sessionClosed(sessionId: string): void;
  /** For tests and diagnostics: the tab a session works in on a browser. */
  tabOf(sessionId: string, connectionId: string): number | undefined;
}

const key = (sessionId: string, connectionId: string) => `${sessionId}\u0000${connectionId}`;

export function createSessionTabs(): SessionTabs {
  const tabs = new Map<string, number>();
  /** What the extension of each browser is connected to, as far as this server routed it. */
  const connected = new Map<string, { tabId: number; sessionId: string }>();
  const queues = new Map<string, Promise<unknown>>();

  function queued<T>(connectionId: string, run: () => Promise<T>): Promise<T> {
    const tail = queues.get(connectionId) ?? Promise.resolve();
    const result = tail.then(run, run);
    queues.set(connectionId, result.catch(() => undefined));
    return result;
  }

  function observe(sessionId: string | undefined, connectionId: string, type: ToolName, payload: Record<string, unknown>, response: ExtensionResponse) {
    const result = (response.result ?? {}) as Record<string, unknown>;
    if (!response.success) {
      if (response.error?.code === 'TAB_GONE' && sessionId) forget(sessionId, connectionId);
      return;
    }
    if (!sessionId) {
      if (type === 'browser_close_tab') closed(connectionId, typeof result.tabId === 'number' ? result.tabId : undefined);
      return;
    }
    if (type === 'browser_new_tab') {
      const tab = (result.tab ?? {}) as { id?: number; connected?: boolean };
      const tabId = tab.id ?? (result.tabId as number | undefined);
      if (typeof tabId === 'number' && tab.connected !== false) adopt(sessionId, connectionId, tabId);
    } else if (type === 'browser_switch_tab' && typeof payload.tabId === 'number') {
      adopt(sessionId, connectionId, payload.tabId);
    } else if (type === 'browser_close_tab') {
      closed(connectionId, typeof result.tabId === 'number' ? result.tabId : undefined);
    }
  }

  /** A tab closed on a browser: no session works in it any more. */
  function closed(connectionId: string, tabId: number | undefined) {
    if (tabId === undefined) return;
    for (const [k, t] of [...tabs]) if (t === tabId && k.endsWith(`\u0000${connectionId}`)) tabs.delete(k);
    if (connected.get(connectionId)?.tabId === tabId) connected.delete(connectionId);
  }

  function adopt(sessionId: string, connectionId: string, tabId: number) {
    tabs.set(key(sessionId, connectionId), tabId);
    connected.set(connectionId, { tabId, sessionId });
  }

  function forget(sessionId: string, connectionId: string) {
    const tabId = tabs.get(key(sessionId, connectionId));
    tabs.delete(key(sessionId, connectionId));
    if (tabId !== undefined && connected.get(connectionId)?.tabId === tabId) connected.delete(connectionId);
  }

  function route(context: Context, sessionId: string | undefined, connectionId: string): Context {
    return {
      ...context,
      send: (type, payload = {}, ...rest) => {
        const run = async (): Promise<ExtensionResponse> => {
          if (!sessionId || NOT_ROUTED.has(type)) {
            const response = await context.send(type, payload, ...rest);
            if (sessionId) observe(sessionId, connectionId, type, payload, response);
            return response;
          }
          const mine = tabs.get(key(sessionId, connectionId));
          if (mine === undefined) {
            const other = connected.get(connectionId);
            if (other && other.sessionId !== sessionId) {
              return {
                id: '',
                success: false,
                error: {
                  code: 'NO_SESSION_TAB',
                  message: 'NO_SESSION_TAB: this session has no tab of its own on this browser, and the connected tab belongs to another session. Open one with browser_new_tab or pick one with browser_switch_tab.',
                },
              };
            }
            const response = await context.send(type, payload, ...rest);
            observe(sessionId, connectionId, type, payload, response);
            return response;
          }
          const response = await context.send(type, { ...payload, targetTabId: mine }, ...rest);
          if (response.success) connected.set(connectionId, { tabId: mine, sessionId });
          observe(sessionId, connectionId, type, payload, response);
          return response;
        };
        return NOT_QUEUED.has(type) ? run() : queued(connectionId, run);
      },
    };
  }

  function system(context: Context, connectionId: string): Context {
    return {
      ...context,
      send: (type, payload = {}, ...rest) => queued(connectionId, async () => {
        const response = await context.send(type, payload, ...rest);
        observe(undefined, connectionId, type, payload, response);
        return response;
      }),
    };
  }

  function sessionClosed(sessionId: string) {
    for (const k of [...tabs.keys()]) if (k.startsWith(`${sessionId}\u0000`)) tabs.delete(k);
    // The connected tab stays this session's until it closes or someone picks it: it may be a
    // tab held open for Dani (keepOpenMinutes), and a session without a tab must not act in it.
    logger.info(`[session-tabs] session ${sessionId} closed: its tab routing is forgotten`);
  }

  return { route, system, sessionClosed, tabOf: (s, c) => tabs.get(key(s, c)) };
}
