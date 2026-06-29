import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { PageContext } from '@ai-browser-agent/shared';
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
} from './tasks/store.js';
import {
  planTask,
  runTask,
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
} from './scheduler/scheduler.js';
import { getAuditLog } from './safety/audit.js';
import { describeLLM } from './llm/provider.js';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
} from './workflows/store.js';
import { instantiateWorkflow, saveTaskAsWorkflow } from './workflows/service.js';

const PORT = parseInt(process.env.PORT ?? '3847', 10);

/** Match a URL against a pattern: '*' wildcard, otherwise case-insensitive substring. */
function urlMatches(url: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(url);
  }
  return url.toLowerCase().includes(pattern.toLowerCase());
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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
    const { userRequest, tabId, url, pageContext, kind, loopIntervalMs, loopMaxIterations } =
      req.body as {
        userRequest: string;
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

    const task = createTask({
      userRequest,
      tabId,
      url,
      kind,
      loopIntervalMs,
      loopMaxIterations,
    });

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

app.post('/api/tasks/:id/start', async (req, res) => {
  try {
    const task = await runTask(req.params.id);
    if (task.kind === 'loop' && task.loopIntervalMs) {
      scheduleLoopTask(task.id, task.loopIntervalMs);
    }
    broadcastTaskUpdate(task.id);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

app.post('/api/tasks/:id/resume', async (req, res) => {
  try {
    const task = await resumeTask(req.params.id);
    broadcastTaskUpdate(task.id);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

app.post('/api/tasks/:id/confirm', async (req, res) => {
  try {
    const { confirmed } = req.body as { confirmed: boolean };
    const task = await confirmPendingAction(req.params.id, confirmed ?? false);
    broadcastTaskUpdate(task.id);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/audit', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 100;
  res.json({ audit: getAuditLog(limit) });
});

app.get('/api/workflows', (_req, res) => {
  res.json({ workflows: listWorkflows() });
});

app.get('/api/workflows/match', (req, res) => {
  const url = (req.query.url as string) ?? '';
  const matches = listWorkflows().filter((w) =>
    w.triggers.some(
      (t) => t.type === 'onPageOpen' && t.urlPattern && urlMatches(url, t.urlPattern)
    )
  );
  res.json({ workflows: matches });
});

app.get('/api/workflows/:id', (req, res) => {
  const workflow = getWorkflow(req.params.id);
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ workflow });
});

app.post('/api/workflows', (req, res) => {
  try {
    const workflow = createWorkflow(req.body);
    res.status(201).json({ workflow });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/workflows/:id', (req, res) => {
  try {
    const workflow = updateWorkflow(req.params.id, req.body);
    res.json({ workflow });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/workflows/:id', (req, res) => {
  deleteWorkflow(req.params.id);
  res.json({ ok: true });
});

app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    const workflow = getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const { params, tabId, url } = req.body as {
      params?: Record<string, string>;
      tabId?: number;
      url?: string;
    };

    const task = instantiateWorkflow(workflow, params ?? {}, { tabId, url });
    const started = await runTask(task.id);
    if (started.kind === 'loop' && started.loopIntervalMs) {
      scheduleLoopTask(started.id, started.loopIntervalMs);
    }
    broadcastTaskUpdate(started.id);
    res.status(201).json({ task: started });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/tasks/:id/save-as-workflow', (req, res) => {
  try {
    const { name, description, triggers } = req.body as {
      name: string;
      description?: string;
      triggers?: import('@ai-browser-agent/shared').WorkflowTrigger[];
    };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const workflow = saveTaskAsWorkflow(req.params.id, { name, description, triggers });
    res.status(201).json({ workflow });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
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
  console.log(`[AI Browser Agent] LLM: ${describeLLM()}`);
});
