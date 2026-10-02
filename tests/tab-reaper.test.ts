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
  tabs = new Map<number, string>([[1, 'https://user.example/inbox']]);
  nextId = 100;
  connected: number | null = null;
  /** Behave like extension builds that predate closing by id: ignore the id, close the connected tab. */
  ignoresCloseId = false;
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
        return ok({ tab: { id, url: payload.url, connected: true } });
      }
      case 'browser_list_tabs': {
        const tabs = [...this.tabs].map(([id, url]) => ({ id, url, title: '', active: false, connected: id === this.connected }));
        // Builds that close by id announce it; older ones answered a bare array.
        return ok(this.ignoresCloseId ? tabs : { tabs, closeById: true });
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
    await call('confirmer', 'browser_switch_tab', { tabId: 100 }); // the step that confirms the payment
    clock = 61 * 60_000;
    await reaper.sweep();
    expect(browser.tabs.has(100)).toBe(true); // the hold ran out, but the confirmer is still on it

    await reaper.sessionClosed('confirmer');
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('does not count another session listing or opening tabs as use of the connected one', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' }); // 100, connected
    browser.open = false; // keep it tracked past the end of s1
    await reaper.sessionClosed('s1');

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

  it('closes after a reconnection when the tab still shows the same page', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    browser.connectedAt = 2000; // service worker restarted, same Chrome
    await reaper.sessionClosed('s1');
    expect(browser.tabs.has(100)).toBe(false);
  });

  it('leaves alone a reused tab id after the browser restarted', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    // Chrome restarted: the same id now belongs to a tab of the user.
    browser.connectedAt = 2000;
    browser.tabs.set(100, 'https://user.example/calendar');

    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([]);
    expect(browser.tabs.has(100)).toBe(true);
    expect(reaper.tracked()).toHaveLength(0);
  });

  it('follows navigation while connected, so the reconnection check uses the latest page', async () => {
    await call('s1', 'browser_new_tab', { url: 'https://shop.example/' });
    browser.tabs.set(100, 'https://shop.example/cart');
    clock = 10 * 60_000;
    await reaper.sweep(); // not due: records the new URL

    browser.connectedAt = 2000;
    await reaper.sessionClosed('s1');
    expect(browser.closes()).toEqual([100]);
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
