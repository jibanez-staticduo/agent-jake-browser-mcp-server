/**
 * Tool registry - exports all available tools.
 */
import { navigationTools } from './navigation.js';
import { stateTools } from './state.js';
import { snapshotTools } from './snapshot.js';
import { interactionTools } from './interaction.js';
import { utilityTools } from './utility.js';
import { tabTools } from './tabs.js';
import { queryTools } from './queries.js';
import { connectionsTools } from './connections.js';
import type { Tool } from '../types.js';
import { isSaveSecretConfigured } from '../onepassword-connect.js';
import { getPluginTools } from './plugins.js';

/**
 * Get all available tools. Plugins (another service behind this server) join the
 * same registry: they are advertised by `tools/list` and answered here, exactly
 * like the server-side browser tools. Nothing is advertised unless configured.
 */
export function getAllTools(): Tool[] {
  return [
    ...navigationTools,
    ...stateTools,
    ...snapshotTools,
    ...interactionTools,
    ...utilityTools,
    ...tabTools,
    ...queryTools,
    ...connectionsTools,
    ...getPluginTools(),
  ].filter((tool) =>
    (tool.schema.name !== 'browser_save_secret' || isSaveSecretConfigured()) &&
    (tool.schema.name !== 'browser_fill_secret' || process.env.AGENT_BROWSER_FILL_SECRET_ENABLED === 'true')
  );
}

// Re-export individual tool sets
export { navigationTools } from './navigation.js';
export { stateTools } from './state.js';
export { snapshotTools } from './snapshot.js';
export { interactionTools } from './interaction.js';
export { utilityTools } from './utility.js';
export { tabTools } from './tabs.js';
export { queryTools } from './queries.js';
export { connectionsTools } from './connections.js';

// Re-export types and helpers
export { createTool, textResult, imageResult, errorResult, mixedResult } from './types.js';
