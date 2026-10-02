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
 * tab that waits on a person (a payment ready for a human to confirm) after its session is gone.
 *
 * Chrome reuses tab ids after a restart, so a tab is closed only after the browser lists it
 * with the URL last seen for it: across a reconnection a different URL under the same id is
 * someone else's tab, and the entry is dropped instead.
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
  lastUsed: number;
  keepUntil: number;
  url: string;
  /** connectedAt of the browser connection when `url` was last observed. */
  connectedAt: number;
  sessionClosed: boolean;
}

interface ListedTab {
  id: number;
  url: string;
}

export interface TabReaperOptions {
  idleMs: number;
  /** Raw access to the extension: send to one connection, list the connections. */
  send(connectionId: string, type: ToolName, payload?: Record<string, unknown>): Promise<ExtensionResponse>;
  listConnections(): BrowserConnectionInfo[];
  now?: () => number;
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

  const connectedAtOf = (connectionId: string) =>
    options.listConnections().find((c) => c.connectionId === connectionId)?.connectedAt ?? 0;

  function touch(connectionId: string, tabId: number | undefined, sessionId: string) {
    if (tabId === undefined) return;
    const tab = tabs.get(key(connectionId, tabId));
    if (!tab) return;
    tab.lastUsed = now();
    if (tab.sessionClosed && tab.sessionId !== sessionId) {
      // Its session is gone and another one works in it (e.g. the step that confirms a held payment):
      // the tab is now that session's, and closes when that one ends.
      tab.sessionId = sessionId;
      tab.sessionClosed = false;
    }
  }

  function adopt(sessionId: string, connectionId: string, tabId: number, url: string) {
    if (tabs.has(key(connectionId, tabId))) return;
    tabs.set(key(connectionId, tabId), {
      connectionId,
      tabId,
      sessionId,
      lastUsed: now(),
      keepUntil: 0,
      url,
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
      const tab = (result.tab ?? {}) as { id?: number; url?: string; connected?: boolean };
      const tabId = tab.id ?? (result.tabId as number | undefined);
      if (typeof tabId !== 'number') return;
      adopt(sessionId, connectionId, tabId, tab.url || String(payload.url ?? ''));
      if (tab.connected !== false) currentTab.set(connectionId, tabId);
      if (keepOpenMinutes !== undefined) keep(connectionId, tabId, keepOpenMinutes);
      return;
    }

    const opened = result.newTabOpened as { id?: number; url?: string } | undefined;
    if (typeof opened?.id === 'number') adopt(sessionId, connectionId, opened.id, opened.url ?? '');

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
        const named = typeof payload.tabId === 'number' ? payload.tabId : undefined;
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
          'its extension does not close by id (needs an extension that announces closeById); no more closing on that browser',
      );
      return false;
    }
    logger.info(
      `[tab-reaper] closed tab ${tab.tabId} on ${tab.connectionId} (session ${tab.sessionId}, ${tab.sessionClosed ? 'session ended' : 'idle'})`,
    );
    return true;
  }

  async function sweepConnection(connection: BrowserConnectionInfo, mine: TrackedTab[], t: number): Promise<number> {
    const listing = await options.send(connection.connectionId, 'browser_list_tabs');
    if (!listing.success) return 0;
    const open = new Map(listedTabs(listing).map((tab) => [tab.id, tab.url ?? '']));
    const announced = closesById(listing);
    let closed = 0;

    for (const tab of mine) {
      const url = open.get(tab.tabId);
      const forget = () => {
        tabs.delete(key(tab.connectionId, tab.tabId));
        if (currentTab.get(tab.connectionId) === tab.tabId) currentTab.delete(tab.connectionId);
      };
      if (url === undefined) {
        forget(); // already gone
      } else if (tab.connectedAt !== connection.connectedAt && url !== tab.url) {
        // The browser reconnected and that id now shows another page: maybe not our tab.
        logger.warn(`[tab-reaper] tab ${tab.tabId} on ${tab.connectionId} changed across a reconnection; no longer tracked`);
        forget();
      } else if (isDue(tab, t)) {
        // Stays tracked: it closes once the browser runs a build that can.
        if (!announced || unsafe.has(tab.connectionId)) continue;
        if (await closeTab(tab)) closed++;
        forget();
      } else {
        tab.url = url;
        tab.connectedAt = connection.connectedAt;
      }
    }
    return closed;
  }

  async function runSweep(): Promise<number> {
    const t = now();
    let closed = 0;
    for (const connection of options.listConnections()) {
      if (connection.open === false) continue;
      const mine = [...tabs.values()].filter((tab) => tab.connectionId === connection.connectionId);
      if (!mine.length) continue;
      try {
        closed += await sweepConnection(connection, mine, t);
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

  return {
    track,
    touchSession,
    keep,
    sessionClosed,
    sweep,
    tracked: () => [...tabs.values()],
  };
}

/** AGENT_BROWSER_TAB_IDLE_MINUTES: minutes without use before an agent tab closes; 0 turns it off. */
export function idleMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AGENT_BROWSER_TAB_IDLE_MINUTES ?? '').trim();
  if (raw === '') return 60;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}
