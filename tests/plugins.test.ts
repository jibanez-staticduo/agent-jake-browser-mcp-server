/**
 * Server plugins (SC-2577): tools this server advertises and answers without a browser,
 * so a consumer (the copilot side panel) gains a capability from `tools/list` alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAllTools } from '../src/tools/index.js';
import { getPluginTools } from '../src/tools/plugins.js';

const ENV = {
  PASEO_MCP_URL: 'http://paseo.test:6767/mcp/agents',
  PASEO_MCP_TOKEN: 'tok',
  PASEO_DEFAULT_PROVIDER: 'claude/test',
};

const tool = (name: string) => {
  const t = getAllTools().find((x) => x.schema.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('server plugins', () => {
  it('advertises nothing while paseo is unconfigured: better no tool than one that always fails', () => {
    vi.stubEnv('PASEO_MCP_URL', '');
    vi.stubEnv('PASEO_MCP_TOKEN', '');
    expect(getPluginTools()).toEqual([]);
    expect(getAllTools().map((t) => t.schema.name)).not.toContain('delegar');
  });

  it('joins the registry once configured, marked external and server-side', () => {
    vi.stubEnv('PASEO_MCP_URL', ENV.PASEO_MCP_URL);
    vi.stubEnv('PASEO_MCP_TOKEN', ENV.PASEO_MCP_TOKEN);
    const names = getAllTools().map((t) => t.schema.name);
    expect(names).toContain('delegar');
    expect(names).toContain('delegar_estado');
    const delegar = tool('delegar');
    expect(delegar.external).toBe(true);
    expect(delegar.serverSide).toBe(true);
  });

  it('delegar launches a paseo agent with the full context and does not wait for it to finish', async () => {
    vi.stubEnv('PASEO_MCP_URL', ENV.PASEO_MCP_URL);
    vi.stubEnv('PASEO_MCP_TOKEN', ENV.PASEO_MCP_TOKEN);
    vi.stubEnv('PASEO_DEFAULT_PROVIDER', ENV.PASEO_DEFAULT_PROVIDER);
    const calls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ body, headers: init.headers });
      return {
        ok: true, status: 200, headers: new Headers(),
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"agentId":"ag-1"}' }] } }),
      };
    }));

    const result = await tool('delegar').handle({} as never, { orden: 'Build the October report from this table' });

    expect(result).toMatchObject({ content: [{ type: 'text', text: '{"agentId":"ag-1"}' }] });
    expect(calls[0].body).toMatchObject({
      method: 'tools/call',
      params: { name: 'create_agent', arguments: {
        title: 'Build the October report from this table',
        provider: 'claude/test',
        initialPrompt: 'Build the October report from this table',
        background: true,
      } },
    });
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('a down paseo reaches the model as an error, not as a broken turn', async () => {
    vi.stubEnv('PASEO_MCP_URL', ENV.PASEO_MCP_URL);
    vi.stubEnv('PASEO_MCP_TOKEN', ENV.PASEO_MCP_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const result = await tool('delegar_estado').handle({} as never, { agente: 'ag-1' });

    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('ECONNREFUSED') }] });
  });
});
