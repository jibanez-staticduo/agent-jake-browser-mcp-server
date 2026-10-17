/**
 * Manual test script for MCP server + Chrome extension integration.
 * Launches browser with extension and sends MCP commands via stdin.
 */
import { spawn } from 'child_process';
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '..', '..', 'agent-jake-browser-mcp-extension', 'dist');
const SERVER_PATH = path.join(__dirname, '..', 'dist', 'index.js');

let requestId = 1;

/**
 * Send an MCP request and wait for response.
 */
function sendRequest(serverProcess, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Request timeout for ${method}`));
    }, 15000);

    const onData = (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timeout);
              serverProcess.stdout.off('data', onData);
              resolve(response);
              return;
            }
          } catch {
            // Not valid JSON yet
          }
        }
      }
    };

    serverProcess.stdout.on('data', onData);

    console.log(`\n📤 Sending: ${method}`);
    serverProcess.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function main() {
  console.log('🚀 Starting MCP Server + Extension Test\n');
  console.log('Extension path:', EXTENSION_PATH);
  console.log('Server path:', SERVER_PATH);

  // Start MCP server
  console.log('\n1️⃣ Starting MCP server...');
  const server = spawn('node', [SERVER_PATH, '--verbose'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (data) => {
    console.log('[Server]', data.toString().trim());
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Launch browser with extension
  console.log('\n2️⃣ Launching Chrome with extension...');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  console.log('✅ Browser launched');

  // Wait for extension to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Get extension ID
  const workers = context.serviceWorkers();
  const extensionWorker = workers.find(w => w.url().includes('chrome-extension://'));
  if (extensionWorker) {
    const match = extensionWorker.url().match(/chrome-extension:\/\/([^/]+)/);
    if (match) {
      console.log('✅ Extension loaded, ID:', match[1]);
    }
  }

  // Test 1: List tools
  console.log('\n3️⃣ Testing tools/list...');
  try {
    const toolsResponse = await sendRequest(server, 'tools/list');
    if (toolsResponse.result?.tools) {
      console.log(`✅ Got ${toolsResponse.result.tools.length} tools:`);
      toolsResponse.result.tools.forEach(t => console.log(`   - ${t.name}`));
    } else {
      console.log('❌ No tools returned:', toolsResponse);
    }
  } catch (err) {
    console.log('❌ tools/list failed:', err.message);
  }

  // Wait for extension to connect
  console.log('\n4️⃣ Waiting for extension to connect (check popup)...');
  console.log('   Open the extension popup and click "Connect" if needed');

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n📝 Interactive mode - enter commands:');
  console.log('   navigate <url> - Navigate to URL');
  console.log('   snapshot       - Take accessibility snapshot');
  console.log('   screenshot     - Take screenshot');
  console.log('   tabs           - List tabs');
  console.log('   quit           - Exit\n');

  const askCommand = () => {
    rl.question('> ', async (input) => {
      const [cmd, ...args] = input.trim().split(' ');

      try {
        switch (cmd) {
          case 'navigate': {
            const url = args[0] || 'https://example.com';
            const res = await sendRequest(server, 'tools/call', {
              name: 'browser_navigate',
              arguments: { url },
            });
            console.log('📥 Response:', JSON.stringify(res.result || res.error, null, 2));
            break;
          }
          case 'snapshot': {
            const res = await sendRequest(server, 'tools/call', {
              name: 'browser_snapshot',
              arguments: {},
            });
            console.log('📥 Response:', JSON.stringify(res.result || res.error, null, 2));
            break;
          }
          case 'screenshot': {
            const res = await sendRequest(server, 'tools/call', {
              name: 'browser_screenshot',
              arguments: {},
            });
            if (res.result?.content?.[0]?.type === 'image') {
              console.log('📥 Screenshot taken (base64 data received)');
            } else {
              console.log('📥 Response:', JSON.stringify(res.result || res.error, null, 2));
            }
            break;
          }
          case 'tabs': {
            const res = await sendRequest(server, 'tools/call', {
              name: 'browser_list_tabs',
              arguments: {},
            });
            console.log('📥 Response:', JSON.stringify(res.result || res.error, null, 2));
            break;
          }
          case 'quit':
          case 'exit':
            console.log('👋 Shutting down...');
            await context.close();
            server.kill();
            rl.close();
            process.exit(0);
            return;
          default:
            console.log('Unknown command:', cmd);
        }
      } catch (err) {
        console.log('❌ Error:', err.message);
      }

      askCommand();
    });
  };

  askCommand();
}

main().catch(console.error);
