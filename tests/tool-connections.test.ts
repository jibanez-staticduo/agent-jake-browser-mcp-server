/**
 * browser_list_connections is answered by the server, not the browser.
 */
import { describe, it, expect, vi } from 'vitest';
import { getAllTools } from '../src/tools/index.ts';
import type { BrowserConnectionInfo, Context } from '../src/types.ts';

const connections: BrowserConnectionInfo[] = [
  {
    connectionId: 'chrome-a',
    label: 'casa',
    userAgent: 'Chrome',
    connectedAt: 1,
    lastActiveAt: 2,
    open: true,
    active: true,
    secondsSinceLastActivity: 0,
  },
];

describe('browser_list_connections', () => {
  const tool = getAllTools().find((t) => t.schema.name === 'browser_list_connections');

  it('is registered as a server-side tool', () => {
    expect(tool).toBeDefined();
    expect(tool?.serverSide).toBe(true);
    // The base schema stays untouched: `connection` is annotated at the HTTP layer.
    expect(tool?.schema.inputSchema.properties?.connection).toBeUndefined();
  });

  it('answers from the context without touching the browser', async () => {
    const send = vi.fn();
    const context: Context = {
      send,
      isConnected: () => false,
      listConnections: () => connections,
    };

    const result = await tool!.handle(context, {});
    expect(send).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed[0].connectionId).toBe('chrome-a');
    expect(parsed[0].active).toBe(true);
  });

  it('answers with an empty list when nothing is connected', async () => {
    const context: Context = {
      send: vi.fn(),
      isConnected: () => false,
      listConnections: () => [],
    };
    const result = await tool!.handle(context, {});
    expect(result.content[0].text).toBe('[]');
  });
});
