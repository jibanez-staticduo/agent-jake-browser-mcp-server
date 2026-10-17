/**
 * E2E test: MCP server + Chrome extension integration.
 * Automatically connects the extension and tests navigation.
 */
import { spawn } from 'child_process';
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '..', '..', 'agent-jake-browser-mcp-extension', 'dist');
const SERVER_PATH = path.join(__dirname, '..', 'dist', 'index.js');

let requestId = 1;

function sendRequest(serverProcess, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    const request = { jsonrpc: '2.0', id, method, params };

    let buffer = '';
    const timeout = setTimeout(() => {
      serverProcess.stdout.off('data', onData);
      reject(new Error(`Timeout: ${method}`));
    }, 15000);

    const onData = (data) => {
      buffer += data.toString();
      for (const line of buffer.split('\n')) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timeout);
              serverProcess.stdout.off('data', onData);
              resolve(response);
              return;
            }
          } catch {}
        }
      }
    };

    serverProcess.stdout.on('data', onData);
    serverProcess.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function main() {
  console.log('🧪 E2E Test: MCP Server + Chrome Extension\n');

  // Start MCP server
  console.log('1️⃣  Starting MCP server...');
  const server = spawn('node', [SERVER_PATH, '--verbose'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let serverConnected = false;
  server.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Extension connected')) {
      serverConnected = true;
    }
    console.log('[Server]', msg.trim());
  });

  await new Promise(r => setTimeout(r, 2000));
  console.log('✅ MCP server started\n');

  // Launch browser
  console.log('2️⃣  Launching Chrome with extension...');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  await new Promise(r => setTimeout(r, 2000));

  // Get extension ID
  const workers = context.serviceWorkers();
  console.log('   Found', workers.length, 'service workers');

  const extensionWorker = workers.find(w => w.url().includes('chrome-extension://'));
  const extensionId = extensionWorker?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];

  if (!extensionId) {
    // Try waiting longer
    await new Promise(r => setTimeout(r, 3000));
    const workers2 = context.serviceWorkers();
    const extensionWorker2 = workers2.find(w => w.url().includes('chrome-extension://'));
    const extensionId2 = extensionWorker2?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId2) {
      console.log('❌ Extension not loaded after waiting');
      console.log('   Service workers:', workers2.map(w => w.url()));
      process.exit(1);
    }
  }
  console.log('✅ Extension loaded:', extensionId, '\n');

  // Listen for console messages from extension
  extensionWorker?.on('console', msg => {
    console.log('[ExtensionWorker]', msg.text());
  });

  // First, open a regular page that we'll automate
  console.log('3️⃣  Opening a test page...');
  const testPage = context.pages()[0] || await context.newPage();
  await testPage.goto('https://example.com');
  await testPage.waitForLoadState('networkidle');
  console.log('✅ Test page loaded\n');

  // Open popup and connect the tab
  console.log('4️⃣  Opening extension popup and connecting tab...');
  const popupPage = await context.newPage();

  // Capture console messages from popup
  popupPage.on('console', msg => {
    console.log('[Popup]', msg.type(), msg.text());
  });
  popupPage.on('pageerror', err => {
    console.log('[Popup Error]', err.message);
  });

  await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await popupPage.waitForTimeout(2000);

  // Look for tabs and click one to connect
  try {
    // Wait for tab list to load
    await popupPage.waitForSelector('.tab-item', { timeout: 5000 });

    // Get all tab items
    const tabItems = await popupPage.locator('.tab-item').all();
    console.log(`   Found ${tabItems.length} tabs in popup`);

    if (tabItems.length > 0) {
      // Click the first tab (should be example.com)
      await tabItems[0].click();
      console.log('✅ Clicked tab to connect');
    } else {
      console.log('⚠️  No tabs found in popup');
    }
  } catch (err) {
    console.log('⚠️  Tab connection error:', err.message);
  }

  // Wait for extension to connect to MCP server
  console.log('   Waiting for extension to connect to MCP server...');
  await popupPage.waitForTimeout(3000);

  // Check connection status
  try {
    const statusText = await popupPage.locator('#statusText').textContent();
    console.log('   Popup status:', statusText);
  } catch {
    console.log('   Could not read popup status');
  }
  console.log('');

  // Test: List tools
  console.log('5️⃣  Testing tools/list...');
  const toolsRes = await sendRequest(server, 'tools/list');
  if (toolsRes.result?.tools?.length > 0) {
    console.log(`✅ ${toolsRes.result.tools.length} tools available\n`);
  } else {
    console.log('❌ No tools\n');
  }

  // Test: Navigate
  console.log('6️⃣  Testing browser_navigate...');
  const navRes = await sendRequest(server, 'tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });

  if (navRes.result && !navRes.result.isError) {
    console.log('✅ Navigation result:', navRes.result.content?.[0]?.text || navRes.result);
  } else {
    console.log('❌ Navigation failed:', navRes.result?.content?.[0]?.text || navRes.error);
  }

  // Test: Snapshot
  console.log('\n7️⃣  Testing browser_snapshot...');
  const snapRes = await sendRequest(server, 'tools/call', {
    name: 'browser_snapshot',
    arguments: {},
  });

  if (snapRes.result && !snapRes.result.isError) {
    const content = snapRes.result.content?.[0]?.text || '';
    const preview = content.substring(0, 200);
    console.log('✅ Snapshot preview:', preview, '...');
  } else {
    console.log('❌ Snapshot failed:', snapRes.result?.content?.[0]?.text || snapRes.error);
  }

  // Test: Screenshot
  console.log('\n8️⃣  Testing browser_screenshot...');
  const ssRes = await sendRequest(server, 'tools/call', {
    name: 'browser_screenshot',
    arguments: {},
  });

  if (ssRes.result?.content?.[0]?.type === 'image') {
    console.log('✅ Screenshot captured (base64 data received)');
  } else {
    console.log('❌ Screenshot failed:', ssRes.result?.content?.[0]?.text || ssRes.error);
  }

  // Cleanup
  console.log('\n9️⃣  Cleaning up...');
  await popupPage.close();
  await context.close();
  server.kill();

  console.log('\n✅ E2E Test Complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
