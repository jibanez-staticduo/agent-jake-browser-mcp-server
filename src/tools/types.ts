/**
 * Tool type definitions and helpers.
 */
import { z } from 'zod';
import type { Context, Tool, ToolSchema, ToolResult, ContentItem } from '../types.js';

/**
 * Helper to create a tool from a Zod schema.
 */
export function createTool<T extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: T;
  handle: (context: Context, params: z.infer<T>) => Promise<ToolResult>;
}): Tool {
  const { name, description, schema, handle } = options;

  const inputSchema = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-7',
  }) as Record<string, unknown>;

  // Remove $schema property as MCP doesn't need it
  delete inputSchema.$schema;

  const toolSchema: ToolSchema = {
    name,
    description,
    inputSchema,
  };

  return {
    schema: toolSchema,
    async handle(context: Context, params?: Record<string, unknown>): Promise<ToolResult> {
      // Validate input
      const parsed = schema.safeParse(params ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.message}` }],
          isError: true,
        };
      }

      return handle(context, parsed.data);
    },
  };
}

/**
 * Helper to create a text result.
 */
export function textResult(text: string, isError?: boolean): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

/**
 * Helper to create an image result.
 */
export function imageResult(data: string, mimeType: string = 'image/png'): ToolResult {
  return {
    content: [{ type: 'image', data, mimeType }],
  };
}

/**
 * Helper to create a mixed result with text and image.
 */
export function mixedResult(items: ContentItem[]): ToolResult {
  return {
    content: items,
  };
}

/**
 * Helper to format an error result.
 */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
