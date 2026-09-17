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
  description: `Take an accessibility snapshot of the current page. Returns a simplified representation of the page structure with element references (ref="...") that can be used with other tools like click, type, etc. Always use this before interacting with elements. Elements inside an iframe come back with their frame tag ("f3:s1e42"): pass the ref exactly as printed — stripped of the tag it resolves against the top frame and finds nothing.`,
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
