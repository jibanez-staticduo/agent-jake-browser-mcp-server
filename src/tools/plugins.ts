/**
 * Server plugins: tools this server advertises and answers itself, without touching a browser.
 * They exist so a consumer (the copilot side panel) gains a capability by reading `tools/list`
 * instead of shipping code for it.
 *
 * `delegar` and `delegar_estado` talk to paseo's MCP server, which is what launches Claude CLI
 * agents. Both settings are read from the environment on every call so a test can point them at
 * its own stub. Without URL or token the plugins are not advertised at all: better to have no
 * tool than to advertise one that always fails.
 */
import { z } from 'zod';
import { createTool, textResult, errorResult } from './types.js';
import type { Tool, ToolResult } from '../types.js';

let seq = 0;

interface PaseoConfig {
  url: string;
  token: string;
  provider: string;
}

function paseoConfig(): PaseoConfig | null {
  const url = process.env.PASEO_MCP_URL ?? '';
  const token = process.env.PASEO_MCP_TOKEN ?? '';
  if (!url || !token) return null;
  return { url, token, provider: process.env.PASEO_DEFAULT_PROVIDER || 'claude/qwen38-flash-next' };
}

/** One JSON-RPC POST to paseo; the answer arrives as JSON or as a single SSE `data:` line. */
async function rpc(config: PaseoConfig, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, ...(params === undefined ? {} : { params }) }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`paseo ${response.status}: ${body.slice(0, 200)}`);
  const payload = body.includes('data:') ? body.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim() : body;
  const parsed = (payload ? JSON.parse(payload) : {}) as { result?: Record<string, unknown>; error?: { message: string } };
  if (parsed.error) throw new Error(`paseo: ${parsed.error.message}`);
  return parsed.result ?? {};
}

/** Calls one paseo tool and hands back its text. */
async function callPaseo(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const config = paseoConfig();
  if (!config) return errorResult('The paseo plugin is not configured (PASEO_MCP_URL, PASEO_MCP_TOKEN).');
  try {
    const result = await rpc(config, 'tools/call', { name, arguments: args });
    const parts = (result.content as { text?: string }[] | undefined) ?? [];
    const text = parts.map((part) => part.text ?? '').join('\n').trim();
    return result.isError ? errorResult(text || `paseo failed: ${name}`) : textResult(text);
  } catch (error) {
    return errorResult(`Could not reach paseo: ${(error as Error).message}`);
  }
}

export function getPluginTools(): Tool[] {
  if (!paseoConfig()) return [];
  return [
    createTool({
      name: 'delegar',
      description:
        'Delegate a job to an agent running outside the browser (Claude CLI on paseo) and return as soon as it is launched, without waiting for it to finish. ' +
        'Use it when what is needed is not a browser action: writing code, building a report, a long task. ' +
        'The `orden` text must carry all the context: that agent does not see this page or this conversation. ' +
        'With the id it returns, `delegar_estado` tells how it is going.',
      schema: z.object({
        orden: z.string().min(1).describe('What the agent has to do, with all the context it needs.'),
        titulo: z.string().max(60).optional().describe('Short title for the agent (<= 60 characters).'),
        proveedor: z.string().optional().describe('provider/model pair, e.g. claude/qwen38-flash-next. Defaults to the one configured on this server.'),
      }),
      serverSide: true,
      external: true,
      handle: async (_context, params) => {
        const config = paseoConfig()!;
        const title = (params.titulo ?? params.orden).slice(0, 60);
        return callPaseo('create_agent', {
          title,
          provider: params.proveedor ?? config.provider,
          initialPrompt: params.orden,
          background: true,
        });
      },
    }),
    createTool({
      name: 'delegar_estado',
      description: 'How a delegated job is going: the status of the agent that `delegar` returned.',
      schema: z.object({ agente: z.string().min(1).describe('The id `delegar` returned.') }),
      serverSide: true,
      external: true,
      handle: async (_context, params) => callPaseo('get_agent_status', { agentId: params.agente }),
    }),
  ];
}
