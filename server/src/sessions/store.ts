import { v4 as uuidv4 } from 'uuid';
import type { ChatSession, Task } from '@ai-browser-agent/shared';
import { JsonRepository } from '../persistence/json-repository.js';
import { getTask } from '../tasks/store.js';

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
export function addTaskToSession(sessionId: string, taskId: string, request?: string): ChatSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const taskIds = session.taskIds.includes(taskId) ? session.taskIds : [...session.taskIds, taskId];
  const title =
    (session.title === DEFAULT_TITLE || !session.title) && request
      ? titleFromRequest(request)
      : session.title;
  return sessions.upsert({ ...session, taskIds, title, updatedAt: Date.now() });
}

export function getSessionTasks(id: string): Task[] {
  const session = sessions.get(id);
  if (!session) return [];
  return session.taskIds
    .map((taskId) => getTask(taskId))
    .filter((t): t is Task => Boolean(t))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Context engineering: produce a compact, token-bounded summary of the prior
 * tasks in this session so the planner/agent has memory of what already
 * happened (requests + outcomes). Excludes the task currently being processed.
 */
export function buildConversationContext(
  sessionId: string | undefined,
  excludeTaskId?: string,
  maxTasks = 5
): string {
  if (!sessionId) return '';
  const session = sessions.get(sessionId);
  if (!session) return '';

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
    return `${i + 1}. 用户请求: ${t.userRequest}\n   结果(${t.status}): ${String(outcome).slice(0, 300)}`;
  });

  return lines.join('\n');
}
