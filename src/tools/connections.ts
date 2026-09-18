/**
 * Server-side tools about the browser connections themselves.
 */
import { z } from 'zod';
import { createTool, textResult } from './types.js';
import type { Tool } from '../types.js';

/**
 * Lists the browsers currently attached to this server. Answered locally: no
 * message goes to the extension, so it also works when nothing is connected.
 */
export const connectionsTools: Tool[] = [
  createTool({
    name: 'browser_list_connections',
    description:
      'List the browser connections currently attached to this server: connectionId, label, user agent, last activity and which one is active. Pass a returned connectionId as the "connection" argument of any other tool to drive that specific browser. Answered by the server itself, so it also works with no browser connected.',
    schema: z.object({}),
    serverSide: true,
    handle: async (context) => {
      const connections = context.listConnections ? context.listConnections() : [];
      return textResult(JSON.stringify(connections, null, 2));
    },
  }),
];
