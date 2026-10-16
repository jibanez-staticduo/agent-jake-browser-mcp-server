/**
 * Closes the tabs an agent opened once nobody needs them, so the browser does not fill up.
 *
 * A tab is the agent's when its MCP session opened it: `browser_new_tab`, or a click that
 * opened one (`newTabOpened`). Tabs the agent only switched to — the user's own — are never
 * tracked and never closed.
 *
 * An agent tab closes when either:
 *   - all MCP sessions using it end (DELETE /mcp, transport closed), or
 *   - it has gone `idleMs` without use: no call targeted it and no participating session made a call.
 * `keepOpenMinutes` on browser_new_tab / browser_switch_tab holds it open until then, for a
 * tab that waits on a person (a payment ready for a human to confirm) after its session is gone.
 *
 * Chrome reuses tab ids after a restart. A socket reconnection invalidates all tracked tabs:
 * neither the numeric id nor its URL proves that it is still the tab the agent opened.
 *
 * Extension builds that predate closing by id ignored the id of browser_close_tab and closed the
 * connected tab. So the reaper closes only on a browser whose tab listing announces
 * `closeById`, and a close counts only when the extension echoes the id it closed; a browser
 * that ever answers without that echo is left alone from then on.
 */
import type { BrowserConnectionInfo, Context, ExtensionResponse, ToolName } from './types.js';
import { logger } from './utils/logger.js';

export const MAX_KEEP_MINUTES = 24 * 60;

interface TrackedTab {
  connectionId: string;
  tabId: number;
  sessionId: string;
  participants: Set<string>;
  lastUsed: number;
  keepUntil: number;
  url: string;
  windowId?: number;
  /** connectedAt of the browser connection when `url` was last observed. */
  connectedAt: number;
  connectionEpoch: string | number;
  sessionClosed: boolean;
}

interface ListedTab {
  id: number;
  url: string;
  windowId?: number;
}

export interface TabReaperOptions {
  idleMs: number;
  /** Raw access to the extension: send to one connection, list the connections. */
  send(connectionId: string, type: ToolName, payload?: Record<string, unknown>): Promise<ExtensionResponse>;
  listConnections(): BrowserConnectionInfo[];
  now?: () => number;
  /** Serialize the whole listing/revalidation/close transaction with session commands and claims. */
  exclusive?<T>(connectionId: string, run: () => Promise<T>): Promise<T>;
}

export interface TabReaper {
  /**
   * Wrap a per-call context so the reaper sees what the call opens, switches to and closes.
   * `keepOpenMinutes` holds the tab the call opens or switches to (see keep).
   */
  track(
    context: Context,
    sessionId: string | undefined,
    connectionId: string | undefined,
    keepOpenMinutes?: number,
  ): Context;
  /** The session made a call: its tabs are in use. */
  touchSession(sessionId: string | undefined): void;
  /** Hold a tab open for `minutes` (capped at MAX_KEEP_MINUTES) whatever its session does. */
  keep(connectionId: string | undefined, tabId: number, minutes: number): void;
  sessionClosed(sessionId: string): Promise<void>;
  /** Close every tab that is due. Returns how many it closed. */
  sweep(): Promise<number>;
  tracked(): ReadonlyArray<Readonly<TrackedTab>>;
  ownerOf(connectionId: string, tabId: number): { sessionId: string; sessionClosed: boolean } | undefined;
  claim(connectionId: string, tabId: number, sessionId: string): boolean;
}

const key = (connectionId: string, tabId: number) => `${connectionId}:${tabId}`;

/**
 * Tools that manage tabs instead of acting on the page: they use the tab they name by id, never
 * the connected one. Another session listing or opening tabs is not working in this one.
 */
const TAB_MANAGEMENT = new Set<ToolName>([
  'browser_new_tab',
  'browser_list_tabs',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_send_to_back',
]);

function listedTabs(response: ExtensionResponse): ListedTab[] {
  const raw = response.result as ListedTab[] | { tabs?: ListedTab[] } | undefined;
  const tabs = Array.isArray(raw) ? raw : raw?.tabs ?? [];
  return tabs.filter((t) => typeof t?.id === 'number');
}

/** Only extension builds that close the tab they are asked for say so in their listing. */
function closesById(response: ExtensionResponse): boolean {
  const raw = response.result as { closeById?: unknown } | undefined;
  return !Array.isArray(raw) && raw?.closeById === true;
}

export function createTabReaper(options: TabReaperOptions): TabReaper {
  const now = options.now ?? Date.now;
  const tabs = new Map<string, TrackedTab>();
  const currentTab = new Map<string, number>();
  let sweeping: Promise<number> | null = null;
  /** Browsers whose extension closed a tab without echoing its id: never closed again. */
  const unsafe = new Set<string>();
  const inFlight = new Map<string, number>();
  const activeSessions = new Map<string, number>();
  const closedSessions = new Set<string>();
  const closing = new Set<string>();

  const connectedAtOf = (connectionId: string) =>
    options.listConnections().find((c) => c.connectionId === connectionId)?.connectedAt ?? 0;
  const epochOf = (connectionId: string) => {
    const connection = options.listConnections().find((c) => c.connectionId === connectionId && c.open);
    return connection?.connectionEpoch ?? connection?.connectedAt;
  };

  function invalidate(connectionId: string) {
    for (const [id, tab] of tabs) {
      if (tab.connectionId === connectionId && tab.connectionEpoch !== epochOf(connectionId)) tabs.delete(id);
    }
    currentTab.delete(connectionId);
  }

  function touch(connectionId: string, tabId: number | undefined, sessionId: string) {
    if (tabId === undefined) return;
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab) return;
    tab.lastUsed = now();
    if (closedSessions.has(sessionId)) return;
    tab.participants.add(sessionId);
    if (tab.sessionClosed && tab.sessionId !== sessionId) {
      // Its session is gone and another one works in it (e.g. the step that confirms a held payment):
      // the tab is now that session's, and closes when that one ends.
      tab.sessionId = sessionId;
      tab.sessionClosed = false;
    }
  }

  function adopt(sessionId: string, connectionId: string, tabId: number, url: string, windowId?: number) {
    if (tabs.has(key(connectionId, tabId))) return;
    tabs.set(key(connectionId, tabId), {
      connectionId,
      tabId,
      sessionId,
      participants: new Set(closedSessions.has(sessionId) ? [] : [sessionId]),
      lastUsed: now(),
      keepUntil: 0,
      url,
      windowId,
      connectedAt: connectedAtOf(connectionId),
      connectionEpoch: epochOf(connectionId)!,
      sessionClosed: closedSessions.has(sessionId),
    });
    logger.info(`[tab-reaper] tab ${tabId} on ${connectionId} belongs to session ${sessionId}`);
  }

  function observe(
    sessionId: string,
    connectionId: string,
    type: ToolName,
    payload: Record<string, unknown>,
    response: ExtensionResponse,
    keepOpenMinutes: number | undefined,
  ) {
    if (!response.success) return;
    const result = (response.result ?? {}) as Record<string, unknown>;

    if (type === 'browser_new_tab') {
      // The extension answers { tab: { id, url, connected } }; older builds answered { tabId }.
      const tab = (result.tab ?? {}) as { id?: number; url?: string; connected?: boolean; windowId?: number };
      const tabId = tab.id ?? (result.tabId as number | undefined);
      if (typeof tabId !== 'number') return;
      adopt(sessionId, connectionId, tabId, tab.url || String(payload.url ?? ''), tab.windowId ?? (result.windowId as number | undefined));
      if (tab.connected !== false) currentTab.set(connectionId, tabId);
      if (keepOpenMinutes !== undefined) keep(connectionId, tabId, keepOpenMinutes);
      return;
    }

    const opened = result.newTabOpened as { id?: number; url?: string; windowId?: number } | undefined;
    if (typeof opened?.id === 'number') adopt(sessionId, connectionId, opened.id, opened.url ?? '', opened.windowId);

    if (type === 'browser_switch_tab' && typeof payload.tabId === 'number') {
      currentTab.set(connectionId, payload.tabId);
      if (keepOpenMinutes !== undefined) keep(connectionId, payload.tabId, keepOpenMinutes);
    } else if (type === 'browser_close_tab') {
      // The echo says which tab really closed; without one, the id asked for or the connected tab.
      const closed = typeof result.tabId === 'number'
        ? result.tabId
        : typeof payload.tabId === 'number' ? payload.tabId : currentTab.get(connectionId);
      if (closed !== undefined) {
        tabs.delete(key(connectionId, closed));
        if (currentTab.get(connectionId) === closed) currentTab.delete(connectionId);
      }
    }
  }

  function track(
    context: Context,
    sessionId: string | undefined,
    connectionId: string | undefined,
    keepOpenMinutes?: number,
  ): Context {
    if (!sessionId || !connectionId) return context;
    return {
      ...context,
      send: async (type, payload = {}, ...rest) => {
        if (closing.has(connectionId)) {
          return { id: '', success: false, error: {
            code: 'TAB_CLEANUP_IN_PROGRESS',
            message: 'A tab is being closed on this browser. Retry after cleanup finishes.',
          } };
        }
        const epoch = epochOf(connectionId);
        if ([...tabs.values()].some((tab) => tab.connectionId === connectionId && tab.connectionEpoch !== epoch)) {
          invalidate(connectionId);
        }
        inFlight.set(connectionId, (inFlight.get(connectionId) ?? 0) + 1);
        activeSessions.set(sessionId, (activeSessions.get(sessionId) ?? 0) + 1);
        const named = typeof payload.tabId === 'number' ? payload.tabId : typeof payload.targetTabId === 'number' ? payload.targetTabId : undefined;
        touch(connectionId, named ?? (TAB_MANAGEMENT.has(type) ? undefined : currentTab.get(connectionId)), sessionId);
        try {
          const response = await context.send(type, payload, ...rest);
          if (epoch !== undefined && epoch === epochOf(connectionId)) {
            observe(sessionId, connectionId, type, payload, response, keepOpenMinutes);
            touch(connectionId, named ?? (TAB_MANAGEMENT.has(type) ? undefined : currentTab.get(connectionId)), sessionId);
          }
          return response;
        } finally {
          const remaining = (inFlight.get(connectionId) ?? 1) - 1;
          if (remaining) inFlight.set(connectionId, remaining);
          else inFlight.delete(connectionId);
          const sessionRemaining = (activeSessions.get(sessionId) ?? 1) - 1;
          if (sessionRemaining) activeSessions.set(sessionId, sessionRemaining);
          else activeSessions.delete(sessionId);
          touchSession(sessionId);
          if (closedSessions.has(sessionId)) void (sweeping ?? Promise.resolve()).then(() => sweep());
        }
      },
    };
  }

  function touchSession(sessionId: string | undefined) {
    if (!sessionId) return;
    const t = now();
    for (const tab of tabs.values()) if (tab.participants.has(sessionId)) tab.lastUsed = t;
  }

  function keep(connectionId: string | undefined, tabId: number, minutes: number) {
    if (!connectionId) return;
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab) return;
    if (!Number.isFinite(minutes) || minutes < 0) return;
    const capped = Math.min(minutes, MAX_KEEP_MINUTES);
    tab.keepUntil = Math.max(tab.keepUntil, now() + capped * 60_000);
  }

  const isDue = (tab: TrackedTab, t: number) =>
    options.idleMs > 0 && t >= tab.keepUntil && (tab.participants.size === 0 || t - tab.lastUsed >= options.idleMs);

  async function closeTab(tab: TrackedTab): Promise<boolean> {
    const answer = await options.send(tab.connectionId, 'browser_close_tab', { tabId: tab.tabId }).catch(
      (error: Error) => ({ success: false, error: { code: 'SEND_FAILED', message: error.message } }) as ExtensionResponse,
    );
    if (!answer.success) {
      logger.warn(`[tab-reaper] could not close tab ${tab.tabId} on ${tab.connectionId}: ${answer.error?.message}`);
      return false;
    }
    const echoed = (answer.result as { tabId?: unknown } | undefined)?.tabId;
    if (echoed !== tab.tabId) {
      unsafe.add(tab.connectionId);
      logger.error(
        `[tab-reaper] ${tab.connectionId} did not confirm closing tab ${tab.tabId}: ` +
          'its extension does not close by id (needs an extension that announces closeById); no more closing on that browser',
      );
      return false;
    }
    logger.info(
      `[tab-reaper] closed tab ${tab.tabId} on ${tab.connectionId} (session ${tab.sessionId}, ${tab.sessionClosed ? 'session ended' : 'idle'})`,
    );
    return true;
  }

  function forget(tab: TrackedTab) {
    if (tabs.get(key(tab.connectionId, tab.tabId)) !== tab) return;
    tabs.delete(key(tab.connectionId, tab.tabId));
    if (currentTab.get(tab.connectionId) === tab.tabId) currentTab.delete(tab.connectionId);
  }

  const eligible = (tab: TrackedTab) =>
    tabs.get(key(tab.connectionId, tab.tabId)) === tab && !inFlight.has(tab.connectionId) &&
    ![...tab.participants].some((sessionId) => activeSessions.has(sessionId)) &&
    !activeSessions.has(tab.sessionId) && isDue(tab, now());

  async function closeWindow(connection: BrowserConnectionInfo, windowId: number, group: TrackedTab[]): Promise<number> {
    const ids = group.map((tab) => tab.tabId);
    const answer = await options.send(connection.connectionId, 'browser_close_window', { windowId, tabIds: ids });
    if (!answer.success) return -1; // The per-tab fallback can handle an unsupported/forgotten window.
    const result = answer.result as { windowId?: unknown; closedTabIds?: unknown } | undefined;
    const echoed = result?.closedTabIds;
    if (result?.windowId !== windowId || !Array.isArray(echoed) ||
        echoed.some((id) => !ids.includes(id)) || new Set(echoed).size !== echoed.length) {
      unsafe.add(connection.connectionId);
      logger.error(`[tab-reaper] invalid window-close acknowledgement on ${connection.connectionId}; no more cleanup`);
      return 0;
    }
    if (epochOf(connection.connectionId) !== (connection.connectionEpoch ?? connection.connectedAt)) {
      invalidate(connection.connectionId);
      return 0;
    }
    let closed = 0;
    for (const tab of group) if (echoed.includes(tab.tabId)) { forget(tab); closed++; }
    if (closed < group.length) {
      // Chrome may lose or move a tab between listing and removal. Absence is not a wrong-target echo.
      const listing = await options.send(connection.connectionId, 'browser_list_tabs');
      if (epochOf(connection.connectionId) !== (connection.connectionEpoch ?? connection.connectedAt)) {
        invalidate(connection.connectionId);
        return closed;
      }
      if (listing.success) {
        const live = new Map(listedTabs(listing).map((tab) => [tab.id, tab]));
        for (const tab of group) {
          if (echoed.includes(tab.tabId)) continue;
          const current = live.get(tab.tabId);
          if (!current) forget(tab);
          else { tab.url = current.url; tab.windowId = current.windowId; }
        }
      }
    }
    return closed;
  }

  async function sweepConnection(connection: BrowserConnectionInfo, mine: TrackedTab[]): Promise<number> {
    const epoch = connection.connectionEpoch ?? connection.connectedAt;
    if (mine.some((tab) => tab.connectionEpoch !== epoch)) {
      invalidate(connection.connectionId);
      mine = mine.filter((tab) => tab.connectionEpoch === epoch);
    }
    if (!mine.length || inFlight.has(connection.connectionId)) return 0;
    const listing = await options.send(connection.connectionId, 'browser_list_tabs');
    if (!listing.success) return 0;
    if (epochOf(connection.connectionId) !== epoch) { invalidate(connection.connectionId); return 0; }
    const listed = listedTabs(listing);
    const open = new Map(listed.map((tab) => [tab.id, tab]));
    const due: TrackedTab[] = [];
    for (const tab of mine) {
      if (tabs.get(key(tab.connectionId, tab.tabId)) !== tab) continue;
      const live = open.get(tab.tabId);
      if (!live) { forget(tab); continue; }
      tab.windowId = live.windowId;
      if (eligible(tab)) due.push(tab);
      else { tab.url = live.url; tab.connectedAt = connection.connectedAt; }
    }
    if (!closesById(listing) || unsafe.has(connection.connectionId)) return 0;
    let closed = 0;
    const done = new Set<TrackedTab>();
    const capabilities = listing.result as { closeWindow?: unknown };
    const groups = new Map<number, TrackedTab[]>();
    if (capabilities.closeWindow === true) {
      for (const tab of due) if (typeof tab.windowId === 'number') {
        groups.set(tab.windowId, [...(groups.get(tab.windowId) ?? []), tab]);
      }
    }
    for (const [windowId, group] of groups) {
      const ids = new Set(group.map((tab) => tab.tabId));
      if (listed.some((tab) => tab.windowId === windowId && !ids.has(tab.id))) continue;
      if (unsafe.has(connection.connectionId)) break;
      if (epochOf(connection.connectionId) !== epoch) { invalidate(connection.connectionId); return closed; }
      // Ownership/use is checked inside the connection transaction, immediately before close.
      if (!group.every(eligible)) continue;
      closing.add(connection.connectionId);
      try {
        const count = await closeWindow(connection, windowId, group);
        if (count >= 0) {
          closed += count;
          for (const tab of group) done.add(tab);
        }
      } finally { closing.delete(connection.connectionId); }
    }
    for (const tab of due) {
      if (done.has(tab) || unsafe.has(connection.connectionId) || !eligible(tab)) continue;
      if (epochOf(connection.connectionId) !== epoch) { invalidate(connection.connectionId); break; }
      closing.add(connection.connectionId);
      try {
        if (await closeTab(tab)) { closed++; forget(tab); }
      } finally { closing.delete(connection.connectionId); }
    }
    return closed;
  }

  async function runSweep(): Promise<number> {
    if (options.idleMs <= 0) return 0;
    let closed = 0;
    for (const connection of options.listConnections()) {
      if (connection.open === false) continue;
      const mine = [...tabs.values()].filter((tab) => tab.connectionId === connection.connectionId);
      if (!mine.length) continue;
      try {
        const run = () => sweepConnection(connection, mine);
        closed += await (options.exclusive ? options.exclusive(connection.connectionId, run) : run());
      } catch (error) {
        logger.warn(`[tab-reaper] sweep of ${connection.connectionId} failed: ${(error as Error).message}`);
      }
    }
    for (const sessionId of closedSessions) {
      if (!activeSessions.has(sessionId) && ![...tabs.values()].some((tab) => tab.sessionId === sessionId || tab.participants.has(sessionId))) {
        closedSessions.delete(sessionId);
      }
    }
    return closed;
  }

  function sweep(): Promise<number> {
    sweeping ??= runSweep().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  async function sessionClosed(sessionId: string) {
    if (activeSessions.has(sessionId) || [...tabs.values()].some((tab) => tab.sessionId === sessionId || tab.participants.has(sessionId))) {
      closedSessions.add(sessionId);
    }
    let any = false;
    for (const tab of tabs.values()) {
      if (tab.participants.delete(sessionId)) any = true;
      if (tab.sessionId === sessionId) {
        tab.sessionClosed = true;
        any = true;
      }
    }
    if (any) {
      const pending = sweeping;
      await sweep();
      // A running sweep may have snapshotted connections/tabs before this session ended.
      if (pending) await sweep();
    }
  }

  function ownerOf(connectionId: string, tabId: number) {
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab || tab.connectionEpoch !== epochOf(connectionId)) return undefined;
    return { sessionId: tab.sessionId, sessionClosed: tab.sessionClosed };
  }

  function claim(connectionId: string, tabId: number, sessionId: string): boolean {
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab || closing.has(connectionId) || closedSessions.has(sessionId) || tab.connectionEpoch !== epochOf(connectionId)) return false;
    tab.sessionId = sessionId;
    tab.sessionClosed = false;
    tab.participants = new Set([sessionId]);
    tab.lastUsed = now();
    return true;
  }

  return {
    track,
    touchSession,
    keep,
    sessionClosed,
    sweep,
    tracked: () => [...tabs.values()],
    ownerOf,
    claim,
  };
}

/** AGENT_BROWSER_TAB_IDLE_MINUTES: minutes without use before an agent tab closes; 0 turns it off. */
export function idleMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AGENT_BROWSER_TAB_IDLE_MINUTES ?? '').trim();
  if (raw === '') return 60;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}
