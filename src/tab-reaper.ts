/**
 * Closes the tabs an agent opened once nobody needs them, so the browser does not fill up.
 *
 * A tab is the agent's when its MCP session opened it: `browser_new_tab`, or a click that
 * opened one (`newTabOpened`). Tabs the agent only switched to — the user's own — are never
 * tracked and never closed.
 *
 * An agent tab closes when either:
 *   - its MCP session ends (DELETE /mcp, transport closed), or
 *   - it has gone `idleMs` without use: no call targeted it and its session made no call.
 * `keepOpenMinutes` on browser_new_tab / browser_switch_tab holds it open until then, for a
 * tab that waits on a person (a payment ready for Dani's tap) after its session is gone.
 *
 * On a browser that gives each session a window of its own (`closeWindow` in the listing), a
 * window whose tracked tabs are all due closes in one piece with `browser_close_window`; one
 * that also holds a tab we did not open, or a tab still wanted (keepOpenMinutes), loses only the
 * due tabs.
 *
 * Chrome reuses tab ids after a restart, so a tab is closed only after the browser lists it
 * with the URL last seen for it: across a reconnection a different URL under the same id is
 * someone else's tab, and the entry is dropped instead.
 *
 * Builds before agent-browser-extension#18 ignored the id of browser_close_tab and closed the
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
  lastUsed: number;
  keepUntil: number;
  url: string;
  /** Window the tab lives in, when the extension says (agent-browser-extension windowPerSession). */
  windowId?: number;
  /** connectedAt of the browser connection when `url` was last observed. */
  connectedAt: number;
  sessionClosed: boolean;
}

interface ListedTab {
  id: number;
  url: string;
  windowId?: number;
}

export interface TabReaperOptions {
  /** Minutes without use before a tab closes. 0 turns closing off; ownership is still tracked. */
  idleMs: number;
  /** Raw access to the extension: send to one connection, list the connections. */
  send(connectionId: string, type: ToolName, payload?: Record<string, unknown>): Promise<ExtensionResponse>;
  listConnections(): BrowserConnectionInfo[];
  now?: () => number;
  /** Serialize listing/revalidation/closing with session commands and claims. */
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
  /** Single source of tab ownership: who opened (or claimed) this tab, undefined for tabs it never saw. */
  ownerOf(connectionId: string, tabId: number): TabOwner | undefined;
  /** Hand a tracked tab to `sessionId` (browser_claim_tab). False when the tab is not tracked. */
  claim(connectionId: string, tabId: number, sessionId: string): boolean;
}

export interface TabOwner {
  sessionId: string;
  /** Its session ended: another session may take the tab over, as with a held payment tab. */
  sessionClosed: boolean;
}

const key = (connectionId: string, tabId: number) => `${connectionId}:${tabId}`;

/**
 * Tools that manage tabs instead of acting on the page: they use the tab they name by id, never
 * the connected one. Another session listing or opening tabs is not working in this one.
 */
const TAB_MANAGEMENT = new Set<ToolName>([
  'browser_new_tab',
  'browser_list_tabs',
  'browser_find_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_send_to_back',
]);

function listedTabs(response: ExtensionResponse): ListedTab[] {
  const raw = response.result as ListedTab[] | { tabs?: ListedTab[] } | undefined;
  const tabs = Array.isArray(raw) ? raw : raw?.tabs ?? [];
  return tabs.filter((t) => typeof t?.id === 'number');
}

/** Only extension builds that close agent windows say so in their listing. */
function closesWindows(response: ExtensionResponse): boolean {
  const raw = response.result as { closeWindow?: unknown } | undefined;
  return !Array.isArray(raw) && raw?.closeWindow === true;
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

  const connectedAtOf = (connectionId: string) =>
    options.listConnections().find((c) => c.connectionId === connectionId)?.connectedAt ?? 0;

  function touch(connectionId: string, tabId: number | undefined, sessionId: string) {
    if (tabId === undefined) return;
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab) return;
    tab.lastUsed = now();
    if (tab.sessionClosed && tab.sessionId !== sessionId) {
      // Its session is gone and another one works in it (confirmar_pago on a held payment tab):
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
      lastUsed: now(),
      keepUntil: 0,
      url,
      ...(typeof windowId === 'number' ? { windowId } : {}),
      connectedAt: connectedAtOf(connectionId),
      sessionClosed: false,
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
        const named = typeof payload.tabId === 'number'
          ? payload.tabId
          : typeof payload.targetTabId === 'number' ? payload.targetTabId : undefined;
        touch(connectionId, named ?? (TAB_MANAGEMENT.has(type) ? undefined : currentTab.get(connectionId)), sessionId);
        const response = await context.send(type, payload, ...rest);
        observe(sessionId, connectionId, type, payload, response, keepOpenMinutes);
        return response;
      },
    };
  }

  function touchSession(sessionId: string | undefined) {
    if (!sessionId) return;
    const t = now();
    for (const tab of tabs.values()) if (tab.sessionId === sessionId) tab.lastUsed = t;
  }

  function keep(connectionId: string | undefined, tabId: number, minutes: number) {
    if (!connectionId) return;
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab) return;
    const capped = Math.min(Math.max(minutes, 0), MAX_KEEP_MINUTES);
    tab.keepUntil = Math.max(tab.keepUntil, now() + capped * 60_000);
  }

  const isDue = (tab: TrackedTab, t: number) =>
    t >= tab.keepUntil && (tab.sessionClosed || t - tab.lastUsed >= options.idleMs);

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
        `[tab-reaper] asked ${tab.connectionId} to close tab ${tab.tabId} and it answered ${JSON.stringify(answer.result)}: ` +
          'its extension does not close by id (needs agent-browser-extension#18); no more closing on that browser',
      );
      return false;
    }
    logger.info(
      `[tab-reaper] closed tab ${tab.tabId} on ${tab.connectionId} (session ${tab.sessionId}, ${tab.sessionClosed ? 'session ended' : 'idle'})`,
    );
    return true;
  }

  function forgetTab(tab: TrackedTab) {
    if (tabs.get(key(tab.connectionId, tab.tabId)) !== tab) return;
    tabs.delete(key(tab.connectionId, tab.tabId));
    if (currentTab.get(tab.connectionId) === tab.tabId) currentTab.delete(tab.connectionId);
  }

  async function closeWindow(connectionId: string, windowId: number, group: TrackedTab[]): Promise<number> {
    const ids = group.map((tab) => tab.tabId);
    const answer = await options.send(connectionId, 'browser_close_window', { windowId, tabIds: ids });
    if (!answer.success) return -1;
    const result = answer.result as { windowId?: unknown; closedTabIds?: unknown } | undefined;
    const echoed = result?.closedTabIds;
    if (result?.windowId !== windowId || !Array.isArray(echoed) ||
        echoed.some((id) => !ids.includes(id)) || new Set(echoed).size !== echoed.length) {
      unsafe.add(connectionId);
      logger.error(`[tab-reaper] invalid window-close acknowledgement on ${connectionId}; no more cleanup`);
      return 0;
    }
    let closed = 0;
    for (const tab of group) if (echoed.includes(tab.tabId)) { forgetTab(tab); closed++; }
    if (closed < group.length) {
      // A tab may disappear or move in Chrome while the close is in flight.
      const listing = await options.send(connectionId, 'browser_list_tabs');
      if (listing.success) {
        const live = new Map(listedTabs(listing).map((tab) => [tab.id, tab]));
        for (const tab of group) {
          if (echoed.includes(tab.tabId)) continue;
          const current = live.get(tab.tabId);
          if (!current) forgetTab(tab);
          else { tab.url = current.url; tab.windowId = current.windowId; }
        }
      }
    }
    return closed;
  }

  async function sweepConnection(connection: BrowserConnectionInfo, mine: TrackedTab[], t: number): Promise<number> {
    const listing = await options.send(connection.connectionId, 'browser_list_tabs');
    if (!listing.success) return 0;
    const listed = listedTabs(listing);
    const open = new Map(listed.map((tab) => [tab.id, tab.url ?? '']));
    const announced = closesById(listing);
    const windowsAnnounced = closesWindows(listing);
    let closed = 0;

    const due: TrackedTab[] = [];
    const staying: TrackedTab[] = [];
    for (const tab of mine) {
      const url = open.get(tab.tabId);
      if (url === undefined) {
        forgetTab(tab); // already gone
        continue;
      }
      const windowId = listed.find((l) => l.id === tab.tabId)?.windowId;
      if (typeof windowId === 'number') tab.windowId = windowId;
      if (tab.connectedAt !== connection.connectedAt && url !== tab.url) {
        // The browser reconnected and that id now shows another page: maybe not our tab.
        logger.warn(`[tab-reaper] tab ${tab.tabId} on ${tab.connectionId} changed across a reconnection; no longer tracked`);
        forgetTab(tab);
      } else if (isDue(tab, t)) {
        due.push(tab);
      } else {
        tab.url = url;
        tab.connectedAt = connection.connectedAt;
        staying.push(tab);
      }
    }
    // Stays tracked: it closes once the browser runs a build that can.
    if (!announced || unsafe.has(connection.connectionId)) return closed;

    // A window goes in one piece when every tab in it is one of our due tabs.
    const byWindow = new Map<number, TrackedTab[]>();
    if (windowsAnnounced) {
      for (const tab of due) if (tab.windowId !== undefined) byWindow.set(tab.windowId, [...(byWindow.get(tab.windowId) ?? []), tab]);
    }
    const done = new Set<TrackedTab>();
    for (const [windowId, group] of byWindow) {
      // Only the due tabs of this window may go: anything else listed in it (staying, dropped on a
      // reconnection, or never ours) keeps the window open.
      const groupIds = new Set(group.map((tab) => tab.tabId));
      const blocked = listed.some((l) => l.windowId === windowId && !groupIds.has(l.id));
      if (blocked || unsafe.has(connection.connectionId)) continue;
      if (!group.every((tab) => tabs.get(key(tab.connectionId, tab.tabId)) === tab && isDue(tab, now()))) continue;
      const count = await closeWindow(connection.connectionId, windowId, group);
      if (count >= 0) {
        closed += count;
        for (const tab of group) done.add(tab);
      }
    }

    for (const tab of due) {
      if (done.has(tab) || unsafe.has(connection.connectionId) || tabs.get(key(tab.connectionId, tab.tabId)) !== tab || !isDue(tab, now())) continue;
      if (await closeTab(tab)) closed++;
      forgetTab(tab);
    }
    return closed;
  }

  async function runSweep(): Promise<number> {
    if (options.idleMs <= 0) return 0; // closing is off; the registry still serves ownership
    let closed = 0;
    for (const connection of options.listConnections()) {
      if (connection.open === false) continue;
      const mine = [...tabs.values()].filter((tab) => tab.connectionId === connection.connectionId);
      if (!mine.length) continue;
      try {
        const run = () => sweepConnection(connection,
          [...tabs.values()].filter((tab) => tab.connectionId === connection.connectionId), now());
        closed += await (options.exclusive ? options.exclusive(connection.connectionId, run) : run());
      } catch (error) {
        logger.warn(`[tab-reaper] sweep of ${connection.connectionId} failed: ${(error as Error).message}`);
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
    let any = false;
    for (const tab of tabs.values()) {
      if (tab.sessionId === sessionId) {
        tab.sessionClosed = true;
        any = true;
      }
    }
    if (any) await sweep();
  }

  function ownerOf(connectionId: string, tabId: number): TabOwner | undefined {
    const tab = tabs.get(key(connectionId, tabId));
    return tab ? { sessionId: tab.sessionId, sessionClosed: tab.sessionClosed } : undefined;
  }

  function claim(connectionId: string, tabId: number, sessionId: string): boolean {
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab) return false;
    tab.sessionId = sessionId;
    tab.sessionClosed = false;
    tab.lastUsed = now();
    logger.info(`[tab-reaper] tab ${tabId} on ${connectionId} claimed by session ${sessionId}`);
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
