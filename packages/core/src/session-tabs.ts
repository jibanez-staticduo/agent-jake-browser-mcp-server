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
 *     `system`, and their closes are seen too;
 *   - a tab belongs to the session that opened it, as the tab reaper records it (the single source
 *     of ownership: this file keeps none). Acting on another live session's tab — by its own
 *     `tabId`, or by a switch/close/send-to-back that names it — answers TAB_OWNED without
 *     sending anything; browser_claim_tab hands the tab over. Tabs nobody opened (the user's) and
 *     tabs whose session ended stay adoptable;
 *   - on a browser whose extension announces `windowPerSession` (browser_list_tabs), each session
 *     opens its tabs in a window of its own, created in the background: `windowOf` remembers it,
 *     browser_new_tab carries it and the answer refreshes it (a window that died is replaced by
 *     the extension). A session that acts without a tab gets one opened first, instead of
 *     latching onto the user's active tab. Browsers without the capability behave as before.
 */
import type { Context, ExtensionResponse, ToolName } from './types.js';
import { logger } from './utils/logger.js';

/** Commands that choose or list tabs themselves, or do not touch one. */
const NOT_ROUTED = new Set<ToolName>([
  'browser_new_tab',
  'browser_switch_tab',
  'browser_list_tabs',
  'browser_wait',
] as ToolName[]);

/** Commands that do not use the tab and need not wait for the browser's queue. */
const NOT_QUEUED = new Set<ToolName>(['browser_wait'] as ToolName[]);

/** Tab ownership, served by the tab reaper (src/tab-reaper.ts). */
export interface TabOwnership {
  ownerOf(connectionId: string, tabId: number): { sessionId: string; sessionClosed: boolean } | undefined;
  claim(connectionId: string, tabId: number, sessionId: string): boolean;
}

/** Tab-management commands name their own tab in `tabId`; the others take it as an explicit target. */
const NAMES_TAB = new Set<ToolName>(['browser_switch_tab', 'browser_close_tab', 'browser_send_to_back'] as ToolName[]);

/** Whether a command may carry an explicit `tabId` that is not part of its own arguments. */
export function acceptsExplicitTab(type: string): boolean {
  return !NOT_ROUTED.has(type as ToolName) && !NAMES_TAB.has(type as ToolName) && type !== 'browser_claim_tab';
}

export interface RouteOptions {
  /** `tabId` the caller asked for on a command that does not have one of its own. */
  explicitTabId?: number;
}

export interface SessionTabs {
  /** For tests and diagnostics: the window a session opens its tabs in on a browser. */
  windowOf(sessionId: string, connectionId: string): number | undefined;
  route(context: Context, sessionId: string | undefined, connectionId: string, options?: RouteOptions): Context;
  /** The server's own calls to a browser (tab reaper): queued like the sessions', closes observed. */
  system(context: Context, connectionId: string): Context;
  exclusive<T>(connectionId: string, run: () => Promise<T>): Promise<T>;
  observeSystem(connectionId: string, type: ToolName, response: ExtensionResponse): void;
  sessionClosed(sessionId: string): void;
  /** For tests and diagnostics: the tab a session works in on a browser. */
  tabOf(sessionId: string, connectionId: string): number | undefined;
}

const key = (sessionId: string, connectionId: string) => `${sessionId}\u0000${connectionId}`;

const short = (sessionId: string) => sessionId.slice(0, 8);

export function createSessionTabs(ownership?: TabOwnership): SessionTabs {
  const tabs = new Map<string, number>();
  /** What the extension of each browser is connected to, as far as this server routed it. */
  const connected = new Map<string, { tabId: number; sessionId: string }>();
  const queues = new Map<string, Promise<unknown>>();
  const windows = new Map<string, number>();
  /** Per browser connection: whether its extension gives each session a window (probed once per connect). */
  const windowCapable = new Map<string, { epoch: string | number; windowPerSession: boolean }>();
  const epochs = new Map<string, string | number>();
  const closedSessions = new Set<string>();

  function invalidate(context: Context, connectionId: string) {
    const connection = context.listConnections().find((c) => c.connectionId === connectionId);
    const epoch = connection?.connectionEpoch ?? connection?.connectedAt ?? 0;
    if (epochs.has(connectionId) && epochs.get(connectionId) !== epoch) {
      for (const k of [...tabs.keys()]) if (k.endsWith(`\u0000${connectionId}`)) tabs.delete(k);
      // Window IDs survive only as hints: windowPerSession extensions verify their live browser witness before reuse.
      connected.delete(connectionId);
      windowCapable.delete(connectionId);
    }
    epochs.set(connectionId, epoch);
    return epoch;
  }

  function queued<T>(connectionId: string, run: () => Promise<T>): Promise<T> {
    const tail = queues.get(connectionId) ?? Promise.resolve();
    const result = tail.then(run, run);
    queues.set(connectionId, result.catch(() => undefined));
    return result;
  }

  function observe(sessionId: string | undefined, connectionId: string, type: ToolName, payload: Record<string, unknown>, response: ExtensionResponse) {
    if (sessionId && closedSessions.has(sessionId)) return;
    const result = (response.result ?? {}) as Record<string, unknown>;
    if (!response.success) {
      if (response.error?.code === 'TAB_GONE' && sessionId) forget(sessionId, connectionId);
      return;
    }
    if (type === 'browser_close_window') {
      for (const id of Array.isArray(result.closedTabIds) ? result.closedTabIds : []) if (typeof id === 'number') closed(connectionId, id);
      for (const [k, w] of [...windows]) if (w === result.windowId && k.endsWith(`\u0000${connectionId}`)) windows.delete(k);
      return;
    }
    if (type === 'browser_new_tab' && sessionId) {
      const tab = (result.tab ?? {}) as { windowId?: unknown };
      const windowId = typeof result.windowId === 'number' ? result.windowId : tab.windowId;
      if (typeof windowId === 'number') windows.set(key(sessionId, connectionId), windowId);
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

  async function windowPerSession(context: Context, connectionId: string): Promise<boolean> {
    const epoch = invalidate(context, connectionId);
    const known = windowCapable.get(connectionId);
    if (known && known.epoch === epoch) return known.windowPerSession;
    const listing = await context.send('browser_list_tabs').catch(() => undefined);
    const raw = listing?.success ? (listing.result as { windowPerSession?: unknown } | undefined) : undefined;
    const announced = !Array.isArray(raw) && raw?.windowPerSession === true;
    // A failed probe is not cached: the next command asks again.
    if (listing?.success) windowCapable.set(connectionId, { epoch, windowPerSession: announced });
    return announced;
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

  /** TAB_OWNED when the tab belongs to another live session; undefined when this one may act in it. */
  function ownedByOther(sessionId: string, connectionId: string, tabId: number): ExtensionResponse | undefined {
    const owner = ownership?.ownerOf(connectionId, tabId);
    if (!owner || owner.sessionId === sessionId || owner.sessionClosed) return undefined;
    return {
      id: '',
      success: false,
      error: {
        code: 'TAB_OWNED',
        message:
          `TAB_OWNED: la pestaña ${tabId} es de la sesión ${short(owner.sessionId)} ` +
          `(tab ${tabId} belongs to session ${short(owner.sessionId)}); toma el control con browser_claim_tab`,
      },
    };
  }

  function claimTab(sessionId: string | undefined, connectionId: string, tabId: number): { ok: boolean; message?: string } {
    if (sessionId && closedSessions.has(sessionId)) return { ok: false, message: 'MCP session has closed.' };
    if (!sessionId || !ownership) return { ok: false, message: 'browser_claim_tab needs an MCP session over the HTTP transport.' };
    const owner = ownership.ownerOf(connectionId, tabId);
    if (!owner) {
      return {
        ok: false,
        message:
          `Tab ${tabId} is not one an agent opened (it may be the user's own), so there is nothing to claim: ` +
          'adopt it with browser_switch_tab.',
      };
    }
    if (!ownership.claim(connectionId, tabId, sessionId)) return { ok: false, message: `Tab ${tabId} is unavailable or cleanup is in progress.` };
    if (owner.sessionId !== sessionId) {
      // The session that had it no longer works in it.
      for (const [k, t] of [...tabs]) if (t === tabId && k.endsWith(`\u0000${connectionId}`) && !k.startsWith(`${sessionId}\u0000`)) tabs.delete(k);
    }
    adopt(sessionId, connectionId, tabId);
    return { ok: true };
  }

  function route(rawContext: Context, sessionId: string | undefined, connectionId: string, options: RouteOptions = {}): Context {
    const context: Context = {
      ...rawContext,
      send: async (type, payload, ...rest) => {
        const epoch = invalidate(rawContext, connectionId);
        const response = await rawContext.send(type, payload, ...rest);
        if (invalidate(rawContext, connectionId) !== epoch) return {
          id: response.id, success: false,
          error: { code: 'CONNECTION_CHANGED', message: 'Browser reconnected during this command. Retry on the current connection.' },
        };
        return response;
      },
    };
    return {
      ...context,
      claimTab: (tabId) => queued(connectionId, async () => {
        invalidate(context, connectionId);
        return claimTab(sessionId, connectionId, tabId);
      }),
      send: (type, payload = {}, ...rest) => {
        const run = async (): Promise<ExtensionResponse> => {
          invalidate(context, connectionId);
          if (sessionId && closedSessions.has(sessionId)) return { id: '', success: false, error: { code: 'SESSION_CLOSED', message: 'MCP session has closed.' } };
          if (sessionId) {
            const named = NAMES_TAB.has(type) && typeof payload.tabId === 'number' ? payload.tabId : options.explicitTabId;
            const target = named ?? (NOT_ROUTED.has(type) ? undefined : tabs.get(key(sessionId, connectionId)));
            const refused = target === undefined ? undefined : ownedByOther(sessionId, connectionId, target);
            if (refused) return refused;
          }
          if (!sessionId || NOT_ROUTED.has(type)) {
            let sent = payload;
            if (sessionId && type === 'browser_new_tab' && await windowPerSession(context, connectionId)) {
              const windowId = windows.get(key(sessionId, connectionId));
              if (windowId !== undefined && sent.windowId === undefined) sent = { ...payload, windowId };
            }
            const response = await context.send(type, sent, ...rest);
            if (sessionId) observe(sessionId, connectionId, type, payload, response);
            return response;
          }
          const explicit = acceptsExplicitTab(type) ? options.explicitTabId : undefined;
          if (explicit !== undefined) {
            // An explicit target is sent as it is: it does not become the session's tab.
            const response = await context.send(type, { ...payload, targetTabId: explicit }, ...rest);
            observe(sessionId, connectionId, type, payload, response);
            return response;
          }
          let mine = tabs.get(key(sessionId, connectionId));
          if (mine === undefined && await windowPerSession(context, connectionId)) {
            // The session acts without a tab: open its own (in its window) rather than use the user's.
            const windowId = windows.get(key(sessionId, connectionId));
            const opened = await context.send('browser_new_tab', { url: 'about:blank', ...(windowId !== undefined ? { windowId } : {}) });
            observe(sessionId, connectionId, 'browser_new_tab', { url: 'about:blank' }, opened);
            if (!opened.success) return opened;
            mine = tabs.get(key(sessionId, connectionId));
          }
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
    closedSessions.add(sessionId);
    for (const k of [...tabs.keys()]) if (k.startsWith(`${sessionId}\u0000`)) tabs.delete(k);
    for (const k of [...windows.keys()]) if (k.startsWith(`${sessionId}\u0000`)) windows.delete(k);
    // The connected tab stays this session's until it closes or someone picks it: it may be a
    // tab held open for Dani (keepOpenMinutes), and a session without a tab must not act in it.
    logger.info(`[session-tabs] session ${sessionId} closed: its tab routing is forgotten`);
  }

  return {
    route,
    system,
    exclusive: queued,
    observeSystem: (connectionId, type, response) => observe(undefined, connectionId, type, {}, response),
    sessionClosed,
    tabOf: (s, c) => tabs.get(key(s, c)),
    windowOf: (s, c) => windows.get(key(s, c)),
  };
}
