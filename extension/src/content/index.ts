import { extractPageContext } from './page-context.js';
import { executeBrowserTool } from './browser-tools.js';
import { initFloatingUI } from './floating-ui.js';

type ContentMessage = {
  type: string;
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
};

declare global {
  interface Window {
    __AI_AGENT_CONTENT__?: boolean;
  }
}

// Guard against double-execution: the content script may run from the manifest
// (document_idle) AND be re-injected programmatically by the background after a
// navigation. Registering listeners twice would cause duplicate responses.
if (!window.__AI_AGENT_CONTENT__) {
  window.__AI_AGENT_CONTENT__ = true;

  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
    const handle = async () => {
      switch (message.type) {
        case 'PING':
          // Readiness probe used by the background to know the script is alive.
          return { ready: true };

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

  const boot = () => initFloatingUI();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Let the background know a top-level page loaded (drives auto-run workflows).
  if (window.top === window.self) {
    chrome.runtime.sendMessage({ type: 'PAGE_LOADED', url: location.href }).catch(() => {});
  }

  console.log('[AI Browser Agent] Content script loaded');
}
