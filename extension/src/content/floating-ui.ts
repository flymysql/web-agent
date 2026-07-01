import type {
  Task,
  TaskAttachment,
  TaskLogEntry,
  PlanStep,
  Workflow,
  WorkflowStep,
  WorkflowParam,
  RecordedAction,
  RecordingNarration,
  ChatSession,
} from '@ai-browser-agent/shared';
import { DEFAULT_BACKEND_URL, DEFAULT_WS_URL } from '@ai-browser-agent/shared';
import { extractPageContext } from './page-context.js';
import { createDictation, createContinuous, isSpeechSupported, type SpeechSession } from './speech.js';

type AgentState = 'idle' | 'thinking' | 'working' | 'happy' | 'error' | 'waiting';

const BALL_POS_KEY = 'agent_ball_pos';
// Whether the user has explicitly minimized the panel. Persisted so the panel
// stays open across task-driven navigations (the content script reloads each
// time) unless the user chose to collapse it.
const PANEL_MIN_KEY = 'agent_panel_minimized';
// Maps a page origin → the chat session active on it, so the session is shared
// across all pages of the same site and survives page reloads (e.g. a login
// redirect mid-task). Persisted in chrome.storage.local (survives navigations).
const SESSION_BY_ORIGIN_KEY = 'agent_session_by_origin';

// Composer auto-grow: cap automatic height at this many lines; beyond that the
// textarea scrolls (users can still drag it taller manually).
const MAX_AUTO_LINES = 3;
// Attachment guards to avoid oversized prompts.
const MAX_TEXT_CHARS = 16000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const TEXT_EXT = /\.(txt|md|markdown|json|csv|log|js|ts|jsx|tsx|py|java|go|rs|c|cpp|h|hpp|css|scss|html|xml|yaml|yml|sql|sh|toml|ini|env|conf)$/i;

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
  // Uses currentColor so the star inherits the accent color of whatever pill /
  // header it sits in (visible on both light frosted and colored backgrounds).
  return `<svg viewBox="0 0 24 24" width="15" height="15" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" fill="currentColor"/>
    <circle cx="19" cy="5" r="1.4" fill="currentColor" opacity="0.85"/>
  </svg>`;
}

function refreshSvg(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-.5 3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function mascotSvg(): string {
  // Soft pastel robot: light periwinkle body, white face, indigo eyes and a
  // gentle smile with rosy cheeks. Kept light so it reads on the near-white ball
  // and the frosted panel header alike (a subtle outline + shadow give it edge).
  return `
  <svg class="mascot" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bodyGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#dbe3ff"/>
        <stop offset="100%" stop-color="#b3bef2"/>
      </linearGradient>
      <linearGradient id="faceGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#eef3ff"/>
      </linearGradient>
    </defs>
    <ellipse class="shadow" cx="32" cy="58" rx="15" ry="2.6"/>
    <rect class="antenna-stick" x="31" y="5" width="2" height="8" rx="1"/>
    <circle class="antenna" cx="32" cy="5" r="3.2"/>
    <rect class="ear ear-left" x="9" y="25" width="5" height="11" rx="2.5" fill="url(#bodyGrad)"/>
    <rect class="ear ear-right" x="50" y="25" width="5" height="11" rx="2.5" fill="url(#bodyGrad)"/>
    <rect class="head" x="13" y="13" width="38" height="32" rx="14" fill="url(#bodyGrad)"/>
    <rect class="visor" x="18" y="20" width="28" height="18" rx="9" fill="url(#faceGrad)"/>
    <circle class="eye eye-left" cx="26.5" cy="28" r="3.1"/>
    <circle class="eye eye-right" cx="37.5" cy="28" r="3.1"/>
    <circle class="cheek cheek-left" cx="22" cy="33" r="2.2"/>
    <circle class="cheek cheek-right" cx="42" cy="33" r="2.2"/>
    <path class="mouth" d="M29 33 Q32 35.6 35 33" stroke-linecap="round"/>
  </svg>`;
}

const STYLES = `
:host {
  all: initial;
  /* iOS system palette + materials */
  --blue: #0a84ff;
  --blue-press: #0060df;
  --indigo: #5e5ce6;
  --green: #34c759;
  --red: #ff3b30;
  --bg: #f2f2f7;
  --bg-elev: #ffffff;
  --label: #1c1c1e;
  --label-2: rgba(60,60,67,0.6);
  --label-3: rgba(60,60,67,0.3);
  --separator: rgba(60,60,67,0.16);
  --fill: rgba(118,118,128,0.12);
  --fill-2: rgba(118,118,128,0.22);
  --material: rgba(248,248,250,0.72);
  --material-strong: rgba(255,255,255,0.86);
  --card-edge: rgba(255,255,255,0.5);
  --bubble-in: #e9e9eb;
  --blur: saturate(180%) blur(20px);
  --r-lg: 22px;
  --r-md: 16px;
  --r-sm: 11px;
  --shadow: 0 10px 40px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.06);
}
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'PingFang SC', sans-serif; -webkit-font-smoothing: antialiased; }

.ball {
  position: fixed;
  width: 60px;
  height: 60px;
  z-index: 2147483646;
  cursor: grab;
  border-radius: 50%;
  background: radial-gradient(125% 125% at 32% 24%, #ffffff 0%, #f2f6ff 46%, #e2eaff 100%);
  box-shadow: 0 10px 26px rgba(120,140,220,0.30), inset 0 1.5px 2px rgba(255,255,255,0.95), inset 0 -3px 7px rgba(150,170,230,0.18);
  border: 0.5px solid rgba(190,205,245,0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  touch-action: none;
  transition: transform 0.2s cubic-bezier(0.2,0.8,0.2,1), box-shadow 0.2s;
}
.ball:hover { transform: scale(1.06); box-shadow: 0 14px 32px rgba(120,140,220,0.42), inset 0 1.5px 2px rgba(255,255,255,0.95), inset 0 -3px 7px rgba(150,170,230,0.18); }
.ball:active { transform: scale(0.95); }
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
  padding: 10px 15px;
  border: 0.5px solid var(--separator);
  border-radius: 999px;
  cursor: pointer;
  color: var(--label);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  text-align: left;
  background: var(--material-strong);
  -webkit-backdrop-filter: var(--blur);
  backdrop-filter: var(--blur);
  box-shadow: 0 6px 18px rgba(0,0,0,0.14);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: transform 0.14s cubic-bezier(0.2,0.8,0.2,1), box-shadow 0.2s ease, opacity 0.2s ease;
  animation: pillIn 0.26s cubic-bezier(0.2,0.8,0.2,1) both;
}
.suggest-pill .spark { flex: 0 0 auto; display: inline-flex; color: var(--blue); }
.suggest-pill .pill-text { overflow: hidden; text-overflow: ellipsis; }
.suggest-pill:hover { transform: translateX(-3px) scale(1.03); box-shadow: 0 9px 24px rgba(0,0,0,0.2); }
.suggest-bar.flip .suggest-pill:hover { transform: translateX(3px) scale(1.03); }
.suggest-pill.refresh {
  background: var(--material);
  color: var(--blue);
  font-weight: 600;
  padding: 8px 14px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.12);
}
.suggest-pill.refresh:hover { box-shadow: 0 7px 18px rgba(0,0,0,0.18); }
.suggest-pill.refresh .spark { color: var(--blue); }
.suggest-pill.refresh.spin .spark { animation: refreshSpin 0.6s linear; }
@keyframes refreshSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pillIn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
.suggest-bar.flip .suggest-pill { animation-name: pillInFlip; }
@keyframes pillInFlip { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: translateX(0); } }

/* Centered result overlay: an iOS-style frosted dialog */
.result-modal { position: fixed; inset: 0; z-index: 2147483647; display: none; }
.result-modal.open { display: block; }
.rm-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.28); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); animation: rmFade 0.2s ease; }
.rm-card {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: min(760px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--material-strong); border-radius: var(--r-lg); overflow: hidden;
  border: 0.5px solid var(--card-edge);
  -webkit-backdrop-filter: saturate(180%) blur(30px); backdrop-filter: saturate(180%) blur(30px);
  box-shadow: 0 30px 80px rgba(0,0,0,0.34); animation: rmPop 0.28s cubic-bezier(0.2,0.8,0.2,1);
}
.rm-head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px; color: var(--label);
  background: var(--material); border-bottom: 0.5px solid var(--separator);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
}
.rm-spark { display: inline-flex; flex: 0 0 auto; color: var(--blue); }
.rm-title { flex: 1; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rm-copy-all, .rm-close { border: none; background: var(--fill); color: var(--blue); cursor: pointer; border-radius: var(--r-sm); font-size: 13px; font-weight: 600; }
.rm-copy-all { padding: 6px 11px; }
.rm-close { font-size: 17px; line-height: 1; padding: 5px 10px; color: var(--label-2); }
.rm-copy-all:hover, .rm-close:hover { background: var(--fill-2); }
.rm-body { padding: 18px 20px; overflow: auto; color: var(--label); font-size: 14px; line-height: 1.62; }
.rm-h { margin: 16px 0 8px; font-weight: 700; line-height: 1.3; letter-spacing: -0.01em; }
.rm-h:first-child { margin-top: 0; }
h1.rm-h { font-size: 20px; } h2.rm-h { font-size: 18px; } h3.rm-h { font-size: 16px; } h4.rm-h { font-size: 15px; }
.rm-p { margin: 8px 0; }
.rm-ul, .rm-ol { margin: 8px 0; padding-left: 22px; }
.rm-ul li, .rm-ol li { margin: 4px 0; }
.rm-code { margin: 12px 0; border-radius: var(--r-sm); overflow: hidden; }
.rm-code-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background: #1b1f2e; color: #9aa4c0; font-size: 12px; }
.rm-code-head .rm-copy { border: none; background: #2a3146; color: #cdd6f4; border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
.rm-code-head .rm-copy:hover { background: #3a4366; }
.rm-code pre { margin: 0; padding: 12px 14px; overflow: auto; background: #0f1117; color: #e6e9f5; font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size: 12.5px; line-height: 1.55; white-space: pre; }
.rm-table-wrap { overflow: auto; margin: 12px 0; }
.rm-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.rm-table th, .rm-table td { border: 1px solid var(--separator); padding: 7px 10px; text-align: left; }
.rm-table th { background: var(--fill); font-weight: 700; }
.rm-body a { color: var(--blue); word-break: break-all; }
.rm-badge { flex: 0 0 auto; font-size: 12px; font-weight: 600; background: rgba(10,132,255,0.14); color: var(--blue); padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
.rm-actions { display: flex; gap: 6px; }
.rm-act-btn { border: none; background: var(--fill); color: var(--blue); cursor: pointer; border-radius: var(--r-sm); padding: 6px 11px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.rm-act-btn:hover { background: var(--fill-2); }

/* links template */
.rm-links { display: flex; flex-direction: column; gap: 8px; }
.rm-link { display: flex; flex-direction: column; gap: 2px; padding: 11px 13px; border: 0.5px solid var(--separator); border-radius: var(--r-md); background: var(--bg-elev); text-decoration: none; transition: border-color 0.15s, background 0.15s; }
.rm-link:hover { border-color: var(--blue); background: rgba(10,132,255,0.06); }
.rm-link-t { color: var(--label); font-weight: 600; font-size: 13.5px; word-break: break-word; }
.rm-link-u { color: var(--label-2); font-size: 12px; word-break: break-all; }

/* key-value / facts template */
.rm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 0; margin: 0; border: 0.5px solid var(--separator); border-radius: var(--r-md); overflow: hidden; }
.rm-kv-row { display: contents; }
.rm-kv dt { background: var(--fill); color: var(--blue); font-weight: 600; padding: 9px 12px; border-bottom: 0.5px solid var(--separator); }
.rm-kv dd { margin: 0; padding: 9px 12px; border-bottom: 0.5px solid var(--separator); color: var(--label); word-break: break-word; }
.rm-kv .rm-kv-row:last-child dt, .rm-kv .rm-kv-row:last-child dd { border-bottom: none; }

/* checklist / cards template */
.rm-cards { display: flex; flex-direction: column; gap: 8px; }
.rm-card-item { display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px; background: var(--bg-elev); border: 0.5px solid var(--separator); border-radius: var(--r-md); font-size: 13.5px; line-height: 1.5; }
.rm-card-item .rm-dot { flex: 0 0 auto; width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: var(--blue); }

@keyframes rmFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rmPop { from { opacity: 0; transform: translate(-50%,-46%) scale(0.94); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }

/* Compact result card shown inside chat with a button to open the overlay */
.res-card { display: flex; flex-direction: column; gap: 8px; }
.res-card-row { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.res-preview { color: var(--label-2); font-size: 12.5px; line-height: 1.5; max-height: 58px; overflow: hidden; }
.btn-view { align-self: flex-start; border: none; border-radius: 999px; cursor: pointer; padding: 7px 15px; font-size: 12.5px; font-weight: 600; color: #fff; background: var(--blue); transition: background 0.15s, transform 0.12s; }
.btn-view:hover { background: var(--blue-press); }
.btn-view:active { transform: scale(0.96); }

.mascot { width: 46px; height: 46px; animation: bob 2.6s ease-in-out infinite; filter: drop-shadow(0 2px 3px rgba(90,110,190,0.20)); }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

.shadow { fill: rgba(80,100,180,0.14); }
.antenna { fill: #ff9e8a; animation: blinkAntenna 1.6s ease-in-out infinite; }
.antenna-stick { fill: #b3bef2; }
.head { stroke: rgba(120,140,220,0.30); stroke-width: 0.6; }
.visor { stroke: rgba(120,140,220,0.18); stroke-width: 0.5; }
.eye { fill: #5563b8; animation: blink 4s infinite; }
.cheek { fill: #ffb3c1; opacity: 0.8; }
.mouth { fill: none; stroke: #5563b8; stroke-width: 2; }
@keyframes blink { 0%,92%,100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
@keyframes blinkAntenna { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* state-specific expressions */
.ball[data-state="thinking"] .mascot { animation: tilt 1.2s ease-in-out infinite; }
@keyframes tilt { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
.ball[data-state="working"] .eye { fill: #f0a020; }
.ball[data-state="working"] .mascot { animation: bob 0.8s ease-in-out infinite; }
.ball[data-state="happy"] .mouth { d: path("M28.5 32.5 Q32 36.5 35.5 32.5"); }
.ball[data-state="error"] .eye { fill: #ef5350; }
.ball[data-state="error"] .mouth { d: path("M29 34.5 Q32 32.2 35 34.5"); }
.ball[data-state="waiting"] .antenna { animation: blinkAntenna 0.5s ease-in-out infinite; fill: #ff6b6b; }

.badge {
  position: absolute;
  top: -2px; right: -2px;
  min-width: 18px; height: 18px;
  padding: 0 5px;
  background: var(--red);
  color: #fff;
  border-radius: 9px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-weight: 600;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.9);
  display: none;
}
.badge.show { display: block; }

/* Chat panel — iOS grouped-background sheet */
.panel {
  position: fixed;
  width: 360px;
  height: 520px;
  max-height: 80vh;
  z-index: 2147483647;
  background: var(--bg);
  border-radius: 20px;
  box-shadow: var(--shadow);
  display: none;
  flex-direction: column;
  overflow: hidden;
  border: 0.5px solid var(--separator);
}
.panel.open { display: flex; animation: popIn 0.22s cubic-bezier(0.2,0.8,0.2,1); }
@keyframes popIn { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: none; } }

.panel-header {
  display: flex; align-items: center; gap: 6px;
  padding: 12px 14px;
  background: var(--material);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
  color: var(--label);
  border-bottom: 0.5px solid var(--separator);
}
.panel-header .avatar { width: 30px; height: 30px; flex-shrink: 0; }
.panel-header .title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; flex: 1; color: var(--label); }
.panel-header .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); }
.panel-header .status-dot.connected { background: var(--green); }
.panel-header button {
  background: var(--fill); border: none; color: var(--blue);
  width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 15px;
  transition: background 0.15s;
}
.panel-header button:hover { background: var(--fill-2); }
.panel-header .stop-btn { background: var(--red); color: #fff; font-size: 12px; padding: 4px 11px; width: auto; border-radius: 999px; font-weight: 600; }
.panel-header .stop-btn:hover { background: #d70015; }
.panel-header .stop-btn:disabled { opacity: 0.5; cursor: default; }

/* Overflow ("more") menu */
.menu-wrap { position: relative; display: inline-flex; }
.panel-header .more-btn { font-size: 19px; line-height: 1; font-weight: 700; }
.more-menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 10;
  min-width: 168px; padding: 6px;
  background: var(--material-strong); border: 0.5px solid var(--separator);
  border-radius: var(--r-md); box-shadow: var(--shadow);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
  display: none; flex-direction: column; gap: 2px;
  animation: popIn 0.16s cubic-bezier(0.2,0.8,0.2,1);
}
.more-menu.open { display: flex; }
.panel-header .more-menu .menu-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; height: auto; padding: 9px 11px;
  background: transparent; border-radius: 9px;
  color: var(--label); font-size: 13.5px; font-weight: 500; text-align: left;
}
.panel-header .more-menu .menu-item:hover { background: var(--fill); }
.more-menu .mi-ic { font-size: 15px; line-height: 1; width: 18px; text-align: center; flex: 0 0 auto; }

/* Recording indicator bar (under the header while capturing user actions) */
.rec-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; border-bottom: 0.5px solid var(--separator);
  background: color-mix(in srgb, var(--red, #ff3b30) 12%, transparent);
  font-size: 12.5px; color: var(--label);
}
.rec-bar .rec-dot {
  width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
  background: var(--red, #ff3b30); animation: recPulse 1.1s ease-in-out infinite;
}
.rec-bar .rec-text { flex: 1; }
.rec-bar .rec-stop {
  border: none; cursor: pointer; padding: 5px 10px; border-radius: 8px;
  background: var(--red, #ff3b30); color: #fff; font-size: 12px; font-weight: 600;
}
.rec-bar .rec-stop:hover { filter: brightness(0.94); }
.rec-bar .rec-stop:disabled { opacity: 0.6; cursor: default; }
@keyframes recPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

/* Review modal (recording → workflow) reuses the settings dialog styling */
.rev-steps { display: flex; flex-direction: column; gap: 8px; }
.rev-step {
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 9px;
  background: var(--fill); display: flex; flex-direction: column; gap: 6px;
}
.rev-step-top { display: flex; align-items: center; gap: 6px; }
.rev-step-idx {
  min-width: 20px; height: 20px; border-radius: 6px; background: var(--blue); color: #fff;
  font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
}
.rev-step-tool {
  font-size: 11px; font-weight: 600; color: var(--blue); background: var(--card);
  border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px;
}
.rev-step-sp { flex: 1; }
.rev-step-btn {
  border: 1px solid var(--border); background: var(--card); color: var(--label);
  width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 13px; line-height: 1;
}
.rev-step-btn:hover:not(:disabled) { background: var(--fill-2, var(--fill)); }
.rev-step-btn:disabled { opacity: 0.35; cursor: default; }
.rev-step-btn.del:hover { border-color: #ef4444; color: #ef4444; }
.rev-field { display: flex; flex-direction: column; gap: 2px; }
.rev-field > label { font-size: 10.5px; color: var(--label-2); }
.rev-in {
  width: 100%; box-sizing: border-box; font-size: 12.5px; padding: 5px 7px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--label);
  font-family: inherit;
}
.rev-in.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.rev-params { display: flex; flex-direction: column; gap: 8px; }
.rev-param {
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 9px;
  background: var(--fill); display: flex; flex-direction: column; gap: 6px;
}
.rev-param-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rev-param-top code {
  background: var(--card); padding: 2px 6px; border-radius: 6px; color: var(--blue);
  font-size: 12px; border: 1px solid var(--border);
}
.rev-param-mode { margin-left: auto; font-size: 12px; padding: 3px 6px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--card); color: var(--label); }
.rev-nl-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.rev-nl { resize: vertical; }

/* Settings overlay — same frosted-dialog language as the result modal */
.set-modal { position: fixed; inset: 0; z-index: 2147483647; display: none; }
.set-modal.open { display: block; }
.set-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.28); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); animation: rmFade 0.2s ease; }
.set-card {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: min(440px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--material-strong); border-radius: var(--r-lg); overflow: hidden;
  border: 0.5px solid var(--card-edge);
  -webkit-backdrop-filter: saturate(180%) blur(30px); backdrop-filter: saturate(180%) blur(30px);
  box-shadow: 0 30px 80px rgba(0,0,0,0.34); animation: rmPop 0.28s cubic-bezier(0.2,0.8,0.2,1);
}
.set-head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px; color: var(--label);
  background: var(--material); border-bottom: 0.5px solid var(--separator);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
}
.set-spark { display: inline-flex; flex: 0 0 auto; color: var(--blue); }
.set-title { flex: 1; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.set-close { border: none; background: var(--fill); color: var(--label-2); cursor: pointer; border-radius: var(--r-sm); font-size: 17px; line-height: 1; padding: 5px 10px; }
.set-close:hover { background: var(--fill-2); }
.set-body { padding: 4px 18px 8px; overflow: auto; }
.set-sec { padding: 14px 0; border-bottom: 0.5px solid var(--separator); }
.set-sec:last-child { border-bottom: none; }
.set-sec-t { font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: var(--label-2); margin-bottom: 10px; }
.set-field { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--label-2); margin-bottom: 10px; }
.set-field:last-child { margin-bottom: 0; }
.set-in[type="text"], .set-in[type="password"], .set-in[type="number"], textarea.set-in {
  width: 100%; padding: 8px 11px; font-size: 13.5px; color: var(--label);
  background: var(--bg-elev); border: 0.5px solid var(--separator); border-radius: var(--r-sm);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.set-in[type="text"]:focus, .set-in[type="password"]:focus, .set-in[type="number"]:focus, textarea.set-in:focus {
  border-color: var(--blue); box-shadow: 0 0 0 3px rgba(10,132,255,0.15);
}
textarea.set-in { resize: vertical; min-height: 58px; font-family: inherit; }
.set-check { display: flex; align-items: flex-start; gap: 9px; font-size: 13px; color: var(--label); cursor: pointer; margin-bottom: 9px; line-height: 1.4; }
.set-check:last-child { margin-bottom: 0; }
.set-check input { margin-top: 1px; width: 15px; height: 15px; accent-color: var(--blue); flex: 0 0 auto; }
.set-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.set-ghost { border: 0.5px solid var(--separator); background: var(--bg-elev); color: var(--blue); cursor: pointer; border-radius: var(--r-sm); padding: 7px 13px; font-size: 12.5px; font-weight: 600; }
.set-ghost:hover { background: var(--fill); }
.set-hint { font-size: 12px; color: var(--label-2); }
.set-hint.ok { color: var(--green); }
.set-hint.err { color: var(--red); }
.set-foot { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 12px 18px; border-top: 0.5px solid var(--separator); background: var(--material); }
.set-save { border: none; background: var(--blue); color: #fff; cursor: pointer; border-radius: var(--r-sm); padding: 9px 20px; font-size: 14px; font-weight: 600; }
.set-save:hover { background: var(--blue-press); }

.messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; }

.msg { display: flex; gap: 8px; max-width: 100%; }
.msg.user { flex-direction: row-reverse; }
.bubble {
  padding: 8px 13px; border-radius: 19px; font-size: 14px; line-height: 1.4;
  max-width: 78%; word-break: break-word;
}
.bubble.text { white-space: pre-wrap; }
.msg.agent .bubble { background: var(--bubble-in); color: var(--label); border-bottom-left-radius: 5px; }
.msg.user .bubble { background: var(--blue); color: #fff; border-bottom-right-radius: 5px; }
.msg.system { justify-content: center; }
.msg.system .bubble { background: transparent; color: var(--label-2); font-size: 11px; padding: 2px 8px; max-width: 100%; }

.bubble .plan-title { font-weight: 600; margin-bottom: 6px; }
.bubble .plan-hint { color: var(--label-2); font-size: 11px; margin-top: 4px; }
.bubble ol { margin: 0; padding-left: 18px; }
.bubble li { margin-bottom: 3px; }
.bubble li.risk-high { color: var(--red); }

.inline-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.inline-actions button {
  padding: 7px 14px; border-radius: 999px; border: none; cursor: pointer; font-size: 13px; font-weight: 600;
  transition: background 0.15s, transform 0.12s;
}
.inline-actions button:active { transform: scale(0.96); }
.btn-go { background: var(--blue); color: #fff; }
.btn-go:hover { background: var(--blue-press); }
.btn-ok { background: var(--green); color: #fff; }
.btn-ok:hover { background: #248a3d; }
.btn-no, .btn-cancel { background: var(--fill); color: var(--blue); }
.btn-no:hover, .btn-cancel:hover { background: var(--fill-2); }

.thinking-dots span {
  display: inline-block; width: 6px; height: 6px; margin: 0 1px; border-radius: 50%;
  background: var(--label-3); animation: dotPulse 1.2s infinite;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotPulse { 0%,60%,100% { opacity: 0.3; } 30% { opacity: 1; } }

/* Codex-style input card: textarea on top, a toolbar row at the bottom */
.composer { padding: 10px 12px; border-top: 0.5px solid var(--separator); background: var(--material); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur); }
.input-box {
  border: 0.5px solid var(--separator); border-radius: var(--r-md); background: var(--bg-elev);
  padding: 8px 10px 6px; transition: border-color 0.15s, box-shadow 0.15s;
}
.input-box:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
.composer textarea {
  display: block; width: 100%; resize: vertical; border: none; outline: none;
  padding: 0; font-size: 14px; line-height: 1.4; max-height: 260px; min-height: 22px; font-family: inherit;
  background: transparent; color: var(--label);
}
.composer textarea::placeholder { color: var(--label-2); }
.attach-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.attach-chips:empty { display: none; }
.attach-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 190px;
  padding: 4px 6px 4px 9px; border-radius: 999px; background: var(--fill); color: var(--label);
  font-size: 12px; font-weight: 500;
}
.attach-chip .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-chip .chip-x {
  flex: 0 0 auto; width: 16px; height: 16px; border: none; border-radius: 50%; cursor: pointer;
  background: var(--fill-2); color: var(--label-2); font-size: 12px; line-height: 1; padding: 0;
}
.attach-chip .chip-x:hover { background: var(--label-3); color: #fff; }
.toolbar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.toolbar .spacer { flex: 1; }
.toolbar .attach-btn {
  width: 30px; height: 30px; flex: 0 0 auto; border: none; border-radius: 50%;
  background: var(--fill); color: var(--blue); cursor: pointer; font-size: 18px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; transition: background 0.15s, transform 0.12s;
}
.toolbar .attach-btn:hover { background: var(--fill-2); }
.toolbar .attach-btn:active { transform: scale(0.92); }
.toolbar .mic-btn {
  width: 30px; height: 30px; flex: 0 0 auto; border: none; border-radius: 50%;
  background: var(--fill); color: var(--blue); cursor: pointer; font-size: 15px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; transition: background 0.15s, transform 0.12s;
}
.toolbar .mic-btn:hover { background: var(--fill-2); }
.toolbar .mic-btn:active { transform: scale(0.92); }
.toolbar .mic-btn.listening { background: #ef4444; color: #fff; animation: micPulse 1.1s ease-in-out infinite; }
@keyframes micPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); } 50% { box-shadow: 0 0 0 5px rgba(239,68,68,0); } }
.rec-bar .rec-guide {
  flex: 0 0 auto; border: 0.5px solid var(--separator); border-radius: 999px; padding: 4px 10px;
  background: var(--bg-elev); color: var(--label); cursor: pointer; font-size: 12px; font-weight: 600;
  user-select: none; -webkit-user-select: none; touch-action: none;
}
.rec-bar .rec-guide.talking { background: #ef4444; color: #fff; border-color: #ef4444; }
.toolbar .mode-select {
  font-size: 12px; padding: 5px 9px; border: 0.5px solid var(--separator); border-radius: 999px;
  background: var(--bg-elev); color: var(--label); cursor: pointer; font-family: inherit;
}
.toolbar .mode-select:focus { outline: none; border-color: var(--blue); }
.toolbar .send {
  width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--blue); color: #fff;
  cursor: pointer; font-size: 16px; flex-shrink: 0; transition: background 0.15s, transform 0.12s;
  display: inline-flex; align-items: center; justify-content: center;
}
.toolbar .send:hover { background: var(--blue-press); }
.toolbar .send:active { transform: scale(0.9); }
.toolbar .send:disabled { background: var(--label-3); cursor: not-allowed; }
.msg.agent .bubble .md-code { background: rgba(10,132,255,0.1); color: var(--blue-press); padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.msg.agent .bubble .md-pre { background: #1e293b; color: #e2e8f0; padding: 8px 10px; border-radius: 8px; overflow-x: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; margin: 6px 0; white-space: pre-wrap; }
.msg.agent .bubble a { color: var(--blue); text-decoration: underline; }
.inline-actions .btn-continue { background: var(--blue); color: #fff; border: none; border-radius: 999px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
.inline-actions .btn-retry { background: var(--fill); color: var(--blue); border: none; border-radius: 999px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
.plan-step.done { color: var(--green); text-decoration: line-through; opacity: 0.75; }
.run-opts { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: var(--label-2); }
.run-opts .run-loop { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.run-opts input[type="number"] { width: 78px; padding: 3px 7px; border: 0.5px solid var(--separator); border-radius: 8px; font-size: 12px; background: var(--bg-elev); color: var(--label); }
.run-opts input[type="number"]:disabled { opacity: 0.5; }

/* Drawers: sessions + workflows */
.drawer {
  position: absolute; left: 0; right: 0; top: 52px; bottom: 0;
  background: var(--bg); z-index: 6; display: none; flex-direction: column;
}
.drawer.open { display: flex; animation: popIn 0.18s cubic-bezier(0.2,0.8,0.2,1); }
.drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 0.5px solid var(--separator); font-size: 13px; font-weight: 600; color: var(--label);
}
.drawer-head .drawer-close { background: none; border: none; font-size: 18px; line-height: 1; cursor: pointer; color: var(--label-2); }
.drawer-head .drawer-close:hover { color: var(--label); }
.drawer-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.drawer-foot { padding: 12px; border-top: 0.5px solid var(--separator); }
.drawer-action { width: 100%; padding: 11px; border: none; border-radius: var(--r-md); background: var(--blue); color: #fff; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.15s; }
.drawer-action:hover { background: var(--blue-press); }
.drawer-empty { text-align: center; color: var(--label-2); font-size: 12px; padding: 26px 12px; line-height: 1.6; }

.list-item { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--separator); border-radius: var(--r-md); background: var(--bg-elev); transition: background 0.15s, border-color 0.15s; }
.list-item:hover { background: var(--fill); }
.list-item.active { border-color: var(--blue); background: rgba(10,132,255,0.08); }
.list-item .li-main { flex: 1; min-width: 0; cursor: pointer; }
.list-item .li-title { font-size: 14px; color: var(--label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.list-item .li-sub { font-size: 11px; color: var(--label-2); margin-top: 2px; }
.list-item .li-act { display: flex; gap: 2px; flex-shrink: 0; }
.list-item .li-act button { background: none; border: none; cursor: pointer; font-size: 13px; padding: 4px 6px; border-radius: 7px; color: var(--label-2); }
.list-item .li-act button:hover { background: var(--fill-2); }

/* iOS dark mode — follows the OS appearance */
@media (prefers-color-scheme: dark) {
  :host {
    --blue: #0a84ff;
    --blue-press: #409cff;
    --green: #30d158;
    --red: #ff453a;
    --bg: #1c1c1e;
    --bg-elev: #2c2c2e;
    --label: #ffffff;
    --label-2: rgba(235,235,245,0.6);
    --label-3: rgba(235,235,245,0.3);
    --separator: rgba(84,84,88,0.65);
    --fill: rgba(120,120,128,0.24);
    --fill-2: rgba(120,120,128,0.4);
    --material: rgba(30,30,32,0.72);
    --material-strong: rgba(44,44,46,0.85);
    --card-edge: rgba(255,255,255,0.1);
    --bubble-in: #3a3a3c;
  }
  .badge { box-shadow: 0 0 0 2px rgba(28,28,30,0.9); }
}
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
  private attachBtn!: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private attachChips!: HTMLDivElement;
  private pendingAttachments: TaskAttachment[] = [];
  private userResized = false;
  private lastAutoHeight: number | null = null;
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
  private settingsModal!: HTMLDivElement;
  private recBar!: HTMLDivElement;
  private reviewModal!: HTMLDivElement;
  private recPollTimer: ReturnType<typeof setInterval> | null = null;
  // Voice input state (Web Speech API). Settings are cached from chrome.storage.local.
  private voiceEnabled = true;
  private voiceLang = 'zh-CN';
  private voiceRefine = true;
  private recActive = false;
  private dictationSession: SpeechSession | null = null;
  private narrationSession: SpeechSession | null = null;
  private guidanceSession: SpeechSession | null = null;
  private dictationBase = '';
  // Understood recording awaiting the user's save/demo choice in the review modal.
  private pendingRecording: {
    name: string;
    steps: WorkflowStep[];
    params: WorkflowParam[];
    startUrl?: string;
  } | null = null;
  // A running "演示并保存" replay we should auto-save once it completes.
  private pendingDemo: {
    taskId: string;
    name: string;
    steps: WorkflowStep[];
    params: WorkflowParam[];
    startUrl?: string;
  } | null = null;
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

    const settings = document.createElement('div');
    settings.className = 'set-modal';
    settings.innerHTML = `
      <div class="set-backdrop"></div>
      <div class="set-card">
        <div class="set-head">
          <span class="set-spark">${sparkSvg()}</span>
          <div class="set-title">设置</div>
          <button class="set-close" title="关闭">×</button>
        </div>
        <div class="set-body">
          <section class="set-sec">
            <div class="set-sec-t">后端连接</div>
            <label class="set-field">后端 HTTP 地址
              <input class="set-in" data-k="backendUrl" type="text" placeholder="${DEFAULT_BACKEND_URL}" />
            </label>
            <label class="set-field">WebSocket 地址
              <input class="set-in" data-k="wsUrl" type="text" placeholder="${DEFAULT_WS_URL}" />
            </label>
            <div class="set-inline">
              <button class="set-ghost set-test">测试连接</button>
              <span class="set-hint set-test-res"></span>
            </div>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">模型 (LLM)</div>
            <label class="set-field">Base URL
              <input class="set-in" data-k="llmBaseUrl" type="text" placeholder="https://api.openai.com/v1" />
            </label>
            <label class="set-field">Model
              <input class="set-in" data-k="llmModel" type="text" placeholder="gpt-4o-mini" />
            </label>
            <label class="set-field">API Key
              <input class="set-in" data-k="llmApiKey" type="password" placeholder="留空则不修改" />
            </label>
            <label class="set-field">单次最大步数
              <input class="set-in" data-k="maxSteps" type="number" min="1" placeholder="40" />
            </label>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">自动执行</div>
            <label class="set-check">
              <input class="set-in" data-k="autorunEnabled" type="checkbox" />
              <span>允许“页面加载自动执行”的工作流触发</span>
            </label>
            <label class="set-field">站点白名单（每行一个片段，留空=所有站点）
              <textarea class="set-in" data-k="autorunWhitelist" rows="3" placeholder="example.com&#10;admin.internal"></textarea>
            </label>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">语音输入</div>
            <label class="set-check">
              <input class="set-in" data-k="voiceEnabled" type="checkbox" />
              <span>启用语音转文字（对话听写 + 录制旁白，需 Chrome 与麦克风权限）</span>
            </label>
            <label class="set-check">
              <input class="set-in" data-k="voiceRefine" type="checkbox" />
              <span>对话听写后用 AI 精简并提取意图</span>
            </label>
            <label class="set-field">识别语言
              <input class="set-in" data-k="voiceLang" type="text" placeholder="zh-CN" />
            </label>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">安全</div>
            <label class="set-field">访问令牌 (Auth Token)
              <input class="set-in" data-k="authToken" type="password" placeholder="后端设置 AGENT_AUTH_TOKEN 时填写" />
            </label>
            <label class="set-check">
              <input class="set-in" data-k="allowEvaluate" type="checkbox" />
              <span>允许 agent 执行任意 JavaScript (evaluate)</span>
            </label>
            <label class="set-check">
              <input class="set-in" data-k="allowPrivateNetwork" type="checkbox" />
              <span>允许 httpRequest 访问内网/本地地址</span>
            </label>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">调试</div>
            <div class="set-inline">
              <button class="set-ghost set-export">导出调试包</button>
              <button class="set-ghost set-clearlogs">清空日志</button>
            </div>
            <span class="set-hint set-debug-res"></span>
          </section>
        </div>
        <div class="set-foot">
          <span class="set-hint set-save-res"></span>
          <button class="set-save">保存</button>
        </div>
      </div>`;
    this.root.appendChild(settings);
    this.settingsModal = settings;

    const review = document.createElement('div');
    review.className = 'set-modal rev-modal';
    review.innerHTML = `
      <div class="set-backdrop"></div>
      <div class="set-card">
        <div class="set-head">
          <span class="set-spark">${sparkSvg()}</span>
          <div class="set-title">编辑并保存工作流</div>
          <button class="set-close rev-close" title="关闭">×</button>
        </div>
        <div class="set-body">
          <section class="set-sec">
            <label class="set-field">工作流名称
              <input class="set-in rev-name" type="text" placeholder="给这个工作流起个名字" />
            </label>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">操作步骤（<span class="rev-step-count">0</span>）<span class="set-hint">可上移 / 下移 / 删除 / 直接改内容</span></div>
            <div class="rev-steps"></div>
          </section>
          <section class="set-sec rev-params-sec" style="display:none">
            <div class="set-sec-t">可变参数（每次运行的取值方式）</div>
            <div class="rev-params"></div>
          </section>
          <section class="set-sec">
            <div class="set-sec-t">用自然语言修改</div>
            <textarea class="set-in rev-nl" rows="2" placeholder="例：第 2 步的搜索词每次运行让我填写；或：上传的内容每次自动生成一段测试文本；或：删掉第 4 步"></textarea>
            <div class="rev-nl-row">
              <button class="set-ghost rev-nl-apply">应用修改</button>
              <span class="set-hint rev-nl-res"></span>
            </div>
          </section>
        </div>
        <div class="set-foot rev-foot">
          <span class="set-hint rev-res"></span>
          <button class="set-ghost rev-cancel">取消</button>
          <button class="set-ghost rev-demo">演示并保存</button>
          <button class="set-save rev-save">直接保存</button>
        </div>
      </div>`;
    this.root.appendChild(review);
    this.reviewModal = review;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="panel-header">
        <div class="avatar">${mascotSvg()}</div>
        <div class="title">AI 助手</div>
        <div class="status-dot"></div>
        <button class="new-btn" title="新建会话">➕</button>
        <div class="menu-wrap">
          <button class="more-btn" title="更多">⋯</button>
          <div class="more-menu">
            <button class="menu-item" data-act="record"><span class="mi-ic">⏺</span>录制工作流</button>
            <button class="menu-item" data-act="history"><span class="mi-ic">🕘</span>会话历史</button>
            <button class="menu-item" data-act="workflows"><span class="mi-ic">🗂</span>工作流仓库</button>
            <button class="menu-item" data-act="settings"><span class="mi-ic">⚙️</span>设置</button>
          </div>
        </div>
        <button class="stop-btn" title="停止当前任务" style="display:none">⏹ 停止</button>
        <button class="min-btn" title="收起">—</button>
      </div>
      <div class="rec-bar" style="display:none">
        <span class="rec-dot"></span>
        <span class="rec-text">正在录制操作…（<span class="rec-count">0</span> 步）</span>
        <button class="rec-guide" title="按住说话，为当前操作补充语音说明或对 agent 的指导" style="display:none">🎤 指导</button>
        <button class="rec-stop">停止并保存</button>
      </div>
      <div class="messages"></div>
      <div class="composer">
        <div class="input-box">
          <textarea class="input" rows="1" placeholder="发消息给助手…"></textarea>
          <div class="attach-chips"></div>
          <div class="toolbar">
            <button class="attach-btn" title="添加文件">+</button>
            <button class="mic-btn" title="语音输入" style="display:none">🎤</button>
            <select class="mode-select" title="交互模式">
              <option value="auto">⚡ 自动</option>
              <option value="ask">💬 问答</option>
              <option value="agent">🤖 执行</option>
              <option value="plan">📋 仅计划</option>
            </select>
            <span class="spacer"></span>
            <button class="send" title="发送">↑</button>
          </div>
          <input type="file" class="file-input" multiple hidden
            accept=".txt,.md,.markdown,.json,.csv,.log,.js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.sql,.sh,text/*,image/*" />
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
    this.attachBtn = panel.querySelector('.attach-btn') as HTMLButtonElement;
    this.micBtn = panel.querySelector('.mic-btn') as HTMLButtonElement;
    this.fileInput = panel.querySelector('.file-input') as HTMLInputElement;
    this.attachChips = panel.querySelector('.attach-chips') as HTMLDivElement;
    this.sessionDrawer = panel.querySelector('.session-drawer') as HTMLDivElement;
    this.wfDrawer = panel.querySelector('.wf-drawer') as HTMLDivElement;
    this.recBar = panel.querySelector('.rec-bar') as HTMLDivElement;
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
    (this.panel.querySelector('.more-btn') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMoreMenu();
    });
    this.panel.querySelectorAll<HTMLButtonElement>('.more-menu .menu-item').forEach((b) =>
      b.addEventListener('click', () => {
        this.closeMoreMenu();
        const act = b.dataset.act;
        if (act === 'history') void this.toggleSessionDrawer();
        else if (act === 'workflows') void this.toggleWfDrawer();
        else if (act === 'settings') void this.openSettings();
        else if (act === 'record') void this.startRecordingFlow();
      })
    );

    (this.recBar.querySelector('.rec-stop') as HTMLButtonElement).addEventListener('click', () =>
      this.stopRecordingFlow()
    );
    this.bindVoice();
    this.bindReviewModal();
    (this.panel.querySelector('.new-session-btn') as HTMLButtonElement).addEventListener('click', () => this.newSession());
    this.panel.querySelectorAll('.drawer-close').forEach((b) =>
      b.addEventListener('click', () => this.closeDrawers())
    );

    this.bindSettingsModal();

    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.stopBtn.addEventListener('click', () => this.stopCurrentTask());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.input.addEventListener('input', () => this.autoSizeInput());

    // Detect manual (drag) resize so autosize stops overriding the user's height.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const h = Math.round(this.input.getBoundingClientRect().height);
        if (this.lastAutoHeight !== null && h !== this.lastAutoHeight) {
          this.userResized = true;
        }
      });
      ro.observe(this.input);
    }

    this.attachBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      void this.handleFilesPicked(this.fileInput.files);
      this.fileInput.value = '';
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
      if (e.key !== 'Escape') return;
      if (this.reviewModal.classList.contains('open')) this.closeReview();
      else if (this.settingsModal.classList.contains('open')) this.closeSettings();
      else if (this.resultModal.classList.contains('open')) this.closeResultModal();
      else this.closeMoreMenu();
    });

    // Any click outside the overflow menu dismisses it.
    this.root.addEventListener('click', (e) => {
      const inMenu = (e.target as HTMLElement)?.closest?.('.menu-wrap');
      if (!inMenu) this.closeMoreMenu();
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
    // Resume an in-progress task if the agent is operating this tab. Otherwise
    // (a page the user opened/refreshed themselves) restore the session that
    // belongs to this site so the conversation isn't lost on reload, then offer
    // contextual operation hints on the collapsed ball.
    const resumed = await this.reattach();
    if (!resumed) {
      await this.resumePersistedSession();
      void this.showPageSuggestions();
    }
    // Recording spans navigations; the panel is recreated on each page, so pull
    // the live recording state from the background and restore the indicator.
    void this.refreshRecordState();
    void this.loadVoiceSettings();
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
      // Bind this session to the origin so other same-site pages share it too.
      if (task.sessionId) void this.persistSession(task.sessionId);
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

  /** Remember (or clear) which session is active for the current site's origin. */
  private async persistSession(sessionId: string | null): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(SESSION_BY_ORIGIN_KEY);
      const map = (stored[SESSION_BY_ORIGIN_KEY] as Record<string, string> | undefined) ?? {};
      if (sessionId) map[location.origin] = sessionId;
      else delete map[location.origin];
      await chrome.storage.local.set({ [SESSION_BY_ORIGIN_KEY]: map });
    } catch {
      /* storage unavailable — session sharing degrades gracefully */
    }
  }

  private async readPersistedSessionId(): Promise<string | null> {
    try {
      const stored = await chrome.storage.local.get(SESSION_BY_ORIGIN_KEY);
      const map = (stored[SESSION_BY_ORIGIN_KEY] as Record<string, string> | undefined) ?? {};
      return map[location.origin] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Restore the chat session bound to this site's origin (persisted across
   * reloads and shared by all same-origin pages). Loads its history from the
   * server and replays it into the panel. Returns true when a session was
   * restored. A stale mapping (session no longer on the server) is cleared.
   */
  private async resumePersistedSession(): Promise<boolean> {
    if (!this.connected) return false;
    const sessionId = await this.readPersistedSessionId();
    if (!sessionId) return false;
    try {
      const { session, tasks } = await sendMessage<{ session?: ChatSession; tasks?: Task[] }>({
        type: 'GET_SESSION',
        sessionId,
      });
      if (!session) {
        await this.persistSession(null); // stale — the session was deleted/expired
        return false;
      }
      this.currentSessionId = sessionId;
      this.resetTaskRenderState();
      this.messages.innerHTML = '';
      this.suggestBar?.classList.add('hidden');

      const history = tasks ?? [];
      const live = history.find((t) =>
        ['pending', 'planning', 'running', 'paused', 'waiting_confirmation'].includes(t.status)
      );
      if (history.length) {
        for (const t of history) {
          if (live && t.id === live.id) continue;
          this.renderHistoricalTask(t);
        }
      } else {
        for (const m of session.messages ?? []) {
          if (m.role === 'user') this.addUserMessage(m.content);
          else if (m.role === 'assistant') this.addAgentMessage(m.content);
          else this.addSystemMessage(m.content);
        }
      }
      // A user-driven reload → keep the panel minimized; the restored thread is
      // waiting inside it. Resume polling a live task if one is still going.
      if (live) {
        this.currentTask = live;
        this.onTaskUpdate(live);
        this.notifyBadge();
      }
      clientLog('info', 'session', `恢复本站会话 ${sessionId}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * On a freshly opened page (by the user, not the agent), show 2-3 context-aware
   * hints about what the agent can do here, to help users discover capabilities.
   */
  private async showPageSuggestions(): Promise<void> {
    // Local heuristics are only a FALLBACK. We prepare them but do NOT flash
    // them before the model's page-matched suggestions arrive — otherwise the
    // user briefly sees generic teasers that then get replaced. While a model is
    // reachable, keep the pill bar hidden until real suggestions come back; only
    // fall back to heuristics when the model is unavailable (offline/error).
    const heuristics = this.dedupeSuggestions(this.buildSuggestions());
    this.suggestOffset = 0;

    if (!this.connected) {
      this.suggestPool = heuristics;
      if (this.suggestPool.length) this.renderSuggestionWindow();
      return;
    }

    try {
      const pageContext = extractPageContext();
      const { suggestions } = await sendMessage<{
        suggestions?: Array<{ label: string; prompt: string }>;
      }>({ type: 'SUGGEST_ACTIONS', pageContext });
      const list = (suggestions ?? []).filter((s) => s?.label && s?.prompt);
      // Model suggestions are the most relevant → show them first, keep the
      // heuristic ones as extra batches the user can cycle to with 换一批.
      // If the model returned nothing, fall back to the heuristics.
      this.suggestPool = this.dedupeSuggestions(list.length ? [...list, ...heuristics] : heuristics);
      this.suggestOffset = 0;
      if (this.suggestPool.length) this.renderSuggestionWindow();
    } catch {
      // Model unreachable → surface heuristics so the collapsed ball still helps.
      this.suggestPool = heuristics;
      this.suggestOffset = 0;
      if (this.suggestPool.length) this.renderSuggestionWindow();
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

  /** Grow the textarea up to MAX_AUTO_LINES, unless the user dragged it taller. */
  private autoSizeInput(): void {
    if (this.userResized) return;
    const cs = getComputedStyle(this.input);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = Math.round(lineHeight * MAX_AUTO_LINES + padding);
    this.input.style.height = 'auto';
    const h = Math.min(this.input.scrollHeight, max);
    this.input.style.height = `${h}px`;
    this.input.style.overflowY = this.input.scrollHeight > max ? 'auto' : 'hidden';
    this.lastAutoHeight = Math.round(this.input.getBoundingClientRect().height);
  }

  private resetInputHeight(): void {
    this.userResized = false;
    this.input.style.height = 'auto';
    this.input.style.overflowY = 'hidden';
    this.lastAutoHeight = Math.round(this.input.getBoundingClientRect().height);
  }

  /** Read picked files locally: text → extracted text, images → data URL. */
  private async handleFilesPicked(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (this.pendingAttachments.length >= MAX_ATTACHMENTS) {
        this.addSystemMessage(`最多只能附加 ${MAX_ATTACHMENTS} 个文件`);
        break;
      }
      const isImage = file.type.startsWith('image/');
      const isText = !isImage && (file.type.startsWith('text/') || TEXT_EXT.test(file.name));
      try {
        if (isImage) {
          if (file.size > MAX_IMAGE_BYTES) {
            this.addSystemMessage(`图片「${file.name}」超过 4MB，已跳过`);
            continue;
          }
          const dataUrl = await this.readFile(file, 'dataUrl');
          this.pendingAttachments.push({ name: file.name, mime: file.type || 'image/*', kind: 'image', dataUrl });
        } else if (isText) {
          let text = await this.readFile(file, 'text');
          if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…（已截断）`;
          this.pendingAttachments.push({ name: file.name, mime: file.type || 'text/plain', kind: 'text', text });
        } else {
          this.addSystemMessage(`不支持的文件类型：${file.name}`);
        }
      } catch {
        this.addSystemMessage(`读取「${file.name}」失败`);
      }
    }
    this.renderAttachChips();
  }

  private readFile(file: File, as: 'text' | 'dataUrl'): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error);
      if (as === 'text') reader.readAsText(file);
      else reader.readAsDataURL(file);
    });
  }

  private renderAttachChips(): void {
    this.attachChips.innerHTML = '';
    this.pendingAttachments.forEach((att, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const icon = att.kind === 'image' ? '🖼️' : '📄';
      const nameEl = document.createElement('span');
      nameEl.className = 'chip-name';
      nameEl.textContent = `${icon} ${att.name}`;
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = '移除';
      x.addEventListener('click', () => {
        this.pendingAttachments.splice(i, 1);
        this.renderAttachChips();
      });
      chip.appendChild(nameEl);
      chip.appendChild(x);
      this.attachChips.appendChild(chip);
    });
  }

  private async handleSend(): Promise<void> {
    const text = this.input.value.trim();
    const attachments = this.pendingAttachments.slice();
    if (!text && attachments.length === 0) return;
    if (!this.connected) {
      this.addSystemMessage('未连接到后端服务，请确认 npm run dev:server 已启动');
    }

    const attachNote = attachments.length ? attachments.map((a) => `📎 ${a.name}`).join('  ') : '';
    this.addUserMessage([text, attachNote].filter(Boolean).join('\n'));
    this.input.value = '';
    this.pendingAttachments = [];
    this.renderAttachChips();
    this.resetInputHeight();
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
    const requestMode = this.modeSelect.value || 'auto';

    try {
      await this.ensureSession(text || attachments.map((a) => a.name).join(', '));
      const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
        type: 'CREATE_TASK',
        userRequest: text,
        sessionId: this.currentSessionId ?? undefined,
        requestMode,
        kind: 'once',
        attachments: attachments.length ? attachments : undefined,
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

    // A "演示并保存" replay just finished — auto-save it (or report failure).
    if (
      this.pendingDemo &&
      this.pendingDemo.taskId === task.id &&
      ['completed', 'failed', 'cancelled'].includes(task.status)
    ) {
      void this.handleDemoFinished(task);
    }

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
        void this.persistSession(session.id);
        clientLog('info', 'session', `新建会话 ${session.id}`);
      }
    } catch {
      /* task can still run without a session */
    }
  }

  private newSession(): void {
    this.currentSessionId = null;
    void this.persistSession(null);
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
      void this.persistSession(id);
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
      if (this.currentSessionId === s.id) {
        this.currentSessionId = null;
        void this.persistSession(null);
      }
      await this.loadSessions();
    } catch (err) {
      this.addSystemMessage(`删除失败：${String(err)}`);
    }
  }

  private async refreshSessionsQuietly(): Promise<void> {
    if (!this.sessionDrawer.classList.contains('open')) return;
    await this.loadSessions();
  }

  // ---- Overflow menu ----

  private toggleMoreMenu(): void {
    const menu = this.panel.querySelector('.more-menu') as HTMLElement;
    menu.classList.toggle('open');
  }

  private closeMoreMenu(): void {
    this.panel.querySelector('.more-menu')?.classList.remove('open');
  }

  // ---- Voice input (Web Speech API) ----

  /** Load voice settings from local storage and reflect mic-button visibility. */
  private async loadVoiceSettings(): Promise<void> {
    try {
      const s = await chrome.storage.local.get(['voiceEnabled', 'voiceLang', 'voiceRefine']);
      this.voiceEnabled = s.voiceEnabled !== false; // default on
      this.voiceLang = typeof s.voiceLang === 'string' && s.voiceLang ? s.voiceLang : 'zh-CN';
      this.voiceRefine = s.voiceRefine !== false; // default on
    } catch {
      /* storage unavailable — keep defaults */
    }
    this.updateVoiceUI();
  }

  private voiceAvailable(): boolean {
    return this.voiceEnabled && isSpeechSupported();
  }

  private updateVoiceUI(): void {
    const show = this.voiceAvailable();
    if (this.micBtn) this.micBtn.style.display = show ? 'inline-flex' : 'none';
    const guide = this.recBar?.querySelector('.rec-guide') as HTMLButtonElement | null;
    if (guide) guide.style.display = show ? 'inline-flex' : 'none';
  }

  private bindVoice(): void {
    this.micBtn.addEventListener('click', () => this.toggleDictation());

    const guide = this.recBar.querySelector('.rec-guide') as HTMLButtonElement;
    const start = (e: Event) => {
      e.preventDefault();
      this.startGuidance();
    };
    const end = (e: Event) => {
      e.preventDefault();
      this.stopGuidance();
    };
    guide.addEventListener('pointerdown', start);
    guide.addEventListener('pointerup', end);
    guide.addEventListener('pointerleave', end);
    guide.addEventListener('pointercancel', end);

    // Only the foreground tab should hold the mic during recording.
    document.addEventListener('visibilitychange', () => {
      if (!this.recActive) return;
      if (document.visibilityState === 'visible') this.startNarration();
      else this.stopNarration();
    });

    // Keep voice settings in sync when changed from the settings UI.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.voiceEnabled || changes.voiceLang || changes.voiceRefine) {
          void this.loadVoiceSettings();
        }
      });
    } catch {
      /* storage events unavailable */
    }
  }

  /** Chat dictation: toggle listening; interim streams into the composer. */
  private toggleDictation(): void {
    if (this.dictationSession) {
      this.dictationSession.stop();
      return;
    }
    if (!this.voiceAvailable()) return;
    this.dictationBase = this.input.value.trim();
    this.micBtn.classList.add('listening');
    this.dictationSession = createDictation({
      lang: this.voiceLang,
      onInterim: (text) => {
        this.input.value = (this.dictationBase ? this.dictationBase + ' ' : '') + text;
        this.autoSizeInput();
      },
      onFinal: (text) => {
        this.dictationBase = (this.dictationBase ? this.dictationBase + ' ' : '') + text;
        this.input.value = this.dictationBase;
        this.autoSizeInput();
      },
      onError: (err) => {
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this.addSystemMessage('麦克风权限被拒绝，无法语音输入。请在浏览器地址栏允许本站使用麦克风。');
        }
      },
      onEnd: () => {
        this.dictationSession = null;
        this.micBtn.classList.remove('listening');
        void this.finishDictation();
      },
    });
    if (!this.dictationSession) this.micBtn.classList.remove('listening');
  }

  /** After dictation ends, optionally condense the transcript into a clean instruction. */
  private async finishDictation(): Promise<void> {
    const raw = this.input.value.trim();
    if (!raw || !this.voiceRefine) return;
    try {
      const { instruction, error } = await sendMessage<{ instruction?: string; error?: string }>({
        type: 'REFINE_VOICE',
        transcript: raw,
      });
      if (!error && instruction && instruction.trim()) {
        this.input.value = instruction.trim();
        this.autoSizeInput();
      }
    } catch {
      /* keep the raw transcript on failure */
    }
  }

  /** Continuous hands-free narration while recording (foreground tab only). */
  private startNarration(): void {
    if (this.narrationSession || !this.voiceAvailable()) return;
    if (document.visibilityState !== 'visible') return;
    this.narrationSession = createContinuous({
      lang: this.voiceLang,
      onFinal: (text) => {
        void sendMessage({
          type: 'NARRATION',
          item: { text, at: Date.now(), kind: 'narration' } as RecordingNarration,
        });
      },
    });
  }

  private stopNarration(): void {
    this.narrationSession?.stop();
    this.narrationSession = null;
  }

  /** Push-to-talk guidance: capture a spoken note for the current step. */
  private startGuidance(): void {
    if (!this.voiceAvailable() || this.guidanceSession) return;
    // Free the mic from continuous narration for this focused utterance.
    this.stopNarration();
    const guide = this.recBar.querySelector('.rec-guide') as HTMLButtonElement;
    const textEl = this.recBar.querySelector('.rec-text') as HTMLElement;
    const original = textEl.innerHTML;
    guide.classList.add('talking');
    this.guidanceSession = createDictation({
      lang: this.voiceLang,
      onInterim: (text) => {
        textEl.textContent = `🎤 ${text}`;
      },
      onFinal: (text) => {
        void sendMessage({
          type: 'NARRATION',
          item: { text, at: Date.now(), kind: 'guidance' } as RecordingNarration,
        });
      },
      onError: (err) => {
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this.addSystemMessage('麦克风权限被拒绝，无法语音指导。');
        }
      },
      onEnd: () => {
        this.guidanceSession = null;
        guide.classList.remove('talking');
        textEl.innerHTML = original;
        // Resume hands-free narration if still recording in the foreground.
        if (this.recActive) this.startNarration();
      },
    });
    if (!this.guidanceSession) {
      guide.classList.remove('talking');
      if (this.recActive) this.startNarration();
    }
  }

  private stopGuidance(): void {
    this.guidanceSession?.stop();
  }

  // ---- Action recording (capture user actions → understand → workflow) ----

  /** Reflect the background's recording state in the indicator bar. */
  private async refreshRecordState(): Promise<void> {
    try {
      const st = await sendMessage<{ recording?: boolean; count?: number }>({ type: 'GET_RECORD_STATE' });
      this.setRecBar(Boolean(st?.recording), st?.count ?? 0);
    } catch {
      /* background offline */
    }
  }

  private setRecBar(active: boolean, count: number): void {
    this.recBar.style.display = active ? 'flex' : 'none';
    (this.recBar.querySelector('.rec-count') as HTMLElement).textContent = String(count);
    this.updateVoiceUI();
    // Drive hands-free narration on the recording-active transition. Every session
    // tab polls while active so it also learns when recording stops (and releases
    // the mic), not just the tab that started it.
    if (active && !this.recActive) {
      this.recActive = true;
      this.startNarration();
      if (!this.recPollTimer) {
        this.recPollTimer = setInterval(() => void this.refreshRecordState(), 1200);
      }
    } else if (!active && this.recActive) {
      this.recActive = false;
      this.stopNarration();
      if (this.recPollTimer) {
        clearInterval(this.recPollTimer);
        this.recPollTimer = null;
      }
    }
  }

  private async startRecordingFlow(): Promise<void> {
    try {
      const res = await sendMessage<{ ok?: boolean; error?: string }>({ type: 'START_RECORDING' });
      if (!res?.ok) throw new Error(res?.error ?? '无法开始录制');
      this.setRecBar(true, 0);
      this.openPanel();
      this.addSystemMessage('⏺ 已开始录制。请在页面上正常操作，完成后点上方“停止并保存”。');
      // Live-update the step counter while recording.
      if (this.recPollTimer) clearInterval(this.recPollTimer);
      this.recPollTimer = setInterval(() => void this.refreshRecordState(), 1200);
    } catch (err) {
      this.addSystemMessage(`录制启动失败：${String(err)}`);
    }
  }

  private async stopRecordingFlow(): Promise<void> {
    if (this.recPollTimer) {
      clearInterval(this.recPollTimer);
      this.recPollTimer = null;
    }
    const stopBtn = this.recBar.querySelector('.rec-stop') as HTMLButtonElement;
    stopBtn.disabled = true;
    try {
      const { actions, narration, startUrl } = await sendMessage<{
        actions?: RecordedAction[];
        narration?: RecordingNarration[];
        startUrl?: string;
      }>({ type: 'STOP_RECORDING' });
      this.setRecBar(false, 0);
      if (!actions || actions.length === 0) {
        this.addSystemMessage('没有捕获到任何操作，已取消录制。');
        return;
      }
      this.addSystemMessage(`⏹ 录制结束，共 ${actions.length} 个操作，正在整理为工作流…`);
      this.setState('thinking');
      const understood = await sendMessage<{
        name?: string;
        steps?: WorkflowStep[];
        params?: WorkflowParam[];
        error?: string;
      }>({ type: 'UNDERSTAND_RECORDING', actions, narration, startUrl });
      this.setState('idle');
      if (understood?.error || !understood?.steps?.length) {
        throw new Error(understood?.error ?? '未能整理出可用步骤');
      }
      this.pendingRecording = {
        name: understood.name ?? '录制的工作流',
        steps: understood.steps,
        params: understood.params ?? [],
        startUrl,
      };
      this.openReview();
    } catch (err) {
      this.setState('idle');
      this.addSystemMessage(`整理录制失败：${String(err)}`);
    } finally {
      stopBtn.disabled = false;
    }
  }

  private bindReviewModal(): void {
    const m = this.reviewModal;
    (m.querySelector('.rev-close') as HTMLButtonElement).addEventListener('click', () => this.closeReview());
    (m.querySelector('.set-backdrop') as HTMLElement).addEventListener('click', () => this.closeReview());
    (m.querySelector('.rev-cancel') as HTMLButtonElement).addEventListener('click', () => this.closeReview());
    (m.querySelector('.rev-save') as HTMLButtonElement).addEventListener('click', () => void this.saveRecording(false));
    (m.querySelector('.rev-demo') as HTMLButtonElement).addEventListener('click', () => void this.saveRecording(true));
    (m.querySelector('.rev-nl-apply') as HTMLButtonElement).addEventListener('click', () => void this.applyNlEdit());
  }

  private openReview(): void {
    const r = this.pendingRecording;
    if (!r) return;
    const m = this.reviewModal;
    (m.querySelector('.rev-name') as HTMLInputElement).value = r.name;
    (m.querySelector('.rev-res') as HTMLElement).textContent = '';
    (m.querySelector('.rev-nl') as HTMLTextAreaElement).value = '';
    (m.querySelector('.rev-nl-res') as HTMLElement).textContent = '';
    this.renderReview();
    this.closeMoreMenu();
    m.classList.add('open');
  }

  /** Which arg carries the human-meaningful "value" of a step (for inline editing). */
  private primaryArg(tool: string): { key: string; label: string } | null {
    switch (tool) {
      case 'type':
        return { key: 'text', label: '输入文本' };
      case 'navigate':
        return { key: 'url', label: '网址' };
      case 'selectOption':
        return { key: 'value', label: '选项值' };
      case 'pressKey':
        return { key: 'key', label: '按键' };
      default:
        return null;
    }
  }

  /** Re-render the editable step + param lists from this.pendingRecording. */
  private renderReview(): void {
    const r = this.pendingRecording;
    if (!r) return;
    const m = this.reviewModal;
    (m.querySelector('.rev-step-count') as HTMLElement).textContent = String(r.steps.length);

    const stepsEl = m.querySelector('.rev-steps') as HTMLElement;
    stepsEl.replaceChildren(...r.steps.map((s, i) => this.buildStepRow(s, i)));

    const paramsSec = m.querySelector('.rev-params-sec') as HTMLElement;
    const paramsEl = m.querySelector('.rev-params') as HTMLElement;
    if (r.params.length) {
      paramsSec.style.display = '';
      paramsEl.replaceChildren(...r.params.map((p, i) => this.buildParamRow(p, i)));
    } else {
      paramsSec.style.display = 'none';
      paramsEl.replaceChildren();
    }
  }

  private buildStepRow(step: WorkflowStep, idx: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'rev-step';

    const top = document.createElement('div');
    top.className = 'rev-step-top';
    const badge = document.createElement('span');
    badge.className = 'rev-step-idx';
    badge.textContent = String(idx + 1);
    const tool = document.createElement('span');
    tool.className = 'rev-step-tool';
    tool.textContent = step.tool;
    const sp = document.createElement('span');
    sp.className = 'rev-step-sp';

    const up = this.iconBtn('↑', '上移', idx === 0);
    up.addEventListener('click', () => this.moveStep(idx, -1));
    const down = this.iconBtn('↓', '下移', idx === this.pendingRecording!.steps.length - 1);
    down.addEventListener('click', () => this.moveStep(idx, 1));
    const del = this.iconBtn('🗑', '删除', false);
    del.classList.add('del');
    del.addEventListener('click', () => this.deleteStep(idx));

    top.append(badge, tool, sp, up, down, del);
    row.appendChild(top);

    row.appendChild(
      this.editField('说明', step.description ?? '', (v) => {
        this.pendingRecording!.steps[idx].description = v;
      })
    );

    const pa = this.primaryArg(step.tool);
    if (pa) {
      const cur = step.args?.[pa.key];
      row.appendChild(
        this.editField(pa.label, cur == null ? '' : String(cur), (v) => {
          this.pendingRecording!.steps[idx].args = {
            ...this.pendingRecording!.steps[idx].args,
            [pa.key]: v,
          };
        })
      );
    }

    if (step.args && 'selector' in step.args) {
      row.appendChild(
        this.editField(
          '选择器',
          step.args.selector == null ? '' : String(step.args.selector),
          (v) => {
            this.pendingRecording!.steps[idx].args = {
              ...this.pendingRecording!.steps[idx].args,
              selector: v,
            };
          },
          true
        )
      );
    }

    return row;
  }

  private buildParamRow(param: WorkflowParam, idx: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'rev-param';

    const top = document.createElement('div');
    top.className = 'rev-param-top';
    const code = document.createElement('code');
    code.textContent = `{{${param.key}}}`;
    const modeSel = document.createElement('select');
    modeSel.className = 'rev-param-mode';
    for (const [val, text] of [
      ['prompt', '每次询问'],
      ['generate', '自动生成'],
      ['constant', '固定值'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      modeSel.appendChild(opt);
    }
    modeSel.value = param.mode ?? 'prompt';
    modeSel.addEventListener('change', () => {
      this.pendingRecording!.params[idx].mode = modeSel.value as WorkflowParam['mode'];
      this.renderReview();
    });
    top.append(code, modeSel);
    row.appendChild(top);

    row.appendChild(
      this.editField('名称', param.label ?? param.key, (v) => {
        this.pendingRecording!.params[idx].label = v;
      })
    );

    const mode = param.mode ?? 'prompt';
    if (mode === 'generate') {
      row.appendChild(
        this.editField(
          '如何生成（自然语言）',
          param.instruction ?? '',
          (v) => {
            this.pendingRecording!.params[idx].instruction = v;
          },
          false,
          '例：生成一个随机测试邮箱 / 用今天的日期，格式 YYYY-MM-DD'
        )
      );
    } else {
      row.appendChild(
        this.editField(mode === 'constant' ? '固定值' : '默认值', param.default ?? '', (v) => {
          this.pendingRecording!.params[idx].default = v;
        })
      );
    }

    return row;
  }

  private iconBtn(text: string, title: string, disabled: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'rev-step-btn';
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.disabled = disabled;
    return b;
  }

  private editField(
    label: string,
    value: string,
    onInput: (v: string) => void,
    mono = false,
    placeholder = ''
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'rev-field';
    const lab = document.createElement('label');
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = mono ? 'rev-in mono' : 'rev-in';
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(lab, input);
    return wrap;
  }

  private moveStep(idx: number, dir: -1 | 1): void {
    const steps = this.pendingRecording?.steps;
    if (!steps) return;
    const j = idx + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[idx], steps[j]] = [steps[j], steps[idx]];
    this.renderReview();
  }

  private deleteStep(idx: number): void {
    const steps = this.pendingRecording?.steps;
    if (!steps) return;
    steps.splice(idx, 1);
    this.renderReview();
  }

  /** Send a natural-language edit instruction to the backend and apply the result. */
  private async applyNlEdit(): Promise<void> {
    const r = this.pendingRecording;
    if (!r) return;
    const m = this.reviewModal;
    const ta = m.querySelector('.rev-nl') as HTMLTextAreaElement;
    const resEl = m.querySelector('.rev-nl-res') as HTMLElement;
    const instruction = ta.value.trim();
    if (!instruction) {
      resEl.textContent = '请先输入修改指令';
      return;
    }
    const applyBtn = m.querySelector('.rev-nl-apply') as HTMLButtonElement;
    applyBtn.disabled = true;
    resEl.textContent = '正在修改…';
    try {
      const name = (m.querySelector('.rev-name') as HTMLInputElement).value.trim() || r.name;
      const edited = await sendMessage<{
        name?: string;
        steps?: WorkflowStep[];
        params?: WorkflowParam[];
        error?: string;
      }>({
        type: 'EDIT_RECORDING',
        name,
        steps: r.steps,
        params: r.params,
        instruction,
      });
      if (edited.error || !edited.steps) throw new Error(edited.error ?? '修改失败');
      this.pendingRecording = {
        ...r,
        name: edited.name?.trim() || name,
        steps: edited.steps,
        params: edited.params ?? [],
      };
      (m.querySelector('.rev-name') as HTMLInputElement).value = this.pendingRecording.name;
      this.renderReview();
      ta.value = '';
      resEl.textContent = '✅ 已应用';
    } catch (err) {
      resEl.textContent = `失败：${String(err)}`;
    } finally {
      applyBtn.disabled = false;
    }
  }

  private closeReview(): void {
    this.reviewModal.classList.remove('open');
  }

  /** Persist the reviewed recording — either straight away or after a live demo. */
  private async saveRecording(demo: boolean): Promise<void> {
    if (!this.pendingRecording) return;
    const m = this.reviewModal;
    const name = (m.querySelector('.rev-name') as HTMLInputElement).value.trim();
    if (!name) {
      (m.querySelector('.rev-res') as HTMLElement).textContent = '请填写工作流名称';
      return;
    }
    const rec = { ...this.pendingRecording, name };
    const buttons = m.querySelectorAll<HTMLButtonElement>('.rev-save, .rev-demo');
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (demo) {
        const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
          type: 'DEMO_RECORDING',
          name: rec.name,
          steps: rec.steps,
          params: rec.params,
          startUrl: rec.startUrl,
        });
        if (error || !task) throw new Error(error ?? '演示启动失败');
        // Auto-save once the replay finishes (see handleDemoFinished).
        this.pendingDemo = {
          taskId: task.id,
          name: rec.name,
          steps: rec.steps,
          params: rec.params,
          startUrl: rec.startUrl,
        };
        this.closeReview();
        this.addSystemMessage(`▶️ 正在演示「${rec.name}」，完成后会自动保存为工作流…`);
        this.onTaskUpdate(task);
      } else {
        const { workflow, error } = await sendMessage<{ workflow?: Workflow; error?: string }>({
          type: 'SAVE_RECORDING',
          name: rec.name,
          description: `录制生成 · ${rec.steps.length} 步`,
          steps: rec.steps,
          params: rec.params,
          startUrl: rec.startUrl,
        });
        if (error || !workflow) throw new Error(error ?? '保存失败');
        this.closeReview();
        this.addSystemMessage(`✅ 已保存工作流：${rec.name}`);
        if (this.wfDrawer.classList.contains('open')) void this.loadWorkflows();
      }
      this.pendingRecording = null;
    } catch (err) {
      (m.querySelector('.rev-res') as HTMLElement).textContent = `失败：${String(err)}`;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  private async handleDemoFinished(task: Task): Promise<void> {
    const demo = this.pendingDemo;
    if (!demo) return;
    this.pendingDemo = null;
    const succeeded = task.status === 'completed' && (task.outcome === 'success' || !task.outcome);
    if (!succeeded) {
      this.addSystemMessage('⚠️ 演示未成功完成，未自动保存。你可以重新录制或直接保存。');
      return;
    }
    try {
      const { workflow, error } = await sendMessage<{ workflow?: Workflow; error?: string }>({
        type: 'SAVE_RECORDING',
        name: demo.name,
        description: `录制生成（已演示）· ${demo.steps.length} 步`,
        steps: demo.steps,
        params: demo.params,
        startUrl: demo.startUrl,
      });
      if (error || !workflow) throw new Error(error ?? '保存失败');
      this.addSystemMessage(`✅ 演示成功，已保存工作流：${demo.name}`);
      if (this.wfDrawer.classList.contains('open')) void this.loadWorkflows();
    } catch (err) {
      this.addSystemMessage(`演示成功但保存失败：${String(err)}`);
    }
  }

  // ---- Settings (in-page overlay) ----

  private bindSettingsModal(): void {
    const m = this.settingsModal;
    (m.querySelector('.set-close') as HTMLButtonElement).addEventListener('click', () => this.closeSettings());
    (m.querySelector('.set-backdrop') as HTMLElement).addEventListener('click', () => this.closeSettings());
    (m.querySelector('.set-save') as HTMLButtonElement).addEventListener('click', () => this.saveSettings());
    (m.querySelector('.set-test') as HTMLButtonElement).addEventListener('click', () => this.testConnection());
    (m.querySelector('.set-export') as HTMLButtonElement).addEventListener('click', () => this.exportDebugBundle());
    (m.querySelector('.set-clearlogs') as HTMLButtonElement).addEventListener('click', () => this.clearDebugLogs());
  }

  private setEl<T extends HTMLElement>(key: string): T {
    return this.settingsModal.querySelector(`[data-k="${key}"]`) as T;
  }

  /** Open the settings overlay and populate it from local + server config. */
  private async openSettings(): Promise<void> {
    this.settingsModal.classList.add('open');
    (this.settingsModal.querySelector('.set-save-res') as HTMLElement).textContent = '';

    try {
      const s = await chrome.storage.local.get([
        'backendUrl', 'wsUrl', 'autorunEnabled', 'autorunWhitelist',
        'authToken', 'allowEvaluate', 'allowPrivateNetwork',
        'voiceEnabled', 'voiceLang', 'voiceRefine',
      ]);
      this.setEl<HTMLInputElement>('backendUrl').value = (s.backendUrl as string) ?? '';
      this.setEl<HTMLInputElement>('wsUrl').value = (s.wsUrl as string) ?? '';
      this.setEl<HTMLInputElement>('autorunEnabled').checked = Boolean(s.autorunEnabled);
      this.setEl<HTMLTextAreaElement>('autorunWhitelist').value = Array.isArray(s.autorunWhitelist)
        ? (s.autorunWhitelist as string[]).join('\n')
        : '';
      this.setEl<HTMLInputElement>('authToken').value = (s.authToken as string) ?? '';
      // allowEvaluate defaults ON (matches options page semantics).
      this.setEl<HTMLInputElement>('allowEvaluate').checked = s.allowEvaluate !== false;
      this.setEl<HTMLInputElement>('allowPrivateNetwork').checked = Boolean(s.allowPrivateNetwork);
      // Voice defaults ON.
      this.setEl<HTMLInputElement>('voiceEnabled').checked = s.voiceEnabled !== false;
      this.setEl<HTMLInputElement>('voiceRefine').checked = s.voiceRefine !== false;
      this.setEl<HTMLInputElement>('voiceLang').value = (s.voiceLang as string) ?? 'zh-CN';
    } catch {
      /* storage unavailable */
    }

    try {
      const { config } = await sendMessage<{
        config?: { llmBaseUrl?: string; llmModel?: string; maxSteps?: number; hasApiKey?: boolean };
      }>({ type: 'GET_SERVER_CONFIG' });
      if (config) {
        this.setEl<HTMLInputElement>('llmBaseUrl').value = config.llmBaseUrl ?? '';
        this.setEl<HTMLInputElement>('llmModel').value = config.llmModel ?? '';
        this.setEl<HTMLInputElement>('maxSteps').value = config.maxSteps ? String(config.maxSteps) : '';
        this.setEl<HTMLInputElement>('llmApiKey').placeholder = config.hasApiKey ? '已设置（留空保持不变）' : '留空则不修改';
      }
    } catch {
      /* backend offline; local settings still editable */
    }
  }

  private closeSettings(): void {
    this.settingsModal.classList.remove('open');
  }

  private async saveSettings(): Promise<void> {
    const res = this.settingsModal.querySelector('.set-save-res') as HTMLElement;
    res.textContent = '保存中…';
    res.className = 'set-hint set-save-res';

    const backendUrl = this.setEl<HTMLInputElement>('backendUrl').value.trim();
    const wsUrl = this.setEl<HTMLInputElement>('wsUrl').value.trim();
    const autorunWhitelist = this.setEl<HTMLTextAreaElement>('autorunWhitelist')
      .value.split('\n').map((l) => l.trim()).filter(Boolean);

    try {
      await chrome.storage.local.set({
        backendUrl,
        wsUrl,
        autorunEnabled: this.setEl<HTMLInputElement>('autorunEnabled').checked,
        autorunWhitelist,
        authToken: this.setEl<HTMLInputElement>('authToken').value.trim(),
        allowEvaluate: this.setEl<HTMLInputElement>('allowEvaluate').checked,
        allowPrivateNetwork: this.setEl<HTMLInputElement>('allowPrivateNetwork').checked,
        voiceEnabled: this.setEl<HTMLInputElement>('voiceEnabled').checked,
        voiceRefine: this.setEl<HTMLInputElement>('voiceRefine').checked,
        voiceLang: this.setEl<HTMLInputElement>('voiceLang').value.trim() || 'zh-CN',
      });
    } catch {
      /* storage unavailable */
    }

    const serverPatch: Record<string, unknown> = {
      llmBaseUrl: this.setEl<HTMLInputElement>('llmBaseUrl').value.trim(),
      llmModel: this.setEl<HTMLInputElement>('llmModel').value.trim(),
    };
    const apiKey = this.setEl<HTMLInputElement>('llmApiKey').value;
    if (apiKey) serverPatch.llmApiKey = apiKey;
    const maxSteps = this.setEl<HTMLInputElement>('maxSteps').value.trim();
    if (maxSteps) serverPatch.maxSteps = Number(maxSteps);

    try {
      await sendMessage({ type: 'SET_SERVER_CONFIG', config: serverPatch });
      res.textContent = '已保存 ✓';
      res.className = 'set-hint set-save-res ok';
      this.setEl<HTMLInputElement>('llmApiKey').value = '';
      // Reconnect so a changed backend/ws address takes effect immediately.
      void sendMessage({ type: 'CONNECT_BACKEND' });
    } catch (err) {
      res.textContent = `本地已保存，后端配置失败：${err instanceof Error ? err.message : String(err)}`;
      res.className = 'set-hint set-save-res err';
    }
  }

  private async testConnection(): Promise<void> {
    const res = this.settingsModal.querySelector('.set-test-res') as HTMLElement;
    res.textContent = '测试中…';
    res.className = 'set-hint set-test-res';
    const backendUrl = this.setEl<HTMLInputElement>('backendUrl').value.trim() || DEFAULT_BACKEND_URL;
    try {
      const r = await fetch(`${backendUrl}/health`);
      const data = (await r.json()) as { status?: string; extensionConnected?: boolean };
      res.textContent = `正常（${data.status}，扩展连接=${data.extensionConnected ? '是' : '否'}）`;
      res.className = 'set-hint set-test-res ok';
    } catch (err) {
      res.textContent = `连接失败：${err instanceof Error ? err.message : String(err)}`;
      res.className = 'set-hint set-test-res err';
    }
  }

  private async exportDebugBundle(): Promise<void> {
    const res = this.settingsModal.querySelector('.set-debug-res') as HTMLElement;
    res.textContent = '生成中…';
    res.className = 'set-hint set-debug-res';
    try {
      const bundle = await sendMessage<{ error?: string } & Record<string, unknown>>({ type: 'GET_DEBUG_BUNDLE' });
      if (bundle?.error) throw new Error(bundle.error);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-agent-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      res.textContent = '已导出调试包 ✓';
      res.className = 'set-hint set-debug-res ok';
    } catch (err) {
      res.textContent = `导出失败：${err instanceof Error ? err.message : String(err)}`;
      res.className = 'set-hint set-debug-res err';
    }
  }

  private async clearDebugLogs(): Promise<void> {
    const res = this.settingsModal.querySelector('.set-debug-res') as HTMLElement;
    try {
      await sendMessage({ type: 'CLEAR_DEBUG_LOGS' });
      res.textContent = '已清空日志 ✓';
      res.className = 'set-hint set-debug-res ok';
    } catch (err) {
      res.textContent = `清空失败：${err instanceof Error ? err.message : String(err)}`;
      res.className = 'set-hint set-debug-res err';
    }
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

    const runOpts = await this.askRunOptions(wf.name);
    if (runOpts === null) return; // cancelled

    const loopHint = runOpts.loopIntervalMs ? `（循环，每 ${runOpts.loopIntervalMs}ms）` : '';
    this.addSystemMessage(`▶ 执行工作流：${wf.name}${loopHint}`);
    clientLog('info', 'workflow', `执行工作流 ${wf.name}`, { id: wf.id, loopIntervalMs: runOpts.loopIntervalMs });
    try {
      const { task, error } = await sendMessage<{ task?: Task; error?: string }>({
        type: 'RUN_WORKFLOW',
        workflowId: wf.id,
        params,
        loopIntervalMs: runOpts.loopIntervalMs,
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

  /**
   * Ask how to run a saved workflow: once, or loop on an interval. Returns the
   * chosen `loopIntervalMs` (undefined for a single run) or null if cancelled.
   */
  private askRunOptions(name: string): Promise<{ loopIntervalMs?: number } | null> {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'msg agent';
      el.innerHTML = `
        <div class="bubble text">
          <span class="run-title"></span>
          <div class="run-opts">
            <label class="run-loop"><input type="checkbox" class="loop-toggle"> 循环运行</label>
            <span class="run-interval-wrap"><input type="number" class="run-interval" value="60000" min="5000" step="1000" disabled> ms</span>
          </div>
          <div class="inline-actions">
            <button class="btn-continue run-go">运行一次</button>
            <button class="btn-retry run-cancel">取消</button>
          </div>
        </div>`;
      (el.querySelector('.run-title') as HTMLElement).textContent = `▶ 运行「${name}」`;
      const loopToggle = el.querySelector('.loop-toggle') as HTMLInputElement;
      const interval = el.querySelector('.run-interval') as HTMLInputElement;
      const goBtn = el.querySelector('.run-go') as HTMLButtonElement;
      const cancelBtn = el.querySelector('.run-cancel') as HTMLButtonElement;
      loopToggle.addEventListener('change', () => {
        interval.disabled = !loopToggle.checked;
        goBtn.textContent = loopToggle.checked ? '开始循环' : '运行一次';
      });
      const finish = (result: { loopIntervalMs?: number } | null) => {
        goBtn.disabled = true;
        cancelBtn.disabled = true;
        el.querySelector('.run-opts')?.remove();
        resolve(result);
      };
      goBtn.addEventListener('click', () => {
        if (loopToggle.checked) {
          const ms = Math.max(5000, parseInt(interval.value, 10) || 60000);
          finish({ loopIntervalMs: ms });
        } else {
          finish({});
        }
      });
      cancelBtn.addEventListener('click', () => finish(null));
      this.messages.appendChild(el);
      this.scrollToBottom();
    });
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
