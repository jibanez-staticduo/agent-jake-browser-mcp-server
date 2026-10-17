/**
 * The tab reaper closes the tabs an agent opened when its session ends or after an hour idle,
 * and never a tab the agent did not open.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTabReaper, idleMinutesFromEnv, type TabReaper } from '../src/tab-reaper.ts';
import type { BrowserConnectionInfo, Context, ExtensionResponse, ToolName } from '../src/types.ts';

const HOUR = 60 * 60_000;

/** A browser with tabs, as the extension answers for it. */
class FakeBrowser {
  tabs = new Map<number, string>([[1, 'https://dani.example/inbox']]);
  nextId = 100;
  connected: number | null = null;
  /** Behave like extension builds before agent-browser-extension#18: ignore the id, close the connected tab. */
  ignoresCloseId = false;
  /** Windows, like agent-browser-extension windowPerSession: tab -> window, the user's tab 1 lives in window 1. */
  windowMode = false;
  /** Window mode, but the extension answers browser_close_window without saying which tabs it closed. */
  noWindowEcho = false;
  /** Window mode: the extension echoes only these ids (a partial close), instead of all it was given. */
  echoOnly: number[] | null = null;
  /** Window mode, but the listing does not announce closeWindow (an extension without it). */
  noCloseWindow = false;
  windowOfTab = new Map<number, number>([[1, 1]]);
  nextWindow = 50;
  connectedAt = 1000;
  open = true;
  sent: Array<{ type: ToolName; payload: Record<string, unknown> }> = [];

  connection(): BrowserConnectionInfo {
    return {
      connectionId: 'x86',
      label: '',
      userAgent: 'Chrome',
      connectedAt: this.connectedAt,
      lastActiveAt: 0,
      open: this.open,
      active: true,
      secondsSinceLastActivity: 0,
    };
  }

  async send(type: ToolName, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
    this.sent.push({ type, payload });
    const ok = (result: unknown): ExtensionResponse => ({ id: 'r', success: true, result });
    switch (type) {
      case 'browser_new_tab': {
        const id = this.nextId++;
        this.tabs.set(id, String(payload.url));
        this.connected = id;
        if (this.windowMode) {
          const windowId = typeof payload.windowId === 'number' ? payload.windowId : this.nextWindow++;
          this.windowOfTab.set(id, windowId);
          return ok({ tab: { id, url: payload.url, connected: true, windowId }, windowId, windowCreated: payload.windowId === undefined });
        }
        return ok({ tab: { id, url: payload.url, connected: true } });
      }
      case 'browser_list_tabs': {
        const tabs = [...this.tabs].map(([id, url]) => ({
          id, url, title: '', active: false, connected: id === this.connected,
          ...(this.windowMode ? { windowId: this.windowOfTab.get(id) } : {}),
        }));
        // Builds that close by id announce it; older ones answered a bare array.
        if (this.ignoresCloseId) return ok(tabs);
        return ok({ tabs, closeById: true, ...(this.windowMode && !this.noCloseWindow ? { closeWindow: true, windowPerSession: true } : {}) });
      }
      case 'browser_close_window': {
        const ids = (payload.tabIds as number[] | undefined) ?? [];
        for (const id of ids) this.tabs.delete(id);
        return ok(this.noWindowEcho ? { closed: true } : { windowId: payload.windowId, closed: true, closedTabIds: this.echoOnly ?? ids });
      }
      case 'browser_switch_tab':
        this.connected = payload.tabId as number;
        return ok({});
      case 'browser_close_tab': {
        const target = this.ignoresCloseId ? this.connected : (payload.tabId as number | undefined) ?? this.connected;
        if (target === null || !this.tabs.delete(target)) {
          return { id: 'r', success: false, error: { code: 'E', message: 'No tab with id' } };
        }
        return ok(this.ignoresCloseId ? { closed: true } : { closed: true, tabId: target });
      }
      case 'browser_click':
        if (payload.opens) {
          const id = this.nextId++;
          this.tabs.set(id, 'https://popup.example/');
          return ok({ clicked: 'e1', newTabOpened: { id, url: 'https://popup.example/' } });
        }
        return ok({ clicked: 'e1' });
      default:
        return ok({});
    }
  }

  windowCloses(): Array<{ windowId: number; tabIds: number[] }> {
    return this.sent.filter((m) => m.type === 'browser_close_window').map((m) => m.payload as { windowId: number; tabIds: number[] });
  }

  closes(): number[] {
    return this.sent.filter((m) => m.type === 'browser_close_tab').map((m) => m.payload.tabId as number);
  }
}

let browser: FakeBrowser;
let clock: number;
let reaper: TabReaper;

function contextFor(sessionId: string, keepOpenMinutes?: number): Context {
  const raw: Context = {
    send: (type, payload) => browser.send(type, payload),
    isConnected: () => true,
    listConnections: () => [browser.connection()],
  };
  return reaper.track(raw, sessionId, 'x86', keepOpenMinutes);
}

async function call(sessionId: string, type: ToolName, payload: Record<string, unknown> = {}, keepOpenMinutes?: number) {
  reaper.touchSession(sessionId);
  return contextFor(sessionId, keepOpenMinutes).send(type, payload);
}

beforeEach(() => {
  browser = new FakeBrowser();
  clock = 0;
  reaper = createTabReaper({
    idleMs: HOUR,
    now: () => clock,
    send: (_id, type, payload) => browser.send(type, payload),
    listConnections: () => [browser.connection()],
  });
});

describe('tab reaper', () => {
  it('closes the tabs of a session when the session ends, and nothing else', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await call('s2', 'browser_new_tab', { url: 'https://bank.example/' });

    await reaper.sessionClosed('s1');

    expect(browser.closes()).toEqual([100]);
    expect([...browser.tabs.keys()].sort()).toEqual([1, 101]);
  });

  it('closes a tab after an hour without use, not before', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });

    clock = HOUR - 1;
    expect(await reaper.sweep()).toBe(0);

    clock = HOUR;
    expect(await reaper.sweep()).toBe(1);
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('counts any call of the owning session as use', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    clock = 50 * 60_000;
    await call('s1', 'browser_snapshot');

    clock = HOUR + 1;
    expect(await reaper.sweep()).toBe(0);
    clock = 50 * 60_000 + HOUR;
    expect(await reaper.sweep()).toBe(1);
  });

  it('counts another session working in the tab as use', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    clock = 50 * 60_000;
    await call('s2', 'browser_switch_tab', { tabId: 100 });

    clock = HOUR + 1;
    expect(await reaper.sweep()).toBe(0);
  });

  it('never closes a tab the agent did not open', async () => {
    await call('s1', 'browser_switch_tab', { tabId: 1 });
    await reaper.sessionClosed('s1');
    clock = 10 * HOUR;
    await reaper.sweep();

    expect(browser.closes()).toEqual([]);
    expect(browser.tabs.has(1)).toBe(true);
  });

  it('tracks a tab opened by a click', async () => {
    await call('s1', 'browser_click', { ref: 'e1', opens: true });
    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([100]);
  });

  it('keeps a held tab past the end of its session until the hold runs out', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/checkout' });
    reaper.keep('x86', 100, 24 * 60);

    await reaper.sessionClosed('s1');
    clock = 23 * HOUR;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(true);

    clock = 24 * HOUR;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('holds the tab a call opens or switches to with keepOpenMinutes', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/checkout' }, 120);
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/other' });
    await call('s1', 'browser_switch_tab', { tabId: 101 }, 90);
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/loose' });

    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([102]);

    clock = 90 * 60_000;
    await reaper.sweep();
    expect(browser.closes()).toEqual([102, 101]);
    clock = 120 * 60_000;
    await reaper.sweep();
    expect(browser.closes()).toEqual([102, 101, 100]);
  });

  it('hands a held tab to the session that works in it after its own ended', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/checkout' }, 60);
    await reaper.sessionClosed('s1');

    clock = 30 * 60_000;
    await call('hermes', 'browser_switch_tab', { tabId: 100 }); // confirmar_pago
    clock = 61 * 60_000;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(true); // the hold ran out, but hermes is still on it

    await reaper.sessionClosed('hermes');
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('does not count another session listing or opening tabs as use of the connected one', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' }); // 100, connected
    browser.open = false; // keep it tracked past the end of s1
    await reaper.sessionClosed('s1');
    browser.open = true;

    await call('s2', 'browser_list_tabs');
    await call('s2', 'browser_send_to_back');
    await call('s2', 'browser_new_tab', { url: 'https://other.example/' }); // touches before it opens
    browser.open = true;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('counts another session acting on the page of the connected tab as use', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' }); // 100, connected
    browser.open = false;
    await reaper.sessionClosed('s1');
    browser.open = true;

    await call('s2', 'browser_snapshot'); // works in tab 100: it is s2's now
    browser.open = true;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(true);
    await reaper.sessionClosed('s2');
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('closes nothing on a browser whose extension does not close by id', async () => {
    browser.ignoresCloseId = true;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await call('s1', 'browser_switch_tab', { tabId: 1 }); // the user's tab is the connected one

    await reaper.sessionClosed('s1');
    clock = 10 * HOUR;
    await reaper.sweep();
    expect(browser.closes()).toEqual([]);
    expect(browser.tabs.has(1)).toBe(true);

    // Once it runs a build that can, the tab it kept tracking closes.
    browser.ignoresCloseId = false;
    await reaper.sweep();
    expect(browser.closes()).toEqual([100]);
    expect(browser.tabs.has(1)).toBe(true);
  });

  it('stops closing on a browser that announces closeById but does not echo the id', async () => {
    const listing = browser.send.bind(browser);
    browser.send = async (type, payload) => {
      if (type !== 'browser_close_tab') return listing(type, payload);
      browser.sent.push({ type, payload: payload ?? {} });
      return { id: 'r', success: true, result: { closed: true } };
    };
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await call('s1', 'browser_new_tab', { url: 'https://bank.example/' });

    await reaper.sessionClosed('s1');
    expect(browser.closes()).toHaveLength(1);
    clock = 10 * HOUR;
    await reaper.sweep();
    expect(browser.closes()).toHaveLength(1);
  });

  it('forgets a tab the agent closed itself', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await call('s1', 'browser_close_tab', { tabId: 100 });
    expect(reaper.tracked()).toHaveLength(0);

    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await call('s1', 'browser_close_tab'); // the connected one
    expect(reaper.tracked()).toHaveLength(0);
  });

  it('waits for a browser that is offline instead of dropping its tabs', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    browser.open = false;
    await reaper.sessionClosed('s1');
    expect(reaper.tracked()).toHaveLength(1);

    browser.open = true;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('forgets after reconnection even if the reused tab id shows the same page', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    browser.connectedAt = 2000; // a new connection cannot prove tab identity
    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([]);
    expect(browser.tabs.has(100)).toBe(true);
    expect(reaper.tracked()).toHaveLength(0);
  });

  it('leaves alone a reused tab id after the browser restarted', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    // Chrome restarted: the same id now belongs to a tab of the user.
    browser.connectedAt = 2000;
    browser.tabs.set(100, 'https://dani.example/calendar');

    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([]);
    expect(browser.tabs.has(100)).toBe(true);
    expect(reaper.tracked()).toHaveLength(0);
  });

  it('allows navigation while connected but invalidates ownership on reconnection', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    browser.tabs.set(100, 'https://shop.example/cart');
    clock = 10 * 60_000;
    await reaper.sweep(); // not due: records the new URL

    browser.connectedAt = 2000;
    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([]);
  });
});

describe('idleMinutesFromEnv', () => {
  it('defaults to 60 and accepts 0 to turn the reaper off', () => {
    expect(idleMinutesFromEnv({})).toBe(60);
    expect(idleMinutesFromEnv({ AGENT_BROWSER_TAB_IDLE_MINUTES: '0' })).toBe(0);
    expect(idleMinutesFromEnv({ AGENT_BROWSER_TAB_IDLE_MINUTES: '15' })).toBe(15);
    expect(idleMinutesFromEnv({ AGENT_BROWSER_TAB_IDLE_MINUTES: 'nope' })).toBe(60);
  });
});

describe('tab reaper: windows', () => {
  beforeEach(() => {
    browser.windowMode = true;
  });

  it('closes the window of a session with one browser_close_window when the session ends', async () => {
    const first = await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    const windowId = (first.result as { windowId: number }).windowId;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/two', windowId });
    await call('s2', 'browser_new_tab', { url: 'https://bank.example/' });

    await reaper.sessionClosed('s1');

    expect(browser.windowCloses()).toEqual([{ windowId, tabIds: [100, 101] }]);
    expect(browser.closes()).toEqual([]);
    expect([...browser.tabs.keys()].sort()).toEqual([1, 102]);
    expect(reaper.tracked().map((t) => t.tabId)).toEqual([102]);
  });

  it('closes the window after an hour idle, not before', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    clock = HOUR - 1;
    expect(await reaper.sweep()).toBe(0);
    clock = HOUR;
    expect(await reaper.sweep()).toBe(1);
    expect(browser.windowCloses()).toHaveLength(1);
    expect(browser.closes()).toEqual([]);
  });

  it('a tab held with keepOpenMinutes keeps its window: only the due tab goes', async () => {
    const first = await call('s1', 'browser_new_tab', { url: 'https://pay.example/' }, 120);
    const windowId = (first.result as { windowId: number }).windowId;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/', windowId });

    await reaper.sessionClosed('s1');

    expect(browser.windowCloses()).toEqual([]);
    expect(browser.closes()).toEqual([101]);
    expect(browser.tabs.has(100)).toBe(true);

    clock = 120 * 60_000;
    await reaper.sweep();
    expect(browser.windowCloses()).toEqual([{ windowId, tabIds: [100] }]);
  });

  it('a window that also holds a tab the agent did not open loses only its own tabs', async () => {
    const first = await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    const windowId = (first.result as { windowId: number }).windowId;
    browser.tabs.set(7, 'https://dani.example/dragged'); // the user dragged a tab in
    browser.windowOfTab.set(7, windowId);

    await reaper.sessionClosed('s1');

    expect(browser.windowCloses()).toEqual([]);
    expect(browser.closes()).toEqual([100]);
    expect(browser.tabs.has(7)).toBe(true);
  });

  it('a close_window answer without the closed ids marks the browser unsafe', async () => {
    browser.noWindowEcho = true;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await call('s2', 'browser_new_tab', { url: 'https://bank.example/' });

    await reaper.sessionClosed('s1');
    expect(browser.windowCloses()).toHaveLength(1);
    expect(reaper.tracked().map((t) => t.tabId)).toContain(100); // not trusted: stays tracked

    await reaper.sessionClosed('s2');
    expect(browser.windowCloses()).toHaveLength(1);
    expect(browser.closes()).toEqual([]);
  });

  it('a browser that does not announce closeWindow is closed tab by tab, as before', async () => {
    browser.noCloseWindow = true;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    await reaper.sessionClosed('s1');
    expect(browser.windowCloses()).toEqual([]);
    expect(browser.closes()).toEqual([100]);
  });

  it('with the idle time at 0 the reaper still tracks owners and closes nothing', async () => {
    const off = createTabReaper({
      idleMs: 0,
      now: () => clock,
      send: (_id, type, payload) => browser.send(type, payload),
      listConnections: () => [browser.connection()],
    });
    const raw: Context = { send: (t, p) => browser.send(t, p), isConnected: () => true, listConnections: () => [browser.connection()] };
    await off.track(raw, 's1', 'x86').send('browser_new_tab', { url: 'https://shop.example/' });
    expect(off.ownerOf('x86', 100)).toEqual({ sessionId: 's1', sessionClosed: false });
    await off.sessionClosed('s1');
    clock = 10 * HOUR;
    expect(await off.sweep()).toBe(0);
    expect(browser.closes()).toEqual([]);
    expect(browser.windowCloses()).toEqual([]);
  });

  it('always sends tabIds with browser_close_window: the tracked tabs of that window, never empty', async () => {
    const first = await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    const w1 = (first.result as { windowId: number }).windowId;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/two', windowId: w1 });
    await call('s2', 'browser_new_tab', { url: 'https://bank.example/' });
    await reaper.sessionClosed('s1');
    clock = HOUR; // s2 goes by idle
    await reaper.sweep();

    const closes = browser.sent.filter((m) => m.type === 'browser_close_window');
    expect(closes).toHaveLength(2);
    for (const m of closes) {
      expect(Array.isArray(m.payload.tabIds)).toBe(true);
      expect((m.payload.tabIds as number[]).length).toBeGreaterThan(0);
      expect(typeof m.payload.windowId).toBe('number');
    }
    expect(closes.map((m) => m.payload.tabIds)).toEqual([[100, 101], [102]]);
  });

  it('reconciles a partial close echo against fresh tabs without disabling cleanup', async () => {
    const first = await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    const windowId = (first.result as { windowId: number }).windowId;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/two', windowId });

    browser.echoOnly = [100]; // the extension closed only one of the two
    await reaper.sessionClosed('s1');
    expect(reaper.tracked()).toEqual([]); // fake browser removed both; fresh listing confirms absence
    browser.echoOnly = null;
    await call('s2', 'browser_new_tab', { url: 'https://later.example/' });
    await reaper.sessionClosed('s2');
    expect(browser.windowCloses()).toHaveLength(2);
  });

  it('an echo naming an unrequested tab fails closed', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    browser.echoOnly = [100, 999];
    await reaper.sessionClosed('s1');
    expect(reaper.tracked()).toHaveLength(1);
    await call('s2', 'browser_new_tab', { url: 'https://later.example/' });
    await reaper.sessionClosed('s2');
    expect(browser.windowCloses()).toHaveLength(1);
  });

  it('a reconnection invalidates all tracked tabs in a window', async () => {
    const first = await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    const windowId = (first.result as { windowId: number }).windowId;
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/two', windowId }); // 101
    browser.connectedAt = 2000; // the browser reconnected
    browser.tabs.set(101, 'https://other.example/'); // and 101 now shows another page: maybe not ours

    await reaper.sessionClosed('s1');

    expect(browser.windowCloses()).toEqual([]);
    expect(browser.closes()).toEqual([]);
    expect(browser.tabs.has(100)).toBe(true);
    expect(browser.tabs.has(101)).toBe(true);
  });
});
