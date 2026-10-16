/** A Context whose send() records what the tool sends to the extension and answers `result`, or `error` when given. */
import type { Context, ExtensionResponse } from '../../src/types.js';

export function fakeContext(result: unknown = {}, error?: { code?: string; message: string }) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const context = {
    async send(type: string, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
      sent.push({ type, payload });
      return (error ? { id: 'x', success: false, error } : { id: 'x', success: true, result }) as ExtensionResponse;
    },
    isConnected: () => true,
    listConnections: () => [],
  } as unknown as Context;
  return { context, sent };
}
