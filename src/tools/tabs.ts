/**
 * Tab management tools: newTab, listTabs, switchTab, claimTab, closeTab.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';
import { MAX_KEEP_MINUTES } from '../tab-reaper.js';

/** Handled by the server (src/tab-reaper.ts); never sent to the extension. */
const KEEP_OPEN_MINUTES = z.number()
  .int()
  .min(1)
  .max(MAX_KEEP_MINUTES)
  .optional()
  .describe(
    `Keep this tab open for this many minutes even if your session ends or leaves it idle (max ${MAX_KEEP_MINUTES}). ` +
    'Only for a tab that must outlive the session, such as a payment waiting for a person.',
  );

/**
 * Open a new tab.
 */
export const newTabTool: Tool = createTool({
  name: 'browser_new_tab',
  description:
    'Open a URL in a new browser tab and connect to it. Each session works in a window of its own, ' +
    'created in the BACKGROUND (never focused), so it does not steal the user\'s view; the tab is yours ' +
    'and other sessions get TAB_OWNED if they act in it (they can take it with browser_claim_tab). ' +
    'Your tabs and window close by themselves when your MCP session ends or after 60 minutes without ' +
    'use; keepOpenMinutes holds one open longer (e.g. a payment screen waiting for a person).',
  schema: z.object({
    url: z.string().url().describe('URL to open in the new tab'),
    switchTo: z.boolean()
      .optional()
      .default(false)
      .describe('Deprecated, no effect: nothing is brought to the front. Kept so existing calls still validate.'),
    keepOpenMinutes: KEEP_OPEN_MINUTES,
  }),
  async handle(context, params) {
    const response = await context.send('browser_new_tab', {
      url: params.url,
      switchTo: params.switchTo,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'New tab failed');
    }

    // The extension answers { tab: { id, ... } }; older builds answered { tabId }.
    const result = response.result as { tab?: { id?: number }; tabId?: number };
    return textResult(`Opened new tab (id: ${result.tab?.id ?? result.tabId}) with ${params.url}`);
  },
});

/**
 * List all open tabs.
 */
export const listTabsTool: Tool = createTool({
  name: 'browser_list_tabs',
  description: 'List all open browser tabs with their IDs, titles, and URLs.',
  schema: z.object({}),
  async handle(context) {
    const response = await context.send('browser_list_tabs');

    if (!response.success) {
      return errorResult(response.error?.message ?? 'List tabs failed');
    }

    const rawTabs = response.result as Array<{
      id: number;
      title: string;
      url: string;
      active: boolean;
      connected: boolean;
    }> | { tabs?: Array<{
      id: number;
      title: string;
      url: string;
      active: boolean;
      connected: boolean;
    }> };
    const tabs = Array.isArray(rawTabs) ? rawTabs : rawTabs.tabs ?? [];

    if (tabs.length === 0) {
      return textResult('No tabs found');
    }

    const formatted = tabs.map(tab => {
      const markers = [
        tab.active ? '(active)' : '',
        tab.connected ? '(connected)' : '',
      ].filter(Boolean).join(' ');
      return `[${tab.id}] ${tab.title} ${markers}\n    ${tab.url}`;
    }).join('\n\n');

    return textResult(formatted);
  },
});

/**
 * Switch to a different tab.
 */
export const switchTabTool: Tool = createTool({
  name: 'browser_switch_tab',
  description:
    'Make a browser tab this session\'s current one, by its ID. It does not bring the tab to the front ' +
    'or focus anything: it keeps working in the background. A tab another live session opened answers ' +
    'TAB_OWNED (use browser_claim_tab). With keepOpenMinutes, a tab this session opened stays open that ' +
    'long even after the session ends.',
  schema: z.object({
    tabId: z.number().describe('ID of the tab to switch to'),
    keepOpenMinutes: KEEP_OPEN_MINUTES,
  }),
  async handle(context, params) {
    const response = await context.send('browser_switch_tab', {
      tabId: params.tabId,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Switch tab failed');
    }

    return textResult(`Switched to tab ${params.tabId}`);
  },
});

/**
 * Take over a tab another session opened. Answered by the server (src/session-tabs.ts): the next
 * command already carries the tab as its target, so the extension has nothing to do.
 */
export const claimTabTool: Tool = createTool({
  name: 'browser_claim_tab',
  description:
    'Take over a tab that another session opened, after a command on it answered TAB_OWNED. ' +
    'The tab becomes yours and your session\'s current tab; the previous owner gets TAB_OWNED if it keeps using it. ' +
    'Tabs nobody opened (the user\'s own) cannot be claimed: adopt them with browser_switch_tab.',
  schema: z.object({
    tabId: z.number().describe('ID of the tab to take over (see browser_list_tabs)'),
  }),
  async handle(context, params) {
    if (!context.claimTab) return errorResult('browser_claim_tab needs an MCP session over the HTTP transport.');
    const claimed = await context.claimTab(params.tabId);
    return claimed.ok ? textResult(`Tab ${params.tabId} is now yours`) : errorResult(claimed.message);
  },
});

/**
 * Send a tab to the background.
 */
export const sendToBackTool: Tool = createTool({
  name: 'browser_send_to_back',
  description:
    'Deprecated, does nothing: tabs are never brought to the front, so there is nothing to hide. ' +
    'Kept so existing calls still work.',
  schema: z.object({
    tabId: z.number()
      .optional()
      .describe('ID of the tab to hide. Omit to hide the connected tab.'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_send_to_back', {
      tabId: params.tabId,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Send to back failed');
    }

    return textResult(
      `Tab ${params.tabId ?? 'connected'} sent to background`
    );
  },
});

/**
 * Close a tab.
 */
export const closeTabTool: Tool = createTool({
  name: 'browser_close_tab',
  description: 'Close a browser tab by its ID. If no ID provided, closes the current tab.',
  schema: z.object({
    tabId: z.number().optional().describe('ID of the tab to close. Omit to close current tab.'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_close_tab', {
      tabId: params.tabId,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Close tab failed');
    }

    return textResult(params.tabId ? `Closed tab ${params.tabId}` : 'Closed current tab');
  },
});

export const tabTools: Tool[] = [
  newTabTool,
  listTabsTool,
  switchTabTool,
  claimTabTool,
  sendToBackTool,
  closeTabTool,
];
