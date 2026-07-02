import './env.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type {
  PageContext,
  RequestMode,
  TaskAttachment,
  RecordedAction,
  RecordingNarration,
  WorkflowStep,
  WorkflowParam,
  WorkflowTrigger,
} from '@ai-browser-agent/shared';
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
} from './tasks/store.js';
import {
  addTaskToSession,
  appendUserMessage,
  recordAssistantTurn,
  listSessions,
  createSession,
  getSession,
  getSessionTasks,
  renameSession,
  deleteSession,
} from './sessions/store.js';
import {
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  createWorkflow,
} from './workflows/store.js';
import { instantiateWorkflow, saveTaskAsWorkflow, resolveParamValues } from './workflows/service.js';
import { understandRecording, createReplayTaskFromSteps, editRecording } from './workflows/recording.js';
import { redactedConfig, setRuntimeConfig } from './config/runtime-config.js';
import { getDebugLogs, clearDebugLogs, ingestClientLogs } from './debug/logger.js';
import {
  planTask,
  runTask,
  pauseTask,
  cancelTask,
  resumeTask,
  confirmPendingAction,
  continueTask,
  steerTask,
} from './agent/orchestrator.js';
import { describeLLM, suggestPageActions, refineVoiceInstructionWithLLM } from './llm/provider.js';
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
    const {
      userRequest,
      sessionId,
      tabId,
      url,
      pageContext,
      attachments,
      kind,
      requestMode,
      confirmPolicy,
      loopIntervalMs,
      loopMaxIterations,
    } = req.body as {
      userRequest: string;
      sessionId?: string;
      tabId?: number;
      url?: string;
      pageContext?: PageContext;
      attachments?: TaskAttachment[];
      kind?: 'once' | 'loop';
      requestMode?: RequestMode;
      confirmPolicy?: import('@ai-browser-agent/shared').ConfirmPolicy;
      loopIntervalMs?: number;
      loopMaxIterations?: number;
    };

    if (!userRequest && !(attachments && attachments.length)) {
      return res.status(400).json({ error: 'userRequest is required' });
    }

    const task = createTask({
      userRequest,
      sessionId,
      tabId,
      url,
      attachments,
      kind,
      requestMode,
      confirmPolicy,
      loopIntervalMs,
      loopMaxIterations,
    });

    // Track the task on its session so history can replay the full run
    // (plan + step-by-step operations + outcome), not just the chat thread.
    addTaskToSession(sessionId, task.id, userRequest);
    appendUserMessage(sessionId, task.id, userRequest);

    if (pageContext) {
      updateTask(task.id, {
        checkpoint: { stepIndex: 0, pageContext, savedAt: Date.now() },
        // Seed the stable start page from the page the task was launched on.
        startUrl: task.startUrl ?? pageContext.url,
        url: task.url ?? pageContext.url,
      });
    }

    const planned = await planTask(task.id, pageContext);
    recordAssistantTurn(planned);

    // Auto-execute only a runnable agent plan. Chat answers (completed),
    // clarifying questions (needs_input) and explicit "plan" mode stop here and
    // are shown to the user; the agent's live progress streams over WebSocket.
    const shouldRun = planned.status === 'pending' && (planned.requestMode ?? 'auto') !== 'plan';
    if (shouldRun) {
      runTask(planned.id)
        .then((t) => {
          if (t.kind === 'loop' && t.loopIntervalMs) scheduleLoopTask(t.id, t.loopIntervalMs);
          recordAssistantTurn(getTask(t.id) ?? t);
          broadcastTaskUpdate(t.id);
        })
        .catch((err) => {
          try {
            updateTask(planned.id, {
              status: 'failed',
              outcome: 'failed',
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {
            /* ignore */
          }
          broadcastTaskUpdate(planned.id);
        });
    }

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

app.post('/api/tasks/:id/continue', (req, res) => {
  const taskId = req.params.id;
  if (!getTask(taskId)) return res.status(404).json({ error: 'Task not found' });
  // Fire-and-forget: the continuation streams progress over WebSocket; respond
  // immediately so the UI button doesn't hang for the whole run.
  continueTask(taskId)
    .then((t) => {
      recordAssistantTurn(getTask(t.id) ?? t);
      broadcastTaskUpdate(t.id);
    })
    .catch((err) => {
      try {
        updateTask(taskId, {
          status: 'failed',
          outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* ignore */
      }
      broadcastTaskUpdate(taskId);
    });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/steer', (req, res) => {
  const { text } = req.body as { text?: string };
  const ok = steerTask(req.params.id, text ?? '');
  res.json({ ok });
});

app.post('/api/tasks/:id/confirm', async (req, res) => {
  try {
    const { confirmed, dontAskAgain } = req.body as { confirmed: boolean; dontAskAgain?: boolean };
    const task = await confirmPendingAction(req.params.id, confirmed ?? false, dontAskAgain ?? false);
    broadcastTaskUpdate(task.id);
    res.json({ task });
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
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/audit', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 100;
  res.json({ audit: getAuditLog(limit) });
});

// Page-aware "what can I do here" suggestions, generated from the live page.
app.post('/api/suggest', async (req, res) => {
  try {
    const { pageContext, exclude } = req.body as { pageContext?: PageContext; exclude?: string[] };
    if (!pageContext) return res.status(400).json({ error: 'pageContext is required' });
    const suggestions = await suggestPageActions(
      pageContext,
      Array.isArray(exclude) ? exclude.filter((s): s is string => typeof s === 'string') : []
    );
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Sessions (conversation threads) ----

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
    const { title } = req.body as { title: string };
    res.json({ session: renameSession(req.params.id, title) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const taskIds = deleteSession(req.params.id);
  res.json({ ok: true, taskIds });
});

// ---- Workflows ----

app.get('/api/workflows', (_req, res) => {
  res.json({ workflows: listWorkflows() });
});

app.get('/api/workflows/:id', (req, res) => {
  const workflow = getWorkflow(req.params.id);
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ workflow });
});

app.patch('/api/workflows/:id', (req, res) => {
  try {
    res.json({ workflow: updateWorkflow(req.params.id, req.body ?? {}) });
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
    const { params, tabId, url, loopIntervalMs } = req.body as {
      params?: Record<string, string>;
      tabId?: number;
      url?: string;
      loopIntervalMs?: number;
    };
    const resolved = await resolveParamValues(workflow.params, params ?? {}, {
      goalName: workflow.name,
    });
    const task = instantiateWorkflow(workflow, resolved, { tabId, url, loopIntervalMs });
    runTask(task.id)
      .then((t) => {
        if (t.kind === 'loop' && t.loopIntervalMs) scheduleLoopTask(t.id, t.loopIntervalMs);
        broadcastTaskUpdate(t.id);
      })
      .catch((err) => {
        try {
          updateTask(task.id, {
            status: 'failed',
            outcome: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* ignore */
        }
        broadcastTaskUpdate(task.id);
      });
    res.status(201).json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Voice (speech transcript → concise instruction) ----

app.post('/api/voice/refine', async (req, res) => {
  try {
    const { transcript } = req.body as { transcript?: string };
    if (!transcript?.trim()) return res.status(400).json({ error: 'transcript is required' });
    const instruction = await refineVoiceInstructionWithLLM(transcript);
    res.json({ instruction });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Recordings (capture user actions → understand → workflow) ----

app.post('/api/recordings/understand', async (req, res) => {
  try {
    const { actions, narration, pageContext } = req.body as {
      actions?: RecordedAction[];
      narration?: RecordingNarration[];
      pageContext?: PageContext;
    };
    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'actions is required' });
    }
    const understood = await understandRecording(actions, narration, pageContext);
    res.json(understood);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/recordings/edit', async (req, res) => {
  try {
    const { name, steps, params, instruction, targetStepId, pageContext } = req.body as {
      name?: string;
      steps?: WorkflowStep[];
      params?: WorkflowParam[];
      instruction?: string;
      targetStepId?: string;
      pageContext?: PageContext;
    };
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'steps is required' });
    }
    if (!instruction?.trim()) {
      return res.status(400).json({ error: 'instruction is required' });
    }
    const edited = await editRecording(
      { name: name?.trim() || '录制的工作流', steps, params: params ?? [] },
      instruction.trim(),
      { targetStepId, pageContext }
    );
    res.json(edited);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/recordings/save', (req, res) => {
  try {
    const { name, description, steps, params, startUrl, triggers } = req.body as {
      name?: string;
      description?: string;
      steps?: WorkflowStep[];
      params?: WorkflowParam[];
      startUrl?: string;
      triggers?: WorkflowTrigger[];
    };
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'steps is required' });
    }
    const workflow = createWorkflow({
      name: name.trim(),
      description,
      startUrl,
      params: params ?? [],
      steps: steps.map((s) => ({ ...s, id: s.id || crypto.randomUUID() })),
      triggers: triggers ?? [{ type: 'manual' }],
    });
    res.status(201).json({ workflow });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/recordings/demo', async (req, res) => {
  try {
    const { name, steps, params, startUrl, tabId, url } = req.body as {
      name?: string;
      steps?: WorkflowStep[];
      params?: WorkflowParam[];
      startUrl?: string;
      tabId?: number;
      url?: string;
    };
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'steps is required' });
    }
    // Resolve run-time values (auto-generate 'generate' params) so the demo
    // exercises realistic values rather than empty placeholders.
    const values = await resolveParamValues(params ?? [], {}, { goalName: name });
    const task = createReplayTaskFromSteps(steps, {
      name: name?.trim() || '录制演示',
      startUrl,
      tabId,
      url,
      params,
      values,
    });
    runTask(task.id)
      .then((t) => broadcastTaskUpdate(t.id))
      .catch((err) => {
        try {
          updateTask(task.id, {
            status: 'failed',
            outcome: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* ignore */
        }
        broadcastTaskUpdate(task.id);
      });
    res.status(201).json({ task });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Runtime config (LLM endpoint overrides set from the options page) ----

app.get('/api/config', (_req, res) => {
  res.json({ config: redactedConfig() });
});

app.put('/api/config', (req, res) => {
  setRuntimeConfig(req.body ?? {});
  res.json({ config: redactedConfig() });
});

// ---- Debug logs ----

app.get('/api/debug/logs', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 500;
  res.json({ logs: getDebugLogs({ limit }) });
});

app.delete('/api/debug/logs', (_req, res) => {
  clearDebugLogs();
  res.json({ ok: true });
});

app.get('/api/debug/bundle', (req, res) => {
  const taskId = req.query.taskId as string | undefined;
  res.json({
    logs: getDebugLogs({ limit: 2000, taskId }),
    task: taskId ? getTask(taskId) ?? null : null,
    generatedAt: Date.now(),
  });
});

app.post('/api/debug/client-log', (req, res) => {
  const { entries } = req.body as { entries?: Array<Record<string, unknown>> };
  const n = ingestClientLogs(entries ?? []);
  res.json({ ok: true, ingested: n });
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
