import type {
  Task,
  TaskLogEntry,
  PlanStep,
  Workflow,
  ChatSession,
} from '@ai-browser-agent/shared';

type AgentState = 'idle' | 'thinking' | 'working' | 'happy' | 'error' | 'waiting';

const BALL_POS_KEY = 'agent_ball_pos';

function sendMessage<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/** Forward a UI/flow log to the background → backend debug log (fire-and-forget). */
function clientLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  category: string,
  message: string,
  data?: unknown,
  taskId?: string
): void {
  try {
    chrome.runtime
      .sendMessage({
        type: 'CLIENT_LOG',
        entry: { level, category, message, data, taskId, ts: Date.now() },
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Robot mascot as inline SVG. Expression driven by state. */
function mascotSvg(): string {
  return `
  <svg class="mascot" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bodyGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7c7cf0"/>
        <stop offset="100%" stop-color="#4f46e5"/>
      </linearGradient>
    </defs>
    <ellipse class="shadow" cx="32" cy="58" rx="16" ry="3"/>
    <rect class="antenna-stick" x="31" y="6" width="2" height="8" rx="1"/>
    <circle class="antenna" cx="32" cy="6" r="3"/>
    <rect class="head" x="14" y="14" width="36" height="30" rx="12" fill="url(#bodyGrad)"/>
    <rect class="visor" x="19" y="21" width="26" height="15" rx="7.5"/>
    <circle class="eye eye-left" cx="27" cy="28.5" r="3"/>
    <circle class="eye eye-right" cx="37" cy="28.5" r="3"/>
    <path class="mouth" d="M28 39 Q32 42 36 39" stroke-linecap="round"/>
    <rect class="ear ear-left" x="10" y="24" width="4" height="10" rx="2" fill="url(#bodyGrad)"/>
    <rect class="ear ear-right" x="50" y="24" width="4" height="10" rx="2" fill="url(#bodyGrad)"/>
  </svg>`;
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', sans-serif; }

.ball {
  position: fixed;
  width: 60px;
  height: 60px;
  z-index: 2147483646;
  cursor: grab;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #ffffff22, #4f46e5 70%);
  box-shadow: 0 6px 20px rgba(79,70,229,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  touch-action: none;
  transition: transform 0.15s, box-shadow 0.2s;
}
.ball:hover { transform: scale(1.08); box-shadow: 0 8px 26px rgba(79,70,229,0.6); }
.ball.dragging { cursor: grabbing; transition: none; }

.mascot { width: 46px; height: 46px; animation: bob 2.6s ease-in-out infinite; }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

.shadow { fill: rgba(0,0,0,0.12); }
.antenna { fill: #fbbf24; animation: blinkAntenna 1.6s ease-in-out infinite; }
.antenna-stick { fill: #c7d2fe; }
.visor { fill: #11142a; }
.eye { fill: #7ef9ff; animation: blink 4s infinite; }
.mouth { fill: none; stroke: #7ef9ff; stroke-width: 2; }
@keyframes blink { 0%,92%,100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
@keyframes blinkAntenna { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* state-specific expressions */
.ball[data-state="thinking"] .mascot { animation: tilt 1.2s ease-in-out infinite; }
@keyframes tilt { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
.ball[data-state="working"] .eye { fill: #fbbf24; }
.ball[data-state="working"] .mascot { animation: bob 0.8s ease-in-out infinite; }
.ball[data-state="happy"] .mouth { d: path("M27 38 Q32 44 37 38"); }
.ball[data-state="error"] .eye { fill: #f87171; }
.ball[data-state="error"] .mouth { d: path("M28 41 Q32 38 36 41"); }
.ball[data-state="waiting"] .antenna { animation: blinkAntenna 0.5s ease-in-out infinite; fill: #f87171; }

.badge {
  position: absolute;
  top: -2px; right: -2px;
  min-width: 18px; height: 18px;
  padding: 0 5px;
  background: #ef4444;
  color: #fff;
  border-radius: 9px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-weight: 600;
  display: none;
}
.badge.show { display: block; }

/* Chat panel */
.panel {
  position: fixed;
  width: 360px;
  height: 520px;
  max-height: 80vh;
  z-index: 2147483647;
  background: #f8f9fc;
  border-radius: 16px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.28);
  display: none;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(0,0,0,0.06);
}
.panel.open { display: flex; animation: popIn 0.18s ease-out; }
@keyframes popIn { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }

.panel-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  background: linear-gradient(135deg, #4f46e5, #6366f1);
  color: #fff;
}
.panel-header .avatar { width: 30px; height: 30px; flex-shrink: 0; }
.panel-header .title { font-size: 14px; font-weight: 600; flex: 1; }
.panel-header .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #f87171; }
.panel-header .status-dot.connected { background: #34d399; }
.panel-header button {
  background: rgba(255,255,255,0.18); border: none; color: #fff;
  width: 26px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 15px;
}
.panel-header button:hover { background: rgba(255,255,255,0.3); }

.messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }

.msg { display: flex; gap: 8px; max-width: 100%; }
.msg.user { flex-direction: row-reverse; }
.bubble {
  padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.5;
  max-width: 78%; word-break: break-word;
}
.bubble.text { white-space: pre-wrap; }
.msg.agent .bubble { background: #fff; color: #1a1a2e; border: 1px solid #eceef5; border-bottom-left-radius: 4px; }
.msg.user .bubble { background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
.msg.system { justify-content: center; }
.msg.system .bubble { background: transparent; color: #9ca3af; font-size: 11px; padding: 2px 8px; max-width: 100%; }

.bubble .plan-title { font-weight: 600; margin-bottom: 6px; }
.bubble ol { margin: 0; padding-left: 18px; }
.bubble li { margin-bottom: 3px; }
.bubble li.risk-high { color: #dc2626; }

.inline-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.inline-actions button {
  padding: 6px 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 12px; font-weight: 500;
}
.btn-go { background: #4f46e5; color: #fff; }
.btn-go:hover { background: #4338ca; }
.btn-ok { background: #059669; color: #fff; }
.btn-no, .btn-cancel { background: #fff; color: #374151; border: 1px solid #d1d5db !important; }
.btn-no:hover, .btn-cancel:hover { background: #f3f4f6; }

.thinking-dots span {
  display: inline-block; width: 6px; height: 6px; margin: 0 1px; border-radius: 50%;
  background: #9ca3af; animation: dotPulse 1.2s infinite;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotPulse { 0%,60%,100% { opacity: 0.3; } 30% { opacity: 1; } }

.composer { padding: 10px 12px; border-top: 1px solid #eceef5; background: #fff; }
.composer .row { display: flex; gap: 8px; align-items: flex-end; }
.composer textarea {
  flex: 1; resize: none; border: 1px solid #d1d5db; border-radius: 10px;
  padding: 8px 10px; font-size: 13px; max-height: 90px; min-height: 38px; font-family: inherit;
}
.composer textarea:focus { outline: none; border-color: #a5b4fc; }
.composer .send {
  width: 38px; height: 38px; border-radius: 10px; border: none; background: #4f46e5; color: #fff;
  cursor: pointer; font-size: 16px; flex-shrink: 0;
}
.composer .send:hover { background: #4338ca; }
.composer .send:disabled { background: #c7d2fe; cursor: not-allowed; }
.composer .opts { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: #6b7280; }
.composer .opts input[type="number"] { width: 78px; padding: 2px 6px; border: 1px solid #d1d5db; border-radius: 5px; font-size: 11px; }
.composer .opts input[type="number"]:disabled { opacity: 0.5; }

/* Drawers: sessions + workflows */
.drawer {
  position: absolute; left: 0; right: 0; top: 50px; bottom: 0;
  background: #fff; z-index: 6; display: none; flex-direction: column;
}
.drawer.open { display: flex; animation: popIn 0.15s ease-out; }
.drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 14px; border-bottom: 1px solid #eceef5; font-size: 13px; font-weight: 600; color: #1a1a2e;
}
.drawer-head .drawer-close { background: none; border: none; font-size: 18px; line-height: 1; cursor: pointer; color: #9ca3af; }
.drawer-head .drawer-close:hover { color: #374151; }
.drawer-body { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.drawer-foot { padding: 10px; border-top: 1px solid #eceef5; }
.drawer-action { width: 100%; padding: 8px; border: none; border-radius: 8px; background: #4f46e5; color: #fff; cursor: pointer; font-size: 13px; }
.drawer-action:hover { background: #4338ca; }
.drawer-empty { text-align: center; color: #9ca3af; font-size: 12px; padding: 26px 12px; line-height: 1.6; }

.list-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #eceef5; border-radius: 8px; }
.list-item:hover { background: #f7f8fc; }
.list-item.active { border-color: #a5b4fc; background: #eef2ff; }
.list-item .li-main { flex: 1; min-width: 0; cursor: pointer; }
.list-item .li-title { font-size: 13px; color: #1a1a2e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.list-item .li-sub { font-size: 11px; color: #9ca3af; margin-top: 2px; }
.list-item .li-act { display: flex; gap: 2px; flex-shrink: 0; }
.list-item .li-act button { background: none; border: none; cursor: pointer; font-size: 13px; padding: 3px 5px; border-radius: 5px; color: #6b7280; }
.list-item .li-act button:hover { background: #e5e7eb; }
`;

export class AgentWidget {
  private root: ShadowRoot;
  private ball!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private messages!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusDot!: HTMLDivElement;
  private badge!: HTMLDivElement;
  private loopChk!: HTMLInputElement;
  private loopInterval!: HTMLInputElement;
  private sessionDrawer!: HTMLDivElement;
  private wfDrawer!: HTMLDivElement;
  private sessionList!: HTMLDivElement;
  private wfList!: HTMLDivElement;

  private currentSessionId: string | null = null;
  private sessions: ChatSession[] = [];
  private savedWorkflowFor = new Set<string>();
  private currentTask: Task | null = null;
  private renderedLogIds = new Set<string>();
  private planRenderedFor: string | null = null;
  private resultRendered = false;
  private confirmRenderedStep: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor() {
    const host = document.createElement('div');
    host.id = 'ai-browser-agent-root';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    document.documentElement.appendChild(host);
    this.root = host.attachShadow({ mode: 'open' });
    this.render();
    this.bind();
    this.init();
  }

  private render(): void {
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.root.appendChild(style);

    const ball = document.createElement('div');
    ball.className = 'ball';
    ball.dataset.state = 'idle';
    ball.innerHTML = `${mascotSvg()}<div class="badge"></div>`;
    this.root.appendChild(ball);
    this.ball = ball;
    this.badge = ball.querySelector('.badge') as HTMLDivElement;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="panel-header">
        <div class="avatar">${mascotSvg()}</div>
        <div class="title">AI 助手</div>
        <div class="status-dot"></div>
        <button class="new-btn" title="新建会话">➕</button>
        <button class="session-btn" title="会话历史">🕘</button>
        <button class="wf-btn" title="工作流仓库">🗂</button>
        <button class="min-btn" title="收起">—</button>
      </div>
      <div class="messages"></div>
      <div class="composer">
        <div class="row">
          <textarea class="input" rows="1" placeholder="告诉我你想做什么…例如：提取本页所有链接并总结"></textarea>
          <button class="send" title="发送">➤</button>
        </div>
        <div class="opts">
          <label><input type="checkbox" class="loop-chk"> 循环任务</label>
          <input type="number" class="loop-interval" value="60000" min="5000" disabled> ms
        </div>
      </div>
      <div class="drawer session-drawer">
        <div class="drawer-head"><span>会话历史</span><button class="drawer-close" title="关闭">×</button></div>
        <div class="drawer-body session-list"></div>
        <div class="drawer-foot"><button class="drawer-action new-session-btn">+ 新建会话</button></div>
      </div>
      <div class="drawer wf-drawer">
        <div class="drawer-head"><span>工作流仓库</span><button class="drawer-close" title="关闭">×</button></div>
        <div class="drawer-body wf-list"></div>
      </div>`;
    this.root.appendChild(panel);
    this.panel = panel;
    this.messages = panel.querySelector('.messages') as HTMLDivElement;
    this.input = panel.querySelector('.input') as HTMLTextAreaElement;
    this.sendBtn = panel.querySelector('.send') as HTMLButtonElement;
    this.statusDot = panel.querySelector('.status-dot') as HTMLDivElement;
    this.loopChk = panel.querySelector('.loop-chk') as HTMLInputElement;
    this.loopInterval = panel.querySelector('.loop-interval') as HTMLInputElement;
    this.sessionDrawer = panel.querySelector('.session-drawer') as HTMLDivElement;
    this.wfDrawer = panel.querySelector('.wf-drawer') as HTMLDivElement;
    this.sessionList = panel.querySelector('.session-list') as HTMLDivElement;
    this.wfList = panel.querySelector('.wf-list') as HTMLDivElement;

    this.restorePosition();
    this.addAgentMessage('你好！我是你的页面助手 🤖\n描述你想完成的任务，我会先制定计划再执行。');
  }

  private async restorePosition(): Promise<void> {
    let pos = { right: 20, bottom: 24 };
    try {
      const stored = await chrome.storage.local.get(BALL_POS_KEY);
      if (stored[BALL_POS_KEY]) pos = stored[BALL_POS_KEY];
    } catch {
      /* ignore */
    }
    if ('left' in pos || 'top' in pos) {
      const p = pos as { left?: number; top?: number };
      this.ball.style.left = `${p.left ?? 0}px`;
      this.ball.style.top = `${p.top ?? 0}px`;
      this.ball.style.right = 'auto';
      this.ball.style.bottom = 'auto';
    } else {
      this.ball.style.right = `${pos.right}px`;
      this.ball.style.bottom = `${pos.bottom}px`;
    }
    this.positionPanel();
  }

  private positionPanel(): void {
    const rect = this.ball.getBoundingClientRect();
    const panelW = 360;
    const panelH = Math.min(520, window.innerHeight * 0.8);
    let left = rect.left - panelW - 12;
    if (left < 8) left = rect.right + 12;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    let top = rect.top + rect.height / 2 - panelH / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - panelH - 8));
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
  }

  private bind(): void {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    this.ball.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.ball.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      this.ball.setPointerCapture(e.pointerId);
      this.ball.classList.add('dragging');
    });

    this.ball.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const left = Math.max(0, Math.min(originLeft + dx, window.innerWidth - 60));
      const top = Math.max(0, Math.min(originTop + dy, window.innerHeight - 60));
      this.ball.style.left = `${left}px`;
      this.ball.style.top = `${top}px`;
      this.ball.style.right = 'auto';
      this.ball.style.bottom = 'auto';
      if (this.panel.classList.contains('open')) this.positionPanel();
    });

    this.ball.addEventListener('pointerup', (e) => {
      dragging = false;
      this.ball.classList.remove('dragging');
      this.ball.releasePointerCapture(e.pointerId);
      if (moved) {
        const rect = this.ball.getBoundingClientRect();
        chrome.storage.local.set({ [BALL_POS_KEY]: { left: rect.left, top: rect.top } }).catch(() => {});
      } else {
        this.togglePanel();
      }
    });

    (this.panel.querySelector('.min-btn') as HTMLButtonElement).addEventListener('click', () => {
      this.panel.classList.remove('open');
    });

    (this.panel.querySelector('.new-btn') as HTMLButtonElement).addEventListener('click', () => this.newSession());
    (this.panel.querySelector('.session-btn') as HTMLButtonElement).addEventListener('click', () => this.toggleSessionDrawer());
    (this.panel.querySelector('.wf-btn') as HTMLButtonElement).addEventListener('click', () => this.toggleWfDrawer());
    (this.panel.querySelector('.new-session-btn') as HTMLButtonElement).addEventListener('click', () => this.newSession());
    this.panel.querySelectorAll('.drawer-close').forEach((b) =>
      b.addEventListener('click', () => this.closeDrawers())
    );

    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 90)}px`;
    });

    this.loopChk.addEventListener('change', () => {
      this.loopInterval.disabled = !this.loopChk.checked;
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'BACKEND_STATUS') {
        this.setConnected(message.connected);
      }
      if (message.type === 'TASK_UPDATE' && message.task) {
        this.onTaskUpdate(message.task as Task);
      }
    });

    window.addEventListener('resize', () => {
      if (this.panel.classList.contains('open')) this.positionPanel();
    });
  }

  private async init(): Promise<void> {
    try {
      await sendMessage({ type: 'CONNECT_BACKEND' });
      const status = await sendMessage<{ connected: boolean }>({ type: 'GET_BACKEND_STATUS' });
      this.setConnected(status.connected);
    } catch {
      this.setConnected(false);
    }
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.statusDot.classList.toggle('connected', connected);
  }

  private togglePanel(): void {
    const open = this.panel.classList.toggle('open');
    if (open) {
      this.positionPanel();
      this.input.focus();
      this.badge.classList.remove('show');
      this.badge.textContent = '';
    }
  }

  private setState(state: AgentState): void {
    this.ball.dataset.state = state;
  }

  private scrollToBottom(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private addUserMessage(text: string): void {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="bubble text"></div>`;
    (el.querySelector('.bubble') as HTMLElement).textContent = text;
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  private addAgentMessage(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = `<div class="bubble text"></div>`;
    (el.querySelector('.bubble') as HTMLElement).textContent = text;
    this.messages.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private addSystemMessage(text: string): void {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.innerHTML = `<div class="bubble text"></div>`;
    (el.querySelector('.bubble') as HTMLElement).textContent = text;
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  private addThinking(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'msg agent thinking';
    el.innerHTML = `<div class="bubble"><span class="thinking-dots"><span></span><span></span><span></span></span></div>`;
    this.messages.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private async handleSend(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    if (!this.connected) {
      this.addSystemMessage('未连接到后端服务，请确认 npm run dev:server 已启动');
    }

    this.addUserMessage(text);
    this.input.value = '';
    this.input.style.height = 'auto';
    this.sendBtn.disabled = true;
    this.setState('thinking');

    const thinking = this.addThinking();
    const isLoop = this.loopChk.checked;
    const loopIntervalMs = parseInt(this.loopInterval.value, 10) || 60000;

    try {
      await this.ensureSession(text);
      const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
        type: 'CREATE_TASK',
        userRequest: text,
        sessionId: this.currentSessionId ?? undefined,
        kind: isLoop ? 'loop' : 'once',
        loopIntervalMs: isLoop ? loopIntervalMs : undefined,
        loopMaxIterations: isLoop ? 100 : undefined,
      });
      thinking.remove();
      if (error) throw new Error(error);
      if (task) {
        this.resetTaskRenderState();
        this.onTaskUpdate(task);
      }
    } catch (err) {
      thinking.remove();
      this.setState('error');
      this.addAgentMessage(`出错了：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sendBtn.disabled = false;
    }
  }

  private resetTaskRenderState(): void {
    this.renderedLogIds.clear();
    this.planRenderedFor = null;
    this.resultRendered = false;
    this.confirmRenderedStep = null;
  }

  private onTaskUpdate(task: Task): void {
    const isNewTask = this.currentTask?.id !== task.id;
    if (isNewTask) this.resetTaskRenderState();
    this.currentTask = task;

    if (task.plan && this.planRenderedFor !== task.id) {
      this.renderPlanMessage(task);
      this.planRenderedFor = task.id;
    }

    for (const log of task.logs ?? []) {
      if (this.renderedLogIds.has(log.id)) continue;
      this.renderedLogIds.add(log.id);
      if (log.level === 'info' && log.message.startsWith('Executing step')) {
        this.addSystemMessage(`⚙️ ${log.message}`);
      } else if (log.level === 'error') {
        this.addSystemMessage(`❌ ${log.message}`);
      }
    }

    switch (task.status) {
      case 'running':
        this.setState('working');
        break;
      case 'planning':
        this.setState('thinking');
        break;
      case 'waiting_confirmation':
        this.setState('waiting');
        if (task.pendingConfirmation && this.confirmRenderedStep !== task.pendingConfirmation.stepId) {
          this.renderConfirmation(task);
          this.confirmRenderedStep = task.pendingConfirmation.stepId;
          this.notifyBadge();
        }
        break;
      case 'completed':
        this.setState('happy');
        if (!this.resultRendered) {
          this.addAgentMessage(`✅ 任务完成\n${task.result ?? ''}`.trim());
          this.resultRendered = true;
          this.notifyBadge();
          if (task.recordedSteps?.length && !this.savedWorkflowFor.has(task.id)) {
            this.renderSaveWorkflow(task);
          }
        }
        this.stopPolling();
        void this.refreshSessionsQuietly();
        break;
      case 'failed':
        this.setState('error');
        if (!this.resultRendered) {
          this.addAgentMessage(`任务失败：${task.error ?? '未知错误'}`);
          this.resultRendered = true;
          this.notifyBadge();
        }
        this.stopPolling();
        break;
      case 'cancelled':
        this.setState('idle');
        this.stopPolling();
        break;
    }

    if (['running', 'planning', 'waiting_confirmation'].includes(task.status)) {
      this.startPolling();
    }
  }

  // ---- Drawers ----

  private closeDrawers(): void {
    this.sessionDrawer.classList.remove('open');
    this.wfDrawer.classList.remove('open');
  }

  // ---- Sessions ----

  private async ensureSession(seed: string): Promise<void> {
    if (this.currentSessionId) return;
    try {
      const title = seed.slice(0, 24) || '新会话';
      const { session } = await sendMessage<{ session?: ChatSession }>({
        type: 'CREATE_SESSION',
        title,
      });
      if (session) {
        this.currentSessionId = session.id;
        clientLog('info', 'session', `新建会话 ${session.id}`);
      }
    } catch {
      /* task can still run without a session */
    }
  }

  private newSession(): void {
    this.currentSessionId = null;
    this.currentTask = null;
    this.resetTaskRenderState();
    this.savedWorkflowFor.clear();
    this.messages.innerHTML = '';
    this.closeDrawers();
    this.setState('idle');
    this.addAgentMessage('已开启新会话 ✨\n描述你想完成的任务，我会先制定计划再执行。');
    if (!this.panel.classList.contains('open')) this.togglePanel();
  }

  private async toggleSessionDrawer(): Promise<void> {
    const open = this.sessionDrawer.classList.contains('open');
    this.wfDrawer.classList.remove('open');
    if (open) {
      this.sessionDrawer.classList.remove('open');
      return;
    }
    this.sessionDrawer.classList.add('open');
    await this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    this.sessionList.innerHTML = '<div class="drawer-empty">加载中…</div>';
    try {
      const { sessions } = await sendMessage<{ sessions?: ChatSession[] }>({ type: 'LIST_SESSIONS' });
      this.sessions = sessions ?? [];
      this.renderSessions();
    } catch (err) {
      this.sessionList.innerHTML = `<div class="drawer-empty">加载失败：${this.escape(String(err))}</div>`;
    }
  }

  private renderSessions(): void {
    if (!this.sessions.length) {
      this.sessionList.innerHTML = '<div class="drawer-empty">还没有会话。<br>发送一条消息即可开始新会话。</div>';
      return;
    }
    this.sessionList.innerHTML = '';
    const sorted = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const s of sorted) {
      const item = document.createElement('div');
      item.className = 'list-item' + (s.id === this.currentSessionId ? ' active' : '');
      const date = new Date(s.updatedAt).toLocaleString();
      item.innerHTML = `
        <div class="li-main">
          <div class="li-title"></div>
          <div class="li-sub">${s.taskIds.length} 个任务 · ${date}</div>
        </div>
        <div class="li-act">
          <button class="li-rename" title="重命名">✎</button>
          <button class="li-del" title="删除">🗑</button>
        </div>`;
      (item.querySelector('.li-title') as HTMLElement).textContent = s.title || '未命名会话';
      (item.querySelector('.li-main') as HTMLElement).addEventListener('click', () => this.selectSession(s.id));
      (item.querySelector('.li-rename') as HTMLButtonElement).addEventListener('click', (e) => {
        e.stopPropagation();
        this.renameSession(s);
      });
      (item.querySelector('.li-del') as HTMLButtonElement).addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSession(s);
      });
      this.sessionList.appendChild(item);
    }
  }

  private async selectSession(id: string): Promise<void> {
    try {
      const { session, tasks } = await sendMessage<{ session?: ChatSession; tasks?: Task[] }>({
        type: 'GET_SESSION',
        sessionId: id,
      });
      if (!session) return;
      this.currentSessionId = id;
      this.currentTask = null;
      this.resetTaskRenderState();
      this.savedWorkflowFor.clear();
      this.messages.innerHTML = '';
      this.addSystemMessage(`会话：${session.title}`);
      const history = tasks ?? [];
      for (const t of history) {
        this.addUserMessage(t.userRequest);
        if (t.status === 'completed' && t.result) {
          this.addAgentMessage(`✅ ${t.result}`);
        } else if (t.status === 'failed') {
          this.addAgentMessage(`任务失败：${t.error ?? '未知错误'}`);
        }
      }
      this.closeDrawers();
      if (!this.panel.classList.contains('open')) this.togglePanel();
      const live = history.find((t) =>
        ['running', 'planning', 'waiting_confirmation'].includes(t.status)
      );
      if (live) this.onTaskUpdate(live);
      clientLog('info', 'session', `切换到会话 ${id}`);
    } catch (err) {
      this.addSystemMessage(`加载会话失败：${String(err)}`);
    }
  }

  private async renameSession(s: ChatSession): Promise<void> {
    const title = window.prompt('重命名会话', s.title);
    if (!title || title === s.title) return;
    try {
      await sendMessage({ type: 'RENAME_SESSION', sessionId: s.id, title });
      await this.loadSessions();
    } catch (err) {
      this.addSystemMessage(`重命名失败：${String(err)}`);
    }
  }

  private async deleteSession(s: ChatSession): Promise<void> {
    if (!window.confirm(`删除会话「${s.title}」？此操作不可撤销。`)) return;
    try {
      await sendMessage({ type: 'DELETE_SESSION', sessionId: s.id });
      if (this.currentSessionId === s.id) this.currentSessionId = null;
      await this.loadSessions();
    } catch (err) {
      this.addSystemMessage(`删除失败：${String(err)}`);
    }
  }

  private async refreshSessionsQuietly(): Promise<void> {
    if (!this.sessionDrawer.classList.contains('open')) return;
    await this.loadSessions();
  }

  // ---- Workflows ----

  private async toggleWfDrawer(): Promise<void> {
    const open = this.wfDrawer.classList.contains('open');
    this.sessionDrawer.classList.remove('open');
    if (open) {
      this.wfDrawer.classList.remove('open');
      return;
    }
    this.wfDrawer.classList.add('open');
    await this.loadWorkflows();
  }

  private async loadWorkflows(): Promise<void> {
    this.wfList.innerHTML = '<div class="drawer-empty">加载中…</div>';
    try {
      const { workflows } = await sendMessage<{ workflows?: Workflow[] }>({ type: 'LIST_WORKFLOWS' });
      this.renderWorkflows(workflows ?? []);
    } catch (err) {
      this.wfList.innerHTML = `<div class="drawer-empty">加载失败：${this.escape(String(err))}</div>`;
    }
  }

  private renderWorkflows(workflows: Workflow[]): void {
    if (!workflows.length) {
      this.wfList.innerHTML =
        '<div class="drawer-empty">还没有工作流。<br>完成一个任务后可保存为工作流，方便重复执行。</div>';
      return;
    }
    this.wfList.innerHTML = '';
    const triggerLabel: Record<string, string> = {
      manual: '手动',
      scheduled: '循环',
      onPageOpen: '页面加载',
    };
    for (const wf of workflows) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const triggers =
        wf.triggers.map((t) => triggerLabel[t.type] ?? t.type).join('、') || '手动';
      item.innerHTML = `
        <div class="li-main">
          <div class="li-title"></div>
          <div class="li-sub">${wf.steps.length} 步 · ${triggers}</div>
        </div>
        <div class="li-act">
          <button class="li-run" title="执行">▶</button>
          <button class="li-del" title="删除">🗑</button>
        </div>`;
      (item.querySelector('.li-title') as HTMLElement).textContent = wf.name;
      (item.querySelector('.li-run') as HTMLButtonElement).addEventListener('click', (e) => {
        e.stopPropagation();
        this.runWorkflow(wf);
      });
      (item.querySelector('.li-del') as HTMLButtonElement).addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteWorkflow(wf);
      });
      this.wfList.appendChild(item);
    }
  }

  private async runWorkflow(wf: Workflow): Promise<void> {
    const params: Record<string, string> = {};
    for (const p of wf.params ?? []) {
      const v = window.prompt(`参数：${p.label || p.key}`, p.default ?? '');
      params[p.key] = v ?? p.default ?? '';
    }
    this.closeDrawers();
    if (!this.panel.classList.contains('open')) this.togglePanel();
    this.addSystemMessage(`▶ 执行工作流：${wf.name}`);
    clientLog('info', 'workflow', `执行工作流 ${wf.name}`, { id: wf.id });
    try {
      const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
        type: 'RUN_WORKFLOW',
        workflowId: wf.id,
        params,
      });
      if (error) throw new Error(error);
      if (task) {
        this.resetTaskRenderState();
        this.onTaskUpdate(task);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addAgentMessage(`工作流执行失败：${msg}`);
    }
  }

  private async deleteWorkflow(wf: Workflow): Promise<void> {
    if (!window.confirm(`删除工作流「${wf.name}」？`)) return;
    try {
      await sendMessage({ type: 'DELETE_WORKFLOW', workflowId: wf.id });
      await this.loadWorkflows();
    } catch (err) {
      this.addSystemMessage(`删除失败：${String(err)}`);
    }
  }

  private renderSaveWorkflow(task: Task): void {
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = `<div class="bubble text">💾 将本次操作保存为工作流，便于重复执行？<div class="inline-actions"><button class="btn-go save-wf">保存为工作流</button></div></div>`;
    const btn = el.querySelector('.save-wf') as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      const name = window.prompt('工作流名称', task.userRequest.slice(0, 24));
      if (!name) return;
      btn.disabled = true;
      try {
        await sendMessage({
          type: 'SAVE_AS_WORKFLOW',
          taskId: task.id,
          name,
          description: task.userRequest,
          triggers: [{ type: 'manual' }],
        });
        this.savedWorkflowFor.add(task.id);
        this.addSystemMessage(`已保存工作流：${name}`);
      } catch (err) {
        btn.disabled = false;
        this.addSystemMessage(`保存失败：${String(err)}`);
      }
    });
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  private notifyBadge(): void {
    if (!this.panel.classList.contains('open')) {
      this.badge.textContent = '1';
      this.badge.classList.add('show');
    }
  }

  private renderPlanMessage(task: Task): void {
    const steps = task.plan?.steps ?? [];
    const el = document.createElement('div');
    el.className = 'msg agent';
    const list = steps
      .map(
        (s: PlanStep) =>
          `<li class="${s.riskLevel === 'high' ? 'risk-high' : ''}">${this.escape(s.description)}${
            s.requiresConfirmation ? ' ⚠️' : ''
          }</li>`
      )
      .join('');
    const loopHint = task.kind === 'loop' ? `（循环，每 ${task.loopIntervalMs ?? 0}ms）` : '';
    el.innerHTML = `
      <div class="bubble">
        <div class="plan-title">📋 我的计划${this.escape(loopHint)}（${steps.length} 步）</div>
        <ol>${list}</ol>
        <div class="inline-actions">
          <button class="btn-go">开始执行</button>
          <button class="btn-cancel">取消</button>
        </div>
      </div>`;
    this.messages.appendChild(el);
    this.scrollToBottom();

    const goBtn = el.querySelector('.btn-go') as HTMLButtonElement;
    const cancelBtn = el.querySelector('.btn-cancel') as HTMLButtonElement;
    goBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      cancelBtn.disabled = true;
      el.querySelector('.inline-actions')?.remove();
      await sendMessage({ type: 'START_TASK', taskId: task.id });
      this.setState('working');
      this.startPolling();
      await this.refresh();
    });
    cancelBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      cancelBtn.disabled = true;
      el.querySelector('.inline-actions')?.remove();
      await sendMessage({ type: 'CANCEL_TASK', taskId: task.id });
      this.addSystemMessage('已取消任务');
      await this.refresh();
    });
  }

  private renderConfirmation(task: Task): void {
    const pc = task.pendingConfirmation!;
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = `
      <div class="bubble">
        ⚠️ 这是一个高风险操作，需要你确认：
        <div style="margin:6px 0;font-weight:600;">${this.escape(pc.tool)}</div>
        <div style="color:#6b7280;font-size:12px;">${this.escape(pc.reason)}</div>
        <div class="inline-actions">
          <button class="btn-ok">确认执行</button>
          <button class="btn-no">拒绝</button>
        </div>
      </div>`;
    this.messages.appendChild(el);
    this.scrollToBottom();

    const okBtn = el.querySelector('.btn-ok') as HTMLButtonElement;
    const noBtn = el.querySelector('.btn-no') as HTMLButtonElement;
    const finish = (confirmed: boolean) => async () => {
      okBtn.disabled = true;
      noBtn.disabled = true;
      el.querySelector('.inline-actions')?.remove();
      await sendMessage({ type: 'CONFIRM_TASK', taskId: task.id, confirmed });
      this.addSystemMessage(confirmed ? '已确认，继续执行' : '已拒绝该操作');
      this.startPolling();
      await this.refresh();
    };
    okBtn.addEventListener('click', finish(true));
    noBtn.addEventListener('click', finish(false));
  }

  private async refresh(): Promise<void> {
    if (!this.currentTask) return;
    try {
      const { task } = await sendMessage<{ task: Task }>({ type: 'GET_TASK', taskId: this.currentTask.id });
      if (task) this.onTaskUpdate(task);
    } catch {
      /* ignore */
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.currentTask) return;
      if (['running', 'planning', 'waiting_confirmation'].includes(this.currentTask.status)) {
        this.refresh();
      } else {
        this.stopPolling();
      }
    }, 1500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private escape(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

export function initFloatingUI(): void {
  if (window.top !== window.self) return; // skip iframes
  if (document.getElementById('ai-browser-agent-root')) return;
  if (location.protocol === 'chrome:' || location.protocol === 'chrome-extension:') return;
  new AgentWidget();
}
