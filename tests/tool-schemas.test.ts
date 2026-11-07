/**
 * What a client is told before it calls.
 *
 * The "at least one of these" rules used to live only in a runtime `refine`, so `tools/list`
 * advertised a schema that accepted `{}` and the caller learned about it after a round trip.
 * These assert the same rule as JSON Schema (`anyOf` of `required`), and that every named
 * alternative is a field the schema really declares.
 */
import { describe, expect, it } from 'vitest';
import { connectionsTools } from '../src/tools/connections.ts';
import { interactionTools } from '../src/tools/interaction.ts';
import { navigationTools } from '../src/tools/navigation.ts';
import { queryTools } from '../src/tools/queries.ts';
import { snapshotTools } from '../src/tools/snapshot.ts';
import { stateTools } from '../src/tools/state.ts';
import { tabTools } from '../src/tools/tabs.ts';
import { utilityTools } from '../src/tools/utility.ts';

// The tool sets, not `getAllTools()`: save_secret is only registered when the Connect write
// token is configured, and this contract holds whether or not it is.
const tools = new Map(
  [
    ...navigationTools,
    ...stateTools,
    ...snapshotTools,
    ...interactionTools,
    ...utilityTools,
    ...tabTools,
    ...queryTools,
    ...connectionsTools,
  ].map((tool) => [tool.schema.name, tool]),
);

function schemaOf(name: string): any {
  const tool = tools.get(name);
  expect(tool, name).toBeDefined();
  return tool!.schema.inputSchema;
}

/** The JSON Schema for "at least one of these fields". */
const oneOf = (...fields: string[]) => fields.map((field) => ({ required: [field] }));

/** Every "at least one of" group the advertised schema declares, top level or under `allOf`. */
function alternatives(name: string): string[][] {
  const schema = schemaOf(name);
  const groups: string[][] = [];
  if (Array.isArray(schema.anyOf)) {
    groups.push(...schema.anyOf.map((part: any) => part.required));
  }
  for (const part of (schema.allOf ?? []) as any[]) {
    if (Array.isArray(part.anyOf)) groups.push(...part.anyOf.map((inner: any) => inner.required));
  }
  return groups;
}

describe('required alternatives in the advertised schemas', () => {
  it.each(['browser_click', 'browser_type', 'browser_hover', 'browser_highlight',
    'browser_get_text', 'browser_get_attribute', 'browser_is_visible', 'browser_passkey'])(
    '%s advertises ref or selector', (name) => {
      expect(schemaOf(name).anyOf).toEqual(oneOf('ref', 'selector'));
    },
  );

  it('keeps the two rules of a drag independent', () => {
    expect(schemaOf('browser_drag').allOf).toEqual([
      { anyOf: oneOf('sourceRef', 'sourceSelector') },
      { anyOf: oneOf('targetRef', 'targetSelector') },
    ]);
    expect(schemaOf('browser_drag').anyOf).toBeUndefined();
  });

  it('splits select, drop and save_secret into their own groups', () => {
    expect(schemaOf('browser_select_option').allOf).toEqual([
      { anyOf: oneOf('ref', 'selector') },
      { anyOf: oneOf('value', 'label', 'index') },
    ]);
    expect(schemaOf('browser_drop').allOf).toEqual([
      { anyOf: oneOf('ref', 'selector') },
      { anyOf: oneOf('paths', 'data') },
    ]);
    expect(schemaOf('browser_save_secret').anyOf).toEqual(oneOf('ref', 'selector', 'regex'));
  });

  it('advertises the file argument of an upload', () => {
    expect(schemaOf('browser_upload_file').anyOf).toEqual(oneOf('filePath', 'filePaths'));
  });

  it('keeps a tool with no such rule free of anyOf', () => {
    expect(schemaOf('browser_navigate').anyOf).toBeUndefined();
    expect(schemaOf('browser_navigate').allOf).toBeUndefined();
  });

  it('names only fields the tool actually declares', () => {
    for (const tool of tools.values()) {
      const properties = (tool.schema.inputSchema as any).properties ?? {};
      for (const group of alternatives(tool.schema.name)) {
        for (const field of group) {
          expect(properties, `${tool.schema.name} advertises required ${field}`).toHaveProperty(field);
        }
      }
    }
  });

  it('still refuses a call that satisfies none of the alternatives', async () => {
    const tool = tools.get('browser_get_text')!;
    const result = await tool.handle({ send: async () => ({ id: '1', success: true, result: 'x' }) } as never, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ref or selector');
  });
});

describe('annotations', () => {
  /** What a client may assume before calling: read-only, destructive, repeatable, outside world. */
  function annotationsOf(name: string): any {
    const annotations = tools.get(name)!.schema.annotations;
    expect(annotations, name).toBeDefined();
    return annotations;
  }

  it.each([
    'browser_state', 'browser_find', 'browser_snapshot', 'browser_get_text', 'browser_get_attribute',
    'browser_is_visible', 'browser_wait_for_element', 'browser_get_cookies', 'browser_list_tabs',
    'browser_find_tab', 'browser_list_connections', 'browser_wait',
  ])('%s is a repeatable read', (name) => {
    expect(annotationsOf(name)).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it.each([
    'browser_get_html', 'browser_screenshot', 'browser_pdf', 'browser_network_requests',
    'browser_network_request',
  ])('%s reads the page but may write its output, so a repeat is not a no-op', (name) => {
    const annotations = annotationsOf(name);
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.idempotentHint).toBeUndefined();
  });

  it.each(['browser_close_tab', 'browser_run_code_unsafe'])('%s is destructive', (name) => {
    expect(annotationsOf(name).destructiveHint).toBe(true);
  });

  it('claims nothing about tools that change the page', () => {
    for (const name of ['browser_click', 'browser_type', 'browser_navigate', 'browser_reload',
      'browser_new_tab', 'browser_switch_tab', 'browser_drop', 'browser_highlight']) {
      const annotations = annotationsOf(name);
      expect(annotations.readOnlyHint, name).toBe(false);
      expect(annotations.destructiveHint, name).toBe(false);
    }
  });

  it('opens the world only for a tool that reaches a browser', () => {
    for (const [name, tool] of tools) {
      expect(tool.schema.annotations, name).toBeDefined();
      expect(tool.schema.annotations?.openWorldHint, name).toBe(!tool.serverSide);
    }
  });
});
