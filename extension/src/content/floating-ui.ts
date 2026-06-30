import type {
  Task,
  TaskLogEntry,
  PlanStep,
  Workflow,
  ChatSession,
} from '@ai-browser-agent/shared';
import { extractPageContext } from './page-context.js';

type AgentState = 'idle' | 'thinking' | 'working' | 'happy' | 'error' | 'waiting';

const BALL_POS_KEY = 'agent_ball_pos';
// Whether the user has explicitly minimized the panel. Persisted so the panel
// stays open across task-driven navigations (the content script reloads each
// time) unless the user chose to collapse it.
const PANEL_MIN_KEY = 'agent_panel_minimized';

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
function sparkSvg(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" fill="#fff"/>
    <circle cx="19" cy="5" r="1.4" fill="#fff" opacity="0.85"/>
  </svg>`;
}

function refreshSvg(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-.5 3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

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

/* Page-aware suggestion pills floating next to the ball (teaser when collapsed) */
.suggest-bar {
  position: fixed;
  z-index: 2147483645;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  transform: translateY(-50%);
  pointer-events: none;
}
.suggest-bar.flip { align-items: flex-start; }
.suggest-bar.hidden { display: none; }
.suggest-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  padding: 10px 16px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  text-align: left;
  background: linear-gradient(100deg, #7c83ff 0%, #8b7cf6 42%, #56c8b2 100%);
  box-shadow: 0 6px 18px rgba(99,102,241,0.38);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: transform 0.12s ease, box-shadow 0.2s ease, opacity 0.2s ease;
  animation: pillIn 0.26s cubic-bezier(0.2,0.8,0.2,1) both;
}
.suggest-pill .spark { flex: 0 0 auto; display: inline-flex; }
.suggest-pill .pill-text { overflow: hidden; text-overflow: ellipsis; }
.suggest-pill:hover { transform: translateX(-3px) scale(1.03); box-shadow: 0 9px 24px rgba(99,102,241,0.55); }
.suggest-bar.flip .suggest-pill:hover { transform: translateX(3px) scale(1.03); }
.suggest-pill.refresh {
  background: rgba(255,255,255,0.92);
  color: #6366f1;
  font-weight: 600;
  padding: 7px 14px;
  box-shadow: 0 4px 14px rgba(17,24,39,0.16);
  border: 1px solid rgba(99,102,241,0.25);
}
.suggest-pill.refresh:hover { box-shadow: 0 7px 18px rgba(17,24,39,0.22); }
.suggest-pill.refresh .spark { color: #6366f1; }
.suggest-pill.refresh.spin .spark { animation: refreshSpin 0.6s linear; }
@keyframes refreshSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pillIn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
.suggest-bar.flip .suggest-pill { animation-name: pillInFlip; }
@keyframes pillInFlip { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: translateX(0); } }

/* Centered result overlay: present substantial output in a rich, readable card */
.result-modal { position: fixed; inset: 0; z-index: 2147483647; display: none; }
.result-modal.open { display: block; }
.rm-backdrop { position: absolute; inset: 0; background: rgba(15,17,33,0.55); backdrop-filter: blur(3px); animation: rmFade 0.2s ease; }
.rm-card {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: min(760px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: #fff; border-radius: 16px; overflow: hidden;
  box-shadow: 0 24px 70px rgba(0,0,0,0.42); animation: rmPop 0.24s cubic-bezier(0.2,0.8,0.2,1);
}
.rm-head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px; color: #fff;
  background: linear-gradient(100deg,#6366f1,#8b5cf6 55%,#22b8a6);
}
.rm-spark { display: inline-flex; flex: 0 0 auto; }
.rm-title { flex: 1; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rm-copy-all, .rm-close { border: none; background: rgba(255,255,255,0.18); color: #fff; cursor: pointer; border-radius: 8px; font-size: 13px; }
.rm-copy-all { padding: 5px 10px; }
.rm-close { font-size: 18px; line-height: 1; padding: 3px 9px; }
.rm-copy-all:hover, .rm-close:hover { background: rgba(255,255,255,0.34); }
.rm-body { padding: 18px 20px; overflow: auto; color: #1f2433; font-size: 14px; line-height: 1.62; }
.rm-h { margin: 16px 0 8px; font-weight: 700; line-height: 1.3; }
.rm-h:first-child { margin-top: 0; }
h1.rm-h { font-size: 20px; } h2.rm-h { font-size: 18px; } h3.rm-h { font-size: 16px; } h4.rm-h { font-size: 15px; }
.rm-p { margin: 8px 0; }
.rm-ul, .rm-ol { margin: 8px 0; padding-left: 22px; }
.rm-ul li, .rm-ol li { margin: 4px 0; }
.rm-code { margin: 12px 0; border-radius: 10px; overflow: hidden; }
.rm-code-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background: #1b1f2e; color: #9aa4c0; font-size: 12px; }
.rm-code-head .rm-copy { border: none; background: #2a3146; color: #cdd6f4; border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
.rm-code-head .rm-copy:hover { background: #3a4366; }
.rm-code pre { margin: 0; padding: 12px 14px; overflow: auto; background: #0f1117; color: #e6e9f5; font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size: 12.5px; line-height: 1.55; white-space: pre; }
.rm-table-wrap { overflow: auto; margin: 12px 0; }
.rm-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.rm-table th, .rm-table td { border: 1px solid #e5e7f0; padding: 7px 10px; text-align: left; }
.rm-table th { background: #f3f4fb; font-weight: 700; }
.rm-body a { color: #4f46e5; word-break: break-all; }
.rm-badge { flex: 0 0 auto; font-size: 12px; font-weight: 600; background: rgba(255,255,255,0.22); color: #fff; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.rm-actions { display: flex; gap: 6px; }
.rm-act-btn { border: none; background: rgba(255,255,255,0.18); color: #fff; cursor: pointer; border-radius: 8px; padding: 5px 10px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.rm-act-btn:hover { background: rgba(255,255,255,0.34); }

/* links template */
.rm-links { display: flex; flex-direction: column; gap: 8px; }
.rm-link { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid #e5e7f0; border-radius: 10px; text-decoration: none; transition: border-color 0.15s, background 0.15s; }
.rm-link:hover { border-color: #a5b4fc; background: #f5f6ff; }
.rm-link-t { color: #1f2433; font-weight: 600; font-size: 13.5px; word-break: break-word; }
.rm-link-u { color: #6b7280; font-size: 12px; word-break: break-all; }

/* key-value / facts template */
.rm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 0; margin: 0; border: 1px solid #e5e7f0; border-radius: 10px; overflow: hidden; }
.rm-kv-row { display: contents; }
.rm-kv dt { background: #f6f7fc; color: #4338ca; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #eceef6; }
.rm-kv dd { margin: 0; padding: 9px 12px; border-bottom: 1px solid #eceef6; color: #1f2433; word-break: break-word; }
.rm-kv .rm-kv-row:last-child dt, .rm-kv .rm-kv-row:last-child dd { border-bottom: none; }

/* checklist / cards template */
.rm-cards { display: flex; flex-direction: column; gap: 8px; }
.rm-card-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: #f7f8fd; border: 1px solid #eceef6; border-radius: 10px; font-size: 13.5px; line-height: 1.5; }
.rm-card-item .rm-dot { flex: 0 0 auto; width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: linear-gradient(135deg,#6366f1,#22b8a6); }

@keyframes rmFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rmPop { from { opacity: 0; transform: translate(-50%,-46%) scale(0.96); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }

/* Compact result card shown inside chat with a button to open the overlay */
.res-card { display: flex; flex-direction: column; gap: 8px; }
.res-card-row { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.res-preview { color: #6b7280; font-size: 12.5px; line-height: 1.5; max-height: 58px; overflow: hidden; }
.btn-view { align-self: flex-start; border: none; border-radius: 8px; cursor: pointer; padding: 6px 14px; font-size: 12.5px; font-weight: 600; color: #fff; background: linear-gradient(100deg,#6366f1,#8b5cf6 60%,#22b8a6); }
.btn-view:hover { filter: brightness(1.06); }

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
.panel-header .stop-btn { background: #ef4444; color: #fff; font-size: 12px; padding: 2px 8px; width: auto; border-radius: 6px; font-weight: 600; }
.panel-header .stop-btn:hover { background: #dc2626; }
.panel-header .stop-btn:disabled { opacity: 0.6; cursor: default; }

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
.bubble .plan-hint { color: #9ca3af; font-size: 11px; margin-top: 4px; }
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
.composer .opts .mode-select {
  font-size: 11px; padding: 2px 4px; border: 1px solid #d1d5db; border-radius: 5px;
  background: #fff; color: #374151; cursor: pointer; font-family: inherit;
}
.composer .opts .mode-select:focus { outline: none; border-color: #a5b4fc; }
.msg.agent .bubble .md-code { background: #eef2ff; color: #3730a3; padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.msg.agent .bubble .md-pre { background: #1e293b; color: #e2e8f0; padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; margin: 6px 0; white-space: pre-wrap; }
.msg.agent .bubble a { color: #4f46e5; text-decoration: underline; }
.inline-actions .btn-continue { background: #4f46e5; color: #fff; border: none; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
.inline-actions .btn-retry { background: #fff; color: #4f46e5; border: 1px solid #c7d2fe; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
.plan-step.done { color: #16a34a; text-decoration: line-through; opacity: 0.75; }
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
  private modeSelect!: HTMLSelectElement;
  private loopChk!: HTMLInputElement;
  private loopInterval!: HTMLInputElement;
  private sessionDrawer!: HTMLDivElement;
  private wfDrawer!: HTMLDivElement;
  private sessionList!: HTMLDivElement;
  private wfList!: HTMLDivElement;
  private stopBtn!: HTMLButtonElement;

  private currentSessionId: string | null = null;
  private sessions: ChatSession[] = [];
  private savedWorkflowFor = new Set<string>();
  private currentTask: Task | null = null;
  private streamBubbles = new Map<string, HTMLElement>();
  private suggestBar!: HTMLDivElement;
  private resultModal!: HTMLDivElement;
  private resultModalRaw = '';
  private userMinimized = false;
  // Rotating pool of "what can I do here" suggestions + the current 3-wide window
  // offset, so the user can cycle through batches with the 换一批 control.
  private suggestPool: Array<{ label: string; prompt: string }> = [];
  private suggestOffset = 0;
  // Set when the user manually (re)loaded a page that still has a live task bound
  // to it: keep the panel minimized + suggestions until the user opens it, even as
  // live task updates keep streaming in.
  private autoOpenSuppressed = false;
  private renderedLogIds = new Set<string>();
  private planRenderedFor: string | null = null;
  private planEl: HTMLElement | null = null;
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

    const suggestBar = document.createElement('div');
    suggestBar.className = 'suggest-bar hidden';
    this.root.appendChild(suggestBar);
    this.suggestBar = suggestBar;

    const modal = document.createElement('div');
    modal.className = 'result-modal';
    modal.innerHTML = `
      <div class="rm-backdrop"></div>
      <div class="rm-card">
        <div class="rm-head">
          <span class="rm-spark">${sparkSvg()}</span>
          <div class="rm-title">任务结果</div>
          <span class="rm-badge"></span>
          <div class="rm-actions"></div>
          <button class="rm-copy-all" title="复制全部">⧉ 复制</button>
          <button class="rm-close" title="关闭">×</button>
        </div>
        <div class="rm-body"></div>
      </div>`;
    this.root.appendChild(modal);
    this.resultModal = modal;
    (modal.querySelector('.rm-close') as HTMLButtonElement).addEventListener('click', () => this.closeResultModal());
    (modal.querySelector('.rm-backdrop') as HTMLElement).addEventListener('click', () => this.closeResultModal());
    (modal.querySelector('.rm-copy-all') as HTMLButtonElement).addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      navigator.clipboard
        ?.writeText(this.resultModalRaw)
        .then(() => {
          btn.textContent = '✓ 已复制';
          setTimeout(() => (btn.textContent = '⧉ 复制'), 1500);
        })
        .catch(() => {});
    });

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
        <button class="stop-btn" title="停止当前任务" style="display:none">⏹ 停止</button>
        <button class="min-btn" title="收起">—</button>
      </div>
      <div class="messages"></div>
      <div class="composer">
        <div class="row">
          <textarea class="input" rows="1" placeholder="告诉我你想做什么…例如：提取本页所有链接并总结"></textarea>
          <button class="send" title="发送">➤</button>
        </div>
        <div class="opts">
          <select class="mode-select" title="交互模式">
            <option value="auto">⚡ 自动</option>
            <option value="ask">💬 问答</option>
            <option value="agent">🤖 执行</option>
            <option value="plan">📋 仅计划</option>
          </select>
          <label><input type="checkbox" class="loop-chk"> 循环</label>
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
    this.modeSelect = panel.querySelector('.mode-select') as HTMLSelectElement;
    this.loopChk = panel.querySelector('.loop-chk') as HTMLInputElement;
    this.loopInterval = panel.querySelector('.loop-interval') as HTMLInputElement;
    this.sessionDrawer = panel.querySelector('.session-drawer') as HTMLDivElement;
    this.wfDrawer = panel.querySelector('.wf-drawer') as HTMLDivElement;
    this.sessionList = panel.querySelector('.session-list') as HTMLDivElement;
    this.wfList = panel.querySelector('.wf-list') as HTMLDivElement;
    this.stopBtn = panel.querySelector('.stop-btn') as HTMLButtonElement;

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
      this.positionSuggestBar();
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
      this.minimizePanel();
    });

    (this.panel.querySelector('.new-btn') as HTMLButtonElement).addEventListener('click', () => this.newSession());
    (this.panel.querySelector('.session-btn') as HTMLButtonElement).addEventListener('click', () => this.toggleSessionDrawer());
    (this.panel.querySelector('.wf-btn') as HTMLButtonElement).addEventListener('click', () => this.toggleWfDrawer());
    (this.panel.querySelector('.new-session-btn') as HTMLButtonElement).addEventListener('click', () => this.newSession());
    this.panel.querySelectorAll('.drawer-close').forEach((b) =>
      b.addEventListener('click', () => this.closeDrawers())
    );

    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.stopBtn.addEventListener('click', () => this.stopCurrentTask());
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
      if (message.type === 'AGENT_EVENT' && message.taskId) {
        this.onAgentEvent(message.taskId, message.event ?? {});
      }
    });

    window.addEventListener('resize', () => {
      if (this.panel.classList.contains('open')) this.positionPanel();
      this.positionSuggestBar();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.resultModal.classList.contains('open')) {
        this.closeResultModal();
      }
    });
  }

  private async init(): Promise<void> {
    try {
      const s = await chrome.storage.local.get(PANEL_MIN_KEY);
      this.userMinimized = !!s[PANEL_MIN_KEY];
    } catch {
      /* default to not minimized */
    }
    try {
      await sendMessage({ type: 'CONNECT_BACKEND' });
      const status = await sendMessage<{ connected: boolean }>({ type: 'GET_BACKEND_STATUS' });
      this.setConnected(status.connected);
    } catch {
      this.setConnected(false);
    }
    // Resume an in-progress task if the agent is operating this tab; otherwise
    // (a page the user opened themselves) offer contextual operation hints.
    const resumed = await this.reattach();
    if (!resumed) void this.showPageSuggestions();
  }

  /**
   * After a navigation (or any fresh page load) the floating UI is recreated with
   * no state. Ask the background whether a task bound to this tab is still running
   * server-side and, if so, resume showing its live progress — the agent's lifecycle
   * is independent of the page. Returns true when a task was resumed.
   */
  private async reattach(): Promise<boolean> {
    try {
      const { task, agentDriven } = await sendMessage<{ task: Task | null; agentDriven?: boolean }>({
        type: 'GET_ACTIVE_TASK',
      });
      if (!task) return false;
      this.currentSessionId = task.sessionId ?? this.currentSessionId;
      this.resetTaskRenderState();

      // The page navigated and recreated this UI empty. Before resuming the live
      // task, replay the rest of its session (prior tasks' plans, steps, outcomes)
      // so earlier conversation history isn't lost on every navigation/refresh.
      if (task.sessionId) {
        try {
          const { tasks } = await sendMessage<{ session?: ChatSession; tasks?: Task[] }>({
            type: 'GET_SESSION',
            sessionId: task.sessionId,
          });
          const prior = (tasks ?? []).filter((t) => t.id !== task.id);
          if (prior.length) {
            this.messages.innerHTML = '';
            this.suggestBar?.classList.add('hidden');
            for (const t of prior) this.renderHistoricalTask(t);
          }
        } catch {
          /* backend offline or no session — fall back to just the live task */
        }
      }

      this.addSystemMessage('↻ 已重新接管进行中的任务');
      this.onTaskUpdate(task);
      this.notifyBadge();
      if (agentDriven && !this.userMinimized) {
        // The agent itself navigated here as part of the task → keep panel open.
        this.openPanel();
      } else if (!agentDriven) {
        // The USER manually refreshed / opened this page (a task just happens to
        // still be bound to the tab). Stay minimized and surface suggestions, and
        // suppress auto-open so live task updates don't pop the panel back open.
        this.autoOpenSuppressed = true;
        this.panel.classList.remove('open');
        void this.showPageSuggestions();
      }
      clientLog('info', 'task', '导航后重新接管任务', { status: task.status, agentDriven }, task.id);
      return true;
    } catch {
      return false; // no active task or backend offline
    }
  }

  /**
   * On a freshly opened page (by the user, not the agent), show 2-3 context-aware
   * hints about what the agent can do here, to help users discover capabilities.
   */
  private async showPageSuggestions(): Promise<void> {
    // Show fast local heuristics immediately as pills next to the ball, then
    // upgrade them in place with page-aware suggestions from the model. The
    // pills are an unobtrusive teaser — they do NOT auto-open the chat panel.
    this.suggestPool = this.dedupeSuggestions(this.buildSuggestions());
    this.suggestOffset = 0;
    if (this.suggestPool.length) this.renderSuggestionWindow();

    if (!this.connected) return;
    try {
      const pageContext = extractPageContext();
      const { suggestions } = await sendMessage<{
        suggestions?: Array<{ label: string; prompt: string }>;
      }>({ type: 'SUGGEST_ACTIONS', pageContext });
      const list = (suggestions ?? []).filter((s) => s?.label && s?.prompt);
      if (list.length) {
        // Model suggestions are the most relevant → show them first, keep the
        // heuristic ones as extra batches the user can cycle to with 换一批.
        this.suggestPool = this.dedupeSuggestions([...list, ...this.suggestPool]);
        this.suggestOffset = 0;
        this.renderSuggestionWindow();
      }
    } catch {
      /* offline or model error — the heuristic pills already shown stand */
    }
  }

  private dedupeSuggestions(
    items: Array<{ label: string; prompt: string }>
  ): Array<{ label: string; prompt: string }> {
    const seen = new Set<string>();
    return items.filter((s) => (s?.label && !seen.has(s.label) ? seen.add(s.label) : false));
  }

  /** Render the current 3-wide window of the suggestion pool (plus 换一批). */
  private renderSuggestionWindow(): void {
    const pool = this.suggestPool;
    if (!pool.length) return;
    const win: Array<{ label: string; prompt: string }> = [];
    const span = Math.min(3, pool.length);
    for (let i = 0; i < span; i++) win.push(pool[(this.suggestOffset + i) % pool.length]);
    // Offer 换一批 whenever there's more to show than one window, or we can ask
    // the model for a fresh batch.
    this.renderSuggestions(win, pool.length > span || this.connected);
  }

  /** Advance to the next batch, fetching fresh model suggestions when exhausted. */
  private async cycleSuggestions(): Promise<void> {
    this.suggestOffset += 3;
    if (this.suggestOffset >= this.suggestPool.length) {
      this.suggestOffset = 0;
      await this.fetchMoreSuggestions();
    }
    this.renderSuggestionWindow();
  }

  /** Ask the model for additional, non-duplicate suggestions for this page. */
  private async fetchMoreSuggestions(): Promise<void> {
    if (!this.connected) return;
    try {
      const pageContext = extractPageContext();
      const exclude = this.suggestPool.map((s) => s.label);
      const { suggestions } = await sendMessage<{
        suggestions?: Array<{ label: string; prompt: string }>;
      }>({ type: 'SUGGEST_ACTIONS', pageContext, exclude });
      const fresh = (suggestions ?? []).filter((s) => s?.label && s?.prompt);
      const seen = new Set(this.suggestPool.map((s) => s.label));
      const added = fresh.filter((s) => !seen.has(s.label));
      if (added.length) this.suggestPool.push(...added);
    } catch {
      /* keep the existing pool and just rotate within it */
    }
  }

  /** Heuristically derive operation hints from what's actually on the page. */
  private buildSuggestions(): Array<{ label: string; prompt: string }> {
    const out: Array<{ label: string; prompt: string }> = [];
    const has = (sel: string): boolean => !!document.querySelector(sel);
    const count = (sel: string): number => document.querySelectorAll(sel).length;

    const hasPassword = has('input[type="password"]');
    const formFields = count('input:not([type="hidden"]), textarea, select');
    const tableCount = count('table');
    const listItems = count('ul li, ol li');
    const linkCount = count('a[href]');
    const imgCount = count('img');
    const textLen = (document.body?.innerText ?? '').length;
    const hasPagination = Array.from(document.querySelectorAll('a, button')).some((e) =>
      /next|下一页|下页|更多|加载更多|load more|page\s*\d/i.test(e.textContent ?? '')
    );

    if (hasPassword) {
      out.push({
        label: '帮我填写登录表单',
        prompt: '识别本页的登录表单并帮我填写（用户名/密码我来确认），填完先不要自动提交',
      });
    } else if (formFields >= 2 || has('form')) {
      out.push({
        label: '帮我填写这个表单',
        prompt: '识别并帮我填写本页表单的各个字段，填完后让我确认再提交',
      });
    }
    if (tableCount > 0) {
      out.push({ label: '提取表格数据', prompt: '提取本页所有表格的数据并整理成结构化列表' });
    } else if (listItems >= 10) {
      out.push({ label: '采集列表数据', prompt: '提取本页列表中的所有条目信息并汇总成表格' });
    }
    if (hasPagination) {
      out.push({
        label: '翻页采集全部数据',
        prompt: '逐页翻页并采集每一页的数据，直到没有下一页为止，最后汇总',
      });
    }
    if (textLen > 1500) {
      out.push({ label: '总结本页内容', prompt: '阅读并用要点总结这个页面的主要内容' });
    }
    if (linkCount > 15) {
      out.push({ label: '提取所有链接', prompt: '提取本页所有链接并按类别汇总' });
    }
    if (imgCount > 5) {
      out.push({ label: '提取所有图片', prompt: '提取本页所有图片的地址并列出' });
    }
    // Always-available nicety as filler.
    out.push({ label: '切换暗色主题', prompt: '把这个页面切换成护眼的暗色主题' });

    const seen = new Set<string>();
    return out.filter((s) => (seen.has(s.label) ? false : seen.add(s.label))).slice(0, 8);
  }

  /** Render page-aware suggestions as gradient pill bars floating next to the ball. */
  private renderSuggestions(
    items: Array<{ label: string; prompt: string }>,
    showRefresh = false
  ): void {
    if (!items.length) return;
    this.suggestBar.innerHTML = '';
    items.slice(0, 3).forEach((s) => {
      const pill = document.createElement('button');
      pill.className = 'suggest-pill';
      pill.title = s.prompt;
      pill.innerHTML = `<span class="spark">${sparkSvg()}</span><span class="pill-text"></span>`;
      (pill.querySelector('.pill-text') as HTMLElement).textContent = s.label;
      pill.addEventListener('click', () => {
        this.suggestBar.classList.add('hidden');
        this.autoOpenSuppressed = false;
        if (!this.panel.classList.contains('open')) this.openPanel();
        void this.setMinimized(false);
        // Run the suggested task right away instead of leaving it in the input.
        this.input.value = s.prompt;
        void this.handleSend();
      });
      this.suggestBar.appendChild(pill);
    });
    if (showRefresh) {
      const refresh = document.createElement('button');
      refresh.className = 'suggest-pill refresh';
      refresh.title = '换一批建议';
      refresh.innerHTML = `<span class="spark">${refreshSvg()}</span><span class="pill-text">换一批</span>`;
      refresh.addEventListener('click', (e) => {
        e.stopPropagation();
        refresh.classList.remove('spin');
        // Restart the spin animation each click.
        void refresh.offsetWidth;
        refresh.classList.add('spin');
        void this.cycleSuggestions();
      });
      this.suggestBar.appendChild(refresh);
    }
    // Only reveal the teaser while the panel is collapsed; it would be redundant
    // (and visually clash) over an open chat panel.
    if (!this.panel.classList.contains('open')) {
      this.suggestBar.classList.remove('hidden');
      this.positionSuggestBar();
    }
    clientLog('info', 'ui', '展示页面操作建议', { count: items.length });
  }

  /** Keep the suggestion pill bar glued to whichever side of the ball has room. */
  private positionSuggestBar(): void {
    if (!this.suggestBar || this.suggestBar.classList.contains('hidden')) return;
    const r = this.ball.getBoundingClientRect();
    const gap = 12;
    this.suggestBar.style.top = `${r.top + r.height / 2}px`;
    this.suggestBar.style.bottom = 'auto';
    if (r.left < 360) {
      // Not enough room on the left — flip the pills to the right of the ball.
      this.suggestBar.style.left = `${r.right + gap}px`;
      this.suggestBar.style.right = 'auto';
      this.suggestBar.classList.add('flip');
    } else {
      this.suggestBar.style.right = `${window.innerWidth - r.left + gap}px`;
      this.suggestBar.style.left = 'auto';
      this.suggestBar.classList.remove('flip');
    }
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.statusDot.classList.toggle('connected', connected);
  }

  private togglePanel(): void {
    if (this.panel.classList.contains('open')) {
      this.minimizePanel();
    } else {
      this.autoOpenSuppressed = false;
      this.openPanel();
      this.input.focus();
      void this.setMinimized(false);
    }
  }

  /** Open the panel (idempotent) without touching the user-minimized flag. */
  private openPanel(): void {
    this.panel.classList.add('open');
    this.suggestBar?.classList.add('hidden');
    this.positionPanel();
    this.badge.classList.remove('show');
    this.badge.textContent = '';
  }

  /** User explicitly collapsed the panel — remember it across navigations. */
  private minimizePanel(): void {
    this.panel.classList.remove('open');
    void this.setMinimized(true);
    // Surface the suggestion teaser again so the collapsed ball still offers
    // page-aware shortcuts (with a 换一批 control to cycle batches).
    void this.showPageSuggestions();
  }

  private async setMinimized(v: boolean): Promise<void> {
    this.userMinimized = v;
    try {
      await chrome.storage.local.set({ [PANEL_MIN_KEY]: v });
    } catch {
      /* storage unavailable — in-memory flag still applies for this page */
    }
  }

  private setState(state: AgentState): void {
    this.ball.dataset.state = state;
    // Show the global stop button whenever a task is actively running.
    const active = state === 'working' || state === 'thinking' || state === 'waiting';
    if (this.stopBtn) this.stopBtn.style.display = active ? '' : 'none';
  }

  private async stopCurrentTask(): Promise<void> {
    const taskId = this.currentTask?.id;
    if (!taskId) {
      this.stopBtn.style.display = 'none';
      return;
    }
    this.stopBtn.disabled = true;
    try {
      await sendMessage({ type: 'CANCEL_TASK', taskId });
      this.addSystemMessage('⏹ 已停止任务');
    } catch (err) {
      this.addSystemMessage(`停止失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.stopBtn.disabled = false;
      this.stopBtn.style.display = 'none';
      this.stopPolling();
      this.setState('idle');
      await this.refresh();
    }
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
    (el.querySelector('.bubble') as HTMLElement).innerHTML = this.mdToHtml(text);
    this.messages.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  /** Lightweight, safe markdown: code, bold, links, line breaks. */
  private mdToHtml(text: string): string {
    return this.escape(text ?? '')
      .replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre class="md-pre">${code.replace(/^\n/, '')}</pre>`)
      .replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\n/g, '<br>');
  }

  /** Heuristic: is the result rich/long enough to deserve the centered overlay? */
  private isSubstantialResult(text: string): boolean {
    const t = (text ?? '').trim();
    if (!t) return false;
    if (t.length >= 160) return true;
    if (/```/.test(t)) return true; // a code/command block
    if (/(^|\n)\s*\|.+\|/.test(t)) return true; // a markdown table
    const lines = t.split('\n').filter((l) => l.trim());
    if (lines.length >= 4) return true;
    if (lines.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l)).length >= 3) return true;
    return false;
  }

  /** A compact in-chat card that links to the full result overlay. */
  private addResultCard(title: string, label: string, text: string): void {
    const preview = text.replace(/`{1,3}/g, '').replace(/\s+/g, ' ').trim().slice(0, 96);
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = `
      <div class="bubble">
        <div class="res-card">
          <div class="res-card-row"><span>📄</span><span></span></div>
          <div class="res-preview"></div>
          <div class="inline-actions"><button class="btn-view">🔎 查看完整结果</button></div>
        </div>
      </div>`;
    (el.querySelector('.res-card-row span:last-child') as HTMLElement).textContent = label;
    (el.querySelector('.res-preview') as HTMLElement).textContent = preview + (text.length > 96 ? '…' : '');
    (el.querySelector('.btn-view') as HTMLButtonElement).addEventListener('click', () =>
      this.openResultModal(title, text)
    );
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  /** Present substantial output in the centered overlay + a compact chat card. */
  private presentResult(task: Task, label: string, text: string, autoOpen: boolean): void {
    const title = task.userRequest?.trim() ? task.userRequest.trim().slice(0, 60) : '任务结果';
    this.addResultCard(title, label, text);
    if (autoOpen) this.openResultModal(title, text);
  }

  private static RESULT_BADGES: Record<string, string> = {
    code: '💻 代码',
    table: '📊 表格',
    links: '🔗 链接',
    kv: '🧾 信息',
    list: '📋 清单',
    article: '📄 摘要',
  };

  private openResultModal(title: string, content: string): void {
    this.resultModalRaw = content;
    const type = this.detectResultType(content);
    (this.resultModal.querySelector('.rm-title') as HTMLElement).textContent = title || '任务结果';
    (this.resultModal.querySelector('.rm-badge') as HTMLElement).textContent = AgentWidget.RESULT_BADGES[type];

    const body = this.resultModal.querySelector('.rm-body') as HTMLElement;
    body.className = `rm-body rm-type-${type}`;
    body.innerHTML = this.renderResultBody(content, type);
    body.querySelectorAll('.rm-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = decodeURIComponent((btn as HTMLElement).dataset.code ?? '');
        navigator.clipboard
          ?.writeText(code)
          .then(() => {
            (btn as HTMLElement).textContent = '已复制';
            setTimeout(() => ((btn as HTMLElement).textContent = '复制'), 1500);
          })
          .catch(() => {});
      });
    });

    this.renderResultActions(type, content);
    body.scrollTop = 0;
    this.resultModal.classList.add('open');
  }

  /** Type-specific header actions (export CSV for tables, open-all for links). */
  private renderResultActions(type: ReturnType<AgentWidget['detectResultType']>, content: string): void {
    const host = this.resultModal.querySelector('.rm-actions') as HTMLElement;
    host.innerHTML = '';
    const addBtn = (text: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.className = 'rm-act-btn';
      b.textContent = text;
      b.addEventListener('click', onClick);
      host.appendChild(b);
    };

    if (type === 'table') {
      addBtn('⬇ 导出 CSV', () => {
        const csv = this.tableToCsv(content);
        if (!csv) return;
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'result.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      });
    } else if (type === 'links') {
      const links = this.parseLinks(content);
      if (links.length) {
        addBtn(`↗ 全部打开 (${links.length})`, () => {
          links.slice(0, 15).forEach((li) => window.open(li.url, '_blank', 'noopener'));
        });
      }
    }
  }

  /** Convert the first markdown table in the text to CSV. */
  private tableToCsv(text: string): string {
    const lines = text.split('\n');
    const rows: string[][] = [];
    const cell = (s: string): string[] => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('|') && /^\s*\|?[\s:|-]*-{2,}/.test(lines[i + 1] ?? '')) {
        rows.push(cell(lines[i]));
        i++;
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
          rows.push(cell(lines[++i]));
        }
        break;
      }
    }
    return rows
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
  }

  private closeResultModal(): void {
    this.resultModal.classList.remove('open');
  }

  /** Inline markdown (code, bold, links) → safe HTML. Shared by all templates. */
  private mdInline(s: string): string {
    return this.escape(s)
      .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }

  private codeBlockHtml(lang: string, raw: string): string {
    return (
      `<div class="rm-code"><div class="rm-code-head"><span>${this.escape(lang || 'code')}</span>` +
      `<button class="rm-copy" data-code="${encodeURIComponent(raw)}">复制</button></div>` +
      `<pre>${this.escape(raw)}</pre></div>`
    );
  }

  /** Classify the result so we can pick the most fitting presentation template. */
  private detectResultType(text: string): 'code' | 'table' | 'links' | 'kv' | 'list' | 'article' {
    const t = (text ?? '').trim();
    if (!t) return 'article';
    const fences = t.match(/```[\s\S]*?```/g);
    if (fences && fences.join('').length > t.length * 0.6) return 'code';
    if (!/\n/.test(t) && /^(\.\/|\$\s|sudo |npm |npx |yarn |pnpm |git |curl |wget |kubectl |docker |python |node )/.test(t)) {
      return 'code';
    }
    if (/(^|\n)\s*\|.+\|/.test(t) && /(^|\n)\s*\|?[\s:|-]*-{2,}/.test(t)) return 'table';
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    const urlCount = (t.match(/https?:\/\/[^\s)]+/g) ?? []).length;
    const linkLines = lines.filter((l) => /https?:\/\//.test(l));
    if (lines.length >= 3 && urlCount >= 3 && linkLines.length >= Math.max(3, lines.length * 0.6)) return 'links';
    const kvLines = lines.filter((l) => /^[^:：]{1,40}[:：]\s*\S/.test(l.replace(/^[-*]\s*/, '')) && !/^https?:/.test(l));
    if (lines.length >= 3 && kvLines.length >= Math.max(3, lines.length * 0.6)) return 'kv';
    // Prose (incl. bullet-point summaries like a README overview) reads best as a
    // flowing rich-text article — the article template already renders <ul> lists.
    return 'article';
  }

  private parseLinks(text: string): Array<{ text: string; url: string }> {
    const out: Array<{ text: string; url: string }> = [];
    for (const l of text.split('\n')) {
      const md = l.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
      if (md) {
        out.push({ text: md[1].trim(), url: md[2] });
        continue;
      }
      const u = l.match(/https?:\/\/[^\s)]+/);
      if (u) {
        const label = l.replace(u[0], '').replace(/^[-*\d.\s|]+/, '').replace(/[|\-–:：]\s*$/, '').trim();
        out.push({ text: label || u[0], url: u[0] });
      }
    }
    return out;
  }

  /** Render the result body using a template chosen for its detected type. */
  private renderResultBody(text: string, type: ReturnType<AgentWidget['detectResultType']>): string {
    switch (type) {
      case 'code': {
        const blocks = [...text.matchAll(/```(\w*)\n?([\s\S]*?)```/g)];
        if (blocks.length) {
          return blocks.map((b) => this.codeBlockHtml(b[1] || 'code', b[2].replace(/\n$/, ''))).join('');
        }
        return this.codeBlockHtml('command', text.trim());
      }
      case 'links': {
        const links = this.parseLinks(text);
        return `<div class="rm-links">${links
          .map(
            (li) =>
              `<a class="rm-link" href="${this.escape(li.url)}" target="_blank" rel="noopener noreferrer">` +
              `<span class="rm-link-t">${this.escape(li.text)}</span>` +
              `<span class="rm-link-u">${this.escape(li.url)}</span></a>`
          )
          .join('')}</div>`;
      }
      case 'kv': {
        const rows = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.replace(/^[-*]\s*/, '').match(/^([^:：]+)[:：]\s*(.+)$/))
          .filter((m): m is RegExpMatchArray => !!m);
        return `<dl class="rm-kv">${rows
          .map((m) => `<div class="rm-kv-row"><dt>${this.escape(m[1].trim())}</dt><dd>${this.mdInline(m[2].trim())}</dd></div>`)
          .join('')}</dl>`;
      }
      case 'list': {
        const items = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^([-*]|\d+\.)\s+/.test(l))
          .map((l) => l.replace(/^([-*]|\d+\.)\s+/, ''));
        return `<div class="rm-cards">${items
          .map((it) => `<div class="rm-card-item"><span class="rm-dot"></span><span>${this.mdInline(it)}</span></div>`)
          .join('')}</div>`;
      }
      case 'table':
      case 'article':
      default:
        return this.renderRichMarkdown(text);
    }
  }

  /** Block-level markdown → HTML for the overlay: headings, lists, tables, code. */
  private renderRichMarkdown(text: string): string {
    const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
    const splitRow = (s: string): string[] =>
      s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const inline = (s: string): string => this.mdInline(s);
    const isTableSep = (l?: string): boolean => !!l && /^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/.test(l) && l.includes('-');

    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line.trim())) {
        const lang = line.trim().slice(3).trim();
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
        i++; // closing fence
        const raw = buf.join('\n');
        out.push(
          `<div class="rm-code"><div class="rm-code-head"><span>${this.escape(lang || 'code')}</span>` +
            `<button class="rm-copy" data-code="${encodeURIComponent(raw)}">复制</button></div>` +
            `<pre>${this.escape(raw)}</pre></div>`
        );
        continue;
      }
      if (line.includes('|') && isTableSep(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        const thead = `<tr>${header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>`;
        const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="rm-table-wrap"><table class="rm-table">${thead}${tbody}</table></div>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        out.push(`<h${h[1].length} class="rm-h">${inline(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
        out.push(`<ul class="rm-ul">${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
        out.push(`<ol class="rm-ol">${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
        continue;
      }
      if (line.trim() === '') {
        i++;
        continue;
      }
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i].trim()) &&
        !/^#{1,4}\s/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !(lines[i].includes('|') && isTableSep(lines[i + 1]))
      ) {
        para.push(lines[i++]);
      }
      out.push(`<p class="rm-p">${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
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
    this.suggestBar?.classList.add('hidden');
    // Starting a new task: ensure the panel is considered open for the run so it
    // persists across any navigations the task triggers.
    this.autoOpenSuppressed = false;
    void this.setMinimized(false);

    // If a task is actively running, treat this message as a mid-run steer
    // (Cursor-style) rather than starting a brand-new task.
    if (this.currentTask && this.currentTask.status === 'running') {
      try {
        const { ok } = await sendMessage<{ ok?: boolean }>({
          type: 'STEER_TASK',
          taskId: this.currentTask.id,
          text,
        });
        if (ok) {
          this.addSystemMessage('🧭 已追加指令，Agent 会在下一步纳入');
          return;
        }
      } catch {
        /* fall through to creating a new task */
      }
    }

    this.sendBtn.disabled = true;
    this.setState('thinking');

    const thinking = this.addThinking();
    const isLoop = this.loopChk.checked;
    const loopIntervalMs = parseInt(this.loopInterval.value, 10) || 60000;
    const requestMode = this.modeSelect.value || 'auto';

    try {
      await this.ensureSession(text);
      const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
        type: 'CREATE_TASK',
        userRequest: text,
        sessionId: this.currentSessionId ?? undefined,
        requestMode,
        kind: isLoop ? 'loop' : 'once',
        loopIntervalMs: isLoop ? loopIntervalMs : undefined,
        loopMaxIterations: isLoop ? 100 : undefined,
      });
      thinking.remove();
      if (error) throw new Error(error);
      if (task) {
        // Do NOT force a render-state reset here: a fast task can finish
        // server-side and arrive via WebSocket (task.update) BEFORE this HTTP
        // response. Resetting would clear `resultRendered` and re-render the
        // same answer/question as a duplicate bubble. onTaskUpdate already
        // resets per new task id on its own.
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

  /** Token-by-token streaming of a chat answer into a single growing bubble. */
  private onAgentEvent(taskId: string, event: { kind?: 'delta' | 'done'; text?: string }): void {
    if (event.kind === 'delta' && event.text) {
      let bubble = this.streamBubbles.get(taskId);
      if (!bubble) {
        bubble = this.addAgentMessage('');
        this.streamBubbles.set(taskId, bubble);
        this.setState('thinking');
      }
      const inner = bubble.querySelector('.bubble') as HTMLElement;
      inner.textContent = `${inner.textContent ?? ''}${event.text}`;
      this.scrollToBottom();
    }
  }

  private resetTaskRenderState(): void {
    this.renderedLogIds.clear();
    this.planRenderedFor = null;
    this.planEl = null;
    this.resultRendered = false;
    this.confirmRenderedStep = null;
  }

  /** Tick off plan steps as the agent advances through them (live todo list). */
  private updatePlanProgress(task: Task): void {
    if (!this.planEl || this.planRenderedFor !== task.id) return;
    const items = this.planEl.querySelectorAll('li.plan-step');
    const done = Math.min(task.currentStepIndex, items.length);
    items.forEach((li, i) => li.classList.toggle('done', i < done));
  }

  /** Offer a one-click "continue" for partial / gave-up runs. */
  private renderContinue(task: Task): void {
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = `<div class="bubble"><div class="inline-actions"><button class="btn-continue">继续推进</button></div></div>`;
    this.messages.appendChild(el);
    this.scrollToBottom();
    (el.querySelector('.btn-continue') as HTMLButtonElement).addEventListener('click', async () => {
      el.querySelector('.inline-actions')?.remove();
      // Continue the SAME task so collected progress / history / plan carry over.
      this.resultRendered = false;
      this.setState('working');
      try {
        await sendMessage({ type: 'CONTINUE_TASK', taskId: task.id });
        this.startPolling();
      } catch (err) {
        this.addSystemMessage(`继续失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** Offer a retry for failed runs (re-run the same request). */
  private renderRetry(task: Task): void {
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = `<div class="bubble"><div class="inline-actions"><button class="btn-retry">重试</button></div></div>`;
    this.messages.appendChild(el);
    this.scrollToBottom();
    (el.querySelector('.btn-retry') as HTMLButtonElement).addEventListener('click', () => {
      el.querySelector('.inline-actions')?.remove();
      void this.submitText(task.userRequest);
    });
  }

  /** Programmatically submit text through the normal send pipeline. */
  private async submitText(text: string): Promise<void> {
    this.input.value = text;
    await this.handleSend();
  }

  private onTaskUpdate(task: Task): void {
    const isNewTask = this.currentTask?.id !== task.id;
    if (isNewTask) this.resetTaskRenderState();
    this.currentTask = task;

    // Keep the panel open for the whole lifecycle of an active task (running,
    // planning, awaiting confirmation/input) — unless the user minimized it.
    if (
      !this.userMinimized &&
      !this.autoOpenSuppressed &&
      !this.panel.classList.contains('open') &&
      ['running', 'planning', 'waiting_confirmation', 'needs_input'].includes(task.status)
    ) {
      this.openPanel();
    }

    if (task.plan && this.planRenderedFor !== task.id) {
      this.renderPlanMessage(task);
      this.planRenderedFor = task.id;
    }
    this.updatePlanProgress(task);

    for (const log of task.logs ?? []) {
      if (this.renderedLogIds.has(log.id)) continue;
      this.renderedLogIds.add(log.id);
      const m = log.message;
      if (log.level === 'error') {
        this.addSystemMessage(`❌ ${m}`);
      } else if (m.startsWith('🤔') || m.startsWith('📄')) {
        // Agent thoughts and page navigations — show live reasoning.
        this.addSystemMessage(m);
      } else if (m.startsWith('执行:') || m.startsWith('Executing step')) {
        this.addSystemMessage(`⚙️ ${m}`);
      } else if (m.startsWith('🧩') || m.startsWith('🔁') || m.startsWith('🛠️')) {
        // Sub-agent / replan / adjustment notices.
        this.addSystemMessage(m);
      } else if (log.level === 'warn' && (m.includes('确认') || m.includes('重复') || m.includes('调整') || m.includes('重新规划'))) {
        this.addSystemMessage(`⚠️ ${m}`);
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
      case 'needs_input':
        this.setState('waiting');
        if (!this.resultRendered) {
          this.addAgentMessage(`❓ ${task.clarifyQuestion ?? task.assistantMessage ?? '我需要你补充一些信息才能继续。'}`);
          this.resultRendered = true;
          this.notifyBadge();
        }
        this.stopPolling();
        void this.refreshSessionsQuietly();
        break;
      case 'completed':
        this.setState('happy');
        if (!this.resultRendered) {
          if (task.mode === 'chat') {
            // A direct conversational answer. If it already streamed in, finalize
            // that bubble instead of adding a duplicate.
            const finalText = task.assistantMessage ?? task.result ?? '';
            const streamed = this.streamBubbles.get(task.id);
            if (streamed) {
              (streamed.querySelector('.bubble') as HTMLElement).innerHTML = this.mdToHtml(finalText);
              this.streamBubbles.delete(task.id);
            } else {
              this.addAgentMessage(finalText);
            }
            // Structured/long answers also get the rich centered overlay.
            if (this.isSubstantialResult(finalText)) {
              this.openResultModal(task.userRequest?.slice(0, 60) || '回答', finalText);
            }
          } else if (task.outcome === 'success' || !task.outcome) {
            const text = task.result ?? '';
            if (this.isSubstantialResult(text)) {
              this.presentResult(task, '✅ 任务完成 · 结果已生成', text, true);
            } else {
              this.addAgentMessage(`✅ 任务完成\n${text}`.trim());
            }
          } else {
            // partial / gave_up: be honest, don't claim success.
            const label = task.outcome === 'partial' ? '部分完成' : '未能完成';
            const text = task.result ?? '';
            if (this.isSubstantialResult(text)) {
              this.presentResult(task, `⚠️ ${label} · 结果`, text, true);
            } else {
              this.addAgentMessage(`⚠️ ${label}\n${text}`.trim());
            }
            this.renderContinue(task);
          }
          this.resultRendered = true;
          this.notifyBadge();
          // Only offer to save a workflow when the run genuinely succeeded.
          if (
            task.outcome === 'success' &&
            task.mode !== 'chat' &&
            task.recordedSteps?.length &&
            !this.savedWorkflowFor.has(task.id)
          ) {
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
          this.renderRetry(task);
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
    this.suggestBar?.classList.add('hidden');
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
      this.suggestBar?.classList.add('hidden');
      this.addSystemMessage(`会话：${session.title}`);
      const history = tasks ?? [];
      const live = history.find((t) =>
        ['running', 'planning', 'waiting_confirmation'].includes(t.status)
      );
      if (history.length > 0) {
        // Replay each task's FULL execution detail (plan + step-by-step logs +
        // outcome), not just the final answer, so reopening a session preserves
        // the whole process the user watched live. The live task (if any) is
        // rendered afterwards via onTaskUpdate so it keeps polling.
        for (const t of history) {
          if (live && t.id === live.id) continue;
          this.renderHistoricalTask(t);
        }
      } else {
        // Sessions with no recorded tasks: fall back to the raw chat thread.
        for (const m of session.messages ?? []) {
          if (m.role === 'user') this.addUserMessage(m.content);
          else if (m.role === 'assistant') this.addAgentMessage(m.content);
          else this.addSystemMessage(m.content);
        }
      }
      this.closeDrawers();
      if (!this.panel.classList.contains('open')) this.togglePanel();
      if (live) this.onTaskUpdate(live);
      clientLog('info', 'session', `切换到会话 ${id}`);
    } catch (err) {
      this.addSystemMessage(`加载会话失败：${String(err)}`);
    }
  }

  /**
   * Re-renders a finished task exactly as the user saw it live: the user
   * request, the plan, the step-by-step thoughts/actions/navigations, and the
   * final outcome — but statically (no buttons, no polling, no side effects).
   */
  private renderHistoricalTask(task: Task): void {
    this.addUserMessage(task.userRequest);

    const steps = task.plan?.steps ?? [];
    if (steps.length) {
      const el = document.createElement('div');
      el.className = 'msg agent';
      const list = steps
        .map(
          (s: PlanStep) =>
            `<li class="plan-step ${s.riskLevel === 'high' ? 'risk-high' : ''}">${this.escape(
              s.description
            )}${s.requiresConfirmation ? ' ⚠️' : ''}</li>`
        )
        .join('');
      const loopHint = task.kind === 'loop' ? `（循环，每 ${task.loopIntervalMs ?? 0}ms）` : '';
      el.innerHTML = `
        <div class="bubble">
          <div class="plan-title">📋 执行计划${this.escape(loopHint)}（${steps.length} 步）</div>
          <ol>${list}</ol>
        </div>`;
      this.messages.appendChild(el);
    }

    // Same log filtering the live view uses, so the replay matches what was shown.
    for (const log of task.logs ?? []) {
      const m = log.message;
      if (log.level === 'error') {
        this.addSystemMessage(`❌ ${m}`);
      } else if (m.startsWith('🤔') || m.startsWith('📄')) {
        this.addSystemMessage(m);
      } else if (m.startsWith('执行:') || m.startsWith('Executing step')) {
        this.addSystemMessage(`⚙️ ${m}`);
      } else if (
        m.startsWith('🧩') ||
        m.startsWith('🔁') ||
        m.startsWith('🛠️') ||
        m.startsWith('⏭️') ||
        m.startsWith('🧭')
      ) {
        this.addSystemMessage(m);
      } else if (
        log.level === 'warn' &&
        (m.includes('确认') || m.includes('重复') || m.includes('调整') || m.includes('重新规划') || m.includes('横跳'))
      ) {
        this.addSystemMessage(`⚠️ ${m}`);
      }
    }

    switch (task.status) {
      case 'completed': {
        const text = (task.mode === 'chat' ? task.assistantMessage ?? task.result : task.result) ?? '';
        const label =
          task.mode === 'chat'
            ? '回答'
            : task.outcome === 'success' || !task.outcome
              ? '✅ 任务完成 · 结果'
              : `⚠️ ${task.outcome === 'partial' ? '部分完成' : '未能完成'} · 结果`;
        if (task.mode !== 'chat' && this.isSubstantialResult(text)) {
          // History stays compact: a card that reopens the overlay on demand.
          this.addResultCard(task.userRequest?.slice(0, 60) || '任务结果', label, text);
        } else if (task.mode === 'chat') {
          this.addAgentMessage(text);
        } else if (task.outcome === 'success' || !task.outcome) {
          this.addAgentMessage(`✅ 任务完成\n${text}`.trim());
        } else {
          this.addAgentMessage(`⚠️ ${task.outcome === 'partial' ? '部分完成' : '未能完成'}\n${text}`.trim());
        }
        break;
      }
      case 'failed':
        this.addAgentMessage(`任务失败：${task.error ?? '未知错误'}`);
        break;
      case 'needs_input':
        this.addAgentMessage(`❓ ${task.clarifyQuestion ?? task.assistantMessage ?? ''}`);
        break;
      case 'cancelled':
        this.addSystemMessage('已停止任务');
        break;
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
          `<li class="plan-step ${s.riskLevel === 'high' ? 'risk-high' : ''}">${this.escape(s.description)}${
            s.requiresConfirmation ? ' ⚠️' : ''
          }</li>`
      )
      .join('');
    const loopHint = task.kind === 'loop' ? `（循环，每 ${task.loopIntervalMs ?? 0}ms）` : '';
    // "Plan" mode stops after planning and waits for the user to run it; every
    // other mode auto-executes and shows the plan as a live, adapting todo list.
    const planOnly = task.requestMode === 'plan' && task.status === 'pending';
    const title = planOnly
      ? `📋 执行计划${this.escape(loopHint)}（${steps.length} 步，待确认）`
      : `📋 执行计划${this.escape(loopHint)}（${steps.length} 步，自动执行中）`;
    const actions = planOnly
      ? `<button class="btn-go run-plan">执行</button><button class="btn-cancel">取消</button>`
      : `<button class="btn-cancel">停止任务</button>`;
    el.innerHTML = `
      <div class="bubble">
        <div class="plan-title">${title}</div>
        <ol>${list}</ol>
        <div class="plan-hint">计划仅为参考，Agent 会根据页面实际情况动态调整。</div>
        <div class="inline-actions">${actions}</div>
      </div>`;
    this.messages.appendChild(el);
    this.planEl = el;
    this.scrollToBottom();
    if (!planOnly) {
      this.setState('working');
      this.startPolling();
    }

    const runBtn = el.querySelector('.run-plan') as HTMLButtonElement | null;
    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        el.querySelector('.inline-actions')?.remove();
        this.setState('working');
        await sendMessage({ type: 'START_TASK', taskId: task.id });
        this.startPolling();
        await this.refresh();
      });
    }

    const cancelBtn = el.querySelector('.btn-cancel') as HTMLButtonElement;
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      el.querySelector('.inline-actions')?.remove();
      await sendMessage({ type: 'CANCEL_TASK', taskId: task.id });
      this.addSystemMessage('已停止任务');
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
