import type { TaskStatus } from '@ai-browser-agent/shared';

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['planning', 'cancelled'],
  planning: ['running', 'failed', 'cancelled'],
  running: ['paused', 'waiting_confirmation', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  waiting_confirmation: ['running', 'paused', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} → ${to}`);
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

export function isActiveStatus(status: TaskStatus): boolean {
  return ['planning', 'running', 'waiting_confirmation'].includes(status);
}
