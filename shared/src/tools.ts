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
    description: 'Wait until a condition holds: an element appears/becomes visible/clickable, page contains text, or the URL changes. Always wait after an action that triggers async loading.',
    parameters: [
      { name: 'selector', type: 'string', description: 'Wait for this element', required: false },
      { name: 'state', type: 'string', description: 'visible | attached | clickable (default visible)', required: false },
      { name: 'text', type: 'string', description: 'Wait for text to appear on page', required: false },
      { name: 'urlIncludes', type: 'string', description: 'Wait until URL contains this', required: false },
      { name: 'timeoutMs', type: 'number', description: 'Max wait time in ms (default 10000)', required: false },
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
  {
    name: 'injectCSS',
    description: 'Inject CSS into the page to restyle it (apply a dark theme, change colors/backgrounds/fonts/layout). Reliable and CSP-safe — prefer this for any theming or appearance change.',
    parameters: [
      { name: 'css', type: 'string', description: 'Raw CSS text to inject', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'setStyle',
    description: 'Set inline CSS style properties (with !important) on element(s) matched by a selector',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector', required: true },
      { name: 'styles', type: 'object', description: 'Map of CSS property to value, e.g. {"background":"#111","color":"#eee"}', required: true },
      { name: 'all', type: 'boolean', description: 'Apply to every match (default false = first only)', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'setText',
    description: 'Replace the text content of an element',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector', required: true },
      { name: 'text', type: 'string', description: 'New text content', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'setHTML',
    description: 'Replace the innerHTML of an element',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector', required: true },
      { name: 'html', type: 'string', description: 'New innerHTML', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'setAttribute',
    description: 'Set or update an attribute on element(s)',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector', required: true },
      { name: 'name', type: 'string', description: 'Attribute name', required: true },
      { name: 'value', type: 'string', description: 'Attribute value', required: true },
      { name: 'all', type: 'boolean', description: 'Apply to every match', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'removeElement',
    description: 'Remove element(s) from the page by selector',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector', required: true },
      { name: 'all', type: 'boolean', description: 'Remove every match (default false = first only)', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'getHTML',
    description: 'Get the outerHTML of an element (or the body) to inspect page structure',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector (omit for document body)', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'evaluate',
    description: 'Run arbitrary JavaScript in the page (like the devtools console) and return the result. The escape hatch when no specific tool fits.',
    parameters: [
      { name: 'code', type: 'string', description: 'JavaScript source; use return to send back a JSON-serializable value', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'webSearch',
    description: 'Search the web and get a list of result titles + URLs. Runs through the browser so it has internet access. Use this to find information or pages online.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'count', type: 'number', description: 'Max results (default 5)', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'imageSearch',
    description: 'Search the web for images and get a list of DIRECT image URLs (usable in <img> or CSS background-image). Use this to find a real picture, e.g. a dog photo, before setting it on the page.',
    parameters: [
      { name: 'query', type: 'string', description: 'Image search query', required: true },
      { name: 'count', type: 'number', description: 'Max image URLs (default 5)', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'httpRequest',
    description: 'Make an arbitrary HTTP request from the browser (bypasses CORS, has internet access). Use for calling public APIs. Returns status and response body (parsed JSON when possible).',
    parameters: [
      { name: 'url', type: 'string', description: 'Request URL', required: true },
      { name: 'method', type: 'string', description: 'HTTP method (default GET)', required: false },
      { name: 'headers', type: 'object', description: 'Request headers', required: false },
      { name: 'body', type: 'string', description: 'Request body', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'navigate',
    description: 'Navigate the tab: go to a URL, or go back/forward/reload. Waits for the page to finish loading and returns the fresh page context. Use this to open a different page instead of guessing selectors.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to open (for action=goto). Include https://', required: false },
      { name: 'action', type: 'string', description: 'goto | back | forward | reload (default goto when url given, else reload)', required: false },
      { name: 'timeoutMs', type: 'number', description: 'Max wait for load (default 15000)', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'expect',
    description: 'Assert/verify a condition on the current page (does NOT change anything). Returns success only if the condition holds. Use it to verify an action achieved its goal.',
    parameters: [
      { name: 'selector', type: 'string', description: 'Element must exist/visible', required: false },
      { name: 'text', type: 'string', description: 'Page must contain this text', required: false },
      { name: 'urlIncludes', type: 'string', description: 'Current URL must contain this', required: false },
      { name: 'attribute', type: 'string', description: 'With selector: attribute name to check', required: false },
      { name: 'equals', type: 'string', description: 'With selector+attribute: expected value', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'pressKey',
    description: 'Dispatch a keyboard key or combo to an element or the page (e.g. Enter, Escape, Tab, "Control+a", "Meta+Enter").',
    parameters: [
      { name: 'key', type: 'string', description: 'Key or combo, e.g. Enter, Escape, Control+a', required: true },
      { name: 'selector', type: 'string', description: 'Target element (optional, defaults to active/body)', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'hover',
    description: 'Hover the mouse over an element (dispatches mouseenter/mouseover/mousemove). Useful to reveal menus/tooltips.',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector or element id', required: true },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'setChecked',
    description: 'Check or uncheck a checkbox/radio input.',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector or element id', required: true },
      { name: 'checked', type: 'boolean', description: 'true to check, false to uncheck (default true)', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'uploadFile',
    description: 'Set files on an <input type=file> using small text/data files (since we cannot read the local disk). Provide file name + text content.',
    parameters: [
      { name: 'selector', type: 'string', description: 'File input selector', required: true },
      { name: 'name', type: 'string', description: 'File name, e.g. note.txt', required: true },
      { name: 'content', type: 'string', description: 'Text content of the file', required: true },
      { name: 'mime', type: 'string', description: 'MIME type (default text/plain)', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'storage',
    description: 'Read or write the page localStorage/sessionStorage. action=get|set|remove|getAll.',
    parameters: [
      { name: 'action', type: 'string', description: 'get | set | remove | getAll', required: true },
      { name: 'area', type: 'string', description: 'local | session (default local)', required: false },
      { name: 'key', type: 'string', description: 'Storage key', required: false },
      { name: 'value', type: 'string', description: 'Value to set', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the visible tab. Returns a data URL (PNG). Use to inspect visual state when the DOM is unclear.',
    parameters: [],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'drag',
    description: 'Drag one element onto another (HTML5 drag-and-drop events).',
    parameters: [
      { name: 'sourceSelector', type: 'string', description: 'Element to drag', required: true },
      { name: 'targetSelector', type: 'string', description: 'Drop target element', required: true },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'cookie',
    description: 'Read/write cookies for the current site. action=list|get|set|remove.',
    parameters: [
      { name: 'action', type: 'string', description: 'list | get | set | remove', required: true },
      { name: 'name', type: 'string', description: 'Cookie name', required: false },
      { name: 'value', type: 'string', description: 'Cookie value (for set)', required: false },
      { name: 'url', type: 'string', description: 'Override URL (default current tab)', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'tab',
    description: 'Manage browser tabs. action=open|close|list|activate. Use open to start work in a new tab.',
    parameters: [
      { name: 'action', type: 'string', description: 'open | close | list | activate', required: true },
      { name: 'url', type: 'string', description: 'URL for open', required: false },
      { name: 'tabId', type: 'number', description: 'Target tab id for close/activate', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'download',
    description: 'Download a file from a URL to the user\'s downloads folder.',
    parameters: [
      { name: 'url', type: 'string', description: 'File URL', required: true },
      { name: 'filename', type: 'string', description: 'Suggested file name', required: false },
    ],
    riskLevel: 'medium',
    runtime: 'browser',
  },
  {
    name: 'autoDialog',
    description: 'Auto-handle native JS dialogs (alert/confirm/prompt) and suppress beforeunload prompts so automation is not blocked.',
    parameters: [
      { name: 'accept', type: 'boolean', description: 'Accept confirms (default true)', required: false },
      { name: 'promptText', type: 'string', description: 'Text returned for prompt()', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'consoleLogs',
    description: 'Capture page console output for front-end debugging. action=install (start capturing, call early), get (recent logs), clear.',
    parameters: [
      { name: 'action', type: 'string', description: 'install | get | clear', required: true },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'network',
    description: 'Inspect network requests made by the current tab (URL, method, status, type). action=get|clear. Useful for debugging API calls.',
    parameters: [
      { name: 'action', type: 'string', description: 'get | clear (default get)', required: false },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
  {
    name: 'inspect',
    description: 'Inspect a DOM element: tag, attributes, key computed styles, bounding box, and a snippet of HTML. Use for front-end debugging.',
    parameters: [
      { name: 'selector', type: 'string', description: 'CSS selector or element id', required: true },
    ],
    riskLevel: 'low',
    runtime: 'browser',
  },
];

export const BACKEND_TOOLS: ToolDefinition[] = [
  {
    name: 'delegate',
    description:
      'Spawn a sub-agent to autonomously complete ONE focused sub-goal on the current tab (e.g. "open this article link and summarize it"), then return a concise result. Use for repetitive multi-item work so the main agent stays high-level.',
    parameters: [
      { name: 'goal', type: 'string', description: 'The focused sub-goal for the sub-agent', required: true },
      { name: 'maxSteps', type: 'number', description: 'Max steps for the sub-agent (default 12)', required: false },
    ],
    riskLevel: 'low',
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
