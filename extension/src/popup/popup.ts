import type { Task, TaskLogEntry, PlanStep, Workflow } from '@ai-browser-agent/shared';

let currentTask: Task | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function sendMessage<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function updateStatus(connected: boolean, lastError?: string | null): void {
  const el = $('status');
  el.textContent = connected ? '已连接' : '未连接';
  el.className = `status ${connected ? 'connected' : 'disconnected'}`;
  el.title = connected ? '' : lastError ?? '正在连接后端…';
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

  const saveWfBtn = $('saveWfBtn') as HTMLButtonElement;
  saveWfBtn.classList.toggle('hidden', !task.plan || !task.plan.steps.length);

  renderLogs(task.logs);

  $<HTMLButtonElement>('startBtn').disabled = !['pending', 'planning'].includes(task.status);
  $<HTMLButtonElement>('pauseBtn').disabled = task.status !== 'running';
  $<HTMLButtonElement>('resumeBtn').disabled = !['paused', 'waiting_confirmation'].includes(
    task.status
  );
  $<HTMLButtonElement>('cancelBtn').disabled = ['completed', 'failed', 'cancelled'].includes(
    task.status
  );
}

async function refreshTask(): Promise<void> {
  if (!currentTask) return;
  const { task } = await sendMessage<{ task: Task }>({ type: 'GET_TASK', taskId: currentTask.id });
  renderTask(task);
}

async function refreshWorkflows(): Promise<void> {
  const list = $('workflowList');
  try {
    const { workflows } = await sendMessage<{ workflows: Workflow[] }>({ type: 'LIST_WORKFLOWS' });
    if (!workflows?.length) {
      list.innerHTML = '<p class="empty">暂无已保存的工作流</p>';
      return;
    }
    list.innerHTML = workflows
      .map(
        (w) => `
        <div class="wf-item" data-id="${w.id}">
          <div class="wf-info">
            <div class="wf-name">${escapeHtml(w.name)}</div>
            <div class="wf-meta">${w.steps.length} 步 · ${w.triggers.map((t) => t.type).join(', ')}</div>
          </div>
          <div class="wf-actions">
            <button class="btn tiny wf-run">运行</button>
            <button class="btn tiny danger wf-del">删除</button>
          </div>
        </div>`
      )
      .join('');

    list.querySelectorAll<HTMLElement>('.wf-item').forEach((item) => {
      const id = item.dataset.id!;
      const wf = workflows.find((w) => w.id === id)!;
      item.querySelector('.wf-run')?.addEventListener('click', () => runWorkflow(wf));
      item.querySelector('.wf-del')?.addEventListener('click', () => deleteWorkflow(id));
    });
  } catch (err) {
    list.innerHTML = `<p class="empty">加载失败: ${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )}</p>`;
  }
}

async function runWorkflow(wf: Workflow): Promise<void> {
  const params: Record<string, string> = {};
  for (const p of wf.params) {
    const val = prompt(`参数 ${p.label || p.key}`, p.default ?? '');
    if (val === null) return;
    params[p.key] = val;
  }
  try {
    const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
      type: 'RUN_WORKFLOW',
      workflowId: wf.id,
      params,
    });
    if (error) throw new Error(error);
    if (task) renderTask(task);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
}

async function deleteWorkflow(id: string): Promise<void> {
  if (!confirm('确定删除该工作流?')) return;
  await sendMessage({ type: 'DELETE_WORKFLOW', workflowId: id });
  await refreshWorkflows();
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

$('refreshWfBtn').addEventListener('click', refreshWorkflows);

$('saveWfBtn').addEventListener('click', async () => {
  if (!currentTask) return;
  const name = prompt('工作流名称', currentTask.plan?.goal ?? currentTask.userRequest);
  if (!name) return;
  try {
    const { error } = await sendMessage<{ error?: string }>({
      type: 'SAVE_AS_WORKFLOW',
      taskId: currentTask.id,
      name,
      triggers: [{ type: 'manual' }],
    });
    if (error) throw new Error(error);
    await refreshWorkflows();
    alert('已保存为工作流');
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

$('loopTask').addEventListener('change', (e) => {
  ($('loopInterval') as HTMLInputElement).disabled = !(e.target as HTMLInputElement).checked;
});

$('createBtn').addEventListener('click', async () => {
  const userRequest = ($('userRequest') as HTMLTextAreaElement).value.trim();
  if (!userRequest) return;

  $<HTMLButtonElement>('createBtn').disabled = true;
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
    $<HTMLButtonElement>('createBtn').disabled = false;
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
    updateStatus(message.connected, message.lastError);
  }
  if (message.type === 'TASK_UPDATE' && message.task) {
    renderTask(message.task as Task);
  }
});

(async () => {
  await sendMessage({ type: 'CONNECT_BACKEND' });
  const status = await sendMessage<{ connected: boolean; lastError?: string | null }>({
    type: 'GET_BACKEND_STATUS',
  });
  updateStatus(status.connected, status.lastError);
  await refreshWorkflows();

  setInterval(async () => {
    const status = await sendMessage<{ connected: boolean; lastError?: string | null }>({
      type: 'GET_BACKEND_STATUS',
    });
    updateStatus(status.connected, status.lastError);

    if (currentTask && ['running', 'planning', 'waiting_confirmation'].includes(currentTask.status)) {
      await refreshTask();
    }
  }, 2000);
})();
