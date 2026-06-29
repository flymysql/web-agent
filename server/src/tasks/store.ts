import { v4 as uuidv4 } from 'uuid';
import type {
  Task,
  TaskLogEntry,
  TaskCheckpoint,
  PageContext,
} from '@ai-browser-agent/shared';
import { JsonRepository } from '../persistence/json-repository.js';
import { debugLog } from '../debug/logger.js';

const tasks = new JsonRepository<Task>('tasks', undefined, { maxItems: 500 });
const MAX_LOGS_PER_TASK = 500;

function createLog(level: TaskLogEntry['level'], message: string, data?: Record<string, unknown>): TaskLogEntry {
  return {
    id: uuidv4(),
    timestamp: Date.now(),
    level,
    message,
    data,
  };
}

export function createTask(input: {
  userRequest: string;
  sessionId?: string;
  tabId?: number;
  url?: string;
  kind?: 'once' | 'loop';
  mode?: 'agent' | 'replay';
  maxSteps?: number;
  loopIntervalMs?: number;
  loopMaxIterations?: number;
  workflowId?: string;
}): Task {
  const now = Date.now();
  const task: Task = {
    id: uuidv4(),
    sessionId: input.sessionId,
    userRequest: input.userRequest,
    status: 'pending',
    kind: input.kind ?? 'once',
    mode: input.mode ?? 'agent',
    maxSteps: input.maxSteps,
    workflowId: input.workflowId,
    tabId: input.tabId,
    url: input.url,
    currentStepIndex: 0,
    toolCalls: [],
    logs: [createLog('info', 'Task created', { userRequest: input.userRequest })],
    loopIntervalMs: input.loopIntervalMs,
    loopMaxIterations: input.loopMaxIterations ?? 100,
    loopIteration: 0,
    createdAt: now,
    updatedAt: now,
  };
  tasks.upsert(task);
  return task;
}

export function deleteTask(id: string): void {
  tasks.delete(id);
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function listTasks(): Task[] {
  return tasks.list().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function updateTask(id: string, updates: Partial<Task>): Task {
  const task = tasks.get(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  const updated = { ...task, ...updates, updatedAt: Date.now() };
  tasks.upsert(updated);
  return updated;
}

export function addLog(
  taskId: string,
  level: TaskLogEntry['level'],
  message: string,
  data?: Record<string, unknown>
): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const logs = [...task.logs, createLog(level, message, data)];
  const trimmed = logs.length > MAX_LOGS_PER_TASK ? logs.slice(-MAX_LOGS_PER_TASK) : logs;
  debugLog({ source: 'task', level, category: 'flow', message, taskId, data });
  return updateTask(taskId, { logs: trimmed });
}

export function saveCheckpoint(taskId: string, checkpoint: Omit<TaskCheckpoint, 'savedAt'>): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return updateTask(taskId, {
    checkpoint: { ...checkpoint, savedAt: Date.now() },
  });
}

export function setPageContext(taskId: string, pageContext: PageContext): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const checkpoint = task.checkpoint ?? { stepIndex: task.currentStepIndex, savedAt: Date.now() };
  return updateTask(taskId, {
    checkpoint: { ...checkpoint, pageContext, savedAt: Date.now() },
    url: pageContext.url,
  });
}

export function getActiveLoopTasks(): Task[] {
  return listTasks().filter(
    (t) => t.kind === 'loop' && ['running', 'paused'].includes(t.status)
  );
}

export function getResumableTasks(): Task[] {
  return listTasks().filter(
    (t) => ['running', 'paused', 'waiting_confirmation'].includes(t.status)
  );
}
