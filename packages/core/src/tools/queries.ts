/**
 * Element query tools: getText, getAttribute, isVisible, waitForElement, highlight.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Get text content of an element.
 */
export const getTextTool: Tool = createTool({
  name: 'browser_get_text',
  description: 'Get the text content of an element.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_get_text', {
      ref: params.ref,
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Get text failed');
    }

    const rawText = response.result as string | { text?: string };
    const text = typeof rawText === 'string' ? rawText : rawText.text;
    return textResult(text || '(empty)');
  },
});

/**
 * Get an attribute value from an element.
 */
export const getAttributeTool: Tool = createTool({
  name: 'browser_get_attribute',
  description: 'Get the value of a specific attribute from an element.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
    attribute: z.string().describe('Name of the attribute to get'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_get_attribute', {
      ref: params.ref,
      selector: params.selector,
      attribute: params.attribute,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Get attribute failed');
    }

    const rawValue = response.result as string | null | { value?: string | null };
    const value = typeof rawValue === 'object' && rawValue !== null ? rawValue.value : rawValue;
    return textResult(value ?? '(null)');
  },
});

/**
 * Check if an element is visible.
 */
export const isVisibleTool: Tool = createTool({
  name: 'browser_is_visible',
  description: 'Check if an element is visible on the page.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_is_visible', {
      ref: params.ref,
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Is visible check failed');
    }

    const visible = response.result as boolean;
    return textResult(visible ? 'Element is visible' : 'Element is not visible');
  },
});

/**
 * Wait for an element to appear.
 */
export const waitForElementTool: Tool = createTool({
  name: 'browser_wait_for_element',
  description: 'Wait for an element to appear on the page.',
  schema: z.object({
    selector: z.string().describe('CSS selector for the element to wait for'),
    timeout: z.number()
      .min(0)
      .max(30000)
      .optional()
      .default(5000)
      .describe('Maximum time to wait in milliseconds'),
    state: z.enum(['attached', 'visible', 'hidden', 'detached'])
      .optional()
      .default('visible')
      .describe('State to wait for'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_wait_for_element', {
      selector: params.selector,
      timeout: params.timeout,
      state: params.state,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? `Element not found: ${params.selector}`);
    }

    return textResult(`Element ${params.selector} is ${params.state}`);
  },
});

/**
 * Highlight an element visually.
 */
export const highlightTool: Tool = createTool({
  name: 'browser_highlight',
  description: 'Temporarily highlight an element with a colored border for visual debugging.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
    color: z.string()
      .optional()
      .default('red')
      .describe('Highlight color (CSS color value)'),
    duration: z.number()
      .min(0)
      .max(10000)
      .optional()
      .default(2000)
      .describe('Duration of highlight in milliseconds'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_highlight', {
      ref: params.ref,
      selector: params.selector,
      color: params.color,
      duration: params.duration,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Highlight failed');
    }

    return textResult(`Highlighted ${params.ref ?? params.selector}`);
  },
});

export const queryTools: Tool[] = [
  getTextTool,
  getAttributeTool,
  isVisibleTool,
  waitForElementTool,
  highlightTool,
];
