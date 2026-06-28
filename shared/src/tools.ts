import type { RiskLevel } from './types.js';

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  riskLevel: RiskLevel;
  requiresConfirmation?: boolean;
  /** Runs in content script (page) or backend */
  runtime: 'browser' | 'backend';
}

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: 'extractPage',
    description: 'Extract page summary including visible text, links, and interactive elements',
    parameters: [],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'click',
    description: 'Click an element by CSS selector or element id from page context',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector or element id', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'type',
    description: 'Type text into an input, textarea, or contenteditable element',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector or element id', required: true },
      { name: 'text', type: 'string', description: 'Text to type', required: true },
      { name: 'clear', type: 'boolean', description: 'Clear existing value first', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a specific element',
    parameters: [
      { name: 'direction', type: 'string', description: 'up | down | top | bottom', required: false },
      { name: 'selector', type: 'string', description: 'Element to scroll (optional)', required: false },
      { name: 'amount', type: 'number', description: 'Pixels to scroll', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'wait',
    description: 'Wait for a condition: element visible, timeout, or navigation',
    parameters: [
      { name: 'selector', type: 'string', description: 'Wait for element to appear', required: false },
      { name: 'timeoutMs', type: 'number', description: 'Max wait time in ms', required: false },
      { name: 'text', type: 'string', description: 'Wait for text to appear on page', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'readText',
    description: 'Read text content from an element or the whole page',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector (omit for page text)', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'getAttribute',
    description: 'Get an attribute value from an element',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector', required: true },
      { name: 'attribute', type: 'string', description: 'Attribute name', required: true },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'selectOption',
    description: 'Select an option in a dropdown',
    parameters: [
      { name: 'selector', type: 'string', description: 'Select element selector', required: true },
      { name: 'value', type: 'string', description: 'Option value or visible text', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
];

export const BACKEND_TOOLS: ToolDefinition[] = [
  {
    name: 'fetch',
    description: 'Make an HTTP request via the backend (cross-origin safe)',
    parameters: [
      { name: 'url', type: 'string', description: 'Request URL', required: true },
      { name: 'method', type: 'string', description: 'HTTP method', required: false },
      { name: 'headers', type: 'object', description: 'Request headers', required: false },
      { name: 'body', type: 'string', description: 'Request body', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'backend',
  },
  {
    name: 'notify',
    description: 'Send a notification to the user',
    parameters: [
      { name: 'title', type: 'string', description: 'Notification title', required: true },
      { name: 'message', type: 'string', description: 'Notification body', required: true },
    ],
    riskLevel: 'low',
    runtime: 'backend',
  },
];

export const ALL_TOOLS: ToolDefinition[] = [...BROWSER_TOOLS, ...BACKEND_TOOLS];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOLS.some((t) => t.name === name);
}

export function isBackendTool(name: string): boolean {
  return BACKEND_TOOLS.some((t) => t.name === name);
}

/** Keywords that trigger high-risk confirmation */
export const DANGEROUS_KEYWORDS = [
  'pay', 'payment', 'purchase', 'buy', 'checkout',
  'delete', 'remove', 'destroy',
  'submit', 'send', 'publish', 'post',
  'confirm order', 'place order',
  'transfer', 'withdraw',
  'password', 'credit card',
];

export function assessRiskFromText(text: string): RiskLevel {
  const lower = text.toLowerCase();
  if (DANGEROUS_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'high';
  }
  if (lower.includes('click') && (lower.includes('button') || lower.includes('submit'))) {
    return 'medium';
  }
  return 'low';
}

export function toolsToJsonSchema(): object {
  return ALL_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map((p) => [
            p.name,
            { type: p.type, description: p.description },
          ])
        ),
        required: tool.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }));
}
