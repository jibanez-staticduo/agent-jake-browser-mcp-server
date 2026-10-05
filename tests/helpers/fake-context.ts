/** A Context whose send() records what the tool sends to the extension and answers `result`. */
import type { Context, ExtensionResponse } from '../../src/types.js';

export function fakeContext(result: unknown = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const context = {
    async send(type: string, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
      sent.push({ type, payload });
      return { id: 'x', success: true, result } as ExtensionResponse;
    },
    isConnected: () => true,
    listConnections: () => [],
  } as unknown as Context;
  return { context, sent };
}
