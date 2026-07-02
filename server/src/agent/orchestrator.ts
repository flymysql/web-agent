import { v4 as uuidv4 } from 'uuid';
import type {
  Task,
  ToolCallRecord,
  PageContext,
  PlanStep,
  WorkflowStep,
  CollectedItem,
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
import { resolveParamValues } from '../workflows/service.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { debugLog } from '../debug/logger.js';
import {
  decideNextAction,
  decideNextBatch,
  verifyExpectation,
  reviewResult,
  generateSummaryWithLLM,
  routeIntent,
  answerChat,
  isVisionEnabled,
  type AgentHistoryItem,
} from '../llm/provider.js';
import type { PlannedStep } from '@ai-browser-agent/shared';

/** Per-run step budget; the agent auto-continues past this up to the hard cap. */
function getDefaultMaxSteps(): number {
  return getRuntimeConfig().maxSteps ?? parseInt(process.env.AGENT_MAX_STEPS ?? '99', 10);
}

/** Absolute ceiling across all auto-continuations — the runaway backstop. */
function getHardStepCap(): number {
  const cfg = getRuntimeConfig().maxStepsHard;
  const fromEnv = parseInt(process.env.AGENT_MAX_STEPS_HARD ?? '600', 10);
  const cap = cfg ?? fromEnv;
  // Never let the hard cap fall below a single budget.
  return Math.max(cap, getDefaultMaxSteps());
}

/** Whether the agent extends its own budget instead of stopping at maxSteps. */
function isAutoContinueEnabled(): boolean {
  const cfg = getRuntimeConfig().autoContinue;
  if (typeof cfg === 'boolean') return cfg;
  return process.env.AGENT_AUTO_CONTINUE !== 'false';
}
const MAX_CONSECUTIVE_FAILURES = 3;
/** How many times a single LLM decision can fail (bad output/parse) before giving up. */
const MAX_DECISION_FAILURES = 4;
/**
 * A transient LLM/network outage gets a longer, backed-off retry budget, and when
 * exhausted the task is PAUSED (resumable, progress kept) rather than terminally
 * failed — so a backend blip doesn't throw away a long task.
 */
const MAX_TRANSIENT_DECISION_FAILURES = 8;

/**
 * Heuristic: does this error look like a transient service/network problem
 * (backend down, timeout, rate-limit, 5xx) rather than a permanent one (bad
 * config, invalid request)? Site-/provider-agnostic — keys off standard status
 * codes, connection errors, and common "unavailable/service down" wording.
 */
function isTransientLLMError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /\b(408|425|429|5\d\d|498)\b/.test(m) ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('econnrefused') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||
    m.includes('socket hang up') ||
    m.includes('fetch failed') ||
    m.includes('network') ||
    m.includes('service down') ||
    m.includes('unavailable') ||
    m.includes('temporarily') ||
    m.includes('overloaded') ||
    m.includes('rate limit')
  );
}
/** Consecutive no-change steps before we replan; and before we honestly give up. */
const NO_PROGRESS_SOFT = 6;
const NO_PROGRESS_HARD = 10;
/**
 * Injected when the page has stopped changing for several steps: the current
 * sub-goal is likely blocked (element missing, content empty, or an unreadable
 * canvas/virtualized area). Site-agnostic guidance to move on and stay honest.
 */
const STUCK_SKIP_CORRECTION =
  '连续多步操作都没有让页面发生任何变化，说明当前这个子目标很可能受阻（目标元素不存在、内容为空，或日志/内容在无法读取的画布/虚拟滚动区域里）。' +
  '不要再在这一个点上反复换选择器重试：如果整体任务还有其它可以独立完成的部分，先跳过这个子目标去完成其余部分；' +
  '把已经拿到的结果如实汇总（用 done 给出 summary，说明哪些拿到了、哪一部分受阻）；' +
  '如果整个目标都卡在这个受阻点，就用 needsInput 向用户说明卡在哪里并请求帮助。绝不要谎报成功。';

/** Labels of the interactive controls on a page (accessible name / text). */
function controlLabels(ctx: PageContext): Set<string> {
  const out = new Set<string>();
  for (const el of ctx.interactiveElements ?? []) {
    const label = (el.accessibleName ?? el.text ?? '').replace(/\s+/g, ' ').trim();
    if (label) out.add(label.slice(0, 40));
  }
  return out;
}

/**
 * Concise, site-agnostic summary of what changed between two page snapshots —
 * the signal the model needs to judge whether its last action actually did
 * anything (a click that swapped a panel, opened a dialog, surfaced a toast, or
 * did nothing at all). Returns undefined for the first observation.
 */
function summarizeContextChange(
  prev: PageContext | undefined,
  cur: PageContext
): string | undefined {
  if (!prev) return undefined;
  const parts: string[] = [];

  if (prev.url !== cur.url) parts.push(`页面已跳转：${prev.url} → ${cur.url}`);

  const prevDialog = prev.regions?.find((r) => r.id === prev.activeDialogRegionId);
  const curDialog = cur.regions?.find((r) => r.id === cur.activeDialogRegionId);
  if (!prevDialog && curDialog) parts.push(`出现弹窗/对话框「${curDialog.label ?? curDialog.role}」`);
  else if (prevDialog && !curDialog) parts.push('弹窗/对话框已关闭');

  const prevRegions = new Set((prev.regions ?? []).map((r) => `${r.role}:${r.label ?? ''}`));
  const curRegions = new Set((cur.regions ?? []).map((r) => `${r.role}:${r.label ?? ''}`));
  const newRegions = [...curRegions].filter((r) => !prevRegions.has(r));
  const goneRegions = [...prevRegions].filter((r) => !curRegions.has(r));
  if (newRegions.length) parts.push(`新增区块：${newRegions.slice(0, 4).join('、')}`);
  if (goneRegions.length) parts.push(`消失区块：${goneRegions.slice(0, 4).join('、')}`);

  const prevLabels = controlLabels(prev);
  const curLabels = controlLabels(cur);
  const newControls = [...curLabels].filter((l) => !prevLabels.has(l));
  if (newControls.length) parts.push(`新增控件：${newControls.slice(0, 6).join('、')}`);

  const prevAnn = new Set(prev.announcements ?? []);
  const newAnn = (cur.announcements ?? []).filter((a) => !prevAnn.has(a));
  if (newAnn.length) parts.push(`新的页面提示：${newAnn.slice(0, 4).join(' / ')}`);

  const dCount =
    (cur.interactiveElements?.length ?? 0) - (prev.interactiveElements?.length ?? 0);
  if (parts.length === 0) {
    // Nothing observable moved — an important cue that the last action likely
    // missed its target (wrong selector / dead control).
    return Math.abs(dCount) >= 3
      ? `页面无明显结构变化（可交互元素数 ${dCount > 0 ? '+' : ''}${dCount}）。`
      : '页面几乎没有变化——上一步操作很可能没有命中目标或没有效果。';
  }
  if (dCount) parts.push(`可交互元素数 ${dCount > 0 ? '+' : ''}${dCount}`);
  return parts.join('；');
}

/** Task ids with an agent loop currently running — prevents double execution. */
const activeAgentLoops = new Set<string>();

/** Mid-run user instructions queued to be injected into a running agent loop. */
const pendingSteers = new Map<string, string[]>();

/**
 * Inject an extra instruction into a running agent loop (Cursor-style steering).
 * The loop picks it up on its next iteration as a high-priority correction.
 */
export function steerTask(taskId: string, text: string): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!activeAgentLoops.has(taskId)) return false;
  const queue = pendingSteers.get(taskId) ?? [];
  queue.push(trimmed);
  pendingSteers.set(taskId, queue);
  addLog(taskId, 'info', `📥 收到追加指令：${trimmed.slice(0, 80)}`);
  emit(taskId);
  return true;
}

export type ToolExecutor = (
  taskId: string,
  tool: string,
  args: Record<string, unknown>,
  callId: string,
  /** When set, run on this tab instead of the task's bound tab (sub-task tabs). */
  tabIdOverride?: number
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

/** Incremental streaming events (chat token deltas, etc.) for live UI. */
export interface AgentEvent {
  kind: 'delta' | 'done';
  text?: string;
}
let agentEventNotifier: ((taskId: string, event: AgentEvent) => void) | null = null;
export function setAgentEventNotifier(fn: (taskId: string, event: AgentEvent) => void): void {
  agentEventNotifier = fn;
}
function emitEvent(taskId: string, event: AgentEvent): void {
  try {
    agentEventNotifier?.(taskId, event);
  } catch {
    /* ignore notifier errors */
  }
}

/**
 * Route the user's request, then either answer (chat), ask a clarifying
 * question (clarify), or build an execution plan (agent). The caller decides
 * whether to auto-run the resulting plan (e.g. 'plan' mode stops after planning).
 */
export async function planTask(taskId: string, pageContext?: PageContext): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  assertTransition(task.status, 'planning');
  task = updateTask(taskId, { status: 'planning' });

  const requestMode = task.requestMode ?? 'auto';
  const conversationContext = buildConversationContext(task.sessionId, taskId);

  // 1) Decide intent. A forced composer mode skips the classifier.
  let intent: 'chat' | 'agent' | 'clarify';
  let answer: string | undefined;
  let question: string | undefined;
  let goal: string | undefined;

  if (requestMode === 'ask') {
    intent = 'chat';
  } else if (requestMode === 'agent' || requestMode === 'plan') {
    intent = 'agent';
  } else {
    addLog(taskId, 'info', '🧭 正在判断意图…');
    emit(taskId);
    try {
      const route = await routeIntent(task.userRequest, pageContext, conversationContext, task.attachments);
      intent = route.kind;
      answer = route.answer;
      question = route.question;
      goal = route.goal;
    } catch (err) {
      addLog(taskId, 'warn', `意图判断失败，按执行处理：${err instanceof Error ? err.message : String(err)}`);
      intent = 'agent';
    }
  }

  // 2) Chat: answer directly, no tools, honest success.
  if (intent === 'chat') {
    let text = answer?.trim();
    if (!text) {
      try {
        // Stream tokens to the UI as they arrive for a Cursor/Codex-like feel.
        text = await answerChat(
          task.userRequest,
          pageContext,
          conversationContext,
          (delta) => emitEvent(taskId, { kind: 'delta', text: delta }),
          task.attachments
        );
        emitEvent(taskId, { kind: 'done' });
      } catch (err) {
        text = `（回答失败：${err instanceof Error ? err.message : String(err)}）`;
      }
    }
    task = updateTask(taskId, {
      mode: 'chat',
      intent: 'chat',
      status: 'completed',
      outcome: 'success',
      assistantMessage: text,
      result: text,
    });
    addLog(taskId, 'info', '已直接回答（聊天模式）');
    emit(taskId);
    return task;
  }

  // 3) Clarify: ask the user one question and wait for input.
  if (intent === 'clarify') {
    const q = question?.trim() || '能再具体说明一下你的目标吗？';
    task = updateTask(taskId, {
      intent: 'clarify',
      status: 'needs_input',
      clarifyQuestion: q,
      assistantMessage: q,
    });
    addLog(taskId, 'info', '需要你补充信息');
    emit(taskId);
    return task;
  }

  // 4) Agent: build a plan. Caller auto-runs unless requestMode === 'plan'.
  addLog(taskId, 'info', 'Planning task...');
  const plan = await createPlan(goal || task.userRequest, pageContext, conversationContext, task.attachments);
  task = updateTask(taskId, { plan, status: 'pending', intent: 'agent' });
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
    // In deterministic replay, 'auto' runs high-risk steps silently; 'ask' and
    // 'reject' both fall back to pausing (silently dropping a committed workflow
    // step would be more surprising than asking).
    if (
      confirmation.required &&
      (task.confirmPolicy ?? 'ask') !== 'auto' &&
      !step.requiresConfirmation
    ) {
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
        outcome: 'success',
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

/**
 * Tools whose result IS information the model needs to reason with (not just a
 * confirmation that an action happened). Their output gets a much larger budget
 * in the model-facing history — otherwise a read/analyze goal (review a diff,
 * summarize logs, extract data) can never SEE what it just read and loops.
 * Action tools (click/type/navigate/…) are absent here and stay terse.
 */
const CONTENT_RESULT_CAPS: Record<string, number> = {
  readText: 8000,
  getHTML: 6000,
  evaluate: 6000,
  inspect: 2000,
  getAttribute: 1200,
  consoleLogs: 4000,
  network: 4000,
};

const DEFAULT_RESULT_CAP = 200;

function summarizeToolResult(tool: string, result: unknown, full = false): string {
  if (tool === 'extractPage') return 'page extracted';
  if (result == null) return 'ok';
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    const cap = full ? (CONTENT_RESULT_CAPS[tool] ?? DEFAULT_RESULT_CAP) : DEFAULT_RESULT_CAP;
    if (text.length <= cap) return text;
    return `${text.slice(0, cap)}…<+${text.length - cap} 字符已截断，可用 readText 指定 selector 读取某区域>`;
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

/** Keep the full content budget only for the most recent reads, so a large diff
 * the model just fetched is visible now, while older reads shrink to bound tokens. */
const FULL_RESULT_RECENCY = 3;

function buildHistory(task: Task): AgentHistoryItem[] {
  const lastIdx = task.toolCalls.length - 1;
  return task.toolCalls.map((c, i) => ({
    tool: c.tool,
    args: compactArgs(c.args),
    success: !c.error,
    error: c.error,
    result: c.error ? undefined : summarizeToolResult(c.tool, c.result, lastIdx - i < FULL_RESULT_RECENCY),
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

  const kept = pruneToolCalls(task.toolCalls);

  return kept.map((c) => ({
    id: uuidv4(),
    description: `${c.tool} ${JSON.stringify(c.args)}`.slice(0, 120),
    tool: c.tool,
    args: generalize(c.args),
    riskLevel: c.riskLevel,
    requiresConfirmation: c.riskLevel === 'high',
  }));
}

/** Pure DOM/inspection tools — they never change page state, so they are noise
 *  in a saved workflow and can be dropped without affecting replay. */
const READONLY_TOOLS = new Set([
  'extractPage',
  'readText',
  'getAttribute',
  'getHTML',
  'expect',
  'screenshot',
]);

const argsEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Strip failed and dead-end steps from the executed tool calls so a saved
 * workflow contains only the operations that actually matter, WITHOUT changing
 * the final outcome. Rules (all provably state-preserving):
 *   1. Drop failed calls and read-only inspections.
 *   2. Collapse exact consecutive duplicate actions (e.g. the same click retried).
 *   3. Collapse consecutive navigates (only the final destination matters).
 *   4. injectCSS / setStyle that target the same id/selector are overwritten, so
 *      keep only the last attempt per target.
 *   5. A clearInjectedCSS removes earlier injected styles, so drop both the clear
 *      and the injectCSS attempts it reverted (the classic "tried a theme, broke
 *      it, reset it" loop) — leaving only styling applied after the reset.
 */
function pruneToolCalls(toolCalls: Task['toolCalls']): Task['toolCalls'] {
  const successful = toolCalls.filter((c) => !c.error && !READONLY_TOOLS.has(c.tool));
  const result: Task['toolCalls'] = [];

  const dropInjectCSS = (id: string | null): void => {
    for (let i = result.length - 1; i >= 0; i--) {
      const r = result[i];
      if (r.tool !== 'injectCSS') continue;
      const rid = r.args.id != null ? String(r.args.id) : null;
      if (id === null || rid === id) result.splice(i, 1);
    }
  };

  for (const c of successful) {
    // Rule 5: a reset wipes prior styling — remove what it reverted, and the reset
    // itself is unnecessary on a fresh replay.
    if (c.tool === 'clearInjectedCSS') {
      dropInjectCSS(c.args.id != null ? String(c.args.id) : null);
      continue;
    }

    const prev = result[result.length - 1];

    // Rule 2: identical action repeated back-to-back.
    if (prev && prev.tool === c.tool && argsEqual(prev.args, c.args)) continue;

    // Rule 3: consecutive navigates — keep only the latest target.
    if (prev && prev.tool === 'navigate' && c.tool === 'navigate') {
      result[result.length - 1] = c;
      continue;
    }

    // Rule 4: a re-injected style block with the same id replaces the previous one.
    if (c.tool === 'injectCSS' && c.args.id != null) {
      dropInjectCSS(String(c.args.id));
    }
    // Rule 4: setStyle on the same selector overwrites the earlier one.
    if (c.tool === 'setStyle' && c.args.selector != null) {
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].tool === 'setStyle' && String(result[i].args.selector ?? '') === String(c.args.selector)) {
          result.splice(i, 1);
          break;
        }
      }
    }

    result.push(c);
  }

  return result;
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

/**
 * Verify a step's post-condition after it executed. Deterministic `expect`
 * checks run the browser `expect` tool DIRECTLY (bypassing executeStep so they
 * never pollute history), with a short bounded poll to tolerate lazy-loaded /
 * late-rendering content. `{changed:true}` is checked against the page diff. A
 * natural-language `verify` falls back to ONE light LLM check. No expectation =>
 * treated as a pass. Never throws — an inconclusive check counts as a pass so it
 * can't wedge the loop.
 */
async function verifyStep(
  task: Task,
  step: PlannedStep,
  curCtx: PageContext | undefined,
  prevCtx: PageContext | undefined
): Promise<{ ok: boolean; reason?: string }> {
  const exp = step.expect;
  if (exp) {
    const hasSpecific = !!(exp.selector || exp.text || exp.urlIncludes);
    // Weakest check: only require the page to have moved since the step.
    if (exp.changed && !hasSpecific) {
      if (!prevCtx || !curCtx) return { ok: true };
      const diff = summarizeContextChange(prevCtx, curCtx);
      const noChange = !diff || diff.includes('几乎没有变化') || diff.includes('无明显结构变化');
      return noChange ? { ok: false, reason: '页面几乎没有变化' } : { ok: true };
    }
    if (hasSpecific || (exp.selector && exp.attribute)) {
      return verifyExpectDeterministic(task, exp);
    }
    return { ok: true };
  }
  if (step.verify && curCtx) {
    try {
      const r = await verifyExpectation(step.verify, curCtx);
      return { ok: r.ok, reason: r.reason };
    } catch {
      return { ok: true };
    }
  }
  return { ok: true };
}

/**
 * Run the browser `expect` tool for a deterministic expectation, polling a few
 * times so lazy content has a chance to appear. Handles state:'gone' by treating
 * an expect failure (element absent/hidden) as success.
 */
async function verifyExpectDeterministic(
  task: Task,
  exp: NonNullable<PlannedStep['expect']>
): Promise<{ ok: boolean; reason?: string }> {
  if (!browserToolExecutor) return { ok: true };
  const wantGone =
    exp.state === 'gone' && !!exp.selector && !exp.text && !exp.urlIncludes && !exp.attribute;

  const args: Record<string, unknown> = {};
  if (exp.selector && exp.state !== 'gone') args.selector = exp.selector;
  if (wantGone) args.selector = exp.selector;
  if (exp.text) args.text = exp.text;
  if (exp.urlIncludes) args.urlIncludes = exp.urlIncludes;
  if (exp.selector && exp.attribute) {
    args.selector = exp.selector;
    args.attribute = exp.attribute;
    if (exp.equals !== undefined) args.equals = exp.equals;
  }
  if (Object.keys(args).length === 0) return { ok: true };

  const tries = 3;
  let lastErr: string | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await browserToolExecutor(task.id, 'expect', args, uuidv4(), undefined);
      if (wantGone) {
        if (!res.success) return { ok: true };
        lastErr = `元素仍然可见：${exp.selector}`;
      } else if (res.success) {
        return { ok: true };
      } else {
        lastErr = res.error;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: lastErr };
}

/**
 * Capture a viewport screenshot for the optional vision layer. Runs the browser
 * `screenshot` tool DIRECTLY (bypassing executeStep) so it never pollutes the
 * task history/audit — it's context for the model, not an agent action. Returns
 * a dataURL, or undefined if vision is off or capture fails.
 */
async function captureScreenshotForVision(task: Task): Promise<string | undefined> {
  if (!isVisionEnabled() || !browserToolExecutor) return undefined;
  try {
    const res = await browserToolExecutor(task.id, 'screenshot', {}, uuidv4(), undefined);
    const dataUrl = (res.result as { dataUrl?: string } | undefined)?.dataUrl;
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:') ? dataUrl : undefined;
  } catch {
    return undefined;
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

  let maxSteps = task.maxSteps ?? getDefaultMaxSteps();
  const conversationContext = buildConversationContext(task.sessionId, taskId);
  let pageContext = task.checkpoint?.pageContext;
  let consecutiveFailures = 0;
  let decisionFailures = 0;
  const actionCounts = new Map<string, number>();
  const thoughtCounts = new Map<string, number>();
  const urlVisits = new Map<string, number>();
  let lastUrl: string | undefined = pageContext?.url;
  let correction: string | undefined;
  let correctionTtl = 0;
  let redundantReads = 0;
  let replanned = false;
  let offlineHits = 0;
  // How many times a self-reviewed "done" was bounced back for being empty/
  // irrelevant. Bounded so a genuinely-impossible task still terminates.
  let doneReviewRetries = 0;
  // The page snapshot used for the PREVIOUS decision, so each step can tell the
  // model exactly what its last action changed (or that nothing changed).
  let prevDecisionContext: PageContext | undefined;
  // Optimistic batch queue: actions returned by one decideNextBatch call are
  // executed consecutively (verified locally) WITHOUT re-invoking the LLM. Only
  // a failed/unexpected step clears the queue and forces a fresh decision.
  // Rehydrated from the task so it survives pause/resume (e.g. a confirmation).
  let batchQueue: PlannedStep[] = task.pendingBatch ? [...task.pendingBatch] : [];
  // Navigation and any success reset consecutiveFailures, which can mask a task
  // that flails for dozens of steps across many URLs. These cumulative tallies
  // are NEVER reset, so we can escalate (and ultimately ask the user) early.
  let totalFailures = 0;
  const errorCounts = new Map<string, number>();
  // No-progress ("stuck") tracking: the page/collected state stops changing even
  // though the model keeps trying different tools/selectors for the same goal.
  let noProgressSteps = 0;
  let lastProgressDigest: string | undefined;

  // Rehydrate the anti-flail counters if we're resuming (e.g. after a high-risk
  // confirmation). Without this, every resume re-enters with zeroed guards, so a
  // task that periodically pauses for confirmation can never trip the give-up /
  // ask-the-user safety nets. Cumulative tallies (totalFailures/errorCounts) are
  // intentionally carried over; navigation still resets the per-turn counters.
  const g0 = task.guardState;
  if (g0) {
    totalFailures = g0.totalFailures ?? 0;
    consecutiveFailures = g0.consecutiveFailures ?? 0;
    redundantReads = g0.redundantReads ?? 0;
    replanned = g0.replanned ?? false;
    noProgressSteps = g0.noProgressSteps ?? 0;
    lastProgressDigest = g0.lastProgressDigest;
    for (const [k, v] of Object.entries(g0.errorCounts ?? {})) errorCounts.set(k, v);
    for (const [k, v] of Object.entries(g0.actionCounts ?? {})) actionCounts.set(k, v);
    for (const [k, v] of Object.entries(g0.thoughtCounts ?? {})) thoughtCounts.set(k, v);
  }

  const persistGuards = (): void => {
    task = updateTask(taskId, {
      guardState: {
        totalFailures,
        consecutiveFailures,
        errorCounts: Object.fromEntries(errorCounts),
        actionCounts: Object.fromEntries(actionCounts),
        thoughtCounts: Object.fromEntries(thoughtCounts),
        redundantReads,
        replanned,
        noProgressSteps,
        lastProgressDigest,
      },
    });
  };

  // Persist the remaining optimistic batch so a pause/resume (confirmation) or a
  // continued run picks up exactly where it left off instead of re-deciding.
  const persistBatch = (): void => {
    task = updateTask(taskId, { pendingBatch: [...batchQueue] });
  };

  if (activeAgentLoops.has(taskId)) return task;
  activeAgentLoops.add(taskId);
  try {
  while (true) {
    task = getTask(taskId)!;
    if (task.status === 'paused' || task.status === 'cancelled') break;
    if (isTerminalStatus(task.status)) break;
    if (task.status === 'waiting_confirmation') break;
    if (task.currentStepIndex >= maxSteps) {
      // Auto-continue: rather than stopping at the budget, extend it in place so
      // long jobs (e.g. dozens of delegated items) keep their collected progress,
      // history and plan. The hard cap is the runaway backstop.
      const hardCap = getHardStepCap();
      if (isAutoContinueEnabled() && task.kind !== 'loop' && maxSteps < hardCap) {
        maxSteps = Math.min(hardCap, maxSteps + getDefaultMaxSteps());
        task = updateTask(taskId, { maxSteps });
        addLog(
          taskId,
          'info',
          `⏭️ 自动续跑：已执行 ${task.currentStepIndex} 步，步数上限提升至 ${maxSteps}（硬上限 ${hardCap}）`
        );
        emit(taskId);
      } else {
        break;
      }
    }

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

    // Pick up any user instructions sent while the agent was running and feed
    // them in as a high-priority correction (Cursor-style steering).
    const steers = pendingSteers.get(taskId);
    if (steers?.length) {
      pendingSteers.delete(taskId);
      const note = steers.join('；');
      correction = `用户追加指令（请优先据此调整）：${note}`;
      correctionTtl = 3;
      addLog(taskId, 'info', `🧭 已纳入追加指令：${note.slice(0, 80)}`);
      emit(taskId);
    }

    // A navigation happened (the page URL changed): that IS progress, so reset the
    // stuck/failure detectors. Otherwise a multi-page task that calls extractPage once
    // per page would falsely trip the "repeated action" guard.
    if (pageContext.url && pageContext.url !== lastUrl) {
      if (lastUrl !== undefined) {
        const visits = (urlVisits.get(pageContext.url) ?? 0) + 1;
        urlVisits.set(pageContext.url, visits);
        if (visits >= 3) {
          // We keep bouncing back to the same URL (click → navigate → click …).
          // A changing URL would normally reset the stuck detector, masking the
          // oscillation. Instead, keep the counters and steer the model to break
          // the cycle (e.g. use a text selector or ask the user).
          correction =
            `检测到你在页面之间反复横跳（已第 ${visits} 次回到 ${pageContext.url}）却没有进展。` +
            `不要再重复点击同一个链接/导航。如果目标元素就在当前页面，请用文本选择器精确定位` +
            `（例如 text=<标签文字> 或 tag:has-text('<标签文字>')，也可用页面上下文里的 el-N id）。` +
            `若确实找不到，请用 needsInput 向用户澄清，而不是继续盲目点击。`;
          correctionTtl = 3;
          addLog(taskId, 'warn', `🔁 检测到页面反复横跳（${pageContext.url} ×${visits}），已提示换策略`);
          emit(taskId);
        } else {
          actionCounts.clear();
          thoughtCounts.clear();
          consecutiveFailures = 0;
          correction = undefined;
          correctionTtl = 0;
          addLog(taskId, 'info', `📄 页面已跳转，继续执行：${pageContext.url}`);
          emit(taskId);
        }
      }
      lastUrl = pageContext.url;
    }

    // No-progress ("stuck") detector. The per-action / per-thought guards below
    // only catch VERBATIM repeats; a model that keeps trying different tools and
    // selectors for the same unmet goal slips past them while the page stays
    // frozen. Track a coarse state fingerprint (url + element count + collected
    // items); if it doesn't move for several steps, replan once, then give up
    // honestly — regardless of how varied the individual actions look.
    const collectedCount = getTask(taskId)?.collected?.length ?? 0;
    // Include a coarse rendered-content signal (text length) so that scrolling a
    // lazy/virtualized feed — which renders new rows without changing the URL or
    // (capped) element count — still counts as progress and doesn't trip the
    // stuck detector. Bucketed to avoid churn from tiny/among-step jitter.
    const textBucket = Math.floor((pageContext.visibleText?.length ?? 0) / 200);
    const progressDigest = `${pageContext.url}|${pageContext.interactiveElements?.length ?? 0}|${collectedCount}|${textBucket}`;
    if (progressDigest === lastProgressDigest) {
      noProgressSteps++;
    } else {
      noProgressSteps = 0;
      lastProgressDigest = progressDigest;
    }
    if (noProgressSteps >= NO_PROGRESS_SOFT && !replanned) {
      replanned = true;
      addLog(taskId, 'warn', `🧭 连续 ${noProgressSteps} 步页面无变化，重新规划并建议跳过受阻子目标`);
      await replanInPlace(taskId, pageContext, '多步无页面进展');
      actionCounts.clear();
      thoughtCounts.clear();
      noProgressSteps = 0;
      correction = STUCK_SKIP_CORRECTION;
      correctionTtl = 3;
      persistGuards();
      emit(taskId);
      continue;
    }
    if (noProgressSteps >= NO_PROGRESS_HARD) {
      task = updateTask(taskId, {
        status: 'completed',
        outcome: 'gave_up',
        result: await finalizeWithReview(
          taskId,
          '⚠️ 多步尝试后页面始终没有变化，判断当前目标在此页面无法继续（可能内容为空或位于无法读取的区域），已停止。'
        ),
        recordedSteps: recordWorkflowDraft(task),
      });
      addLog(taskId, 'warn', `🛑 连续 ${noProgressSteps} 步无进展，诚实停止（部分完成）`);
      persistGuards();
      emit(taskId);
      break;
    }

    // Tell the model what the previous action actually changed on the page
    // (lazy-loaded blocks, a new dialog/toast, or nothing at all — a strong cue
    // the last action missed its target).
    const changeSummary = summarizeContextChange(prevDecisionContext, pageContext);
    prevDecisionContext = pageContext;

    // Only call the LLM when the optimistic batch queue is empty. Steps that pass
    // their local verification auto-advance from the queue with NO new decision.
    if (batchQueue.length === 0) {
      let batch;
      try {
        const screenshot = await captureScreenshotForVision(task);
        batch = await decideNextBatch(task.userRequest, pageContext, buildHistory(task), task.plan, conversationContext, correction, progressBlock(task), screenshot, task.attachments, changeSummary);
        decisionFailures = 0;
        // Keep a correction in effect for a couple of turns so the model actually
        // changes course, instead of clearing it after a single decision.
        if (correctionTtl > 0) {
          correctionTtl--;
          if (correctionTtl === 0) correction = undefined;
        } else {
          correction = undefined;
        }
      } catch (err) {
        // A single LLM hiccup (timeout / rate limit) must NOT kill a long task.
        // Retry a few times before giving up.
        decisionFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        const transient = isTransientLLMError(msg);
        const limit = transient ? MAX_TRANSIENT_DECISION_FAILURES : MAX_DECISION_FAILURES;
        addLog(taskId, 'warn', `决策失败(${decisionFailures}/${limit})：${msg}`);
        emit(taskId);
        if (decisionFailures >= limit) {
          if (transient) {
            // Backend outage — pause instead of terminally failing so the
            // collected progress survives and the task can resume when the LLM
            // service recovers.
            persistGuards();
            task = updateTask(taskId, {
              status: 'paused',
              assistantMessage: `LLM 服务暂时不可用，已暂停并保留进度，服务恢复后可继续。（${msg}）`,
            });
            addLog(taskId, 'warn', '⏸ LLM 服务暂时不可用，已暂停任务（进度已保留，稍后可继续）');
          } else {
            task = updateTask(taskId, {
              status: 'failed',
              outcome: 'failed',
              error: `决策连续失败：${msg}`,
            });
          }
          emit(taskId);
          break;
        }
        // Exponential-ish backoff for transient errors so we don't hammer a
        // struggling backend; a quick fixed wait for one-off bad outputs.
        const backoff = transient ? Math.min(1500 * decisionFailures, 8000) : 1500;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      if (batch.thought) {
        addLog(taskId, 'info', `🤔 ${batch.thought}`);
        emit(taskId);
      }

      // The agent can ask the user for missing info instead of guessing blindly.
      if (batch.needsInput) {
        const q = batch.question?.trim() || '我需要更多信息才能继续，能补充一下吗？';
        task = updateTask(taskId, {
          status: 'needs_input',
          intent: 'clarify',
          clarifyQuestion: q,
          assistantMessage: q,
        });
        addLog(taskId, 'info', '需要你补充信息');
        emit(taskId);
        break;
      }

      if (batch.done) {
        // Final verification: re-observe so the recorded result reflects the true end state.
        const finalCtx = await observePage(task);
        if (finalCtx) pageContext = finalCtx;
        const finalResult = await finalizeResult(taskId, batch.summary);

        // Self-review: never declare success on empty/irrelevant boilerplate. If
        // the result doesn't actually answer the goal, bounce back into the loop
        // (bounded) with a correction so the agent keeps gathering the real data.
        const MAX_DONE_REVIEW_RETRIES = 2;
        let review: { ok: boolean; reason?: string; missing?: string } | undefined;
        try {
          review = await reviewResult(task.userRequest, finalResult);
        } catch {
          review = { ok: true }; // reviewer failed → don't block completion
        }
        if (!review.ok && doneReviewRetries < MAX_DONE_REVIEW_RETRIES) {
          doneReviewRetries++;
          batchQueue = [];
          persistBatch();
          correction =
            `你判定任务完成，但结果审查未通过：${review.reason ?? '结果与目标不符或为空'}。` +
            `${review.missing ? `还缺少：${review.missing}。` : ''}` +
            `请不要用页面导航/页脚等无关文字充当结果——继续操作以获取目标真正要求的数据，只有拿到实质内容后再判定 done。`;
          correctionTtl = 2;
          addLog(taskId, 'warn', `🔍 结果审查未通过，继续推进：${review.reason ?? ''}`);
          emit(taskId);
          continue;
        }

        const reviewFailed = review && !review.ok;
        task = updateTask(taskId, {
          status: 'completed',
          outcome: reviewFailed ? 'gave_up' : 'success',
          result: reviewFailed
            ? `${finalResult}\n\n⚠️ 结果审查提示：${review?.reason ?? '未能获取目标所需的实质内容'}。以上为已获取的部分信息，可能未完成目标。`
            : finalResult,
          recordedSteps: recordWorkflowDraft(task),
        });
        addLog(taskId, 'info', reviewFailed ? 'Agent 判定完成但审查未通过（部分完成）' : 'Agent 判定任务完成');
        emit(taskId);
        break;
      }

      if (!batch.steps.length) {
        consecutiveFailures++;
        addLog(taskId, 'warn', 'LLM 未给出有效动作');
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          task = updateTask(taskId, { status: 'failed', error: 'Agent 连续多次未产出有效动作' });
          break;
        }
        continue;
      }

      batchQueue = batch.steps.slice();
      if (batchQueue.length > 1) {
        addLog(taskId, 'info', `🧠 规划出 ${batchQueue.length} 步可连续执行的动作，将逐步执行并本地校验`);
        emit(taskId);
      }
      persistBatch();
    }

    // Dequeue the next optimistic step. Its thought/expectation drive local
    // verification after execution.
    const planned = batchQueue.shift()!;
    persistBatch();
    const stepThought = planned.thought ?? '';
    if (stepThought) {
      addLog(taskId, 'info', `🤔 ${stepThought}`);
      emit(taskId);
    }
    const action = { tool: planned.tool, args: planned.args ?? {} };

    // The page is re-observed for the model every iteration, so calling
    // extractPage as an action is redundant. Skip it and nudge the model to act
    // on the content it already has instead of looping on reads.
    if (action.tool === 'extractPage' || action.tool === 'observePage') {
      redundantReads++;
      correction =
        '你不需要调用 extractPage——每一步我都会把最新页面快照提供给你。若目标是阅读/分析页面内容（如审查 diff、总结日志、抽取数据），而快照被截断看不全，请用 readText（可传 selector 只读某个区域，返回完整正文）或 getHTML 获取完整内容，而不是 extractPage；一旦已读到所需内容，请直接 done 并在 summary 中给出分析结论，不要反复重读同一处。否则请直接基于"当前页面/可交互元素"选择一个能推进目标的动作（点击链接、navigate、delegate 子任务）。';
      correctionTtl = 2;
      addLog(taskId, 'info', '🛠️ 已跳过冗余的页面读取，提示模型直接行动');
      emit(taskId);
      if (redundantReads >= 3) {
        if (!replanned) {
          replanned = true;
          await replanInPlace(taskId, pageContext, '反复尝试读取页面但未推进');
          actionCounts.clear();
          thoughtCounts.clear();
          redundantReads = 0;
          continue;
        }
        task = updateTask(taskId, {
          status: 'completed',
          outcome: 'gave_up',
          result: (await finalizeResult(taskId)) + '\n\n⚠️ 多次尝试读取页面但未能继续推进，已停止。',
          recordedSteps: recordWorkflowDraft(task),
        });
        emit(taskId);
        break;
      }
      continue;
    }
    redundantReads = 0;

    // Sub-agent delegation: run an ISOLATED bounded nested agent loop for ONE
    // focused sub-goal, store the result in the durable ledger (deduped by key),
    // and surface progress back to the parent.
    if (action.tool === 'delegate') {
      const dargs = action.args as Record<string, unknown>;
      const subGoal = String(dargs?.goal ?? '').trim();
      const subUrl = String(dargs?.url ?? '').trim();
      const subTitle = String(dargs?.title ?? '').trim() || undefined;
      const key = subUrl || subTitle || subGoal;
      if (!subGoal && !subUrl) {
        correction = 'delegate 需要提供 goal（子目标），并建议提供 url（目标页面）。';
        continue;
      }
      if (key && (task.collected ?? []).some((c) => c.key === key)) {
        correction = `『${subTitle ?? key}』已采集，请处理尚未采集的下一项；若全部完成请用 done 结束（系统会自动汇总）。`;
        addLog(taskId, 'info', `↩️ 跳过重复委派：${subTitle ?? key}`);
        emit(taskId);
        continue;
      }
      const subMax = Number(dargs?.maxSteps) || 12;
      addLog(taskId, 'info', `🧩 委派子任务：${subTitle ?? subGoal}${subUrl ? `（${subUrl}）` : ''}`);
      emit(taskId);
      const sub = await runSubAgent(taskId, subGoal || `打开并总结 ${subUrl}`, subMax, subUrl, subTitle);

      if (sub.offline) {
        offlineHits++;
        recordSyntheticCall(taskId, 'delegate', { goal: subGoal, url: subUrl }, sub.content, sub.content);
        addLog(taskId, 'warn', `🌐 子任务因离线失败：${sub.content.slice(0, 100)}`);
        if (offlineHits >= 2) {
          task = updateTask(taskId, {
            status: 'paused',
            error: '检测到网络离线，已暂停。恢复网络后点击「继续」即可。',
          });
          addLog(taskId, 'warn', '🌐 多次检测到离线，已暂停任务');
          emit(taskId);
          break;
        }
      } else {
        offlineHits = 0;
        collectItem(taskId, key, sub.title ?? subTitle, sub.content);
        recordSyntheticCall(taskId, 'delegate', { goal: subGoal, url: subUrl }, sub.content);
        addLog(taskId, 'info', `🧩 已采集「${sub.title ?? subTitle ?? key}」：${sub.content.slice(0, 120)}`);
      }

      const refreshed = await observePage(getTask(taskId)!);
      if (refreshed) {
        pageContext = refreshed;
        lastUrl = refreshed.url;
      }
      actionCounts.clear();
      consecutiveFailures = 0;
      task = updateTask(taskId, { currentStepIndex: getTask(taskId)!.currentStepIndex + 1 });
      emit(taskId);
      continue;
    }

    // Detect "stuck" both by identical action signature AND by a repeated
    // thought (the model rephrasing the same intent with a slightly different
    // selector slips past an args-only check).
    const sig = `${action.tool}:${JSON.stringify(action.args)}`;
    const sigSeen = (actionCounts.get(sig) ?? 0) + 1;
    actionCounts.set(sig, sigSeen);
    const thoughtKey = (stepThought || '').trim().toLowerCase();
    let thoughtSeen = 0;
    if (thoughtKey) {
      thoughtSeen = (thoughtCounts.get(thoughtKey) ?? 0) + 1;
      thoughtCounts.set(thoughtKey, thoughtSeen);
    }
    const seen = Math.max(sigSeen, thoughtSeen);
    if (seen === 2) {
      // Second identical attempt — warn the model before it digs in further.
      correction = `你刚才已经执行过相同动作（${action.tool}），但没有带来进展。请改用不同的选择器/链接/工具来达成目标；若信息已足够就用 done 结束；若缺少必要信息就用 needsInput 反问用户。`;
      correctionTtl = 2;
    }
    if (seen >= 3) {
      if (!replanned) {
        replanned = true;
        addLog(taskId, 'warn', '🔁 重复动作未见进展，根据当前页面重新规划');
        await replanInPlace(taskId, pageContext, `重复动作 ${action.tool} 未推进`);
        actionCounts.clear();
        thoughtCounts.clear();
        correction =
          '已根据当前页面生成新计划，请选择与之前不同的下一步，避免重复无效动作。' +
          '如果你一直在用 evaluate/getHTML 想从列表页提取某个字段却拿不到（说明该字段在每条记录的详情页里），' +
          '请改用爬取策略：收集每行的详情链接，然后对每个 url 用 delegate 打开详情页提取字段（结果会自动汇总），不要再在列表页重复 evaluate。' +
          '若目标确实无法达成，再用 needsInput 反问用户。';
        correctionTtl = 3;
        emit(taskId);
        continue;
      }
      // Graceful stop — honestly mark this as "gave up", not a success.
      task = updateTask(taskId, {
        status: 'completed',
        outcome: 'gave_up',
        result: await finalizeWithReview(taskId, '⚠️ 多次尝试后仍无法继续推进，已停止。'),
        recordedSteps: recordWorkflowDraft(task),
      });
      addLog(taskId, 'warn', `检测到重复动作，已停止: ${sig.slice(0, 120)}`);
      emit(taskId);
      break;
    }

    const confirmation = requiresConfirmation(action.tool, action.args, stepThought);
    const confirmPolicy = task.confirmPolicy ?? 'ask';
    if (confirmation.required && confirmPolicy === 'reject') {
      // Default = auto-reject: deny without asking, record it as a failed action
      // so the agent avoids re-proposing it, and steer toward a low-risk path.
      addLog(taskId, 'warn', `已按默认设置自动拒绝高风险操作: ${action.tool}`);
      task = updateTask(taskId, {
        toolCalls: [
          ...task.toolCalls,
          {
            id: uuidv4(),
            taskId,
            tool: action.tool,
            args: action.args,
            error: '高风险操作已按默认设置自动拒绝',
            startedAt: Date.now(),
            completedAt: Date.now(),
            riskLevel: 'high',
            confirmed: false,
          },
        ],
      });
      correction =
        `该操作（${action.tool}）被判定为高风险，已按你的默认设置自动拒绝。请改用不修改数据/不提交的低风险方式达成目标，` +
        `或跳过这一步；若整体目标必须执行该高风险操作，请用 needsInput 向用户说明并请求改设置。`;
      correctionTtl = 2;
      task = updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
      persistGuards();
      emit(taskId);
      continue;
    }
    if (confirmation.required && confirmPolicy !== 'auto') {
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
      // Persist counters BEFORE pausing: confirming re-enters runAgentLoop, which
      // must resume with these guards intact (not reset to zero).
      persistGuards();
      emit(taskId);
      break;
    }

    addLog(taskId, 'info', `执行: ${action.tool}`);
    emit(taskId);
    // Snapshot BEFORE execution so a step whose expectation is only {changed:true}
    // can be verified against the page diff.
    const ctxBeforeExec = pageContext;
    const result = await executeStep(
      task,
      makeSyntheticStep(action.tool, action.args, stepThought || action.tool)
    );

    if (result.pageContext) {
      pageContext = result.pageContext;
      setPageContext(taskId, pageContext);
    }

    if (!result.success) {
      // A failed step invalidates the rest of the optimistic batch (later steps
      // assumed this one succeeded). Drop the queue so the next iteration
      // re-decides against the real current page.
      if (batchQueue.length) {
        batchQueue = [];
        persistBatch();
      }
      // A "no-op" click (resolved but produced no page change) is a soft signal:
      // count it toward the cumulative/recurring-error budget (→ correction, then
      // ask the user) but NOT toward the abrupt consecutive-failure hard-fail, so a
      // single slow SPA update doesn't kill an otherwise healthy run.
      const isNoOp = !!(result.result as { noOp?: boolean } | undefined)?.noOp;
      if (!isNoOp) consecutiveFailures++;
      totalFailures++;
      addLog(taskId, 'error', `步骤失败: ${result.error}`);

      // Track failures cumulatively and by recurring error (selector text is
      // normalized out so "Element not found for '…'" variants collapse to one).
      const errKey = String(result.error ?? '')
        .replace(/["'][^"']*["']/g, '…')
        .slice(0, 60);
      const errSeen = (errorCounts.get(errKey) ?? 0) + 1;
      errorCounts.set(errKey, errSeen);

      const FAIL_SOFT = 4;
      const FAIL_HARD = 8;
      if (totalFailures >= FAIL_HARD || errSeen >= 4) {
        // Stop flailing: ask the user instead of burning the whole step budget.
        const q =
          '我多次尝试都没能完成这一步——反复找不到目标元素或页面来回跳转，目标很可能在当前页面无法达成' +
          '（比如该功能/按钮根本不存在）。能否确认目标是否正确，或告诉我更具体的元素名称/位置？';
        task = updateTask(taskId, {
          status: 'needs_input',
          intent: 'clarify',
          clarifyQuestion: q,
          assistantMessage: q,
        });
        addLog(taskId, 'warn', `⚠️ 累计失败 ${totalFailures} 次（同类错误「${errKey}」×${errSeen}），停止并请用户澄清`);
        emit(taskId);
        break;
      }
      if (totalFailures === FAIL_SOFT || errSeen === 3) {
        correction =
          `你已经失败了 ${totalFailures} 次都没有推进（最近的错误：${errKey}）。不要再用相似的选择器盲目点击或反复导航。` +
          `请基于「当前页面/可交互元素」里真实存在的 el-N 元素挑一个明显不同的动作；` +
          `如果目标元素根本不在页面上（功能可能不可用），请立刻用 needsInput 向用户澄清，不要继续试错。`;
        correctionTtl = 3;
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        task = updateTask(taskId, { status: 'failed', error: result.error });
        emit(taskId);
        break;
      }
    } else {
      consecutiveFailures = 0;
      // Optimistic verification: confirm the step actually did what the batch
      // expected. A mismatch discards the rest of the batch and forces a fresh
      // decision at this "stuck point" (with full history + current page). A
      // failed expectation is NOT a task failure — it costs at most one extra
      // decision, so an over-strict expectation can't abort the run.
      if (planned.expect || planned.verify) {
        const verdict = await verifyStep(task, planned, pageContext, ctxBeforeExec);
        if (!verdict.ok) {
          const dropped = batchQueue.length;
          if (dropped) {
            batchQueue = [];
            persistBatch();
          }
          correction =
            `上一步（${planned.tool}）执行后未达到预期${verdict.reason ? `（${verdict.reason}）` : ''}。` +
            `请根据当前页面重新判断下一步，不要假设后续步骤仍然成立。`;
          correctionTtl = 2;
          addLog(
            taskId,
            'info',
            `🔎 预期校验未通过，放弃剩余 ${dropped} 步并重新决策${verdict.reason ? `：${verdict.reason}` : ''}`.slice(0, 160)
          );
          emit(taskId);
        }
      }
    }

    task = updateTask(taskId, { currentStepIndex: task.currentStepIndex + 1 });
    persistGuards();
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
      const hardCap = getHardStepCap();
      const hitHardCap = maxSteps >= hardCap;
      task = updateTask(taskId, {
        status: 'completed',
        outcome: 'partial',
        result:
          `${await finalizeResult(taskId)}\n\n⚠️ 已执行 ${task.currentStepIndex} 步` +
          (hitHardCap
            ? `，达到硬步数上限（${hardCap}）后停止，任务可能尚未完全完成。点击「继续推进」可在同一任务上接着跑（保留已采集进度），或调大 AGENT_MAX_STEPS_HARD。`
            : `后停止。点击「继续推进」可在同一任务上接着跑。`),
        recordedSteps: recordWorkflowDraft(task),
      });
      addLog(taskId, 'warn', `已达步数上限 ${maxSteps}（硬上限 ${hardCap}），停止执行`);
    }
  }

  emit(taskId);
  return task;
  } finally {
    activeAgentLoops.delete(taskId);
    pendingSteers.delete(taskId);
  }
}

async function executeStep(
  task: Task,
  step: PlanStep,
  tabIdOverride?: number
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
      result = await browserToolExecutor(task.id, step.tool, step.args, callId, tabIdOverride);
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

async function replanInPlace(
  taskId: string,
  pageContext: PageContext | undefined,
  reason: string
): Promise<void> {
  try {
    const t = getTask(taskId);
    if (!t) return;
    const conversationContext = buildConversationContext(t.sessionId, taskId);
    const plan = await createPlan(t.userRequest, pageContext, conversationContext);
    updateTask(taskId, { plan });
    addLog(taskId, 'info', `🔁 已根据当前页面重新规划（${reason}），新计划 ${plan.steps.length} 步`);
  } catch (err) {
    addLog(taskId, 'warn', `重新规划失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function recordSyntheticCall(
  taskId: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  error?: string
): void {
  const t = getTask(taskId);
  if (!t) return;
  const record: ToolCallRecord = {
    id: uuidv4(),
    taskId,
    stepId: uuidv4(),
    tool,
    args,
    startedAt: Date.now(),
    completedAt: Date.now(),
    riskLevel: 'low',
    confirmed: true,
    result,
    error,
  };
  updateTask(taskId, { toolCalls: [...t.toolCalls, record] });
}

interface SubAgentResult {
  ok: boolean;
  offline?: boolean;
  title?: string;
  content: string;
}

/**
 * Run an ISOLATED bounded nested agent loop for a single sub-goal.
 *
 *  - Its own fresh history (does NOT see the parent's tool-calls), so it can't
 *    hallucinate "already done" from unrelated items.
 *  - Navigates directly to `url` first (index-based clicks are unreliable).
 *  - Fast-fails on offline/error pages instead of burning steps on retries.
 */
async function runSubAgent(
  taskId: string,
  goal: string,
  maxSteps: number,
  url?: string,
  title?: string
): Promise<SubAgentResult> {
  const base = getTask(taskId);
  if (!base) return { ok: false, content: '子任务无法启动（任务不存在）' };

  const subHistory: AgentHistoryItem[] = [];
  let pageContext: PageContext | undefined;
  let steps = 0;
  let consecutiveFailures = 0;
  let lastText = '';
  const actionCounts = new Map<string, number>();
  let correction: string | undefined;

  // When a URL is given, run the sub-task in its OWN background tab so the main
  // task page stays put and keeps focus; the sub tab is closed when we're done.
  let subTabId: number | undefined;
  try {
  if (url) {
    const opened = await executeStep(
      base,
      makeSyntheticStep('tab', { action: 'open', url, active: false }, `后台打开 ${url}`)
    );
    subTabId = (opened.result as { tabId?: number } | undefined)?.tabId;
    if (subTabId == null) {
      return { ok: false, title, content: `无法在后台打开 ${url}：${opened.error ?? '未知错误'}` };
    }
    if (opened.pageContext) pageContext = opened.pageContext;
    subHistory.push({ tool: 'navigate', args: { url }, success: opened.success, error: opened.error, result: opened.success ? 'opened' : undefined });
    addLog(taskId, 'info', `🧩↳ 后台新标签打开 ${url}`);
    emit(taskId);
  }
  // No URL → the sub-task operates on the main tab (observe it as before).
  if (!pageContext) pageContext = await observePage(getTask(taskId)!);
  if (!pageContext) return { ok: false, title, content: '子任务无法获取页面内容' };
  if (isOfflinePage(pageContext)) {
    return { ok: false, offline: true, title, content: `无法访问 ${url ?? '页面'}：检测到离线/无网络。` };
  }

  while (steps < maxSteps) {
    const cur = getTask(taskId);
    if (!cur || cur.status === 'cancelled' || cur.status === 'paused') break;

    let decision;
    try {
      decision = await decideNextAction(goal, pageContext, subHistory, undefined, undefined, correction);
    } catch (err) {
      return { ok: false, title, content: `子任务决策失败：${err instanceof Error ? err.message : String(err)}` };
    }
    correction = undefined;
    if (decision.thought) {
      addLog(taskId, 'info', `🧩↳ ${decision.thought}`);
      emit(taskId);
    }
    if (decision.done) {
      return { ok: true, title, content: decision.summary || lastText || '（子任务完成，但未给出摘要）' };
    }

    const action = decision.action;
    if (!action?.tool) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return { ok: false, title, content: lastText || '子任务未产出有效动作' };
      continue;
    }
    if (action.tool === 'extractPage' || action.tool === 'observePage') {
      correction = '页面内容已提供，请直接行动或用 done 结束子任务。';
      continue;
    }
    if (action.tool === 'delegate') {
      correction = '子任务中不要再委派，请直接完成当前子目标。';
      continue;
    }

    const sig = `${action.tool}:${JSON.stringify(action.args)}`;
    const seen = (actionCounts.get(sig) ?? 0) + 1;
    actionCounts.set(sig, seen);
    if (seen >= 3) return { ok: true, title, content: decision.summary || lastText || '（子任务在重复后结束）' };

    const confirmation = requiresConfirmation(action.tool, action.args, decision.thought);
    if (confirmation.required) {
      correction = `子任务中跳过高风险操作（${action.tool}）。请改用低风险方式或结束子任务。`;
      continue;
    }

    addLog(taskId, 'info', `🧩↳ 执行: ${action.tool}`);
    emit(taskId);
    const result = await executeStep(
      getTask(taskId)!,
      makeSyntheticStep(action.tool, action.args, decision.thought || action.tool),
      subTabId
    );
    if (result.pageContext) {
      pageContext = result.pageContext;
      // Don't overwrite the MAIN task's page context with sub-tab content.
      if (subTabId == null) setPageContext(taskId, pageContext);
    }
    if (pageContext && isOfflinePage(pageContext)) {
      return { ok: false, offline: true, title, content: `无法访问 ${url ?? '页面'}：检测到离线/无网络。` };
    }
    if (action.tool === 'readText' && result.success && result.result && typeof result.result === 'object') {
      const txt = (result.result as { text?: string }).text;
      if (txt) lastText = txt.slice(0, 2000);
    }
    subHistory.push({
      tool: action.tool,
      args: compactArgs(action.args),
      success: result.success,
      error: result.error,
      result: result.success ? summarizeToolResult(action.tool, result.result, true) : undefined,
    });
    if (!result.success) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return { ok: false, title, content: lastText || `子任务多次失败：${result.error}` };
    } else {
      consecutiveFailures = 0;
    }
    steps++;
  }
  return { ok: true, title, content: lastText || '（子任务步数用尽，未能产出完整摘要）' };
  } finally {
    if (subTabId != null) {
      // Sub-task finished (success, failure, or step budget) → close its
      // background tab. Focus never left the main task page.
      await executeStep(base, makeSyntheticStep('tab', { action: 'close', tabId: subTabId }, '关闭子任务标签')).catch(
        () => undefined
      );
      addLog(taskId, 'info', '🧩↳ 已关闭子任务标签');
      emit(taskId);
    }
  }
}

const OFFLINE_MARKERS = [
  '没有网络', '无网络', '网络不可用', '网络连接已断开', '无法连接到网络', '无法访问此网站',
  '此网站无法访问', '断开网络连接', 'offline', 'no internet', 'err_internet', 'err_connection',
  'err_name_not_resolved',
];

function isOfflinePage(ctx: PageContext): boolean {
  const text = `${ctx.title ?? ''} ${(ctx.visibleText ?? '').slice(0, 300)}`.toLowerCase();
  return OFFLINE_MARKERS.some((m) => text.includes(m));
}

function collectItem(taskId: string, key: string, title: string | undefined, content: string): void {
  const t = getTask(taskId);
  if (!t) return;
  const collected: CollectedItem[] = [...(t.collected ?? [])];
  const item: CollectedItem = { key: key || `item-${collected.length + 1}`, title, content, at: Date.now() };
  const idx = collected.findIndex((c) => c.key === item.key);
  if (idx >= 0) collected[idx] = item;
  else collected.push(item);
  updateTask(taskId, { collected });
}

function progressBlock(task: Task): string {
  const items = task.collected ?? [];
  if (!items.length) return '';
  return items.map((it, i) => `${i + 1}. ${it.title ?? it.key}`).join('\n');
}

async function finalizeResult(taskId: string, summary?: string): Promise<string> {
  const t = getTask(taskId);
  if (!t) return summary ?? '';
  const items = t.collected ?? [];
  if (items.length > 0) {
    addLog(taskId, 'info', `🧮 正在汇总 ${items.length} 项采集结果…`);
    emit(taskId);
    try {
      const synth = await generateSummaryWithLLM(
        t.userRequest,
        items.map((i) => ({ title: i.title, content: i.content }))
      );
      return `${synth}\n\n——（已汇总 ${items.length} 项）`;
    } catch (err) {
      addLog(taskId, 'warn', `汇总失败，改用拼接：${err instanceof Error ? err.message : String(err)}`);
      return items.map((it, i) => `${i + 1}. ${it.title ?? it.key}\n${it.content}`).join('\n\n');
    }
  }
  return summary ?? summarizeResult(t);
}

/**
 * Build a give-up result that has been self-reviewed. If the assembled text does
 * not actually answer the goal AND nothing task-relevant was collected, we return
 * an honest "found nothing" line instead of dumping page chrome/footer as a fake
 * "partial result". Site-agnostic.
 */
async function finalizeWithReview(taskId: string, note: string): Promise<string> {
  const t = getTask(taskId);
  const base = await finalizeResult(taskId);
  const collected = (t?.collected ?? []).length;
  try {
    const rv = await reviewResult(t?.userRequest ?? '', base);
    if (!rv.ok && collected === 0) {
      addLog(taskId, 'warn', `🔍 结果审查未通过：${rv.reason ?? '结果与目标无关'}`);
      return `未能获取到与目标相关的有效结果${rv.reason ? `（${rv.reason}）` : ''}。\n\n${note}`;
    }
  } catch {
    /* reviewer failed → fall through to the assembled result */
  }
  return `${base}\n\n${note}`;
}

function summarizeResult(task: Task): string {
  const okCalls = task.toolCalls.filter((c) => !c.error);
  const usedTools = Array.from(new Set(okCalls.map((c) => c.tool)));
  // Neutral wording: the caller decides success/partial/gave-up framing via
  // task.outcome, so this must NOT unconditionally claim "已完成".
  const parts = [
    `本次共执行 ${okCalls.length} 个操作${usedTools.length ? `（${usedTools.join('、')}）` : ''}`,
  ];

  const lastRead = [...task.toolCalls].reverse().find((c) => c.tool === 'readText' && c.result);
  if (lastRead?.result) {
    const text = (lastRead.result as { text?: string }).text;
    if (text) parts.push(`读取内容：${text.slice(0, 400)}…`);
  }

  return parts.join('\n');
}

export async function confirmPendingAction(
  taskId: string,
  confirmed: boolean,
  dontAskAgain = false
): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'waiting_confirmation') {
    throw new Error('Task is not waiting for confirmation');
  }

  const pending = task.pendingConfirmation;

  // "Confirm & don't ask again": stop gating high-risk actions for the rest of
  // THIS task. Persist it up-front so the resumed loop below sees the flag.
  if (confirmed && dontAskAgain) {
    task = updateTask(taskId, { confirmPolicy: 'auto' });
    addLog(taskId, 'info', '已开启本任务「不再询问」，后续高风险操作将自动执行');
  }

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

  // Resolve params (auto-generating 'generate'-mode values) before substitution.
  const merged = await resolveParamValues(wf.params, params, { goalName: wf.name });

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

/**
 * Continue a stopped agent task IN PLACE — same task id, so the collected
 * ledger, executed history, plan and currentStepIndex all carry over. The step
 * budget is extended by one more round beyond wherever it stopped.
 */
export async function continueTask(taskId: string): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.mode === 'chat') return task;
  if (activeAgentLoops.has(taskId)) return task; // already running

  const base = getDefaultMaxSteps();
  const newMax = Math.max(task.maxSteps ?? base, task.currentStepIndex) + base;
  task = updateTask(taskId, {
    status: 'running',
    outcome: undefined,
    error: undefined,
    maxSteps: newMax,
    // Continuing is a deliberate fresh attempt: reset the anti-flail guards so a
    // task that previously gave up isn't instantly stopped again by stale counts.
    guardState: undefined,
  });
  addLog(
    taskId,
    'info',
    `▶️ 继续执行（同一任务，已执行 ${task.currentStepIndex} 步，步数上限提升至 ${newMax}）`
  );
  emit(taskId);
  return runTask(taskId);
}
