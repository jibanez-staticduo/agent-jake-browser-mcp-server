/**
 * Playwright configuration for E2E tests.
 */
import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(process.env.BROWSER_EXTENSION_PATH || './test-artifacts/extension');

export default defineConfig({
  testDir: './tests/integration',
  testMatch: 'e2e.test.ts',
  timeout: 60000,
  retries: 0,
  workers: 1, // Extensions require single worker

  use: {
    headless: false, // Extensions don't work in headless mode
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-sandbox',
          ],
        },
      },
    },
  ],
});
