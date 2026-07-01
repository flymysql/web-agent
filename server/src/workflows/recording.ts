import type {
  PageContext,
  PlanStep,
  RecordedAction,
  RecordingNarration,
  Task,
  WorkflowParam,
  WorkflowStep,
} from '@ai-browser-agent/shared';
import { createTask, updateTask } from '../tasks/store.js';
import {
  editRecordingWithLLM,
  generalizeRecordingWithLLM,
  type EditableRecording,
  type UnderstoodRecording,
} from '../llm/provider.js';
import { extractParams, substituteParams } from './service.js';

/**
 * Attach each spoken utterance to the action it most likely refers to: the
 * action with the greatest timestamp <= the utterance's (the user typically
 * narrates just after acting), falling back to the first action. Utterances are
 * concatenated into that action's `note` for the LLM. Site-agnostic.
 */
function attachNarration(
  actions: RecordedAction[],
  narration?: RecordingNarration[]
): RecordedAction[] {
  if (!narration?.length || !actions.length) return actions;
  const notes = new Map<number, string[]>();
  const sorted = [...narration].sort((a, b) => a.at - b.at);
  for (const item of sorted) {
    const text = item.text?.trim();
    if (!text) continue;
    let idx = 0;
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].at <= item.at) idx = i;
      else break;
    }
    const prefix = item.kind === 'guidance' ? '指导：' : '';
    const list = notes.get(idx) ?? [];
    list.push(`${prefix}${text}`);
    notes.set(idx, list);
  }
  return actions.map((a, i) => {
    const list = notes.get(i);
    if (!list?.length) return a;
    const note = [a.note, ...list].filter(Boolean).join('；');
    return { ...a, note };
  });
}

/**
 * The "understand" pass over a raw recording: hand the captured actions to the
 * LLM to produce a clean, minimal, parameterized workflow, then union any
 * {{placeholders}} the model wrote into args but forgot to declare in params.
 */
export async function understandRecording(
  actions: RecordedAction[],
  narration?: RecordingNarration[],
  pageContext?: PageContext
): Promise<UnderstoodRecording> {
  const annotated = attachNarration(actions, narration);
  const understood = await generalizeRecordingWithLLM(annotated, pageContext);
  const byKey = new Map<string, WorkflowParam>(understood.params.map((p) => [p.key, p]));
  for (const p of extractParams(understood.steps)) {
    if (!byKey.has(p.key)) byKey.set(p.key, p);
  }
  return { ...understood, params: [...byKey.values()] };
}

/**
 * Apply a natural-language edit to an in-review recording and re-union any
 * {{placeholders}} the model introduced but forgot to declare. Site-agnostic.
 */
export async function editRecording(
  current: EditableRecording,
  instruction: string,
  opts: { targetStepId?: string; pageContext?: PageContext } = {}
): Promise<EditableRecording> {
  const edited = await editRecordingWithLLM(current, instruction, opts);
  const byKey = new Map<string, WorkflowParam>(edited.params.map((p) => [p.key, p]));
  for (const p of extractParams(edited.steps)) {
    if (!byKey.has(p.key)) byKey.set(p.key, p);
  }
  return { ...edited, params: [...byKey.values()] };
}

/**
 * Build a deterministic replay Task from generalized steps so the agent can
 * demonstrate the recording once. Any {{param}} placeholders are substituted
 * with their recorded default value, so the demo reproduces the concrete actions
 * the user actually performed (not literal "{{query}}" text).
 */
export function createReplayTaskFromSteps(
  steps: WorkflowStep[],
  ctx: {
    name: string;
    startUrl?: string;
    tabId?: number;
    url?: string;
    params?: WorkflowParam[];
    /** Pre-resolved values (e.g. auto-generated) that override a param's default. */
    values?: Record<string, string>;
  }
): Task {
  const task = createTask({
    userRequest: `▶️ 演示录制：${ctx.name}`,
    mode: 'replay',
    tabId: ctx.tabId,
    url: ctx.url ?? ctx.startUrl,
    kind: 'once',
  });

  const defaults: Record<string, string> = {};
  for (const p of ctx.params ?? []) defaults[p.key] = p.default ?? '';
  // Pre-resolved run-time values (auto-generated / user-supplied) win over defaults.
  for (const [k, v] of Object.entries(ctx.values ?? {})) defaults[k] = v;

  const planSteps: PlanStep[] = steps.map((s) => ({
    id: crypto.randomUUID(),
    description: s.description,
    tool: s.tool,
    args: substituteParams(s.args, defaults),
    riskLevel: s.riskLevel,
    requiresConfirmation: s.requiresConfirmation,
  }));

  // Start the demo from the recorded start page so the saved selectors resolve
  // against the right DOM (mirrors instantiateWorkflow), unless the recording
  // already begins by navigating somewhere itself.
  if (ctx.startUrl && planSteps[0]?.tool !== 'navigate') {
    planSteps.unshift({
      id: crypto.randomUUID(),
      description: `打开起始页 ${ctx.startUrl}`,
      tool: 'navigate',
      args: { url: ctx.startUrl },
      riskLevel: 'low',
      requiresConfirmation: false,
    });
  }

  return updateTask(task.id, {
    status: 'pending',
    startUrl: ctx.startUrl ?? ctx.url,
    // Carry the generalized (placeholder) steps so a later save keeps them reusable.
    recordedSteps: steps,
    plan: { goal: ctx.name, steps: planSteps },
  });
}
