/**
 * browser_find_tab: what it sends to the extension and how it renders the answer (INFRA-916).
 */
import { describe, it, expect } from 'vitest';
import { getAllTools } from '../src/tools/index.js';
import { fakeContext } from './helpers/fake-context.js';

const tool = (name: string) => {
  const t = getAllTools().find(x => x.schema.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? '';

const tabs = [
  { id: 1, title: 'Búsqueda | CaixaBank', url: 'https://www.caixabank.es/empresas', active: true, connected: false },
  { id: 2, title: 'panel DGX', url: 'https://nexus.lan/panel', active: false, connected: true },
];

describe('browser_find_tab', () => {
  it('sends the query and the limit, and shows the matches with their markers', async () => {
    const { context, sent } = fakeContext({ query: 'caixa', total: 1, tabs: [tabs[0]] });

    const out = text(await tool('browser_find_tab').handle(context, { query: 'caixa', limit: 10 } as never));

    expect(sent).toEqual([{ type: 'browser_find_tab', payload: { query: 'caixa', limit: 10 } }]);
    expect(out).toContain('[1] Búsqueda | CaixaBank (active)');
    expect(out).toContain('https://www.caixabank.es/empresas');
  });

  it('says so when nothing matches, without inventing a tab', async () => {
    const { context } = fakeContext({ query: 'nope', total: 0, tabs: [] });

    expect(text(await tool('browser_find_tab').handle(context, { query: 'nope', limit: 10 } as never)))
      .toBe('No tab matches "nope"');
  });

  it('counts every match but prints only the limit it showed', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...tabs[1], id: i + 10, title: `x ${i}` }));
    const { context } = fakeContext({ query: 'x', total: 14, tabs: many });

    expect(text(await tool('browser_find_tab').handle(context, { query: 'x', limit: 3 } as never)))
      .toContain('(14 matches, showing 3)');
  });

  it('is not routed to the session tab and does not count as using one', async () => {
    const fs = await import('node:fs/promises');
    const source = await Promise.all([fs.readFile('src/session-tabs.ts', 'utf8'), fs.readFile('src/tab-reaper.ts', 'utf8')]);
    expect(source[0]).toMatch(/NOT_ROUTED = new Set<ToolName>\(\[[^\]]*'browser_find_tab'/s);
    expect(source[1]).toMatch(/TAB_MANAGEMENT = new Set<ToolName>\(\[[^\]]*'browser_find_tab'/s);
  });
});
