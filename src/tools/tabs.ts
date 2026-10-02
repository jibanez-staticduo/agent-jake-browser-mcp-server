/**
 * Tab management tools: newTab, listTabs, switchTab, closeTab.
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
    'Open a URL in a new browser tab and connect to it. The tab opens in the ' +
    'BACKGROUND so it does not steal the user\'s view; use switchTo: true only ' +
    'when the user is meant to see it. Tabs you open close by themselves when your ' +
    'MCP session ends or after 60 minutes without use; keepOpenMinutes holds one open ' +
    'longer (e.g. a payment screen waiting for a person).',
  schema: z.object({
    url: z.string().url().describe('URL to open in the new tab'),
    switchTo: z.boolean()
      .optional()
      .default(false)
      .describe('Bring the new tab to the front after opening it (default: false, stays in background)'),
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
    'Switch to a different browser tab by its ID. With keepOpenMinutes, a tab this ' +
    'session opened stays open that long even after the session ends.',
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
 * Send a tab to the background.
 */
export const sendToBackTool: Tool = createTool({
  name: 'browser_send_to_back',
  description:
    'Hide the connected (or given) tab by activating another tab of its window, ' +
    'giving the user their view back. Use browser_switch_tab to bring a tab to ' +
    'the front when the user is meant to see it.',
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
  sendToBackTool,
  closeTabTool,
];
