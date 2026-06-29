import { v4 as uuidv4 } from 'uuid';
import type { Workflow } from '@ai-browser-agent/shared';
import { JsonRepository } from '../persistence/json-repository.js';

const workflows = new JsonRepository<Workflow>('workflows');

export function listWorkflows(): Workflow[] {
  return workflows.list().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getWorkflow(id: string): Workflow | undefined {
  return workflows.get(id);
}

export function createWorkflow(input: Partial<Workflow> & { name: string }): Workflow {
  const now = Date.now();
  const workflow: Workflow = {
    id: uuidv4(),
    name: input.name,
    description: input.description,
    startUrl: input.startUrl,
    params: input.params ?? [],
    steps: input.steps ?? [],
    triggers: input.triggers ?? [{ type: 'manual' }],
    createdAt: now,
    updatedAt: now,
  };
  return workflows.upsert(workflow);
}

export function updateWorkflow(id: string, updates: Partial<Workflow>): Workflow {
  const existing = workflows.get(id);
  if (!existing) throw new Error(`Workflow not found: ${id}`);
  const updated: Workflow = {
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  return workflows.upsert(updated);
}

export function deleteWorkflow(id: string): void {
  workflows.delete(id);
}

export function getWorkflowsByTrigger(type: Workflow['triggers'][number]['type']): Workflow[] {
  return workflows.list().filter((w) => w.triggers.some((t) => t.type === type));
}
