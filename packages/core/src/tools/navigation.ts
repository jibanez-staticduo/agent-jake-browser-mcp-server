/**
 * Navigation tools: navigate, goBack, goForward, reload.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Navigate to a URL.
 */
export const navigateTool: Tool = createTool({
  name: 'browser_navigate',
  description: 'Navigate the browser to a specified URL. Use this to open web pages.',
  schema: z.object({
    url: z.string().url().describe('The URL to navigate to'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle'])
      .optional()
      .default('load')
      .describe('When to consider navigation complete'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_navigate', {
      url: params.url,
      waitUntil: params.waitUntil,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Navigation failed');
    }

    return textResult(`Navigated to ${params.url}`);
  },
});

/**
 * Go back in browser history.
 */
export const goBackTool: Tool = createTool({
  name: 'browser_go_back',
  description: 'Navigate back in browser history.',
  schema: z.object({}),
  async handle(context) {
    const response = await context.send('browser_go_back');

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Go back failed');
    }

    return textResult('Navigated back');
  },
});

/**
 * Go forward in browser history.
 */
export const goForwardTool: Tool = createTool({
  name: 'browser_go_forward',
  description: 'Navigate forward in browser history.',
  schema: z.object({}),
  async handle(context) {
    const response = await context.send('browser_go_forward');

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Go forward failed');
    }

    return textResult('Navigated forward');
  },
});

/**
 * Reload the current page.
 */
export const reloadTool: Tool = createTool({
  name: 'browser_reload',
  description: 'Reload the current page.',
  schema: z.object({
    ignoreCache: z.boolean()
      .optional()
      .default(false)
      .describe('If true, bypasses the cache'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_reload', {
      ignoreCache: params.ignoreCache,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Reload failed');
    }

    return textResult('Page reloaded');
  },
});

export const navigationTools: Tool[] = [
  navigateTool,
  goBackTool,
  goForwardTool,
  reloadTool,
];
