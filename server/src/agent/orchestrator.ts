import { v4 as uuidv4 } from 'uuid';
import type {
  Task,
  ToolCallRecord,
  PageContext,
  PlanStep,
  WorkflowStep,
} from '@ai-browser-agent/shared';
import { isBrowserTool, isBackendTool } from '@ai-browser-agent/shared';
import {
  getTask,
  createTask,
  updateTask,
  addLog,
  saveCheckpoint,
  setPageContext,
} from '../tasks/store.js';
import { assertTransition, isTerminalStatus } from '../tasks/state-machine.js';
import { createPlan } from './planner.js';
import {
  requiresConfirmation,
  recordAudit,
  maskArgs,
  assessToolRisk,
} from '../safety/audit.js';
import { executeBackendTool } from '../tools/registry.js';
import { buildConversationContext } from '../sessions/store.js';
import { getWorkflow } from '../workflows/store.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { debugLog } from '../debug/logger.js';
import {
  decideNextAction,
  type AgentHistoryItem,
} from '../llm/provider.js';

function getDefaultMaxSteps(): number {
  return getRuntimeConfig().maxSteps ?? parseInt(process.env.AGENT_MAX_STEPS ?? '40', 10);
}
const MAX_CONSECUTIVE_FAILURES = 3;

export type ToolExecutor = (
  taskId: string,
  tool: string,
  args: Record<string, unknown>,
  callId: string
) => Promise<{ success: boolean; result?: unknown; error?: string; pageContext?: PageContext }>;

let browserToolExecutor: ToolExecutor | null = null;

export function setBrowserToolExecutor(executor: ToolExecutor): void {
  browserToolExecutor = executor;
}

let taskUpdateNotifier: ((taskId: string) => void) | null = null;
export function setTaskUpdateNotifier(fn: (taskId: string) => void): void {
  taskUpdateNotifier = fn;
}
function emit(taskId: string): void {
  try {
    taskUpdateNotifier?.(taskId);
  } catch {
    /* ignore notifier errors */
  }
}

export async function planTask(taskId: string, pageContext?: PageContext): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  assertTransition(task.status, 'planning');
  task = updateTask(taskId, { status: 'planning' });
  addLog(taskId, 'info', 'Planning task...');

  const conversationContext = buildConversationContext(task.sessionId, taskId);
  const plan = await createPlan(task.userRequest, pageContext, conversationContext);
  task = updateTask(taskId, { plan, status: 'pending' });
  addLog(taskId, 'info', `Plan created with ${plan.steps.length} steps`);

  return task;
}

export async function runTask(taskId: string): Promise<Task> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.mode === 'agent') return runAgentLoop(taskId);
  return runReplay(taskId);
}

async function runReplay(taskId: string): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status === 'pending' || task.status === 'planning') {
    if (!task.plan) {
      task = await planTask(taskId, task.checkpoint?.pageContext);
    }
    assertTransition(task.status, 'running');
    task = updateTask(taskId, { status: 'running' });
    addLog(taskId, 'info', 'Task started');
  } else if (task.status === 'paused' || task.status === 'waiting_confirmation') {
    assertTransition(task.status, 'running');
    task = updateTask(taskId, { status: 'running' });
    addLog(taskId, 'info', 'Task resumed');
  }

  const plan = task.plan;
  if (!plan) throw new Error('No plan available');

  while (task.currentStepIndex < plan.steps.length) {
    task = getTask(taskId)!;

    if (task.status === 'paused' || task.status === 'cancelled') break;
    if (isTerminalStatus(task.status)) break;

    if (task.status === 'waiting_confirmation') break;

    const step = plan.steps[task.currentStepIndex];
    addLog(taskId, 'info', `Executing step ${task.currentStepIndex + 1}: ${step.description}`);
    emit(taskId);

    const confirmation = requiresConfirmation(step.tool, step.args, step.description);
    if (confirmation.required && !step.requiresConfirmation) {
      step.requiresConfirmation = true;
      step.riskLevel = 'high';
    }

    if (step.requiresConfirmation) {
      task = updateTask(taskId, {
        status: 'waiting_confirmation',
        pendingConfirmation: {
          stepId: step.id,
          tool: step.tool,
          args: step.args,
          reason: confirmation.reason ?? 'High risk action',
        },
      });
      addLog(taskId, 'warn', `Waiting for user confirmation: ${step.description}`);
      break;
    }

    const result = await executeStep(task, step);

    if (!result.success) {
      addLog(taskId, 'error', `Step failed: ${result.error}`, { step: step.id });
      emit(taskId);

      // Adaptive recovery: re-observe the page and let the LLM re-locate / fix this step.
      const recovered = await recoverReplayStep(task, step, result.error ?? 'unknown');
      if (recovered) {
        addLog(taskId, 'info', `已通过自适应重定位恢复步骤 ${task.currentStepIndex + 1}`);
        if (recovered.pageContext) setPageContext(taskId, recovered.pageContext);
        saveCheckpoint(taskId, {
          stepIndex: task.currentStepIndex + 1,
          pageContext: recovered.pageContext ?? task.checkpoint?.pageContext,
        });
        task = updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
        emit(taskId);
        continue;
      }

      task = updateTask(taskId, {
        status: 'failed',
        error: result.error,
      });
      emit(taskId);
      break;
    }

    if (result.pageContext) {
      setPageContext(taskId, result.pageContext);
    }

    saveCheckpoint(taskId, {
      stepIndex: task.currentStepIndex + 1,
      lastToolCallId: result.callId,
      pageContext: result.pageContext ?? task.checkpoint?.pageContext,
    });

    task = updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
    emit(taskId);
  }

  task = getTask(taskId)!;

  if (
    task.plan &&
    task.currentStepIndex >= task.plan.steps.length &&
    task.status === 'running'
  ) {
    if (task.kind === 'loop') {
      const iteration = task.loopIteration + 1;
      if (task.loopMaxIterations && iteration >= task.loopMaxIterations) {
        task = updateTask(taskId, {
          status: 'completed',
          result: `Loop completed after ${iteration} iterations`,
          loopIteration: iteration,
        });
      } else {
        task = updateTask(taskId, {
          currentStepIndex: 0,
          loopIteration: iteration,
          status: 'running',
        });
        addLog(taskId, 'info', `Loop iteration ${iteration} complete, restarting plan`);
      }
    } else {
      task = updateTask(taskId, {
        status: 'completed',
        result: summarizeResult(task),
      });
      addLog(taskId, 'info', 'Task completed successfully');
    }
  }

  emit(taskId);
  return task;
}

function makeSyntheticStep(
  tool: string,
  args: Record<string, unknown>,
  description: string
): PlanStep {
  const riskLevel = assessToolRisk(tool, args);
  return {
    id: uuidv4(),
    description,
    tool,
    args,
    riskLevel,
    requiresConfirmation: riskLevel === 'high',
  };
}

function summarizeToolResult(tool: string, result: unknown): string {
  if (tool === 'extractPage') return 'page extracted';
  if (result == null) return 'ok';
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return text.slice(0, 200);
  } catch {
    return 'ok';
  }
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 300) {
      out[k] = `${v.slice(0, 120)}…<${v.length} chars omitted>`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildHistory(task: Task): AgentHistoryItem[] {
  return task.toolCalls.map((c) => ({
    tool: c.tool,
    args: compactArgs(c.args),
    success: !c.error,
    error: c.error,
    result: c.error ? undefined : summarizeToolResult(c.tool, c.result),
  }));
}

/**
 * Generalize the successfully executed tool calls into reusable workflow steps.
 * String argument values that literally appear in the user's request are lifted
 * into {{param}} placeholders so the workflow can be re-run with new inputs.
 */
function recordWorkflowDraft(task: Task): WorkflowStep[] {
  const request = task.userRequest;
  let paramIdx = 0;
  const valueToParam = new Map<string, string>();

  const generalize = (args: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length >= 2 && request.includes(value)) {
        let param = valueToParam.get(value);
        if (!param) {
          param = `param${++paramIdx}`;
          valueToParam.set(value, param);
        }
        out[key] = `{{${param}}}`;
      } else {
        out[key] = value;
      }
    }
    return out;
  };

  return task.toolCalls
    .filter((c) => !c.error && c.tool !== 'extractPage')
    .map((c) => ({
      id: uuidv4(),
      description: `${c.tool} ${JSON.stringify(c.args)}`.slice(0, 120),
      tool: c.tool,
      args: generalize(c.args),
      riskLevel: c.riskLevel,
      requiresConfirmation: c.riskLevel === 'high',
    }));
}

async function recoverReplayStep(
  task: Task,
  step: PlanStep,
  error: string
): Promise<{ pageContext?: PageContext } | null> {
  try {
    const ctx = await observePage(task);
    if (!ctx) return null;
    const decision = await decideNextAction(
      `${task.userRequest}\n当前需要完成的步骤: ${step.description}（原工具 ${step.tool} 失败: ${error}）。` +
        `请使用当前页面真实存在的选择器重做这一步，只输出这一个动作。`,
      ctx,
      buildHistory(task),
      task.plan,
      undefined
    );
    const action = decision.action;
    if (!action?.tool) return null;
    const res = await executeStep(
      task,
      makeSyntheticStep(action.tool, action.args, decision.thought || action.tool)
    );
    if (res.success) return { pageContext: res.pageContext };
    return null;
  } catch {
    return null;
  }
}

async function observePage(task: Task): Promise<PageContext | undefined> {
  const obs = await executeStep(task, makeSyntheticStep('extractPage', {}, '观察页面'));
  if (obs.pageContext) {
    setPageContext(task.id, obs.pageContext);
    return obs.pageContext;
  }
  if (obs.success && obs.result && typeof obs.result === 'object' && 'url' in (obs.result as object)) {
    const ctx = obs.result as PageContext;
    setPageContext(task.id, ctx);
    return ctx;
  }
  return undefined;
}

export async function runAgentLoop(taskId: string): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status === 'pending' || task.status === 'planning') {
    assertTransition(task.status, 'running');
    task = updateTask(taskId, { status: 'running' });
    addLog(taskId, 'info', 'Agent 开始执行');
  } else if (task.status === 'paused' || task.status === 'waiting_confirmation') {
    assertTransition(task.status, 'running');
    task = updateTask(taskId, { status: 'running' });
    addLog(taskId, 'info', 'Agent 继续执行');
  }

  const maxSteps = task.maxSteps ?? getDefaultMaxSteps();
  const conversationContext = buildConversationContext(task.sessionId, taskId);
  let pageContext = task.checkpoint?.pageContext;
  let consecutiveFailures = 0;
  const actionCounts = new Map<string, number>();
  let lastUrl: string | undefined = pageContext?.url;

  while (true) {
    task = getTask(taskId)!;
    if (task.status === 'paused' || task.status === 'cancelled') break;
    if (isTerminalStatus(task.status)) break;
    if (task.status === 'waiting_confirmation') break;
    if (task.currentStepIndex >= maxSteps) break;

    if (!pageContext) {
      addLog(taskId, 'info', '执行: extractPage');
      pageContext = await observePage(task);
      task = updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
      if (!pageContext) {
        task = updateTask(taskId, { status: 'failed', error: '无法获取页面上下文(扩展是否已连接?)' });
        break;
      }
      continue;
    }

    // A navigation happened (the page URL changed): that IS progress, so reset the
    // stuck/failure detectors. Otherwise a multi-page task that calls extractPage once
    // per page would falsely trip the "repeated action" guard.
    if (pageContext.url && pageContext.url !== lastUrl) {
      if (lastUrl !== undefined) {
        actionCounts.clear();
        consecutiveFailures = 0;
        addLog(taskId, 'info', `📄 页面已跳转，继续执行：${pageContext.url}`);
        emit(taskId);
      }
      lastUrl = pageContext.url;
    }

    let decision;
    try {
      decision = await decideNextAction(task.userRequest, pageContext, buildHistory(task), task.plan, conversationContext);
    } catch (err) {
      task = updateTask(taskId, {
        status: 'failed',
        error: `决策失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      break;
    }

    if (decision.thought) {
      addLog(taskId, 'info', `🤔 ${decision.thought}`);
      emit(taskId);
    }

    if (decision.done) {
      // Final verification: re-observe so the recorded result reflects the true end state.
      const finalCtx = await observePage(task);
      if (finalCtx) pageContext = finalCtx;
      task = updateTask(taskId, {
        status: 'completed',
        result: decision.summary ?? summarizeResult(task),
        recordedSteps: recordWorkflowDraft(task),
      });
      addLog(taskId, 'info', 'Agent 判定任务完成');
      emit(taskId);
      break;
    }

    const action = decision.action;
    if (!action?.tool) {
      consecutiveFailures++;
      addLog(taskId, 'warn', 'LLM 未给出有效动作');
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        task = updateTask(taskId, { status: 'failed', error: 'Agent 连续多次未产出有效动作' });
        break;
      }
      continue;
    }

    const sig = `${action.tool}:${JSON.stringify(action.args)}`;
    const seen = (actionCounts.get(sig) ?? 0) + 1;
    actionCounts.set(sig, seen);
    if (seen >= 3) {
      task = updateTask(taskId, {
        status: 'failed',
        error: `检测到重复动作(${action.tool})已 ${seen} 次仍无进展，已停止以避免卡死。`,
      });
      addLog(taskId, 'warn', `检测到重复动作，已停止: ${sig.slice(0, 120)}`);
      emit(taskId);
      break;
    }

    const confirmation = requiresConfirmation(action.tool, action.args, decision.thought);
    if (confirmation.required) {
      task = updateTask(taskId, {
        status: 'waiting_confirmation',
        pendingConfirmation: {
          stepId: uuidv4(),
          tool: action.tool,
          args: action.args,
          reason: confirmation.reason ?? '高风险操作',
        },
      });
      addLog(taskId, 'warn', `需要确认高风险操作: ${action.tool}`);
      emit(taskId);
      break;
    }

    addLog(taskId, 'info', `执行: ${action.tool}`);
    emit(taskId);
    const result = await executeStep(
      task,
      makeSyntheticStep(action.tool, action.args, decision.thought || action.tool)
    );

    if (result.pageContext) {
      pageContext = result.pageContext;
      setPageContext(taskId, pageContext);
    }

    if (!result.success) {
      consecutiveFailures++;
      addLog(taskId, 'error', `步骤失败: ${result.error}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        task = updateTask(taskId, { status: 'failed', error: result.error });
        emit(taskId);
        break;
      }
    } else {
      consecutiveFailures = 0;
    }

    task = updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
    emit(taskId);
  }

  task = getTask(taskId)!;

  if (task.status === 'running') {
    if (task.kind === 'loop') {
      const iteration = task.loopIteration + 1;
      if (task.loopMaxIterations && iteration >= task.loopMaxIterations) {
        task = updateTask(taskId, {
          status: 'completed',
          result: `循环完成,共 ${iteration} 轮`,
          loopIteration: iteration,
        });
      } else {
        task = updateTask(taskId, { currentStepIndex: 0, loopIteration: iteration });
        addLog(taskId, 'info', `第 ${iteration} 轮完成,等待下次触发`);
      }
    } else if (task.currentStepIndex >= maxSteps) {
      task = updateTask(taskId, {
        status: 'completed',
        result:
          `${summarizeResult(task)}\n\n⚠️ 已达到单次步数上限（${maxSteps} 步）后停止，任务可能尚未完全完成。` +
          `如需继续，请回复“继续”，或在 .env 中调大 AGENT_MAX_STEPS。`,
        recordedSteps: recordWorkflowDraft(task),
      });
      addLog(taskId, 'warn', `已达最大步数 ${maxSteps}，停止执行`);
    }
  }

  emit(taskId);
  return task;
}

async function executeStep(
  task: Task,
  step: PlanStep
): Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
  pageContext?: PageContext;
  callId: string;
}> {
  const callId = uuidv4();
  const { masked, maskedFields } = maskArgs(step.args);
  const riskLevel = assessToolRisk(step.tool, step.args);

  recordAudit({
    taskId: task.id,
    action: 'tool_call',
    tool: step.tool,
    args: masked,
    riskLevel,
    confirmed: !step.requiresConfirmation,
    maskedFields,
  });

  const record: ToolCallRecord = {
    id: callId,
    taskId: task.id,
    stepId: step.id,
    tool: step.tool,
    args: masked,
    startedAt: Date.now(),
    riskLevel,
    confirmed: !step.requiresConfirmation,
  };

  let result: { success: boolean; result?: unknown; error?: string; pageContext?: PageContext };

  if (isBrowserTool(step.tool)) {
    if (!browserToolExecutor) {
      result = { success: false, error: 'Browser not connected' };
    } else {
      result = await browserToolExecutor(task.id, step.tool, step.args, callId);
    }
  } else if (isBackendTool(step.tool)) {
    result = await executeBackendTool(step.tool, step.args);
  } else {
    result = { success: false, error: `Unknown tool: ${step.tool}` };
  }

  record.completedAt = Date.now();
  record.result = result.result;
  record.error = result.error;

  debugLog({
    source: 'tool',
    level: result.success ? 'info' : 'error',
    category: step.tool,
    message: result.success
      ? `✓ ${step.tool} (${(record.completedAt ?? 0) - record.startedAt}ms)`
      : `✗ ${step.tool}: ${result.error}`,
    taskId: task.id,
    data: {
      args: masked,
      durationMs: (record.completedAt ?? 0) - record.startedAt,
      result: result.success ? summarizeToolResult(step.tool, result.result) : undefined,
      error: result.error,
    },
  });

  updateTask(task.id, {
    toolCalls: [...task.toolCalls, record],
  });

  return { ...result, callId };
}

function summarizeResult(task: Task): string {
  const okCalls = task.toolCalls.filter((c) => !c.error);
  const usedTools = Array.from(new Set(okCalls.map((c) => c.tool)));
  const parts = [`已完成：${task.userRequest}`];
  parts.push(
    `共执行 ${okCalls.length} 个操作${usedTools.length ? `（${usedTools.join('、')}）` : ''}`
  );

  const lastRead = [...task.toolCalls].reverse().find((c) => c.tool === 'readText' && c.result);
  if (lastRead?.result) {
    const text = (lastRead.result as { text?: string }).text;
    if (text) parts.push(`读取内容：${text.slice(0, 400)}…`);
  }

  return parts.join('\n');
}

export async function confirmPendingAction(taskId: string, confirmed: boolean): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'waiting_confirmation') {
    throw new Error('Task is not waiting for confirmation');
  }

  const pending = task.pendingConfirmation;

  if (!confirmed) {
    recordAudit({
      taskId,
      action: 'confirmation_rejected',
      tool: pending?.tool,
      args: pending?.args,
      riskLevel: 'high',
      confirmed: false,
    });

    if (task.mode === 'agent' && pending) {
      // Record the rejection as a failed action so the agent avoids re-proposing it.
      addLog(taskId, 'warn', `用户拒绝: ${pending.tool}`);
      task = updateTask(taskId, {
        status: 'running',
        pendingConfirmation: undefined,
        toolCalls: [
          ...task.toolCalls,
          {
            id: uuidv4(),
            taskId,
            stepId: pending.stepId,
            tool: pending.tool,
            args: pending.args,
            error: '用户拒绝该操作',
            startedAt: Date.now(),
            completedAt: Date.now(),
            riskLevel: 'high',
            confirmed: false,
          },
        ],
      });
      return runAgentLoop(taskId);
    }

    return updateTask(taskId, {
      status: 'paused',
      pendingConfirmation: undefined,
    });
  }

  recordAudit({
    taskId,
    action: 'confirmation_accepted',
    tool: pending?.tool,
    args: pending?.args,
    riskLevel: 'high',
    confirmed: true,
  });

  if (task.mode === 'agent' && pending) {
    task = updateTask(taskId, { status: 'running', pendingConfirmation: undefined });
    const result = await executeStep(
      task,
      makeSyntheticStep(pending.tool, pending.args, `用户已确认: ${pending.tool}`)
    );
    if (result.pageContext) setPageContext(taskId, result.pageContext);
    updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
    return runAgentLoop(taskId);
  }

  const step = task.plan?.steps[task.currentStepIndex];
  if (step) step.requiresConfirmation = false;

  task = updateTask(taskId, {
    status: 'running',
    pendingConfirmation: undefined,
  });

  return runReplay(taskId);
}

function applyParams(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? `{{${k}}}`);
  }
  if (Array.isArray(value)) return value.map((v) => applyParams(v, params));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyParams(v, params);
    return out;
  }
  return value;
}

/** Run a saved workflow as a deterministic replay task. */
export async function runWorkflow(
  workflowId: string,
  params: Record<string, string> = {},
  tabId?: number,
  url?: string
): Promise<Task> {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

  const merged: Record<string, string> = {};
  for (const p of wf.params) merged[p.key] = p.default ?? '';
  Object.assign(merged, params);

  const steps: PlanStep[] = wf.steps.map((step) => ({
    id: uuidv4(),
    description: step.description,
    tool: step.tool,
    args: applyParams(step.args, merged) as Record<string, unknown>,
    riskLevel: step.riskLevel,
    requiresConfirmation: step.requiresConfirmation,
  }));

  // Replay starts from a known URL so saved selectors resolve against the right page.
  if (wf.startUrl && steps[0]?.tool !== 'navigate') {
    steps.unshift({
      id: uuidv4(),
      description: `打开起始页 ${wf.startUrl}`,
      tool: 'navigate',
      args: { url: wf.startUrl },
      riskLevel: 'low',
      requiresConfirmation: false,
    });
  }

  const task = createTask({ userRequest: `▶️ 工作流：${wf.name}`, mode: 'replay', workflowId, tabId, url });
  updateTask(task.id, { plan: { goal: wf.name, steps } });
  addLog(task.id, 'info', `运行工作流：${wf.name}（${steps.length} 步）`);
  return runTask(task.id);
}

export async function pauseTask(taskId: string): Promise<Task> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  assertTransition(task.status, 'paused');
  addLog(taskId, 'info', 'Task paused');
  return updateTask(taskId, { status: 'paused' });
}

export async function cancelTask(taskId: string): Promise<Task> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  assertTransition(task.status, 'cancelled');
  addLog(taskId, 'info', 'Task cancelled');
  return updateTask(taskId, { status: 'cancelled', pendingConfirmation: undefined });
}

export async function resumeTask(taskId: string): Promise<Task> {
  return runTask(taskId);
}
