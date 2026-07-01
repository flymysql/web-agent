import type {
  PageContext,
  PlanStep,
  Task,
  Workflow,
  WorkflowParam,
  WorkflowStep,
  WorkflowTrigger,
} from '@ai-browser-agent/shared';
import { getTask, createTask, updateTask } from '../tasks/store.js';
import { generateValueWithLLM } from '../llm/provider.js';
import { createWorkflow } from './store.js';

/** Collect {{param}} placeholders referenced inside a set of workflow steps. */
export function extractParams(steps: WorkflowStep[]): WorkflowParam[] {
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
export function substituteParams(
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

/**
 * Resolve the concrete run-time value for every workflow param, honoring its
 * mode: 'prompt' uses the supplied/default value, 'constant' the fixed default,
 * and 'generate' produces a fresh value via the LLM from its instruction. A
 * value explicitly supplied at run time always wins, so an auto-generated field
 * can still be overridden on demand. Site-agnostic.
 */
export async function resolveParamValues(
  params: WorkflowParam[],
  provided: Record<string, string>,
  ctx: { pageContext?: PageContext; goalName?: string } = {}
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const supplied = provided[p.key];
    const hasSupplied = supplied != null && supplied !== '';
    const mode = p.mode ?? 'prompt';
    if (mode === 'generate' && !hasSupplied) {
      const note = ctx.goalName ? `工作流：${ctx.goalName}` : undefined;
      out[p.key] = await generateValueWithLLM(p.instruction ?? p.label ?? p.key, {
        pageContext: ctx.pageContext,
        note,
      });
    } else if (mode === 'constant') {
      out[p.key] = p.default ?? '';
    } else {
      out[p.key] = hasSupplied ? supplied : p.default ?? '';
    }
  }
  return out;
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
  context: { tabId?: number; url?: string; loopIntervalMs?: number }
): Task {
  const mergedParams: Record<string, string> = {};
  for (const p of workflow.params) {
    mergedParams[p.key] = params[p.key] ?? p.default ?? '';
  }

  // A caller-supplied loop interval (chosen at run time) takes precedence over a
  // scheduled trigger baked into the workflow definition.
  const scheduled = workflow.triggers.find((t) => t.type === 'scheduled');
  const loopIntervalMs = context.loopIntervalMs ?? scheduled?.intervalMs;
  const kind = loopIntervalMs ? 'loop' : 'once';

  const task = createTask({
    userRequest: `[工作流] ${workflow.name}`,
    workflowId: workflow.id,
    mode: 'replay',
    tabId: context.tabId,
    url: context.url ?? workflow.startUrl,
    kind,
    loopIntervalMs,
  });

  const steps = workflow.steps.map((s) => workflowStepToPlanStep(s, mergedParams));

  // Replay must start from the workflow's recorded start page so the saved
  // selectors resolve against the right page — otherwise launching the workflow
  // from a different page runs the recorded steps against the wrong DOM. Skip
  // when the workflow already begins by navigating somewhere itself.
  if (workflow.startUrl && steps[0]?.tool !== 'navigate') {
    steps.unshift({
      id: crypto.randomUUID(),
      description: `打开起始页 ${workflow.startUrl}`,
      tool: 'navigate',
      args: { url: workflow.startUrl },
      riskLevel: 'low',
      requiresConfirmation: false,
    });
  }

  return updateTask(task.id, {
    status: 'pending',
    plan: {
      goal: workflow.description ?? workflow.name,
      steps,
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
    // Prefer the stable start page (where the run began) over `task.url`, which
    // by save time has drifted to the LAST page the agent navigated to.
    startUrl: task.startUrl ?? task.url,
    params: extractParams(steps),
    steps,
    triggers: input.triggers ?? [{ type: 'manual' }],
  });
}
