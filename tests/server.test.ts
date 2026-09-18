/**
 * Unit tests for the MCP server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAllTools } from '../src/tools/index.js';

describe('Tool Registry', () => {
  it('returns all registered tools', () => {
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('each tool has required schema properties', () => {
    const tools = getAllTools();

    for (const tool of tools) {
      expect(tool.schema).toBeDefined();
      expect(tool.schema.name).toBeDefined();
      expect(typeof tool.schema.name).toBe('string');
      expect(tool.schema.description).toBeDefined();
      expect(typeof tool.schema.description).toBe('string');
      expect(tool.schema.inputSchema).toBeDefined();
    }
  });

  it('tool names are unique', () => {
    const tools = getAllTools();
    const names = tools.map(t => t.schema.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('includes all expected tool categories', () => {
    const tools = getAllTools();
    const names = tools.map(t => t.schema.name);

    // Navigation
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_go_back');
    expect(names).toContain('browser_go_forward');
    expect(names).toContain('browser_reload');

    // Snapshot
    expect(names).toContain('browser_snapshot');

    // Interaction
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_type');
    expect(names).toContain('browser_hover');
    expect(names).toContain('browser_drag');
    expect(names).toContain('browser_select_option');
    expect(names).toContain('browser_press_key');

    // Utility
    expect(names).toContain('browser_wait');
    expect(names).toContain('browser_screenshot');
    expect(names).toContain('browser_get_console_logs');

    // Tab management
    expect(names).toContain('browser_new_tab');
    expect(names).toContain('browser_list_tabs');
    expect(names).toContain('browser_switch_tab');
    expect(names).toContain('browser_close_tab');

    // Queries
    expect(names).toContain('browser_get_text');
    expect(names).toContain('browser_get_attribute');
    expect(names).toContain('browser_is_visible');
    expect(names).toContain('browser_wait_for_element');
    expect(names).toContain('browser_highlight');
  });
});

describe('Tool Input Validation', () => {
  it('browser_navigate requires valid URL', async () => {
    const tools = getAllTools();
    const navigateTool = tools.find(t => t.schema.name === 'browser_navigate')!;

    // Mock context
    const mockContext = {
      send: vi.fn(),
      isConnected: () => true,
      listConnections: () => [],
    };

    // Invalid URL should fail validation
    const result = await navigateTool.handle(mockContext, { url: 'not-a-url' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid');
  });

  it('browser_click requires ref or selector', async () => {
    const tools = getAllTools();
    const clickTool = tools.find(t => t.schema.name === 'browser_click')!;

    const mockContext = {
      send: vi.fn(),
      isConnected: () => true,
      listConnections: () => [],
    };

    // Neither ref nor selector should fail
    const result = await clickTool.handle(mockContext, {});
    expect(result.isError).toBe(true);
  });

  it('browser_wait_for_element validates timeout range', async () => {
    const tools = getAllTools();
    const waitTool = tools.find(t => t.schema.name === 'browser_wait_for_element')!;

    const mockContext = {
      send: vi.fn(),
      isConnected: () => true,
      listConnections: () => [],
    };

    // Timeout too large should fail
    const result = await waitTool.handle(mockContext, {
      selector: '.test',
      timeout: 60000,
    });
    expect(result.isError).toBe(true);
  });
});

describe('Tool Result Formatting', () => {
  it('successful navigation returns text result', async () => {
    const tools = getAllTools();
    const navigateTool = tools.find(t => t.schema.name === 'browser_navigate')!;

    const mockContext = {
      send: vi.fn().mockResolvedValue({ success: true }),
      isConnected: () => true,
      listConnections: () => [],
    };

    const result = await navigateTool.handle(mockContext, {
      url: 'https://example.com',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('example.com');
  });

  it('screenshot returns image result', async () => {
    const tools = getAllTools();
    const screenshotTool = tools.find(t => t.schema.name === 'browser_screenshot')!;

    const mockContext = {
      send: vi.fn().mockResolvedValue({
        success: true,
        result: 'base64-image-data',
      }),
      isConnected: () => true,
      listConnections: () => [],
    };

    const result = await screenshotTool.handle(mockContext, {});

    expect(result.content[0].type).toBe('image');
    expect(result.content[0].data).toBe('base64-image-data');
    expect(result.content[0].mimeType).toBe('image/png');
  });

  it('failed operation returns error result', async () => {
    const tools = getAllTools();
    const clickTool = tools.find(t => t.schema.name === 'browser_click')!;

    const mockContext = {
      send: vi.fn().mockResolvedValue({
        success: false,
        error: { code: 'ELEMENT_NOT_FOUND', message: 'Element not found' },
      }),
      isConnected: () => true,
      listConnections: () => [],
    };

    const result = await clickTool.handle(mockContext, { ref: 'e1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Element not found');
  });
});
