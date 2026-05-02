/**
 * Shared type definitions for the MCP server.
 */

/**
 * Tool names supported by the extension.
 * These must match the handler names in the extension.
 */
export type ToolName =
  // Navigation
  | 'browser_navigate'
  | 'browser_go_back'
  | 'browser_go_forward'
  | 'browser_reload'
  // Snapshot
  | 'browser_snapshot'
  // Interaction
  | 'browser_click'
  | 'browser_type'
  | 'browser_hover'
  | 'browser_drag'
  | 'browser_select_option'
  | 'browser_press_key'
  // Utility
  | 'browser_wait'
  | 'browser_screenshot'
  | 'browser_get_console_logs'
  // Tab management
  | 'browser_new_tab'
  | 'browser_list_tabs'
  | 'browser_switch_tab'
  | 'browser_close_tab'
  // Element queries
  | 'browser_get_text'
  | 'browser_get_attribute'
  | 'browser_is_visible'
  | 'browser_wait_for_element'
  | 'browser_highlight'
  | 'browser_evaluate'
  | 'browser_get_html'
  | 'browser_iframe_eval'
  | 'browser_iframe_click'
  | 'browser_upload_file'
  | 'browser_resize_viewport';

/**
 * Message sent to the extension via WebSocket.
 */
export interface ExtensionMessage {
  id: string;
  type: ToolName;
  payload: Record<string, unknown>;
}

/**
 * Response from the extension.
 */
export interface ExtensionResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * MCP tool result content item.
 */
export interface ContentItem {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * MCP tool result.
 */
export interface ToolResult {
  content: ContentItem[];
  isError?: boolean;
}

/**
 * Tool schema for MCP registration.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Context interface for tools.
 */
export interface Context {
  send(type: ToolName, payload?: Record<string, unknown>): Promise<ExtensionResponse>;
  isConnected(): boolean;
}

/**
 * Tool definition interface.
 */
export interface Tool {
  schema: ToolSchema;
  handle(context: Context, params?: Record<string, unknown>): Promise<ToolResult>;
}
