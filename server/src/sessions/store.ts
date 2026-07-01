import { v4 as uuidv4 } from 'uuid';
import type { ChatSession, ChatMessage, Task } from '@ai-browser-agent/shared';
import { JsonRepository } from '../persistence/json-repository.js';
import { getTask, listTasks } from '../tasks/store.js';

const sessions = new JsonRepository<ChatSession>('sessions');

const DEFAULT_TITLE = '新会话';

function titleFromRequest(request: string): string {
  const clean = request.replace(/\s+/g, ' ').trim();
  return clean.length > 30 ? `${clean.slice(0, 30)}…` : clean || DEFAULT_TITLE;
}

export function createSession(title?: string): ChatSession {
  const now = Date.now();
  const session: ChatSession = {
    id: uuidv4(),
    title: title?.trim() || DEFAULT_TITLE,
    taskIds: [],
    createdAt: now,
    updatedAt: now,
  };
  sessions.upsert(session);
  return session;
}

export function getSession(id: string): ChatSession | undefined {
  return sessions.get(id);
}

export function listSessions(): ChatSession[] {
  return sessions.list().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function renameSession(id: string, title: string): ChatSession {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session not found: ${id}`);
  return sessions.upsert({ ...session, title: title.trim() || session.title, updatedAt: Date.now() });
}

export function deleteSession(id: string): string[] {
  const session = sessions.get(id);
  const taskIds = session?.taskIds ?? [];
  sessions.delete(id);
  return taskIds;
}

export function touchSession(id: string): void {
  const session = sessions.get(id);
  if (session) sessions.upsert({ ...session, updatedAt: Date.now() });
}

/** Attach a task to a session, deriving the session title from the first request. */
export function addTaskToSession(
  sessionId: string | undefined,
  taskId: string,
  request?: string
): ChatSession | undefined {
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const taskIds = session.taskIds.includes(taskId) ? session.taskIds : [...session.taskIds, taskId];
  const title =
    (session.title === DEFAULT_TITLE || !session.title) && request
      ? titleFromRequest(request)
      : session.title;
  return sessions.upsert({ ...session, taskIds, title, updatedAt: Date.now() });
}

/** Append a user turn to the conversation thread (no-op without a session). */
export function appendUserMessage(
  sessionId: string | undefined,
  taskId: string,
  content: string
): void {
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  const messages = [...(session.messages ?? [])];
  messages.push({ id: uuidv4(), role: 'user', kind: 'text', content, taskId, createdAt: Date.now() });
  sessions.upsert({ ...session, messages, updatedAt: Date.now() });
}

/**
 * Record (or update) the assistant turn for a task once it reaches a
 * user-facing state: a chat answer, a clarifying question, a final result, or a
 * failure. Idempotent per task so repeated calls during a run don't duplicate.
 */
export function recordAssistantTurn(task: Task): void {
  if (!task.sessionId) return;
  const session = sessions.get(task.sessionId);
  if (!session) return;

  let content: string | undefined;
  if (task.status === 'needs_input') content = task.clarifyQuestion ?? task.assistantMessage;
  else if (task.status === 'completed') content = task.assistantMessage ?? task.result;
  else if (task.status === 'failed') content = `任务失败：${task.error ?? '未知错误'}`;
  else return;
  if (!content) return;

  const messages = [...(session.messages ?? [])];
  const idx = messages.findIndex((m) => m.taskId === task.id && m.role === 'assistant');
  const message: ChatMessage = {
    id: idx >= 0 ? messages[idx].id : uuidv4(),
    role: 'assistant',
    kind: task.mode === 'chat' ? 'text' : 'run',
    content,
    taskId: task.id,
    createdAt: idx >= 0 ? messages[idx].createdAt : Date.now(),
  };
  if (idx >= 0) messages[idx] = message;
  else messages.push(message);
  sessions.upsert({ ...session, messages, updatedAt: Date.now() });
}

export function getSessionTasks(id: string): Task[] {
  const session = sessions.get(id);
  if (!session) return [];
  const byId = new Map<string, Task>();
  for (const taskId of session.taskIds) {
    const t = getTask(taskId);
    if (t) byId.set(t.id, t);
  }
  // Self-heal: also include any task that stamped this session on itself but was
  // never linked into `taskIds` (e.g. a task created before linking, or a lost
  // update). This keeps history a faithful replay even if the link is missing.
  for (const t of listTasks()) {
    if (t.sessionId === id) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Context engineering: produce a compact, token-bounded summary of the prior
 * tasks in this session so the planner/agent has memory of what already
 * happened (requests + outcomes). Excludes the task currently being processed.
 */
export function buildConversationContext(
  sessionId: string | undefined,
  excludeTaskId?: string,
  maxTasks = 3
): string {
  if (!sessionId) return '';
  const session = sessions.get(sessionId);
  if (!session) return '';

  // Preferred: the real message thread (multi-turn memory for follow-ups).
  const msgs = (session.messages ?? []).filter((m) => m.taskId !== excludeTaskId);
  if (msgs.length > 0) {
    const recent = msgs.slice(-maxTasks * 2);
    return recent
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content).slice(0, 200)}`)
      .join('\n');
  }

  const prior = session.taskIds
    .filter((id) => id !== excludeTaskId)
    .map((id) => getTask(id))
    .filter((t): t is Task => Boolean(t));

  const recent = prior.slice(-maxTasks);
  if (recent.length === 0) return '';

  const lines = recent.map((t, i) => {
    let outcome: string;
    if (t.status === 'completed') outcome = t.result ?? '(已完成)';
    else if (t.status === 'failed') outcome = `失败: ${t.error ?? '未知'}`;
    else outcome = t.status;
    return `${i + 1}. 用户请求: ${t.userRequest}\n   结果(${t.status}): ${String(outcome).slice(0, 160)}`;
  });

  return lines.join('\n');
}
