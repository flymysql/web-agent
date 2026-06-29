import { DEFAULT_BACKEND_URL, DEFAULT_WS_URL } from '@ai-browser-agent/shared';
import type { PageContext, Task, WsMessage } from '@ai-browser-agent/shared';

const BACKEND_HTTP = DEFAULT_BACKEND_URL;
const BACKEND_WS = DEFAULT_WS_URL;

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;
const pendingToolCalls = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}>();

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent<T>(tabId: number, message: object): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

export async function getPageContext(tabId?: number): Promise<PageContext> {
  const tab = tabId ? { id: tabId } : await getActiveTab();
  if (!tab?.id) throw new Error('No active tab');
  const response = await sendToContent<{ pageContext: PageContext }>(tab.id, {
    type: 'GET_PAGE_CONTEXT',
  });
  return response.pageContext;
}

export async function executeToolOnTab(
  tabId: number,
  tool: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string; pageContext?: PageContext }> {
  return sendToContent(tabId, { type: 'EXECUTE_TOOL', tool, args });
}

function sendWs(msg: WsMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connectBackend(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }

  console.log('[AI Browser Agent] Connecting to backend:', BACKEND_WS);
  try {
    ws = new WebSocket(BACKEND_WS);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error('[AI Browser Agent] WebSocket construction failed:', lastError);
    broadcastStatus({ connected: false });
    reconnectTimer = setTimeout(connectBackend, 3000);
    return;
  }

  ws.onopen = async () => {
    console.log('[AI Browser Agent] WebSocket connected');
    lastError = null;
    const tab = await getActiveTab();
    sendWs({
      id: crypto.randomUUID(),
      type: 'session.register',
      payload: {
        extensionVersion: chrome.runtime.getManifest().version,
        activeTabId: tab?.id,
        activeUrl: tab?.url,
      },
      timestamp: Date.now(),
    });
    broadcastStatus({ connected: true });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data) as WsMessage;

    switch (msg.type) {
      case 'session.registered':
        sessionId = (msg.payload as { sessionId: string }).sessionId;
        broadcastStatus({ connected: true, sessionId });
        break;

      case 'tool.execute': {
        const payload = msg.payload as {
          taskId: string;
          callId: string;
          tool: string;
          args: Record<string, unknown>;
        };
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendWs({
            id: crypto.randomUUID(),
            type: 'tool.result',
            payload: {
              taskId: payload.taskId,
              callId: payload.callId,
              success: false,
              error: 'No active tab',
            },
            timestamp: Date.now(),
          });
          break;
        }
        const result = await executeToolOnTab(tab.id, payload.tool, payload.args);
        sendWs({
          id: crypto.randomUUID(),
          type: 'tool.result',
          payload: {
            taskId: payload.taskId,
            callId: payload.callId,
            success: result.success,
            result: result.result,
            error: result.error,
            pageContext: result.pageContext,
          },
          timestamp: Date.now(),
        });
        break;
      }

      case 'page.context': {
        const payload = msg.payload as { taskId?: string; tabId?: number };
        try {
          const pageContext = await getPageContext(payload.tabId);
          sendWs({
            id: crypto.randomUUID(),
            type: 'page.context.result',
            payload: { taskId: payload.taskId, pageContext },
            timestamp: Date.now(),
          });
        } catch (err) {
          sendWs({
            id: crypto.randomUUID(),
            type: 'error',
            payload: {
              code: 'PAGE_CONTEXT_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'task.update':
        chrome.runtime.sendMessage({ type: 'TASK_UPDATE', task: (msg.payload as { task: Task }).task });
        break;

      case 'pong':
        break;
    }
  };

  ws.onclose = (event) => {
    console.warn(
      `[AI Browser Agent] WebSocket closed (code=${event.code}, reason="${event.reason}")`
    );
    if (event.code !== 1000 && !lastError) {
      lastError = `WebSocket closed unexpectedly (code ${event.code})`;
    }
    sessionId = null;
    broadcastStatus({ connected: false });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectBackend, 3000);
  };

  ws.onerror = () => {
    lastError = `Failed to reach ${BACKEND_WS} — is the server running? (npm run dev:server)`;
    console.error('[AI Browser Agent] WebSocket error:', lastError);
    ws?.close();
  };
}

function broadcastStatus(status: { connected: boolean; sessionId?: string | null }): void {
  chrome.runtime.sendMessage({ type: 'BACKEND_STATUS', lastError, ...status }).catch(() => {});
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BACKEND_HTTP}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message ?? res.statusText);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case 'CONNECT_BACKEND':
        connectBackend();
        return { connected: ws?.readyState === WebSocket.OPEN, sessionId, lastError };

      case 'GET_BACKEND_STATUS':
        return { connected: ws?.readyState === WebSocket.OPEN, sessionId, lastError };

      case 'GET_PAGE_CONTEXT': {
        const tab = await getActiveTab();
        if (!tab?.id) throw new Error('No active tab');
        return { pageContext: await getPageContext(tab.id) };
      }

      case 'CREATE_TASK': {
        const tab = await getActiveTab();
        const pageContext = tab?.id ? await getPageContext(tab.id) : undefined;
        return apiRequest('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            userRequest: message.userRequest,
            tabId: tab?.id,
            url: tab?.url,
            pageContext,
            kind: message.kind ?? 'once',
            loopIntervalMs: message.loopIntervalMs,
            loopMaxIterations: message.loopMaxIterations,
          }),
        });
      }

      case 'START_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/start`, { method: 'POST' });

      case 'PAUSE_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/pause`, { method: 'POST' });

      case 'RESUME_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/resume`, { method: 'POST' });

      case 'CANCEL_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/cancel`, { method: 'POST' });

      case 'CONFIRM_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/confirm`, {
          method: 'POST',
          body: JSON.stringify({ confirmed: message.confirmed }),
        });

      case 'GET_TASK':
        return apiRequest(`/api/tasks/${message.taskId}`);

      case 'LIST_TASKS':
        return apiRequest('/api/tasks');

      case 'LIST_WORKFLOWS':
        return apiRequest('/api/workflows');

      case 'RUN_WORKFLOW': {
        const tab = await getActiveTab();
        return apiRequest(`/api/workflows/${message.workflowId}/run`, {
          method: 'POST',
          body: JSON.stringify({
            params: message.params ?? {},
            tabId: tab?.id,
            url: tab?.url,
          }),
        });
      }

      case 'DELETE_WORKFLOW':
        return apiRequest(`/api/workflows/${message.workflowId}`, { method: 'DELETE' });

      case 'SAVE_AS_WORKFLOW':
        return apiRequest(`/api/tasks/${message.taskId}/save-as-workflow`, {
          method: 'POST',
          body: JSON.stringify({
            name: message.name,
            description: message.description,
            triggers: message.triggers,
          }),
        });

      default:
        return { error: `Unknown message: ${message.type}` };
    }
  };

  handle().then(sendResponse).catch((err) => {
    sendResponse({ error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

connectBackend();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    sendWs({ id: crypto.randomUUID(), type: 'ping', payload: {}, timestamp: Date.now() });
  }
}, 30000);

console.log('[AI Browser Agent] Service worker started');
