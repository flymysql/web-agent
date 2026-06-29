import type {
  PlanStep,
  Task,
  Workflow,
  WorkflowParam,
  WorkflowStep,
  WorkflowTrigger,
} from '@ai-browser-agent/shared';
import { getTask, createTask, updateTask } from '../tasks/store.js';
import { createWorkflow } from './store.js';

/** Collect {{param}} placeholders referenced inside a set of workflow steps. */
function extractParams(steps: WorkflowStep[]): WorkflowParam[] {
  const keys = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) keys.add(m[1]);
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(scan);
    }
  };
  for (const step of steps) scan(step.args);
  return [...keys].map((key) => ({ key, label: key }));
}

/** Replace {{param}} placeholders inside arbitrary tool args. */
function substituteParams(
  args: Record<string, unknown>,
  params: Record<string, string>
): Record<string, unknown> {
  const replaceString = (value: string): string =>
    value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) =>
      key in params ? params[key] : `{{${key}}}`
    );

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)])
      );
    }
    return value;
  };

  return walk(args) as Record<string, unknown>;
}

function workflowStepToPlanStep(step: WorkflowStep, params: Record<string, string>): PlanStep {
  return {
    id: crypto.randomUUID(),
    description: step.description,
    tool: step.tool,
    args: substituteParams(step.args, params),
    riskLevel: step.riskLevel,
    requiresConfirmation: step.requiresConfirmation,
  };
}

/**
 * Instantiate a workflow into a concrete (already-planned) Task. Steps come
 * straight from the workflow definition with params substituted, so no LLM call
 * is needed for a replay.
 */
export function instantiateWorkflow(
  workflow: Workflow,
  params: Record<string, string>,
  context: { tabId?: number; url?: string }
): Task {
  const mergedParams: Record<string, string> = {};
  for (const p of workflow.params) {
    mergedParams[p.key] = params[p.key] ?? p.default ?? '';
  }

  const scheduled = workflow.triggers.find((t) => t.type === 'scheduled');
  const kind = scheduled ? 'loop' : 'once';

  const task = createTask({
    userRequest: `[工作流] ${workflow.name}`,
    workflowId: workflow.id,
    mode: 'replay',
    tabId: context.tabId,
    url: context.url ?? workflow.startUrl,
    kind,
    loopIntervalMs: scheduled?.intervalMs,
  });

  return updateTask(task.id, {
    status: 'pending',
    plan: {
      goal: workflow.description ?? workflow.name,
      steps: workflow.steps.map((s) => workflowStepToPlanStep(s, mergedParams)),
    },
  });
}

/** Turn a finished/loaded task's plan into a reusable workflow definition. */
export function saveTaskAsWorkflow(
  taskId: string,
  input: { name: string; description?: string; triggers?: WorkflowTrigger[] }
): Workflow {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // Prefer the steps actually executed by the agent (already generalized with
  // {{param}} placeholders); fall back to the upfront plan.
  const source: WorkflowStep[] | undefined =
    task.recordedSteps?.length
      ? task.recordedSteps
      : task.plan?.steps.map((s) => ({
          id: crypto.randomUUID(),
          description: s.description,
          tool: s.tool,
          args: s.args,
          riskLevel: s.riskLevel,
          requiresConfirmation: s.requiresConfirmation,
        }));

  if (!source?.length) throw new Error('Task has no steps to save');

  const steps: WorkflowStep[] = source.map((s) => ({ ...s, id: crypto.randomUUID() }));

  return createWorkflow({
    name: input.name,
    description: input.description ?? task.plan?.goal ?? task.userRequest,
    startUrl: task.url,
    params: extractParams(steps),
    steps,
    triggers: input.triggers ?? [{ type: 'manual' }],
  });
}
