import type {
  PageContext,
  Task,
  TaskPlan,
  ToolCallRecord,
} from './types.js';

/** Extension ↔ Background ↔ Server message types */

export type MessageSource = 'popup' | 'background' | 'content' | 'server';

export interface BaseMessage {
  id: string;
  type: string;
  timestamp: number;
  source: MessageSource;
}

/** Popup / extension internal messages */
export interface ExtensionMessage extends BaseMessage {
  tabId?: number;
}

export type ExtensionMessageType =
  | 'GET_PAGE_CONTEXT'
  | 'PAGE_CONTEXT_RESULT'
  | 'EXECUTE_TOOL'
  | 'TOOL_RESULT'
  | 'TASK_UPDATE'
  | 'CONNECT_BACKEND'
  | 'BACKEND_STATUS'
  | 'CONFIRM_ACTION'
  | 'REJECT_ACTION';

/** WebSocket protocol between extension and server */
export type WsMessageType =
  | 'session.register'
  | 'session.registered'
  | 'task.create'
  | 'task.created'
  | 'task.start'
  | 'task.pause'
  | 'task.resume'
  | 'task.cancel'
  | 'task.update'
  | 'task.confirm'
  | 'task.reject'
  | 'task.steer'
  | 'agent.event'
  | 'tool.execute'
  | 'tool.result'
  | 'page.context'
  | 'page.context.result'
  | 'ping'
  | 'pong'
  | 'error';

export interface WsMessage<T = unknown> {
  id: string;
  type: WsMessageType;
  payload: T;
  timestamp: number;
}

export interface SessionRegisterPayload {
  extensionVersion: string;
  activeTabId?: number;
  activeUrl?: string;
}

export interface SessionRegisteredPayload {
  sessionId: string;
}

export interface TaskCreatePayload {
  userRequest: string;
  tabId?: number;
  url?: string;
  pageContext?: PageContext;
  kind?: 'once' | 'loop';
  loopIntervalMs?: number;
  loopMaxIterations?: number;
}

export interface TaskCreatedPayload {
  task: Task;
}

export interface TaskUpdatePayload {
  task: Task;
}

export interface AgentEventPayload {
  taskId: string;
  tabId?: number;
  kind: 'delta' | 'done';
  text?: string;
}

export interface TaskSteerPayload {
  taskId: string;
  text: string;
}

export interface ToolExecutePayload {
  taskId: string;
  stepId?: string;
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  /** Tab the task is bound to; extension should target this tab (falls back to active tab) */
  tabId?: number;
}

export interface ToolResultPayload {
  taskId: string;
  callId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  pageContext?: PageContext;
}

export interface PageContextRequestPayload {
  taskId?: string;
  tabId?: number;
}

export interface PageContextResultPayload {
  taskId?: string;
  pageContext: PageContext;
}

export interface TaskConfirmPayload {
  taskId: string;
  confirmed: boolean;
}

export interface TaskStartPayload {
  taskId: string;
}

export interface TaskIdPayload {
  taskId: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface PlanGeneratedPayload {
  taskId: string;
  plan: TaskPlan;
}

export function createWsMessage<T>(
  type: WsMessageType,
  payload: T,
  id?: string
): WsMessage<T> {
  return {
    id: id ?? crypto.randomUUID(),
    type,
    payload,
    timestamp: Date.now(),
  };
}

export function createExtensionMessage(
  type: ExtensionMessageType,
  source: MessageSource,
  data?: Partial<ExtensionMessage>
): ExtensionMessage {
  return {
    id: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    source,
    ...data,
  };
}

/** HTTP REST endpoints (short tasks / fallback) */
export const API_ROUTES = {
  health: '/health',
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${id}`,
  taskStart: (id: string) => `/api/tasks/${id}/start`,
  taskPause: (id: string) => `/api/tasks/${id}/pause`,
  taskResume: (id: string) => `/api/tasks/${id}/resume`,
  taskCancel: (id: string) => `/api/tasks/${id}/cancel`,
  taskConfirm: (id: string) => `/api/tasks/${id}/confirm`,
  audit: '/api/audit',
} as const;

export const DEFAULT_BACKEND_URL = 'http://localhost:3847';
export const DEFAULT_WS_URL = 'ws://localhost:3847/ws';

export type { Task, TaskPlan, ToolCallRecord, PageContext };
