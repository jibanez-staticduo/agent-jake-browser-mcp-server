import { describe, expect, it } from 'vitest';
import { createSessionTabs } from '../src/session-tabs.js';
import { createTabReaper } from '../src/tab-reaper.js';
import type { BrowserConnectionInfo, Context, ExtensionResponse, ToolName } from '../src/types.js';

const ok = (result: unknown): ExtensionResponse => ({ id: '', success: true, result });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

function setup() {
  let clock = 0;
  let nextId = 100;
  let epoch = 'first';
  const live = new Map<number, number>();
  const sent: Array<{ type: ToolName; payload: Record<string, unknown> }> = [];
  let onClose: ((payload: Record<string, unknown>) => Promise<ExtensionResponse>) | undefined;
  const connection = (): BrowserConnectionInfo => ({ connectionId: 'chrome', connectionEpoch: epoch,
    connectedAt: 1, open: true, active: true, label: '', userAgent: '', lastActiveAt: 0, secondsSinceLastActivity: 0 });
  const raw: Context = {
    isConnected: () => true,
    listConnections: () => [connection()],
    send: async (type, payload = {}) => {
      sent.push({ type, payload });
      if (type === 'browser_new_tab') {
        const id = nextId++;
        const windowId = Number(payload.windowId ?? id + 50);
        live.set(id, windowId);
        return ok({ tab: { id, windowId, url: 'about:blank', connected: true }, windowId });
      }
      if (type === 'browser_list_tabs') return ok({ tabs: [...live].map(([id, windowId]) => ({ id, windowId, url: 'about:blank' })), closeById: true, closeWindow: true, windowPerSession: true });
      if (type === 'browser_close_window') {
        if (onClose) return onClose(payload);
        for (const id of payload.tabIds as number[]) live.delete(id);
        return ok({ windowId: payload.windowId, closedTabIds: payload.tabIds });
      }
      if (type === 'browser_close_tab') { live.delete(Number(payload.tabId)); return ok({ tabId: payload.tabId }); }
      return ok({});
    },
  };
  let reaper: ReturnType<typeof createTabReaper>;
  const router = createSessionTabs({ ownerOf: (...args) => reaper.ownerOf(...args), claim: (...args) => reaper.claim(...args) });
  reaper = createTabReaper({ idleMs: 100, now: () => clock, listConnections: raw.listConnections,
    exclusive: router.exclusive,
    send: async (_id, type, payload) => {
      const response = await raw.send(type, payload);
      router.observeSystem('chrome', type, response);
      return response;
    },
  });
  return { raw, router, reaper, live, sent,
    as: (session: string) => router.route(reaper.track(raw, session, 'chrome'), session, 'chrome'),
    advance: () => { clock += 101; },
    reconnect: () => { epoch = 'second'; },
    onClose: (handler: typeof onClose) => { onClose = handler; },
  };
}

describe('session ownership and window cleanup regression races', () => {
  it('a claim during an in-flight window close cannot succeed for a tab that is deleted', async () => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    const started = deferred(); const release = deferred();
    t.onClose(async (payload) => {
      started.resolve(); await release.promise;
      t.live.delete(100);
      return ok({ windowId: payload.windowId, closedTabIds: [100] });
    });
    const closing = t.reaper.sessionClosed('A');
    await started.promise;
    let settled = false;
    const claim = t.as('B').claimTab!(100).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(t.reaper.claim('chrome', 100, 'B')).toBe(false);
    release.resolve(); await closing;
    expect((await claim).ok).toBe(false);
    expect(t.live.has(100)).toBe(false);
    expect(t.reaper.ownerOf('chrome', 100)).toBeUndefined();
    expect(t.router.tabOf('A', 'chrome')).toBeUndefined();
  });

  it('rejects a queued command and claim after their MCP session closes', async () => {
    const t = setup();
    const started = deferred(); const release = deferred();
    const lock = t.router.exclusive('chrome', async () => { started.resolve(); await release.promise; });
    await started.promise;
    const command = t.as('A').send('browser_click');
    const claim = t.as('A').claimTab!(100);
    t.router.sessionClosed('A');
    release.resolve(); await lock;
    expect((await command).error?.code).toBe('SESSION_CLOSED');
    expect((await claim).ok).toBe(false);
    expect(t.live.size).toBe(0);
  });

  it('resweeps another session that closes after the running sweep snapshots its connections', async () => {
    const connections: BrowserConnectionInfo[] = [];
    const info = (connectionId: string): BrowserConnectionInfo => ({ connectionId, connectedAt: 1, open: true,
      active: true, label: '', userAgent: '', lastActiveAt: 0, secondsSinceLastActivity: 0 });
    connections.push(info('first'));
    const live = new Map([['first', new Set<number>()], ['second', new Set<number>()]]);
    const started = deferred(); const release = deferred();
    const send = async (id: string, type: ToolName, payload: Record<string, unknown> = {}) => {
      const tabs = live.get(id)!;
      if (type === 'browser_new_tab') { tabs.add(100); return ok({ tab: { id: 100, url: 'about:blank' } }); }
      if (type === 'browser_list_tabs') return ok({ tabs: [...tabs].map((tabId) => ({ id: tabId, url: 'about:blank' })), closeById: true });
      if (type === 'browser_close_tab') {
        if (id === 'first') { started.resolve(); await release.promise; }
        tabs.delete(Number(payload.tabId)); return ok({ tabId: payload.tabId });
      }
      return ok({});
    };
    const reaper = createTabReaper({ idleMs: 100, listConnections: () => connections, send });
    const as = (session: string, id: string) => reaper.track({ isConnected: () => true,
      listConnections: () => connections, send: (type, payload) => send(id, type, payload) }, session, id);
    await as('A', 'first').send('browser_new_tab');
    const first = reaper.sessionClosed('A');
    await started.promise;
    connections.push(info('second'));
    await as('B', 'second').send('browser_new_tab');
    const second = reaper.sessionClosed('B');
    release.resolve();
    await Promise.all([first, second]);
    expect(live.get('second')?.size).toBe(0);
    expect(reaper.tracked()).toHaveLength(0);
  });

  it('revalidates a stale cleanup candidate after an earlier queued claim refreshes ownership', async () => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    t.advance();
    const started = deferred(); const release = deferred();
    const lock = t.router.exclusive('chrome', async () => { started.resolve(); await release.promise; });
    await started.promise;
    const claim = t.as('B').claimTab!(100);
    const sweep = t.reaper.sweep();
    release.resolve(); await lock;
    expect((await claim).ok).toBe(true);
    expect(await sweep).toBe(0);
    expect(t.reaper.ownerOf('chrome', 100)?.sessionId).toBe('B');
    expect(t.live.has(100)).toBe(true);
  });

  it.each(['removed', 'moved'])('reconciles a normal partial window acknowledgement (%s) and later cleanup still runs', async (kind) => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    t.onClose(async (payload) => {
      if (kind === 'removed') t.live.delete(100);
      else t.live.set(100, 900);
      return ok({ windowId: payload.windowId, closedTabIds: [] });
    });
    await t.reaper.sessionClosed('A');
    if (kind === 'removed') expect(t.reaper.ownerOf('chrome', 100)).toBeUndefined();
    else expect(t.reaper.tracked()[0]?.windowId).toBe(900);
    t.onClose(undefined);
    await t.as('B').send('browser_new_tab');
    await t.reaper.sessionClosed('B');
    expect(t.live.size).toBe(0);
  });

  it('fails closed permanently for an acknowledgement containing an unrequested tab ID', async () => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    t.onClose(async (payload) => ok({ windowId: payload.windowId, closedTabIds: [999] }));
    await t.reaper.sessionClosed('A');
    t.onClose(undefined);
    await t.as('B').send('browser_new_tab');
    await t.reaper.sessionClosed('B');
    expect(t.sent.filter((m) => m.type === 'browser_close_window')).toHaveLength(1);
    expect(t.live.size).toBe(2);
  });

  it('falls back to safe per-tab closing when the extension rejects an old window hint', async () => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    t.onClose(async () => ({ id: '', success: false, error: { code: 'NOT_AGENT_WINDOW', message: 'No live witness' } }));
    await t.reaper.sessionClosed('A');
    expect(t.live.size).toBe(0);
    expect(t.sent.some((m) => m.type === 'browser_close_tab')).toBe(true);
  });

  it('does not close a window containing an untracked human tab', async () => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    t.live.set(1, 150);
    await t.reaper.sessionClosed('A');
    expect(t.live.has(1)).toBe(true);
    expect(t.live.has(100)).toBe(false);
    expect(t.sent.some((m) => m.type === 'browser_close_window')).toBe(false);
  });

  it('forgets routing and ownership on same-millisecond socket reconnection', async () => {
    const t = setup();
    await t.as('A').send('browser_new_tab');
    t.reconnect();
    expect((await t.as('B').claimTab!(100)).ok).toBe(false);
    await t.as('A').send('browser_click');
    expect(t.router.tabOf('A', 'chrome')).toBe(101);
    expect(t.sent.filter((m) => m.type === 'browser_new_tab').at(-1)?.payload.windowId).toBe(150);
    expect(t.reaper.ownerOf('chrome', 100)).toBeUndefined();
  });
});
