/**
 * Snapshot tool: generates ARIA accessibility tree.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Take an ARIA snapshot of the page.
 */
export const snapshotTool: Tool = createTool({
  name: 'browser_snapshot',
  description: `EXPENSIVE FALLBACK: full accessibility tree of the page (can be 10-50x larger than browser_state). Use browser_state first; reach for this only when the compact state is not enough — nested structure you need to understand, or elements browser_state does not list. Returns refs (ref="s1e42") that work with click/type exactly like compact [n] refs.`,
  schema: z.object({
    selector: z.string()
      .optional()
      .describe('CSS selector to scope the snapshot to a specific element'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_snapshot', {
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Snapshot failed');
    }

    // Extension returns {url, title, snapshot}
    const result = response.result as { url?: string; title?: string; snapshot?: string } | string;
    const snapshot = typeof result === 'string' ? result : result.snapshot;

    if (!snapshot) {
      return errorResult('No snapshot data received');
    }

    // Include URL and title as header
    const header = typeof result === 'object' && result.url
      ? `Page: ${result.title || 'Untitled'}\nURL: ${result.url}\n\n`
      : '';

    return textResult(header + snapshot);
  },
});

export const snapshotTools: Tool[] = [snapshotTool];
