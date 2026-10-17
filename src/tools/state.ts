/**
 * DOM-first state: the default tools for seeing a page.
 * browser_state typically costs ~1-3 KB. The ARIA snapshot (browser_snapshot)
 * can be 10-50x larger: it is the fallback, not the normal path.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

export const stateTool: Tool = createTool({
  name: 'browser_state',
  description: `Compact page state: url, title, VISIBLE interactive elements with [n] refs, and a text digest. This is the DEFAULT way to see the page before acting; [n] refs work with browser_click, browser_type, browser_select_option, etc. Use browser_snapshot only when this is not enough (nested structure, visual audit).`,
  schema: z.object({
    max: z.number().optional().describe('Maximum elements to list (default 150)'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_state', { max: params.max });
    if (!response.success) {
      return errorResult(response.error?.message ?? 'browser_state failed');
    }
    const result = response.result as { state?: string } | string;
    const state = typeof result === 'string' ? result : result.state;
    return state ? textResult(state) : errorResult('No state data');
  },
});

export const findTool: Tool = createTool({
  name: 'browser_find',
  description: `Search interactive elements by text (visible name or href) and return only the matches with their [n] refs. Cheaper than browser_state when you already know what to look for.`,
  schema: z.object({
    text: z.string().describe('Text to search for in the element name or href'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_find', { text: params.text });
    if (!response.success) {
      return errorResult(response.error?.message ?? 'browser_find failed');
    }
    const result = response.result as { matches?: string } | string;
    const matches = typeof result === 'string' ? result : result.matches;
    return textResult(matches ?? '  (no matches)');
  },
});

export const stateTools: Tool[] = [stateTool, findTool];
