import { v4 as uuidv4 } from 'uuid';
import type { Task, ToolCallRecord, PageContext, PlanStep } from '@ai-browser-agent/shared';
import { isBrowserTool, isBackendTool } from '@ai-browser-agent/shared';
import {
  getTask,
  updateTask,
  addLog,
  saveCheckpoint,
  setPageContext,
} from '../tasks/store.js';
import { assertTransition, isTerminalStatus } from '../tasks/state-machine.js';
import { createPlan, replanFromFailure } from './planner.js';
import {
  requiresConfirmation,
  recordAudit,
  maskArgs,
  assessToolRisk,
} from '../safety/audit.js';
import { executeBackendTool } from '../tools/registry.js';

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

export async function planTask(taskId: string, pageContext?: PageContext): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  assertTransition(task.status, 'planning');
  task = updateTask(taskId, { status: 'planning' });
  addLog(taskId, 'info', 'Planning task...');

  const plan = await createPlan(task.userRequest, pageContext);
  task = updateTask(taskId, { plan, status: 'pending' });
  addLog(taskId, 'info', `Plan created with ${plan.steps.length} steps`);

  return task;
}

export async function runTask(taskId: string): Promise<Task> {
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

      if (task.currentStepIndex < 2) {
        const retrySteps = replanFromFailure(
          task.userRequest,
          task.checkpoint?.pageContext,
          step,
          result.error ?? 'unknown'
        );
        task = updateTask(taskId, {
          plan: {
            ...task.plan!,
            steps: [...task.plan!.steps.slice(0, task.currentStepIndex), ...retrySteps],
          },
        });
        continue;
      }

      task = updateTask(taskId, {
        status: 'failed',
        error: result.error,
      });
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

  updateTask(task.id, {
    toolCalls: [...task.toolCalls, record],
  });

  return { ...result, callId };
}

function summarizeResult(task: Task): string {
  const parts = [`Completed: ${task.userRequest}`];
  parts.push(`Steps executed: ${task.currentStepIndex}/${task.plan?.steps.length ?? 0}`);

  const lastRead = [...task.toolCalls].reverse().find((c) => c.tool === 'readText' && c.result);
  if (lastRead?.result) {
    const text = (lastRead.result as { text?: string }).text;
    if (text) parts.push(`Extracted text: ${text.slice(0, 500)}...`);
  }

  const extracts = task.toolCalls.filter((c) => c.tool === 'extractPage' && !c.error);
  if (extracts.length > 0) {
    parts.push(`Page extractions: ${extracts.length}`);
  }

  return parts.join('\n');
}

export async function confirmPendingAction(taskId: string, confirmed: boolean): Promise<Task> {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'waiting_confirmation') {
    throw new Error('Task is not waiting for confirmation');
  }

  if (!confirmed) {
    recordAudit({
      taskId,
      action: 'confirmation_rejected',
      tool: task.pendingConfirmation?.tool,
      args: task.pendingConfirmation?.args,
      riskLevel: 'high',
      confirmed: false,
    });
    return updateTask(taskId, {
      status: 'paused',
      pendingConfirmation: undefined,
    });
  }

  recordAudit({
    taskId,
    action: 'confirmation_accepted',
    tool: task.pendingConfirmation?.tool,
    args: task.pendingConfirmation?.args,
    riskLevel: 'high',
    confirmed: true,
  });

  const step = task.plan?.steps[task.currentStepIndex];
  if (step) step.requiresConfirmation = false;

  task = updateTask(taskId, {
    status: 'running',
    pendingConfirmation: undefined,
  });

  return runTask(taskId);
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
