/**
 * Simple logging utility for the MCP server.
 * Logs to stderr to keep stdout clean for MCP protocol.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

/**
 * Set the minimum log level.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Format a log message with timestamp and level.
 */
function format(level: LogLevel, message: string, ...args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : message;
  return `[${timestamp}] [${level.toUpperCase()}] ${formatted}`;
}

/**
 * Log a message if it meets the current log level threshold.
 */
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]) {
    console.error(format(level, message, ...args));
  }
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => log('debug', message, ...args),
  info: (message: string, ...args: unknown[]) => log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  setLevel: setLogLevel,
};
