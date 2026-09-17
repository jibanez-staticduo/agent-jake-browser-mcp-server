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
import type { Tool } from '../types.js';

/**
 * Get all available tools.
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
  ];
}

// Re-export individual tool sets
export { navigationTools } from './navigation.js';
export { stateTools } from './state.js';
export { snapshotTools } from './snapshot.js';
export { interactionTools } from './interaction.js';
export { utilityTools } from './utility.js';
export { tabTools } from './tabs.js';
export { queryTools } from './queries.js';

// Re-export types and helpers
export { createTool, textResult, imageResult, errorResult, mixedResult } from './types.js';
