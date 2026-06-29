import './env.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { PageContext, WorkflowParam, WorkflowStep, WorkflowTrigger } from '@ai-browser-agent/shared';
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
} from './tasks/store.js';
import {
  createSession,
  getSession,
  listSessions,
  renameSession,
  deleteSession,
  addTaskToSession,
  getSessionTasks,
} from './sessions/store.js';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getWorkflowsByTrigger,
} from './workflows/store.js';
import {
  planTask,
  runTask,
  runWorkflow,
  pauseTask,
  cancelTask,
  resumeTask,
  confirmPendingAction,
} from './agent/orchestrator.js';
import {
  handleWebSocketConnection,
  broadcastTaskUpdate,
  isExtensionConnected,
} from './websocket/handler.js';
import {
  startScheduler,
  scheduleLoopTask,
  unscheduleLoopTask,
  setSchedulerCallbacks,
  syncWorkflowSchedules,
} from './scheduler/scheduler.js';
import { getAuditLog } from './safety/audit.js';
import { getRuntimeConfig, setRuntimeConfig, redactedConfig } from './config/runtime-config.js';
import {
  debugLog,
  getDebugLogs,
  clearDebugLogs,
  ingestClientLogs,
  installGlobalErrorHandlers,
} from './debug/logger.js';

const PORT = parseInt(process.env.PORT ?? '3847', 10);

const AUTH_TOKEN = process.env.AGENT_AUTH_TOKEN; // optional; when set, all API/WS calls must present it

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Optional local-token auth. Open by default for localhost dev; enforced only
// when AGENT_AUTH_TOKEN is configured.
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if (req.path === '/health') return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

installGlobalErrorHandlers();

// HTTP access log (skip health + client-log ingestion to avoid noise/feedback).
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/api/debug/client-log') return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    debugLog({
      source: 'http',
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      category: `${req.method} ${req.path}`,
      message: `${res.statusCode} (${Date.now() - startedAt}ms)`,
    });
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    extensionConnected: isExtensionConnected(),
    timestamp: Date.now(),
  });
});

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: listTasks() });
});

app.get('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { userRequest, sessionId, tabId, url, pageContext, kind, loopIntervalMs, loopMaxIterations } =
      req.body as {
        userRequest: string;
        sessionId?: string;
        tabId?: number;
        url?: string;
        pageContext?: PageContext;
        kind?: 'once' | 'loop';
        loopIntervalMs?: number;
        loopMaxIterations?: number;
      };

    if (!userRequest) {
      return res.status(400).json({ error: 'userRequest is required' });
    }

    let sid = sessionId && getSession(sessionId) ? sessionId : undefined;
    if (!sid) sid = createSession().id;

    const task = createTask({
      userRequest,
      sessionId: sid,
      tabId,
      url,
      kind,
      loopIntervalMs,
      loopMaxIterations,
    });

    addTaskToSession(sid, task.id, userRequest);

    if (pageContext) {
      updateTask(task.id, {
        checkpoint: { stepIndex: 0, pageContext, savedAt: Date.now() },
      });
    }

    const planned = await planTask(task.id, pageContext);
    res.status(201).json({ task: planned });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/tasks/:id/start', (req, res) => {
  const id = req.params.id;
  const task = getTask(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // Run asynchronously: the loop pushes progress over WebSocket; return immediately.
  runTask(id)
    .then((t) => {
      if (t.kind === 'loop' && t.loopIntervalMs) scheduleLoopTask(t.id, t.loopIntervalMs);
      broadcastTaskUpdate(t.id);
    })
    .catch((err) => {
      try {
        updateTask(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      } catch {
        /* ignore */
      }
      broadcastTaskUpdate(id);
    });
  res.json({ task });
});

app.post('/api/tasks/:id/pause', async (req, res) => {
  try {
    const task = await pauseTask(req.params.id);
    broadcastTaskUpdate(task.id);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/tasks/:id/resume', (req, res) => {
  const id = req.params.id;
  const task = getTask(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  resumeTask(id)
    .then((t) => broadcastTaskUpdate(t.id))
    .catch((err) => {
      try {
        updateTask(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      } catch {
        /* ignore */
      }
      broadcastTaskUpdate(id);
    });
  res.json({ task });
});

app.post('/api/tasks/:id/cancel', async (req, res) => {
  try {
    const task = await cancelTask(req.params.id);
    unscheduleLoopTask(task.id);
    broadcastTaskUpdate(task.id);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/tasks/:id/confirm', (req, res) => {
  const id = req.params.id;
  const { confirmed } = req.body as { confirmed: boolean };
  const task = getTask(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  confirmPendingAction(id, confirmed ?? false)
    .then((t) => broadcastTaskUpdate(t.id))
    .catch((err) => {
      try {
        updateTask(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      } catch {
        /* ignore */
      }
      broadcastTaskUpdate(id);
    });
  res.json({ task });
});

app.get('/api/config', (_req, res) => {
  res.json({ config: redactedConfig() });
});

app.put('/api/config', (req, res) => {
  const { llmBaseUrl, llmModel, llmApiKey, maxSteps } = req.body as {
    llmBaseUrl?: string;
    llmModel?: string;
    llmApiKey?: string;
    maxSteps?: number;
  };
  const patch: Record<string, unknown> = {};
  if (llmBaseUrl !== undefined) patch.llmBaseUrl = llmBaseUrl;
  if (llmModel !== undefined) patch.llmModel = llmModel;
  if (llmApiKey !== undefined && llmApiKey !== '') patch.llmApiKey = llmApiKey;
  if (maxSteps !== undefined) patch.maxSteps = Number(maxSteps) || undefined;
  setRuntimeConfig(patch);
  res.json({ config: redactedConfig() });
});

app.get('/api/audit', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 100;
  res.json({ audit: getAuditLog(limit) });
});

app.get('/api/debug/logs', (req, res) => {
  res.json({
    logs: getDebugLogs({
      limit: parseInt(req.query.limit as string, 10) || 500,
      source: req.query.source as never,
      level: req.query.level as never,
      taskId: req.query.taskId as string | undefined,
    }),
  });
});

app.delete('/api/debug/logs', (_req, res) => {
  clearDebugLogs();
  res.json({ ok: true });
});

app.post('/api/debug/client-log', (req, res) => {
  const { entries } = req.body as { entries?: Array<Record<string, unknown>> };
  const count = Array.isArray(entries) ? ingestClientLogs(entries) : 0;
  res.json({ ok: true, count });
});

// One-shot diagnostic bundle to hand to a developer / debugging AI.
app.get('/api/debug/bundle', (req, res) => {
  const taskId = req.query.taskId as string | undefined;
  const task = taskId ? getTask(taskId) : undefined;
  res.json({
    generatedAt: Date.now(),
    config: redactedConfig(),
    env: {
      node: process.version,
      llmModel: process.env.LLM_MODEL ?? process.env.OPENAI_MODEL,
      llmBaseUrl: process.env.LLM_BASE_URL,
      agentMaxSteps: process.env.AGENT_MAX_STEPS,
    },
    extensionConnected: isExtensionConnected(),
    focusTask: task ?? null,
    tasks: listTasks()
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        userRequest: t.userRequest,
        status: t.status,
        mode: t.mode,
        error: t.error,
        steps: t.currentStepIndex,
        updatedAt: t.updatedAt,
      })),
    audit: getAuditLog(100),
    logs: getDebugLogs({ limit: taskId ? 1000 : 800, taskId }),
  });
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: listSessions() });
});

app.post('/api/sessions', (req, res) => {
  const { title } = req.body as { title?: string };
  res.status(201).json({ session: createSession(title) });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session, tasks: getSessionTasks(req.params.id) });
});

app.patch('/api/sessions/:id', (req, res) => {
  try {
    const { title } = req.body as { title?: string };
    const session = renameSession(req.params.id, title ?? '');
    res.json({ session });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const taskIds = deleteSession(req.params.id);
  for (const tid of taskIds) deleteTask(tid);
  res.json({ ok: true });
});

function paramsFromSteps(steps: WorkflowStep[]): WorkflowParam[] {
  const keys = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  for (const step of steps) {
    const json = JSON.stringify(step.args ?? {});
    let m: RegExpExecArray | null;
    while ((m = re.exec(json)) !== null) keys.add(m[1]);
  }
  return Array.from(keys).map((k) => ({ key: k, label: k }));
}

function urlMatches(pattern: string | undefined, url: string): boolean {
  if (!pattern) return true;
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
    return re.test(url);
  }
  return url.includes(pattern);
}

app.get('/api/workflows', (_req, res) => {
  res.json({ workflows: listWorkflows() });
});

app.get('/api/workflows/match', (req, res) => {
  const url = String(req.query.url ?? '');
  const matches = getWorkflowsByTrigger('onPageOpen').filter((w) =>
    w.triggers.some((t) => t.type === 'onPageOpen' && urlMatches(t.urlPattern, url))
  );
  res.json({ workflows: matches });
});

app.get('/api/workflows/:id', (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ workflow: wf });
});

app.patch('/api/workflows/:id', (req, res) => {
  try {
    const { name, description, triggers, steps, params, startUrl } = req.body as {
      name?: string;
      description?: string;
      triggers?: WorkflowTrigger[];
      steps?: WorkflowStep[];
      params?: WorkflowParam[];
      startUrl?: string;
    };
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (triggers !== undefined) updates.triggers = triggers;
    if (startUrl !== undefined) updates.startUrl = startUrl;
    if (steps !== undefined) {
      updates.steps = steps;
      // Recompute params from step placeholders unless explicitly provided.
      updates.params = params !== undefined ? params : paramsFromSteps(steps);
    } else if (params !== undefined) {
      updates.params = params;
    }
    const wf = updateWorkflow(req.params.id, updates);
    syncWorkflowSchedules();
    res.json({ workflow: wf });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/workflows/:id', (req, res) => {
  deleteWorkflow(req.params.id);
  syncWorkflowSchedules();
  res.json({ ok: true });
});

app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    const { params, tabId, url } = req.body as {
      params?: Record<string, string>;
      tabId?: number;
      url?: string;
    };
    const task = await runWorkflow(req.params.id, params ?? {}, tabId, url);
    broadcastTaskUpdate(task.id);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/tasks/:id/save-as-workflow', (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const steps = task.recordedSteps ?? [];
    if (steps.length === 0) {
      return res.status(400).json({ error: '该任务没有可保存的动作（未成功执行任何可复用步骤）' });
    }
    const { name, description, triggers } = req.body as {
      name?: string;
      description?: string;
      triggers?: WorkflowTrigger[];
    };
    const wf = createWorkflow({
      name: name?.trim() || task.userRequest,
      description,
      steps,
      params: paramsFromSteps(steps),
      triggers: triggers && triggers.length ? triggers : [{ type: 'manual' }],
      startUrl: task.url,
    });
    syncWorkflowSchedules();
    res.status(201).json({ workflow: wf });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Express error handler — log unexpected route errors with stack.
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  debugLog({
    source: 'server',
    level: 'error',
    category: `route ${req.method} ${req.path}`,
    message: err.message,
    data: { stack: err.stack },
  });
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (AUTH_TOKEN) {
    try {
      const u = new URL(req.url ?? '', 'http://localhost');
      if (u.searchParams.get('token') !== AUTH_TOKEN) {
        ws.close(1008, 'unauthorized');
        return;
      }
    } catch {
      ws.close(1008, 'unauthorized');
      return;
    }
  }
  handleWebSocketConnection(ws);
});

setSchedulerCallbacks({
  broadcastTaskUpdate,
  checkExtensionConnected: isExtensionConnected,
});

startScheduler();

server.listen(PORT, () => {
  console.log(`[AI Browser Agent] Server running on http://localhost:${PORT}`);
  console.log(`[AI Browser Agent] WebSocket at ws://localhost:${PORT}/ws`);
  debugLog({ source: 'server', level: 'info', category: 'startup', message: `Server listening on ${PORT}` });
  const rc = getRuntimeConfig();
  console.log(
    `[AI Browser Agent] LLM: ${
      rc.llmModel ?? process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
    } @ ${rc.llmBaseUrl ?? process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1'}`
  );
});
