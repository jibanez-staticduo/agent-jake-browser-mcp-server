import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAllTools } from '../src/tools/index.js';

afterEach(() => vi.unstubAllEnvs());

describe('secret fill registration gate', () => {
  it.each([undefined, '', 'false', '1', 'TRUE', ' true '])('keeps the original 39 tools for %j', value => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', value);
    const tools = getAllTools();
    expect(tools).toHaveLength(39);
    expect(tools.some(tool => tool.schema.name === 'browser_fill_secret')).toBe(false);
    expect(tools.some(tool => tool.schema.name === 'browser_new_tab')).toBe(true);
  });

  it('adds exactly one secret fill tool only for true', () => {
    vi.stubEnv('AGENT_BROWSER_FILL_SECRET_ENABLED', 'true');
    const tools = getAllTools();
    expect(tools).toHaveLength(40);
    expect(tools.filter(tool => tool.schema.name === 'browser_fill_secret')).toHaveLength(1);
  });
});
