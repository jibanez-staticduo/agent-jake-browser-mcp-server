import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { INDEX_HTML } from '../src/http/pages.js';

// Exercise the shipped page script with a DOM that refuses HTML parsing sinks.
class Element {
  children: Element[] = [];
  className = '';
  private text = '';

  constructor(readonly tag: string) {}
  set textContent(value: string) {
    this.text = String(value);
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set innerHTML(_value: string) {
    throw new Error('Untrusted HTML parsing is forbidden');
  }
  appendChild(child: Element) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...children: Element[]) {
    this.text = '';
    this.children = children;
  }
}

function page(data: unknown) {
  const box = new Element('div');
  const script = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const context = {
    document: {
      getElementById: () => box,
      createElement: (tag: string) => new Element(tag),
    },
    fetch: async () => ({ json: async () => data }),
    setInterval: () => {},
  };
  runInNewContext(script, context);
  return { box, load: () => runInNewContext('load()', context) as Promise<void> };
}

describe('connections page rendering', () => {
  it('renders hostile connection metadata as literal text in the intended cells', async () => {
    const connectionId = '</code><img src=x onerror=alert(1)>';
    const label = '<svg onload=alert(2)> & "Equipo"';
    const wsUrl = 'wss://example.invalid/<script>alert(3)</script>';
    const { box, load } = page({
      connections: [{ connectionId, label, open: true, active: true, secondsSinceLastActivity: 2.4 }],
      authEnabled: true,
      wsUrl,
    });
    await load();
    const [table, status] = box.children;
    expect(table!.tag).toBe('table');
    expect(table!.children[0]!.children[0]!.children[1]!.textContent).toBe('Equipo / navegador');
    const cells = table!.children[1]!.children[0]!.children;
    expect(cells[0]!.children[0]!.tag).toBe('code');
    expect(cells[0]!.textContent).toBe(connectionId);
    expect(cells[1]!.textContent).toBe(label);
    expect(cells[1]!.children).toHaveLength(0);
    expect(cells[2]!.textContent).toBe('abierta');
    expect(cells[3]!.textContent).toBe('2s');
    expect(cells[4]!.children[0]!.className).toBe('badge active');
    expect(status!.children[0]!.textContent).toBe(wsUrl);
    expect(status!.textContent).toBe('Auth: token requerido · WS: ' + wsUrl);
  });

  it('renders closed, unlabelled connections and empty responses', async () => {
    const data = { connections: [{ connectionId: 'chrome', open: false, active: false, secondsSinceLastActivity: 0 }], wsUrl: 'ws://localhost' };
    const { box, load } = page(data);
    await load();
    const cells = box.children[0]!.children[1]!.children[0]!.children;
    expect(cells[1]!.textContent).toBe('');
    expect(cells[2]!.textContent).toBe('cerrada');
    expect(cells[4]!.children).toHaveLength(0);
    data.connections = [];
    await load();
    expect(box.children).toHaveLength(0);
    expect(box.textContent).toContain('Ninguna conexión abierta');
  });
});
