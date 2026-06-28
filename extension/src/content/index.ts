import { extractPageContext } from './page-context.js';
import { executeBrowserTool } from './browser-tools.js';
import { initFloatingUI } from './floating-ui.js';

type ContentMessage = {
  type: string;
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
};

chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case 'GET_PAGE_CONTEXT':
        return { success: true, pageContext: extractPageContext() };

      case 'EXECUTE_TOOL': {
        if (!message.tool) {
          return { success: false, error: 'tool name required' };
        }
        const result = await executeBrowserTool(message.tool, message.args ?? {});
        const pageContext = extractPageContext();
        return { ...result, pageContext };
      }

      default:
        return { success: false, error: `Unknown message type: ${message.type}` };
    }
  };

  handle().then(sendResponse);
  return true;
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFloatingUI);
} else {
  initFloatingUI();
}

console.log('[AI Browser Agent] Content script loaded');
