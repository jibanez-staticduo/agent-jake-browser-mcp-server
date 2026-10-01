/**
 * End-to-end tests with Playwright and the Chrome extension.
 *
 * These tests start the MCP server, load the Chrome extension,
 * and verify full automation flow.
 */
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '..', '..', 'agent-jake-browser-mcp-extension', 'dist');
const SERVER_PATH = path.join(__dirname, '..', 'dist', 'index.js');

/**
 * Helper to launch browser with extension.
 */
async function launchBrowserWithExtension(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  // Wait for extension to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  return context;
}

/**
 * Helper to start the MCP server.
 */
function startMCPServer(): ChildProcess {
  const proc = spawn('node', [SERVER_PATH, '--verbose'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stderr?.on('data', (data) => {
    console.log('[Server]', data.toString());
  });

  return proc;
}

/**
 * Send an MCP request to the server.
 */
function sendMCPRequest(
  server: ChildProcess,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    let buffer = '';

    const onData = (data: Buffer) => {
      buffer += data.toString();

      // Try to parse complete JSON-RPC responses
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              server.stdout?.off('data', onData);
              resolve(response);
            }
          } catch {
            // Not complete JSON yet
          }
        }
      }
    };

    server.stdout?.on('data', onData);

    // Timeout after 10 seconds
    setTimeout(() => {
      server.stdout?.off('data', onData);
      reject(new Error('Request timeout'));
    }, 10000);

    server.stdin?.write(JSON.stringify(request) + '\n');
  });
}

test.describe('MCP Server E2E', () => {
  let server: ChildProcess;
  let context: BrowserContext;

  test.beforeAll(async () => {
    // Start MCP server
    server = startMCPServer();

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Launch browser with extension
    context = await launchBrowserWithExtension();
  });

  test.afterAll(async () => {
    // Cleanup
    await context?.close();
    server?.kill();
  });

  test('server responds to tools/list', async () => {
    const response = await sendMCPRequest(server, 'tools/list') as {
      result?: { tools: Array<{ name: string }> };
      error?: { message: string };
    };

    expect(response.result).toBeDefined();
    expect(response.result?.tools).toBeDefined();
    expect(response.result?.tools.length).toBeGreaterThan(0);

    // Check for some expected tools
    const toolNames = response.result?.tools.map(t => t.name) ?? [];
    expect(toolNames).toContain('browser_navigate');
    expect(toolNames).toContain('browser_snapshot');
    expect(toolNames).toContain('browser_click');
  });

  test('extension connects to server', async () => {
    // Open extension popup
    const workers = context.serviceWorkers();
    const extensionWorker = workers.find(w => w.url().includes('chrome-extension://'));

    expect(extensionWorker).toBeDefined();

    // Get extension ID
    const match = extensionWorker!.url().match(/chrome-extension:\/\/([^/]+)/);
    const extensionId = match?.[1];
    expect(extensionId).toBeDefined();

    // Open popup and check connection status
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

    // Wait for connection status to update
    await popupPage.waitForTimeout(2000);

    // Should show connection status
    const statusText = await popupPage.locator('#statusText').textContent();
    expect(statusText).toBeTruthy();

    await popupPage.close();
  });

  test.skip('navigate tool works', async () => {
    // This test requires the extension to be connected
    // Skip in CI as it requires manual connection setup

    const response = await sendMCPRequest(server, 'tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    }) as {
      result?: { content: Array<{ text?: string }> };
      error?: { message: string };
    };

    expect(response.result).toBeDefined();
    expect(response.result?.content[0]?.text).toContain('example.com');
  });

  test.skip('snapshot tool works', async () => {
    // Navigate first
    await sendMCPRequest(server, 'tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });

    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Take snapshot
    const response = await sendMCPRequest(server, 'tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    }) as {
      result?: { content: Array<{ text?: string }> };
      error?: { message: string };
    };

    expect(response.result).toBeDefined();
    expect(response.result?.content[0]?.text).toBeTruthy();
    // Snapshot should contain some page elements
    expect(response.result?.content[0]?.text).toContain('Example');
  });
});
