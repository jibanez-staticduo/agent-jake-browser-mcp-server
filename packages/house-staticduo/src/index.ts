import { createServer } from '@agent-jake-browser/core';

// Identity and composition only; integrations belong here when they exist.
export const house = Object.freeze({ id: 'staticduo' as const, createServer });
