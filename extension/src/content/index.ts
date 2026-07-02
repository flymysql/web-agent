import { extractPageContext } from './page-context.js';
import { executeBrowserTool, settleDom, MUTATING_TOOLS } from './browser-tools.js';
import { initFloatingUI } from './floating-ui.js';
import { startRecording, stopRecording } from './recorder.js';

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
          // Let async/lazy DOM updates from a mutating action land before we
          // snapshot, so the agent sees the settled page (new fields, revealed
          // panels, enabled buttons) rather than the pre-mutation state.
          if (result.success && MUTATING_TOOLS.has(message.tool)) {
            await settleDom();
          }
          const pageContext = extractPageContext();
          return { ...result, pageContext };
        }

        // Background broadcasts start/stop so recording follows the user across
        // navigations (each page load re-injects this content script).
        case 'RECORD_CONTROL': {
          if (window.top !== window.self) return { ok: true };
          if (message.args?.action === 'start') startRecording();
          else stopRecording();
          return { ok: true };
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

    // If a recording session is active, re-attach the capture listeners on this
    // freshly loaded page. The navigation itself is recorded by the background on
    // PAGE_LOADED, so we don't emit it here (avoids losing/duplicating it).
    chrome.runtime
      .sendMessage({ type: 'GET_RECORD_STATE' })
      .then((state: { recording?: boolean } | undefined) => {
        if (state?.recording) startRecording();
      })
      .catch(() => {});
  }

  console.log('[AI Browser Agent] Content script loaded');
}
