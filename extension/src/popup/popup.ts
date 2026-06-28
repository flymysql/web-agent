import type { Task, TaskLogEntry, PlanStep } from '@ai-browser-agent/shared';

let currentTask: Task | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function sendMessage<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function updateStatus(connected: boolean): void {
  const el = $('status');
  el.textContent = connected ? '已连接' : '未连接';
  el.className = `status ${connected ? 'connected' : 'disconnected'}`;
}

function renderPlan(steps: PlanStep[]): void {
  const planView = $('planView');
  if (!steps.length) {
    planView.innerHTML = '<p>暂无计划</p>';
    return;
  }
  planView.innerHTML = `<ol>${steps
    .map(
      (s) =>
        `<li class="${s.riskLevel === 'high' ? 'risk-high' : ''}">${s.description}${
          s.requiresConfirmation ? ' ⚠️需确认' : ''
        }</li>`
    )
    .join('')}</ol>`;
}

function renderLogs(logs: TaskLogEntry[]): void {
  const logView = $('logView');
  logView.innerHTML = logs
    .slice(-20)
    .map(
      (l) =>
        `<div class="log-entry log-${l.level}">[${new Date(l.timestamp).toLocaleTimeString()}] ${l.message}</div>`
    )
    .join('');
  logView.scrollTop = logView.scrollHeight;
}

function renderTask(task: Task): void {
  currentTask = task;
  $('taskSection').classList.remove('hidden');
  $('taskStatus').textContent = task.status;
  $('taskId').textContent = task.id.slice(0, 8);

  if (task.plan) {
    renderPlan(task.plan.steps);
  }

  const confirmation = $('confirmationBanner');
  if (task.status === 'waiting_confirmation' && task.pendingConfirmation) {
    confirmation.classList.remove('hidden');
    $('confirmationText').textContent =
      `高风险操作需确认: ${task.pendingConfirmation.tool} - ${task.pendingConfirmation.reason}`;
  } else {
    confirmation.classList.add('hidden');
  }

  const resultView = $('resultView');
  if (task.result) {
    resultView.classList.remove('hidden');
    resultView.textContent = task.result;
  } else if (task.error) {
    resultView.classList.remove('hidden');
    resultView.textContent = `错误: ${task.error}`;
    resultView.style.background = '#fee2e2';
  } else {
    resultView.classList.add('hidden');
  }

  renderLogs(task.logs);

  $('startBtn').disabled = !['pending', 'planning'].includes(task.status);
  $('pauseBtn').disabled = task.status !== 'running';
  $('resumeBtn').disabled = !['paused', 'waiting_confirmation'].includes(task.status);
  $('cancelBtn').disabled = ['completed', 'failed', 'cancelled'].includes(task.status);
}

async function refreshTask(): Promise<void> {
  if (!currentTask) return;
  const { task } = await sendMessage<{ task: Task }>({ type: 'GET_TASK', taskId: currentTask.id });
  renderTask(task);
}

$('loopTask').addEventListener('change', (e) => {
  ($('loopInterval') as HTMLInputElement).disabled = !(e.target as HTMLInputElement).checked;
});

$('createBtn').addEventListener('click', async () => {
  const userRequest = ($('userRequest') as HTMLTextAreaElement).value.trim();
  if (!userRequest) return;

  $('createBtn').disabled = true;
  try {
    const isLoop = ($('loopTask') as HTMLInputElement).checked;
    const loopIntervalMs = parseInt(($('loopInterval') as HTMLInputElement).value, 10) || 60000;

    const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
      type: 'CREATE_TASK',
      userRequest,
      kind: isLoop ? 'loop' : 'once',
      loopIntervalMs: isLoop ? loopIntervalMs : undefined,
      loopMaxIterations: isLoop ? 100 : undefined,
    });

    if (error) throw new Error(error);
    if (task) renderTask(task);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    $('createBtn').disabled = false;
  }
});

$('startBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  await sendMessage({ type: 'START_TASK', taskId: currentTask.id });
  await refreshTask();
});

$('pauseBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  await sendMessage({ type: 'PAUSE_TASK', taskId: currentTask.id });
  await refreshTask();
});

$('resumeBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  await sendMessage({ type: 'RESUME_TASK', taskId: currentTask.id });
  await refreshTask();
});

$('cancelBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  await sendMessage({ type: 'CANCEL_TASK', taskId: currentTask.id });
  await refreshTask();
});

$('confirmBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  await sendMessage({ type: 'CONFIRM_TASK', taskId: currentTask.id, confirmed: true });
  await refreshTask();
});

$('rejectBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  await sendMessage({ type: 'CONFIRM_TASK', taskId: currentTask.id, confirmed: false });
  await refreshTask();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'BACKEND_STATUS') {
    updateStatus(message.connected);
  }
  if (message.type === 'TASK_UPDATE' && message.task) {
    renderTask(message.task as Task);
  }
});

(async () => {
  await sendMessage({ type: 'CONNECT_BACKEND' });
  const status = await sendMessage<{ connected: boolean }>({ type: 'GET_BACKEND_STATUS' });
  updateStatus(status.connected);

  setInterval(async () => {
    if (currentTask && ['running', 'planning', 'waiting_confirmation'].includes(currentTask.status)) {
      await refreshTask();
    }
  }, 2000);
})();
