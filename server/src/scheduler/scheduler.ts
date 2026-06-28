import type { WebSocket } from 'ws';
import type { WsMessage } from '@ai-browser-agent/shared';
import { getActiveLoopTasks, getTask } from '../tasks/store.js';
import { runTask } from '../agent/orchestrator.js';

const scheduledTasks = new Map<string, ReturnType<typeof setInterval>>();

let broadcastTaskUpdate: ((taskId: string) => void) | null = null;
let isExtensionConnected = false;

export function setSchedulerCallbacks(callbacks: {
  broadcastTaskUpdate: (taskId: string) => void;
  checkExtensionConnected: () => boolean;
}): void {
  broadcastTaskUpdate = callbacks.broadcastTaskUpdate;
  isExtensionConnected = callbacks.checkExtensionConnected();
}

export function setExtensionConnected(connected: boolean): void {
  isExtensionConnected = connected;
}

export function scheduleLoopTask(taskId: string, intervalMs: number): void {
  if (scheduledTasks.has(taskId)) return;

  const timer = setInterval(async () => {
    const task = getTask(taskId);
    if (!task || task.status === 'cancelled' || task.status === 'completed') {
      unscheduleLoopTask(taskId);
      return;
    }

    if (!isExtensionConnected) {
      console.log(`[Scheduler] Extension offline, skipping loop for ${taskId}`);
      return;
    }

    if (task.status === 'paused') return;

    try {
      await runTask(taskId);
      broadcastTaskUpdate?.(taskId);
    } catch (err) {
      console.error(`[Scheduler] Loop task error ${taskId}:`, err);
    }
  }, intervalMs);

  scheduledTasks.set(taskId, timer);
  console.log(`[Scheduler] Loop task scheduled: ${taskId} every ${intervalMs}ms`);
}

export function unscheduleLoopTask(taskId: string): void {
  const timer = scheduledTasks.get(taskId);
  if (timer) {
    clearInterval(timer);
    scheduledTasks.delete(taskId);
    console.log(`[Scheduler] Loop task unscheduled: ${taskId}`);
  }
}

export function startScheduler(): void {
  setInterval(async () => {
    if (!isExtensionConnected) return;

    const loopTasks = getActiveLoopTasks();
    for (const task of loopTasks) {
      if (task.loopIntervalMs && !scheduledTasks.has(task.id)) {
        scheduleLoopTask(task.id, task.loopIntervalMs);
      }
    }
  }, 10000);

  console.log('[Scheduler] Started');
}

export async function resumePendingTasks(): Promise<void> {
  if (!isExtensionConnected) return;

  const { getResumableTasks } = await import('../tasks/store.js');
  const tasks = getResumableTasks().filter((t) => t.status === 'running');

  for (const task of tasks) {
    try {
      await runTask(task.id);
      broadcastTaskUpdate?.(task.id);
    } catch (err) {
      console.error(`[Scheduler] Resume error ${task.id}:`, err);
    }
  }
}

export function getScheduledTaskIds(): string[] {
  return Array.from(scheduledTasks.keys());
}
