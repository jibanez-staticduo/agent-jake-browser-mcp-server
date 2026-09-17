/**
 * Interaction tools: click, type, hover, drag, selectOption, pressKey, uploadFile.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Click on an element.
 */
export const clickTool: Tool = createTool({
  name: 'browser_click',
  description: 'Click on an element identified by its ref from a snapshot, or by CSS selector.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot (e.g., "e12")'),
    selector: z.string().optional().describe('CSS selector to find the element'),
    button: z.enum(['left', 'right', 'middle'])
      .optional()
      .default('left')
      .describe('Mouse button to click'),
    clickCount: z.number()
      .optional()
      .default(1)
      .describe('Number of clicks (2 for double-click)'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_click', {
      ref: params.ref,
      selector: params.selector,
      button: params.button,
      clickCount: params.clickCount,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Click failed');
    }

    return textResult(`Clicked on ${params.ref ?? params.selector}`);
  },
});

/**
 * Type text into an element.
 */
export const typeTool: Tool = createTool({
  name: 'browser_type',
  description: 'Type text into an input field or text area.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector to find the element'),
    text: z.string().describe('Text to type'),
    clear: z.boolean()
      .optional()
      .default(false)
      .describe('Clear existing text before typing'),
    delay: z.number()
      .optional()
      .describe('Delay between keystrokes in milliseconds'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_type', {
      ref: params.ref,
      selector: params.selector,
      text: params.text,
      clear: params.clear,
      delay: params.delay,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Type failed');
    }

    return textResult(`Typed "${params.text}" into ${params.ref ?? params.selector}`);
  },
});

/**
 * Hover over an element.
 */
export const hoverTool: Tool = createTool({
  name: 'browser_hover',
  description: 'Hover the mouse over an element to trigger hover effects.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector to find the element'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_hover', {
      ref: params.ref,
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Hover failed');
    }

    return textResult(`Hovered over ${params.ref ?? params.selector}`);
  },
});

/**
 * Drag an element to another location.
 */
export const dragTool: Tool = createTool({
  name: 'browser_drag',
  description: 'Drag an element to another element or position.',
  schema: z.object({
    sourceRef: z.string().optional().describe('Source element reference'),
    sourceSelector: z.string().optional().describe('Source CSS selector'),
    targetRef: z.string().optional().describe('Target element reference'),
    targetSelector: z.string().optional().describe('Target CSS selector'),
  }).refine(
    data => data.sourceRef || data.sourceSelector,
    { message: 'Source ref or selector must be provided' }
  ).refine(
    data => data.targetRef || data.targetSelector,
    { message: 'Target ref or selector must be provided' }
  ),
  async handle(context, params) {
    // The extension's wire format is start*/end* (see its schemas.ts); the MCP
    // surface keeps source*/target* so existing callers do not break.
    const response = await context.send('browser_drag', {
      startRef: params.sourceRef,
      startSelector: params.sourceSelector,
      endRef: params.targetRef,
      endSelector: params.targetSelector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Drag failed');
    }

    return textResult('Drag completed');
  },
});

/**
 * Select an option from a dropdown.
 */
export const selectOptionTool: Tool = createTool({
  name: 'browser_select_option',
  description: 'Select an option from a <select> dropdown element.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the select element'),
    value: z.string().optional().describe('Value attribute of the option to select'),
    label: z.string().optional().describe('Visible text of the option to select'),
    index: z.number().optional().describe('Index of the option to select (0-based)'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ).refine(
    data => data.value !== undefined || data.label !== undefined || data.index !== undefined,
    { message: 'One of value, label, or index must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_select_option', {
      ref: params.ref,
      selector: params.selector,
      value: params.value,
      label: params.label,
      index: params.index,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Select option failed');
    }

    return textResult(`Selected option in ${params.ref ?? params.selector}`);
  },
});

/**
 * Press a keyboard key.
 */
export const pressKeyTool: Tool = createTool({
  name: 'browser_press_key',
  description: 'Press a keyboard key or key combination (e.g., "Enter", "Tab", "Control+A").',
  schema: z.object({
    key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "Control+A")'),
    ref: z.string().optional().describe('Element to focus before pressing key'),
    selector: z.string().optional().describe('CSS selector for element to focus'),
  }),
  async handle(context, params) {
    const response = await context.send('browser_press_key', {
      key: params.key,
      ref: params.ref,
      selector: params.selector,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Press key failed');
    }

    return textResult(`Pressed key: ${params.key}`);
  },
});

/**
 * Upload a file through a file input element.
 */
export const uploadFileTool: Tool = createTool({
  name: 'browser_upload_file',
  description: 'Upload a file through a file input element.',
  schema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for file input'),
    filePath: z.string().describe('Absolute path to the file to upload'),
  }).refine(
    data => data.ref || data.selector,
    { message: 'Either ref or selector must be provided' }
  ),
  async handle(context, params) {
    const response = await context.send('browser_upload_file', {
      ref: params.ref,
      selector: params.selector,
      filePath: params.filePath,
    });

    if (!response.success) {
      return errorResult(response.error?.message ?? 'Upload failed');
    }

    return textResult(`File uploaded: ${params.filePath}`);
  },
});

export const interactionTools: Tool[] = [
  clickTool,
  typeTool,
  hoverTool,
  dragTool,
  selectOptionTool,
  pressKeyTool,
  uploadFileTool,
];
