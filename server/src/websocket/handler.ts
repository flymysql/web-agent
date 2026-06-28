import type { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type {
  WsMessage,
  ToolExecutePayload,
  ToolResultPayload,
  PageContext,
} from '@ai-browser-agent/shared';
import type { ExtensionSession } from '@ai-browser-agent/shared';
import {
  createTask,
  getTask,
  updateTask,
  addLog,
} from '../tasks/store.js';
import {
  planTask,
  runTask,
  pauseTask,
  cancelTask,
  resumeTask,
  confirmPendingAction,
  setBrowserToolExecutor,
} from '../agent/orchestrator.js';
import {
  scheduleLoopTask,
  unscheduleLoopTask,
  setExtensionConnected,
  resumePendingTasks,
} from '../scheduler/scheduler.js';

const sessions = new Map<string, { ws: WebSocket; session: ExtensionSession }>();
const wsToSession = new Map<WebSocket, string>();

const pendingToolCalls = new Map<
  string,
  {
    resolve: (result: ToolResultPayload) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

function send(ws: WebSocket, msg: WsMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastTaskUpdate(taskId: string): void {
  const task = getTask(taskId);
  if (!task) return;

  for (const { ws } of sessions.values()) {
    send(ws, {
      id: uuidv4(),
      type: 'task.update',
      payload: { task },
      timestamp: Date.now(),
    });
  }
}

function executeBrowserToolViaWs(
  taskId: string,
  tool: string,
  args: Record<string, unknown>,
  callId: string
): Promise<{ success: boolean; result?: unknown; error?: string; pageContext?: PageContext }> {
  return new Promise((resolve, reject) => {
    const session = sessions.values().next().value;
    if (!session) {
      reject(new Error('No extension connected'));
      return;
    }

    const timeout = setTimeout(() => {
      pendingToolCalls.delete(callId);
      reject(new Error('Tool execution timeout'));
    }, 60000);

    pendingToolCalls.set(callId, {
      resolve: (result) => {
        resolve({
          success: result.success,
          result: result.result,
          error: result.error,
          pageContext: result.pageContext,
        });
      },
      reject,
      timeout,
    });

    send(session.ws, {
      id: uuidv4(),
      type: 'tool.execute',
      payload: { taskId, tool, args, callId } satisfies ToolExecutePayload,
      timestamp: Date.now(),
    });
  });
}

setBrowserToolExecutor(executeBrowserToolViaWs);

export function handleWebSocketConnection(ws: WebSocket): void {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMessage;

      switch (msg.type) {
        case 'session.register': {
          const sessionId = uuidv4();
          const payload = msg.payload as {
            extensionVersion: string;
            activeTabId?: number;
            activeUrl?: string;
          };
          const session: ExtensionSession = {
            sessionId,
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            activeTabId: payload.activeTabId,
            activeUrl: payload.activeUrl,
          };
          sessions.set(sessionId, { ws, session });
          wsToSession.set(ws, sessionId);
          setExtensionConnected(true);

          send(ws, {
            id: uuidv4(),
            type: 'session.registered',
            payload: { sessionId },
            timestamp: Date.now(),
          });

          resumePendingTasks().catch(console.error);
          break;
        }

        case 'tool.result': {
          const payload = msg.payload as ToolResultPayload;
          const pending = pendingToolCalls.get(payload.callId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingToolCalls.delete(payload.callId);
            pending.resolve(payload);
          }
          break;
        }

        case 'page.context.result': {
          break;
        }

        case 'ping':
          send(ws, {
            id: uuidv4(),
            type: 'pong',
            payload: {},
            timestamp: Date.now(),
          });
          break;

        case 'task.create': {
          const payload = msg.payload as {
            userRequest: string;
            tabId?: number;
            url?: string;
            pageContext?: PageContext;
            kind?: 'once' | 'loop';
            loopIntervalMs?: number;
          };
          const task = createTask(payload);
          if (payload.pageContext) {
            updateTask(task.id, { checkpoint: { stepIndex: 0, pageContext: payload.pageContext, savedAt: Date.now() } });
          }
          const planned = await planTask(task.id, payload.pageContext);
          send(ws, {
            id: uuidv4(),
            type: 'task.created',
            payload: { task: planned },
            timestamp: Date.now(),
          });
          break;
        }

        case 'task.start': {
          const { taskId } = msg.payload as { taskId: string };
          const task = await runTask(taskId);
          if (task.kind === 'loop' && task.loopIntervalMs) {
            scheduleLoopTask(taskId, task.loopIntervalMs);
          }
          broadcastTaskUpdate(taskId);
          break;
        }

        case 'task.pause': {
          const { taskId } = msg.payload as { taskId: string };
          await pauseTask(taskId);
          broadcastTaskUpdate(taskId);
          break;
        }

        case 'task.resume': {
          const { taskId } = msg.payload as { taskId: string };
          await resumeTask(taskId);
          broadcastTaskUpdate(taskId);
          break;
        }

        case 'task.cancel': {
          const { taskId } = msg.payload as { taskId: string };
          await cancelTask(taskId);
          unscheduleLoopTask(taskId);
          broadcastTaskUpdate(taskId);
          break;
        }

        case 'task.confirm': {
          const { taskId, confirmed } = msg.payload as { taskId: string; confirmed: boolean };
          await confirmPendingAction(taskId, confirmed);
          broadcastTaskUpdate(taskId);
          break;
        }
      }
    } catch (err) {
      send(ws, {
        id: uuidv4(),
        type: 'error',
        payload: {
          code: 'HANDLER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
    }
  });

  ws.on('close', () => {
    const sessionId = wsToSession.get(ws);
    if (sessionId) {
      sessions.delete(sessionId);
      wsToSession.delete(ws);
    }
    if (sessions.size === 0) {
      setExtensionConnected(false);
    }
  });
}

export function isExtensionConnected(): boolean {
  return sessions.size > 0;
}

export { broadcastTaskUpdate };
