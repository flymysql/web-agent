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

const PORT = parseInt(process.env.PORT ?? '3847', 10);

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
  console.log(
    `[AI Browser Agent] LLM: ${process.env.OPENAI_API_KEY ? 'enabled' : 'rule-based fallback'}`
  );
});
