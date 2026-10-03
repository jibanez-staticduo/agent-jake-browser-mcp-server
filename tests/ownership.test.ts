/**
 * Tab ownership: the tab reaper's registry says whose a tab is; session-tabs refuses to act in
 * another live session's tab (TAB_OWNED) and browser_claim_tab hands one over.
 */
import { describe, it, expect } from 'vitest';
import { createSessionTabs } from '../src/session-tabs.ts';
import { createTabReaper } from '../src/tab-reaper.ts';
import { claimTabTool } from '../src/tools/tabs.ts';
import type { Context, ExtensionResponse, ToolName } from '../src/types.ts';

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';

/** One browser as the extension answers it; tab 1 is the user's own. */
function setup(extra: { windowPerSession?: boolean } = {}) {
  const sent: Array<{ type: ToolName; payload: Record<string, unknown> }> = [];
  let nextId = 100;
  const open = new Map<number, number>([[1, 1]]); // tabId -> windowId
  let connected = 1;
  const raw = async (type: ToolName, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> => {
    sent.push({ type, payload });
    const ok = (result: unknown): ExtensionResponse => ({ id: '', success: true, result });
    if (typeof payload.targetTabId === 'number') connected = payload.targetTabId;
    if (type === 'browser_new_tab') {
      const id = nextId++;
      const windowId = extra.windowPerSession ? (typeof payload.windowId === 'number' ? payload.windowId : 50 + id) : undefined;
      open.set(id, windowId ?? 1);
      connected = id;
      return ok({ tab: { id, url: String(payload.url), connected: true, ...(windowId ? { windowId } : {}) }, ...(windowId ? { windowId, windowCreated: payload.windowId === undefined } : {}) });
    }
    if (type === 'browser_switch_tab') { connected = payload.tabId as number; return ok({}); }
    if (type === 'browser_list_tabs') {
      const tabs = [...open].map(([id, windowId]) => ({ id, url: 'about:blank', title: '', active: false, connected: id === connected, windowId }));
      return ok({ tabs, closeById: true, ...(extra.windowPerSession ? { closeWindow: true, windowPerSession: true } : {}) });
    }
    if (type === 'browser_close_tab') { const id = (payload.tabId as number | undefined) ?? connected; open.delete(id); return ok({ tabId: id }); }
    return ok({ actedOn: connected });
  };
  const browser = { send: raw, isConnected: () => true, listConnections: () => [{ connectionId: 'x86', connectedAt: 1, open: true }] } as unknown as Context;
  const reaper = createTabReaper({
    idleMs: 60 * 60_000,
    send: (_c, type, payload) => raw(type, payload),
    listConnections: () => browser.listConnections(),
  });
  const tabs = createSessionTabs({ ownerOf: reaper.ownerOf, claim: reaper.claim });
  const as = (session: string, explicitTabId?: number) =>
    tabs.route(reaper.track(browser, session, 'x86'), session, 'x86', { explicitTabId });
  return { as, sent, tabs, reaper, browser };
}

const tabOwned = (tabId: number, owner: string) =>
  `TAB_OWNED: la pestaña ${tabId} es de la sesión ${owner.slice(0, 8)} (tab ${tabId} belongs to session ${owner.slice(0, 8)}); toma el control con browser_claim_tab`;

describe('tab ownership', () => {
  it('refuses another live session\'s tab with the exact TAB_OWNED message and sends nothing', async () => {
    const t = setup();
    await t.as(A).send('browser_new_tab', { url: 'https://a.test' }); // 100
    const before = t.sent.length;
    for (const type of ['browser_switch_tab', 'browser_close_tab', 'browser_send_to_back'] as ToolName[]) {
      const r = await t.as(B).send(type, { tabId: 100 });
      expect(r.success).toBe(false);
      expect(r.error).toEqual({ code: 'TAB_OWNED', message: tabOwned(100, A) });
    }
    expect(t.sent.length).toBe(before);
  });

  it('an explicit tabId respects ownership, and does not change the session\'s own tab', async () => {
    const t = setup();
    await t.as(A).send('browser_new_tab', { url: 'https://a.test' }); // 100
    await t.as(B).send('browser_new_tab', { url: 'https://b.test' }); // 101
    const refused = await t.as(B, 100).send('browser_click', { selector: '#x' });
    expect(refused.error?.code).toBe('TAB_OWNED');
    expect(t.sent.some((m) => m.type === 'browser_click')).toBe(false);

    const own = await t.as(B, 101).send('browser_click', { selector: '#x' });
    expect(own.success).toBe(true);
    // Dani's tab 1 is nobody's: an explicit target is allowed and still not B's default.
    await t.as(B, 1).send('browser_click', { selector: '#y' });
    expect(t.sent.at(-1)?.payload).toEqual({ selector: '#y', targetTabId: 1 });
    expect(t.tabs.tabOf(B, 'x86')).toBe(101);
    await t.as(B).send('browser_click', { selector: '#z' });
    expect(t.sent.at(-1)?.payload).toEqual({ selector: '#z', targetTabId: 101 });
  });

  it('claim hands the tab over, and the previous owner gets TAB_OWNED afterwards', async () => {
    const t = setup();
    await t.as(A).send('browser_new_tab', { url: 'https://a.test' }); // 100
    expect((await t.as(B).send('browser_click', { selector: '#x' }).catch(() => undefined))).toBeDefined();
    const claimed = await claimTabTool.handle(t.as(B), { tabId: 100 });
    expect(claimed.isError).toBeFalsy();
    expect(t.reaper.ownerOf('x86', 100)).toEqual({ sessionId: B, sessionClosed: false });
    expect(t.tabs.tabOf(B, 'x86')).toBe(100);
    expect(t.tabs.tabOf(A, 'x86')).toBeUndefined();
    const r = await t.as(A, 100).send('browser_click', { selector: '#x' });
    expect(r.error).toEqual({ code: 'TAB_OWNED', message: tabOwned(100, B) });
    // B acts in it without being refused.
    expect((await t.as(B).send('browser_click', { selector: '#x' })).success).toBe(true);
  });

  it('the user\'s own tab cannot be claimed but can be adopted', async () => {
    const t = setup();
    const claimed = await claimTabTool.handle(t.as(B), { tabId: 1 });
    expect(claimed.isError).toBe(true);
    expect(JSON.stringify(claimed.content)).toContain('browser_switch_tab');
    expect((await t.as(B).send('browser_switch_tab', { tabId: 1 })).success).toBe(true);
    expect(t.tabs.tabOf(B, 'x86')).toBe(1);
  });

  it('a tab whose owner session closed is adoptable', async () => {
    const t = setup();
    await t.as(A).send('browser_new_tab', { url: 'https://pay.test', keepOpenMinutes: 30 } as never);
    t.reaper.keep('x86', 100, 30);
    await t.reaper.sessionClosed(A);
    t.tabs.sessionClosed(A);
    expect(t.reaper.ownerOf('x86', 100)?.sessionClosed).toBe(true);
    expect((await t.as(B).send('browser_switch_tab', { tabId: 100 })).success).toBe(true);
    expect((await t.as(B, 100).send('browser_click', { selector: '#pay' })).success).toBe(true);
  });

  it('claim outside an HTTP session says so', async () => {
    const t = setup();
    const r = await claimTabTool.handle(t.browser, { tabId: 100 });
    expect(r.isError).toBe(true);
  });
});
