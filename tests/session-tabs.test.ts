/**
 * Each MCP session works in its own tab, even when several share one browser.
 */
import { describe, it, expect } from 'vitest';
import { createSessionTabs } from '../src/session-tabs.ts';
import type { Context, ExtensionResponse, ToolName } from '../src/types.ts';

/** One browser: the extension follows a single connected tab, like the real one. */
function fakeBrowser() {
  const sent: Array<{ type: ToolName; payload: Record<string, unknown> }> = [];
  const state = { connected: 1 as number | null, nextId: 100, open: new Set([1]), inFlight: 0, maxInFlight: 0 };
  const respond = async (type: ToolName, payload: Record<string, unknown>): Promise<ExtensionResponse> => {
    sent.push({ type, payload });
    state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    state.inFlight--;
    const target = payload.targetTabId as number | undefined;
    if (target !== undefined) {
      if (!state.open.has(target)) return { id: '', success: false, error: { code: 'TAB_GONE', message: 'gone' } };
      state.connected = target;
    }
    if (type === 'browser_new_tab') {
      const id = state.nextId++; state.open.add(id); state.connected = id;
      return { id: '', success: true, result: { tab: { id, url: String(payload.url), connected: true } } };
    }
    if (type === 'browser_switch_tab') { state.connected = payload.tabId as number; return { id: '', success: true, result: {} }; }
    if (type === 'browser_close_tab') {
      const closed = (payload.tabId as number | undefined) ?? state.connected!;
      state.open.delete(closed); if (state.connected === closed) state.connected = null;
      return { id: '', success: true, result: { closed: true, tabId: closed } };
    }
    return { id: '', success: true, result: { actedOn: state.connected } };
  };
  const context = { send: respond, isConnected: () => true, listConnections: () => [] } as unknown as Context;
  return { context, sent, state };
}

describe('session tabs', () => {
  it('sends each session\'s commands to its own tab, however they interleave', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(browser.context, 'A', 'x86');
    const b = tabs.route(browser.context, 'B', 'x86');

    await a.send('browser_new_tab', { url: 'https://a.test' }); // 100
    await b.send('browser_new_tab', { url: 'https://b.test' }); // 101, now the connected one
    const ra = await a.send('browser_click', { selector: '#go' });
    const rb = await b.send('browser_type', { selector: '#q', text: 'x' });

    expect((ra.result as { actedOn: number }).actedOn).toBe(100);
    expect((rb.result as { actedOn: number }).actedOn).toBe(101);
    expect(browser.sent.find((m) => m.type === 'browser_click')?.payload).toEqual({ selector: '#go', targetTabId: 100 });
  });

  it('runs one command at a time per browser', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(browser.context, 'A', 'x86');
    const b = tabs.route(browser.context, 'B', 'x86');
    await a.send('browser_new_tab', { url: 'https://a.test' });
    await b.send('browser_new_tab', { url: 'https://b.test' });

    await Promise.all([a.send('browser_click', {}), b.send('browser_click', {}), a.send('browser_type', { text: 'y' })]);

    expect(browser.state.maxInFlight).toBe(1);
  });

  it('stops a session without a tab from acting in another session\'s tab', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    await tabs.route(browser.context, 'A', 'x86').send('browser_new_tab', { url: 'https://a.test' });

    const r = await tabs.route(browser.context, 'C', 'x86').send('browser_click', { selector: '#buy' });

    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('NO_SESSION_TAB');
    expect(browser.sent.filter((m) => m.type === 'browser_click')).toHaveLength(0);
  });

  it('lets a session without a tab use the browser when no session owns the connected tab', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    const r = await tabs.route(browser.context, 'A', 'x86').send('browser_state', {});
    expect(r.success).toBe(true);
    // The router first asks the browser once whether it gives sessions windows; the command goes as it was.
    expect(browser.sent.find((m) => m.type === 'browser_state')?.payload).toEqual({});
  });

  it('forgets a session tab that is gone, and one the session closed', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(browser.context, 'A', 'x86');
    await a.send('browser_new_tab', { url: 'https://a.test' }); // 100
    browser.state.open.delete(100); // the user closed it

    const r = await a.send('browser_click', {});
    expect(r.error?.code).toBe('TAB_GONE');
    expect(tabs.tabOf('A', 'x86')).toBeUndefined();

    await a.send('browser_new_tab', { url: 'https://a2.test' }); // 101
    await a.send('browser_close_tab', {});
    expect(tabs.tabOf('A', 'x86')).toBeUndefined();
    expect(browser.sent.at(-1)?.payload).toEqual({ targetTabId: 101 });
  });

  it('switch_tab makes that tab the session\'s; browser_wait neither routes nor queues', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(browser.context, 'A', 'x86');
    await a.send('browser_switch_tab', { tabId: 1 });
    expect(tabs.tabOf('A', 'x86')).toBe(1);
    await a.send('browser_wait', { time: 0 });
    expect(browser.sent.at(-1)).toEqual({ type: 'browser_wait', payload: { time: 0 } });
  });

  it('keeps a tab of an ended session off-limits to sessions without a tab until it closes', async () => {
    // Architect, #20: a payment tab held open for Dani (keepOpenMinutes) outlives its session;
    // a new session without a tab must not act in it.
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    await tabs.route(browser.context, 'A', 'x86').send('browser_new_tab', { url: 'https://pay.test' }); // 100
    tabs.sessionClosed('A');
    expect(tabs.tabOf('A', 'x86')).toBeUndefined();

    const blocked = await tabs.route(browser.context, 'B', 'x86').send('browser_state', {});
    expect(blocked.error?.code).toBe('NO_SESSION_TAB');

    // the reaper closes it through the same queue, and then the browser is free again
    await tabs.system(browser.context, 'x86').send('browser_close_tab', { tabId: 100 });
    const free = await tabs.route(browser.context, 'B', 'x86').send('browser_state', {});
    expect(free.success).toBe(true);
  });

  it('queues the server\'s own calls with the sessions\'', async () => {
    const browser = fakeBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(browser.context, 'A', 'x86');
    await a.send('browser_new_tab', { url: 'https://a.test' });
    await Promise.all([a.send('browser_click', {}), tabs.system(browser.context, 'x86').send('browser_list_tabs', {}), a.send('browser_type', { text: 'z' })]);
    expect(browser.state.maxInFlight).toBe(1);
  });
});

describe('session windows', () => {
  /** An extension with windowPerSession: every new tab says its window; a given live window is reused. */
  function windowBrowser() {
    const sent: Array<{ type: ToolName; payload: Record<string, unknown> }> = [];
    const liveWindows = new Set<number>();
    let nextWindow = 50;
    let nextId = 100;
    const context = {
      listConnections: () => [{ connectionId: 'x86', connectedAt: 1, open: true }],
      isConnected: () => true,
      send: async (type: ToolName, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> => {
        sent.push({ type, payload });
        const ok = (result: unknown): ExtensionResponse => ({ id: '', success: true, result });
        if (type === 'browser_list_tabs') return ok({ tabs: [], closeById: true, closeWindow: true, windowPerSession: true });
        if (type === 'browser_new_tab') {
          const asked = payload.windowId as number | undefined;
          const windowCreated = asked === undefined || !liveWindows.has(asked);
          const windowId = windowCreated ? nextWindow++ : asked!;
          liveWindows.add(windowId);
          const id = nextId++;
          return ok({ tab: { id, url: String(payload.url), connected: true, windowId }, windowId, windowCreated });
        }
        return ok({ ok: true });
      },
    } as unknown as Context;
    return { context, sent, liveWindows };
  }

  it('opens a session\'s tabs in its own window: injected, and refreshed from the answer', async () => {
    const b = windowBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(b.context, 'A', 'x86');
    await a.send('browser_new_tab', { url: 'https://a.test' });
    expect(tabs.windowOf('A', 'x86')).toBe(50);
    await a.send('browser_new_tab', { url: 'https://a.test/2' });
    expect(b.sent.filter((m) => m.type === 'browser_new_tab').map((m) => m.payload.windowId)).toEqual([undefined, 50]);
    await tabs.route(b.context, 'B', 'x86').send('browser_new_tab', { url: 'https://b.test' });
    expect(tabs.windowOf('B', 'x86')).toBe(51);
  });

  it('falls back to a new window when the session\'s window died', async () => {
    const b = windowBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(b.context, 'A', 'x86');
    await a.send('browser_new_tab', { url: 'https://a.test' });
    b.liveWindows.delete(50); // the user closed it
    await a.send('browser_new_tab', { url: 'https://a.test/2' });
    expect(tabs.windowOf('A', 'x86')).toBe(51);
  });

  it('forgets the window when its session ends', async () => {
    const b = windowBrowser();
    const tabs = createSessionTabs();
    await tabs.route(b.context, 'A', 'x86').send('browser_new_tab', { url: 'https://a.test' });
    tabs.sessionClosed('A');
    expect(tabs.windowOf('A', 'x86')).toBeUndefined();
  });

  it('a close_window the reaper made forgets the tabs and the window', async () => {
    const b = windowBrowser();
    const tabs = createSessionTabs();
    await tabs.route(b.context, 'A', 'x86').send('browser_new_tab', { url: 'https://a.test' });
    const system = tabs.system({ ...b.context, send: async () => ({ id: '', success: true, result: { windowId: 50, closed: true, closedTabIds: [100] } }) } as Context, 'x86');
    await system.send('browser_close_window', { windowId: 50, tabIds: [100] });
    expect(tabs.tabOf('A', 'x86')).toBeUndefined();
    expect(tabs.windowOf('A', 'x86')).toBeUndefined();
  });

  it('a session that acts without a tab gets one opened first, only on a browser that announces windows', async () => {
    const b = windowBrowser();
    const tabs = createSessionTabs();
    const a = tabs.route(b.context, 'A', 'x86');
    const r = await a.send('browser_navigate', { url: 'https://a.test' });
    expect(r.success).toBe(true);
    const order = b.sent.filter((m) => m.type !== 'browser_list_tabs').map((m) => m.type);
    expect(order).toEqual(['browser_new_tab', 'browser_navigate']);
    expect(b.sent.find((m) => m.type === 'browser_new_tab')?.payload).toEqual({ url: 'about:blank' });
    expect(b.sent.at(-1)?.payload).toEqual({ url: 'https://a.test', targetTabId: 100 });
    expect(tabs.tabOf('A', 'x86')).toBe(100);

    const old = fakeBrowser(); // extension without windowPerSession: nothing is opened for the session
    await createSessionTabs().route(old.context, 'A', 'x86').send('browser_state', {});
    expect(old.sent.map((m) => m.type)).not.toContain('browser_new_tab');
  });
});
