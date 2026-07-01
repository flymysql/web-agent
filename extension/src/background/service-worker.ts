import { DEFAULT_BACKEND_URL, DEFAULT_WS_URL } from '@ai-browser-agent/shared';
import type {
  PageContext,
  RecordedAction,
  RecordingNarration,
  Task,
  WsMessage,
} from '@ai-browser-agent/shared';

// ---------------------------------------------------------------------------
// Settings (user-overridable via the options page / chrome.storage.local)
// ---------------------------------------------------------------------------
let BACKEND_HTTP = DEFAULT_BACKEND_URL;
let BACKEND_WS = DEFAULT_WS_URL;
let autorunEnabled = false;
let autorunWhitelist: string[] = [];
let authToken = '';
let allowEvaluate = true;
let allowPrivateNetwork = false;
const recentAutorun = new Map<string, number>();
const AUTORUN_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Action recording (capture user interactions → understand → workflow).
// State lives here (not the content script) so it survives navigations, and is
// mirrored to session storage so it survives a service-worker restart.
// ---------------------------------------------------------------------------
interface RecordingState {
  /** The tab the recording started on (origin). */
  tabId: number;
  /** Every tab that belongs to this recording session (origin + tabs opened during it). */
  tabIds: number[];
  startUrl: string;
  actions: RecordedAction[];
  /** Spoken narration / guidance captured during the session (timestamped). */
  narration: RecordingNarration[];
}
let recording: RecordingState | null = null;
const RECORDING_KEY = 'agent_recording';
// MV3 service workers are terminated aggressively (often mid-navigation). This
// promise lets recording handlers wait until state has been rehydrated from
// session storage after a restart, so a GET_RECORD_STATE / RECORD_ACTION / STOP
// that arrives right after a wake doesn't see a spuriously-empty recording.
let recordingReady: Promise<void> | null = null;

async function loadRecording(): Promise<void> {
  try {
    const s = await chrome.storage.session.get(RECORDING_KEY);
    recording = (s[RECORDING_KEY] as RecordingState | undefined) ?? null;
    // Migrate state persisted before multi-tab / narration existed.
    if (recording && !Array.isArray(recording.tabIds)) {
      recording.tabIds = [recording.tabId];
    }
    if (recording && !Array.isArray(recording.narration)) {
      recording.narration = [];
    }
  } catch {
    /* session storage unavailable */
  }
}

/** True when the tab belongs to the active recording session. */
function isSessionTab(id?: number): boolean {
  return id != null && !!recording && recording.tabIds.includes(id);
}

/** Only http(s) pages are replayable navigations; skip chrome://, about:blank, extension pages, etc. */
function isRecordableUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/**
 * Record a page transition as a `navigate` action so a multi-tab recording can
 * be replayed deterministically in the single bound replay tab. Dedupes against
 * the last navigate and skips the initial start page.
 */
function pushNavigate(url: string | undefined): void {
  if (!recording || !isRecordableUrl(url)) return;
  const last = recording.actions[recording.actions.length - 1];
  if (last?.tool === 'navigate' && last.args?.url === url) return;
  if (url === recording.startUrl && recording.actions.length === 0) return;
  recording.actions.push({ tool: 'navigate', args: { url }, url, at: Date.now() });
  void persistRecording();
}

function ensureRecordingLoaded(): Promise<void> {
  if (!recordingReady) recordingReady = loadRecording();
  return recordingReady;
}

async function persistRecording(): Promise<void> {
  try {
    if (recording) await chrome.storage.session.set({ [RECORDING_KEY]: recording });
    else await chrome.storage.session.remove(RECORDING_KEY);
  } catch {
    /* ignore */
  }
}

// A tab opened while recording joins the session (covers link-open / window.open /
// Ctrl+T). Its actions/navigation are then accepted like the origin tab's.
chrome.tabs.onCreated.addListener((tab) => {
  if (recording && tab.id != null && !recording.tabIds.includes(tab.id)) {
    recording.tabIds.push(tab.id);
    void persistRecording();
  }
});

// Switching to another session tab is recorded as a navigate to that tab's URL,
// so replay (single tab) follows the switch even when the tab was already loaded.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!isSessionTab(tabId)) return;
  chrome.tabs
    .get(tabId)
    .then((tab) => pushNavigate(tab.url))
    .catch(() => {});
});

// Drop a closed tab from the session; abandon the recording only when they're all gone.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!recording) return;
  recording.tabIds = recording.tabIds.filter((id) => id !== tabId);
  if (recording.tabIds.length === 0) {
    recording = null;
  }
  void persistRecording();
});

async function loadSettings(): Promise<void> {
  try {
    const s = await chrome.storage.local.get([
      'backendUrl',
      'wsUrl',
      'autorunEnabled',
      'autorunWhitelist',
      'authToken',
      'allowEvaluate',
      'allowPrivateNetwork',
    ]);
    if (typeof s.backendUrl === 'string' && s.backendUrl) BACKEND_HTTP = s.backendUrl;
    if (typeof s.wsUrl === 'string' && s.wsUrl) BACKEND_WS = s.wsUrl;
    autorunEnabled = Boolean(s.autorunEnabled);
    autorunWhitelist = Array.isArray(s.autorunWhitelist) ? (s.autorunWhitelist as string[]) : [];
    authToken = typeof s.authToken === 'string' ? s.authToken : '';
    allowEvaluate = s.allowEvaluate !== false;
    allowPrivateNetwork = Boolean(s.allowPrivateNetwork);
  } catch {
    /* defaults */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const urlChanged = changes.backendUrl || changes.wsUrl || changes.authToken;
  void loadSettings().then(() => {
    if (urlChanged) {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      connectBackend();
    }
  });
});

// ---------------------------------------------------------------------------
// Client-side log forwarding (batched → backend debug log)
// ---------------------------------------------------------------------------
interface ClientLogEntry {
  ts: number;
  level: string;
  category: string;
  message: string;
  data?: unknown;
  taskId?: string;
}
const clientLogBuffer: ClientLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function logClient(
  level: string,
  category: string,
  message: string,
  data?: unknown,
  taskId?: string
): void {
  clientLogBuffer.push({ ts: Date.now(), level, category, message, data, taskId });
  if (clientLogBuffer.length > 500) clientLogBuffer.splice(0, clientLogBuffer.length - 500);
  if (clientLogBuffer.length >= 20) {
    void flushClientLogs();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushClientLogs();
    }, 3000);
  }
}

async function flushClientLogs(): Promise<void> {
  if (!clientLogBuffer.length) return;
  const batch = clientLogBuffer.splice(0, clientLogBuffer.length);
  try {
    await fetch(`${BACKEND_HTTP}/api/debug/client-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ entries: batch.map((e) => ({ source: 'client', ...e })) }),
    });
  } catch {
    /* backend offline; drop this batch to avoid unbounded growth */
  }
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------
let ws: WebSocket | null = null;
let sessionId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ToolOutcome = {
  success: boolean;
  result?: unknown;
  error?: string;
  pageContext?: PageContext;
};

// ---------------------------------------------------------------------------
// Cross-window / cross-navigation content-script readiness
// ---------------------------------------------------------------------------
const CONTENT_SCRIPT_FILE = 'content.js';

/** Wait until a tab finishes (re)loading, so we don't message a half-loaded page. */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // brief settle so the content script can re-inject after load
      setTimeout(resolve, 400);
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => finish());
  });
}

/** Programmatically (re)inject the content script into the top frame. Returns false on restricted pages. */
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [CONTENT_SCRIPT_FILE],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the top frame's content script is loaded and responsive, waiting out any
 * in-flight navigation and (re)injecting if needed. This is what lets a task keep
 * running after the page navigates to a new URL (or moves between windows).
 */
async function ensureContentReady(tabId: number, timeoutMs = 12000): Promise<boolean> {
  const start = Date.now();
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'loading') await waitForTabComplete(tabId, timeoutMs);
  } catch {
    return false; // tab no longer exists
  }
  let injected = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const pong = (await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 })) as
        | { ready?: boolean }
        | undefined;
      if (pong?.ready) return true;
    } catch {
      if (!injected) injected = await injectContentScript(tabId);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Send a message to the top frame's content script, surviving navigation via readiness checks + retries. */
async function sendToContent<T>(tabId: number, message: object): Promise<T> {
  await ensureContentReady(tabId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await chrome.tabs.sendMessage(tabId, message, { frameId: 0 })) as T;
    } catch (err) {
      lastErr = err;
      await ensureContentReady(tabId); // page likely navigated; wait + re-inject, then retry
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getPageContext(tabId?: number): Promise<PageContext> {
  const tab = tabId ? { id: tabId } : await getActiveTab();
  if (!tab?.id) throw new Error('No active tab');
  const response = await sendToContent<{ pageContext: PageContext }>(tab.id, {
    type: 'GET_PAGE_CONTEXT',
  });
  return response.pageContext;
}

async function getPageContextRetry(tabId: number, attempts = 6): Promise<PageContext | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await getPageContext(tabId);
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return undefined;
}

/** Attach a fresh page context to a successful tool result (so the agent re-observes). */
async function withPageContext(tabId: number, result: ToolOutcome): Promise<ToolOutcome> {
  if (!result.success) return result;
  try {
    result.pageContext = await getPageContext(tabId);
  } catch {
    /* ignore */
  }
  return result;
}

// ---------------------------------------------------------------------------
// Background-executed tools (privileged: scripting / tabs / cookies / network)
// ---------------------------------------------------------------------------
async function runEvaluateOnTab(tabId: number, code: string): Promise<ToolOutcome> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (src: string) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const compile = (body: string): Function => new Function(`return (async () => {${body}})()`);
        // First try the code as a single EXPRESSION (auto-return), so models that
        // write `Array.from(...).map(...)` with no explicit return still yield a
        // value instead of silently returning undefined (which serializes to {}).
        let fn: Function | null = null;
        try {
          fn = compile(`return (\n${src}\n);`);
        } catch {
          fn = null;
        }
        // Otherwise run it as raw STATEMENTS (its own return / multi-line code).
        if (!fn) {
          try {
            fn = compile(`\n${src}\n`);
          } catch (e) {
            return { ok: false, error: String((e as Error)?.message ?? e), syntax: e instanceof SyntaxError };
          }
        }
        try {
          const value = await fn();
          return { ok: true, value };
        } catch (e) {
          return { ok: false, error: String((e as Error)?.message ?? e), syntax: e instanceof SyntaxError };
        }
      },
      args: [code],
    });
    const out = results?.[0]?.result as
      | { ok: boolean; value?: unknown; error?: string; syntax?: boolean }
      | undefined;
    if (!out) return { success: false, error: 'No result returned from page' };
    if (!out.ok) {
      const base = out.error ?? 'evaluate failed';
      // Some sites (e.g. github.com) block eval/new Function via CSP. evaluate
      // can NEVER work there — tell the agent to stop trying it and use DOM tools.
      if (/content security policy|unsafe-eval|EvalError/i.test(base)) {
        return {
          success: false,
          error: '此页面的内容安全策略(CSP)禁止 evaluate（unsafe-eval 被阻止），evaluate 在本站点无法使用。请改用 click / getHTML / readText / inspect 等 DOM 工具或直接读取页面内容，不要再尝试 evaluate。',
        };
      }
      // Make syntax errors actionable so the agent stops resending broken code.
      const error = out.syntax
        ? `evaluate 代码有语法错误（${base}）。不要重发同一段代码——请简化代码、检查括号/引号是否配对，或直接从页面文本/可交互元素读取所需数据。`
        : base;
      return { success: false, error };
    }
    let value = out.value;
    try {
      JSON.stringify(value);
    } catch {
      value = String(value);
    }
    // A bare expression that legitimately yields nothing still returns undefined;
    // flag it so the model doesn't misread "{}" as "the page has no data".
    if (value === undefined) {
      return {
        success: true,
        result: { value: null, note: 'evaluate 没有返回值（代码可能缺少 return，或目标确实为空）；如需取值，请让最后一个表达式就是要返回的数据。' },
      };
    }
    return { success: true, result: { value } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function insertCssOnTab(tabId: number, css: string): Promise<ToolOutcome> {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, css });
    return { success: true, result: { injected: css.length } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

// When the AGENT navigates a tab we note the time, so a freshly (re)loaded page
// can tell whether the load was agent-driven (keep panel open) or a user's own
// refresh/new page (stay minimized + show suggestions).
const agentNavAt = new Map<number, number>();
const AGENT_NAV_WINDOW_MS = 12000;
function markAgentNav(tabId: number): void {
  agentNavAt.set(tabId, Date.now());
}
function wasAgentNav(tabId: number): boolean {
  const at = agentNavAt.get(tabId);
  return at != null && Date.now() - at < AGENT_NAV_WINDOW_MS;
}

/**
 * Normalize a navigation target. A bare host/path (`example.com/x`) gets an
 * `https://` prefix, but any string that already carries a real scheme
 * (`http:`, `data:`, `blob:`, `file:`, `about:`, `mailto:`, …) is passed through
 * untouched — previously we prepended `https://` to everything non-http, which
 * corrupted e.g. `data:text/html,…` into `https://data:text/html,…`.
 *
 * The tricky case is telling a scheme (`data:text`) apart from a host:port
 * (`localhost:3000`): schemes are never followed immediately by digits, whereas
 * a port always is — so a colon followed by a digit means it's a host:port and
 * still needs the prefix.
 */
function normalizeNavUrl(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  const looksLikeHostPort = scheme ? /^\d/.test(url.slice(scheme[0].length)) : false;
  if (!scheme || looksLikeHostPort) return 'https://' + url;
  return url;
}

async function navigateOnTab(tabId: number, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = String(args.action ?? (args.url ? 'goto' : 'reload')).toLowerCase();
  const timeoutMs = Number(args.timeoutMs) || 15000;
  try {
    if (action === 'back') await chrome.tabs.goBack(tabId);
    else if (action === 'forward') await chrome.tabs.goForward(tabId);
    else if (action === 'reload') await chrome.tabs.reload(tabId);
    else {
      let url = String(args.url ?? '').trim();
      if (!url) return { success: false, error: 'url is required for goto' };
      url = normalizeNavUrl(url);
      await chrome.tabs.update(tabId, { url });
    }
    await waitForTabComplete(tabId, timeoutMs);
    markAgentNav(tabId);
    const pageContext = await getPageContextRetry(tabId);
    return { success: true, result: { navigated: true, action, url: pageContext?.url }, pageContext };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function screenshotTab(tabId: number): Promise<ToolOutcome> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { success: true, result: { dataUrl, length: dataUrl.length } };
  } catch (err) {
    const msg = errMsg(err);
    // captureVisibleTab needs <all_urls> (or an activated activeTab). If it still
    // fails, screenshots aren't available here — steer the agent to text/DOM tools.
    if (/all_urls|activeTab|permission/i.test(msg)) {
      return {
        success: false,
        error:
          '截图不可用（缺少 <all_urls>/activeTab 权限，可能需要重新加载扩展）。请改用 getHTML / readText / 提取页面文本来获取所需信息，不要重复尝试 screenshot。',
      };
    }
    return { success: false, error: msg };
  }
}

async function cookieTool(tabId: number, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = String(args.url ?? tab.url ?? '');
    if (!url) return { success: false, error: 'no url for cookie operation' };
    const action = String(args.action ?? 'list');
    const name = args.name != null ? String(args.name) : undefined;
    if (action === 'list') {
      const cookies = await chrome.cookies.getAll({ url });
      return {
        success: true,
        result: { cookies: cookies.map((c) => ({ name: c.name, value: c.value })) },
      };
    }
    if (action === 'get') {
      if (!name) return { success: false, error: 'name is required' };
      const c = await chrome.cookies.get({ url, name });
      return { success: true, result: { cookie: c ? { name: c.name, value: c.value } : null } };
    }
    if (action === 'set') {
      if (!name) return { success: false, error: 'name is required' };
      await chrome.cookies.set({ url, name, value: String(args.value ?? '') });
      return { success: true, result: { set: true } };
    }
    if (action === 'remove') {
      if (!name) return { success: false, error: 'name is required' };
      await chrome.cookies.remove({ url, name });
      return { success: true, result: { removed: true } };
    }
    return { success: false, error: `unknown cookie action: ${action}` };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function tabTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = String(args.action ?? 'list');
  try {
    if (action === 'list') {
      const tabs = await chrome.tabs.query({});
      return {
        success: true,
        result: {
          tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
        },
      };
    }
    if (action === 'open') {
      let url = String(args.url ?? '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      // active defaults to true (keep existing behavior); pass active:false to open
      // a background tab WITHOUT stealing focus from the current (main task) page.
      const active = args.active === undefined ? true : Boolean(args.active);
      const t = await chrome.tabs.create({ url: url || undefined, active });
      // For background sub-task tabs, wait for the page to be ready and return its
      // context so the caller can act on it immediately.
      if (t.id != null && url) {
        await waitForTabComplete(t.id, Number(args.timeoutMs) || 15000);
        markAgentNav(t.id);
        const pageContext = await getPageContextRetry(t.id);
        return { success: true, result: { tabId: t.id, url: t.url }, pageContext };
      }
      return { success: true, result: { tabId: t.id, url: t.url } };
    }
    if (action === 'close') {
      const id = Number(args.tabId);
      if (!id) return { success: false, error: 'tabId is required' };
      await chrome.tabs.remove(id);
      return { success: true, result: { closed: id } };
    }
    if (action === 'activate') {
      const id = Number(args.tabId);
      if (!id) return { success: false, error: 'tabId is required' };
      const t = await chrome.tabs.update(id, { active: true });
      if (t?.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      return { success: true, result: { activated: id } };
    }
    return { success: false, error: `unknown tab action: ${action}` };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function downloadTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const url = String(args.url ?? '');
    if (!url) return { success: false, error: 'url is required' };
    const id = await chrome.downloads.download({
      url,
      filename: args.filename ? String(args.filename) : undefined,
    });
    return { success: true, result: { downloadId: id } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function autoDialogOnTab(tabId: number, args: Record<string, unknown>): Promise<ToolOutcome> {
  const accept = args.accept !== false;
  const promptText = args.promptText != null ? String(args.promptText) : '';
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (acc: boolean, pt: string) => {
        window.alert = () => undefined;
        window.confirm = () => acc;
        window.prompt = () => (acc ? pt : null);
      },
      args: [accept, promptText],
    });
    return { success: true, result: { installed: true, accept } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function consoleLogsOnTab(tabId: number, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = String(args.action ?? 'get');
  try {
    if (action === 'install') {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const w = window as unknown as {
            __aiConsoleHook?: boolean;
            __aiConsoleLogs?: Array<{ level: string; ts: number; text: string }>;
          };
          if (w.__aiConsoleHook) return;
          w.__aiConsoleHook = true;
          w.__aiConsoleLogs = [];
          const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = [
            'log',
            'info',
            'warn',
            'error',
            'debug',
          ];
          for (const level of levels) {
            const c = console as unknown as Record<string, (...a: unknown[]) => void>;
            const orig = c[level];
            c[level] = (...a: unknown[]) => {
              try {
                w.__aiConsoleLogs!.push({ level, ts: Date.now(), text: a.map(String).join(' ') });
                if (w.__aiConsoleLogs!.length > 500) w.__aiConsoleLogs!.shift();
              } catch {
                /* ignore */
              }
              return orig.apply(console, a);
            };
          }
          window.addEventListener('error', (e) => {
            w.__aiConsoleLogs!.push({ level: 'error', ts: Date.now(), text: String(e.message) });
          });
        },
      });
      return { success: true, result: { installed: true } };
    }
    if (action === 'clear') {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          (window as unknown as { __aiConsoleLogs?: unknown[] }).__aiConsoleLogs = [];
        },
      });
      return { success: true, result: { cleared: true } };
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => (window as unknown as { __aiConsoleLogs?: unknown[] }).__aiConsoleLogs ?? [],
    });
    return { success: true, result: { logs: res?.[0]?.result ?? [] } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

// Network capture (global ring buffer keyed by tab)
interface NetEntry {
  url: string;
  method: string;
  statusCode?: number;
  type: string;
  tabId: number;
  ts: number;
}
const networkLog: NetEntry[] = [];
function initNetworkCapture(): void {
  try {
    chrome.webRequest.onCompleted.addListener(
      (d) => {
        networkLog.push({
          url: d.url,
          method: d.method,
          statusCode: d.statusCode,
          type: d.type,
          tabId: d.tabId,
          ts: d.timeStamp,
        });
        if (networkLog.length > 1000) networkLog.splice(0, networkLog.length - 1000);
      },
      { urls: ['<all_urls>'] }
    );
  } catch {
    /* webRequest permission unavailable */
  }
}

async function networkTool(tabId: number, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = String(args.action ?? 'get');
  if (action === 'clear') {
    for (let i = networkLog.length - 1; i >= 0; i--) {
      if (networkLog[i].tabId === tabId) networkLog.splice(i, 1);
    }
    return { success: true, result: { cleared: true } };
  }
  const requests = networkLog.filter((e) => e.tabId === tabId).slice(-100);
  return { success: true, result: { requests } };
}

async function webSearch(query: string, count: number): Promise<ToolOutcome> {
  if (!query) return { success: false, error: 'query is required' };
  try {
    const res = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    const results: Array<{ title: string; url: string }> = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && results.length < count) {
      const raw = m[1];
      const uddg = raw.match(/uddg=([^&]+)/)?.[1];
      const url = uddg ? decodeURIComponent(uddg) : raw;
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title) results.push({ title, url });
    }
    return { success: true, result: { results } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async function imageSearch(query: string, count: number): Promise<ToolOutcome> {
  if (!query) return { success: false, error: 'query is required' };
  try {
    const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    const images: string[] = [];
    const re = /murl&quot;:&quot;(.*?)&quot;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && images.length < count) {
      images.push(m[1].replace(/\\\//g, '/'));
    }
    return { success: true, result: { images } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h.startsWith('169.254.')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

async function httpRequest(args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const url = String(args.url ?? '');
    if (!url) return { success: false, error: 'url is required' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: 'invalid url' };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { success: false, error: 'only http(s) allowed' };
    if (!allowPrivateNetwork && isPrivateHost(parsed.hostname)) {
      return {
        success: false,
        error: 'private/loopback address blocked (enable "allow private network" in settings)',
      };
    }
    const method = String(args.method ?? 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) ?? {};
    const body = args.body != null ? String(args.body) : undefined;
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    const text = await res.text();
    return { success: true, result: { status: res.status, ok: res.ok, body: text.slice(0, 20000) } };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

/**
 * Execute a DOM tool in the content script, then — if the action triggered a
 * navigation — wait for the destination page to load and re-observe it, so the
 * agent's next decision is based on the new page rather than the stale one. Unlike
 * sendToContent it does NOT blindly re-send the action on failure (that would
 * double-click); an unload mid-call is treated as a committed navigation.
 */
async function executeContentTool(
  tabId: number,
  tool: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  await ensureContentReady(tabId);
  let beforeUrl = '';
  try {
    beforeUrl = (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    /* ignore */
  }
  let result: ToolOutcome;
  try {
    result = (await chrome.tabs.sendMessage(
      tabId,
      { type: 'EXECUTE_TOOL', tool, args },
      { frameId: 0 }
    )) as ToolOutcome;
  } catch {
    // Page unloaded before responding: the action almost certainly caused a navigation.
    result = { success: true, result: { navigated: true, note: 'page navigated before response' } };
  }
  try {
    await new Promise((r) => setTimeout(r, 150));
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'loading' || (t.url && t.url !== beforeUrl)) {
      await waitForTabComplete(tabId, 15000);
      markAgentNav(tabId);
      const fresh = await getPageContextRetry(tabId);
      if (fresh) result.pageContext = fresh;
    }
  } catch {
    /* ignore */
  }
  return result;
}

export async function executeToolOnTab(
  tabId: number,
  tool: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  if (tool === 'evaluate' && !allowEvaluate) {
    return { success: false, error: 'evaluate is disabled in settings（安全设置中已禁用 evaluate）。' };
  }
  switch (tool) {
    case 'navigate':
      return navigateOnTab(tabId, args);
    case 'screenshot':
      return screenshotTab(tabId);
    case 'cookie':
      return cookieTool(tabId, args);
    case 'tab':
      return tabTool(args);
    case 'download':
      return downloadTool(args);
    case 'autoDialog':
      return withPageContext(tabId, await autoDialogOnTab(tabId, args));
    case 'consoleLogs':
      return consoleLogsOnTab(tabId, args);
    case 'network':
      return networkTool(tabId, args);
    case 'evaluate':
      return withPageContext(tabId, await runEvaluateOnTab(tabId, String(args.code ?? '')));
    case 'injectCSS':
      return withPageContext(tabId, await insertCssOnTab(tabId, String(args.css ?? '')));
    case 'webSearch':
      return webSearch(String(args.query ?? ''), Number(args.count) || 5);
    case 'imageSearch':
      return imageSearch(String(args.query ?? ''), Number(args.count) || 5);
    case 'httpRequest':
      return httpRequest(args);
    default:
      return executeContentTool(tabId, tool, args);
  }
}

// ---------------------------------------------------------------------------
// Backend WebSocket
// ---------------------------------------------------------------------------
function sendWs(msg: WsMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastStatus(status: { connected: boolean; sessionId?: string | null }): void {
  chrome.runtime.sendMessage({ type: 'BACKEND_STATUS', lastError, ...status }).catch(() => {});
}

function connectBackend(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }
  const wsUrl = authToken ? `${BACKEND_WS}?token=${encodeURIComponent(authToken)}` : BACKEND_WS;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    lastError = errMsg(err);
    broadcastStatus({ connected: false });
    reconnectTimer = setTimeout(connectBackend, 3000);
    return;
  }

  ws.onopen = async () => {
    lastError = null;
    logClient('info', 'ws', 'WebSocket connected');
    const tab = await getActiveTab();
    sendWs({
      id: crypto.randomUUID(),
      type: 'session.register',
      payload: {
        extensionVersion: chrome.runtime.getManifest().version,
        activeTabId: tab?.id,
        activeUrl: tab?.url,
      },
      timestamp: Date.now(),
    });
    broadcastStatus({ connected: true });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data) as WsMessage;

    switch (msg.type) {
      case 'session.registered':
        sessionId = (msg.payload as { sessionId: string }).sessionId;
        broadcastStatus({ connected: true, sessionId });
        break;

      case 'tool.execute': {
        const payload = msg.payload as {
          taskId: string;
          callId: string;
          tool: string;
          args: Record<string, unknown>;
          tabId?: number;
        };
        // Target the task's bound tab so execution survives navigation and works
        // even when the user is focused on a different window/tab.
        let tab: chrome.tabs.Tab | undefined;
        if (payload.tabId != null) {
          tab = await chrome.tabs.get(payload.tabId).catch(() => undefined);
        }
        if (!tab?.id) tab = await getActiveTab();
        if (!tab?.id) {
          sendWs({
            id: crypto.randomUUID(),
            type: 'tool.result',
            payload: {
              taskId: payload.taskId,
              callId: payload.callId,
              success: false,
              error: 'No active tab',
            },
            timestamp: Date.now(),
          });
          break;
        }
        const result = await executeToolOnTab(tab.id, payload.tool, payload.args);
        if (!result.success) {
          logClient(
            'error',
            'tool',
            `${payload.tool} failed: ${result.error}`,
            { args: payload.args },
            payload.taskId
          );
        }
        sendWs({
          id: crypto.randomUUID(),
          type: 'tool.result',
          payload: {
            taskId: payload.taskId,
            callId: payload.callId,
            success: result.success,
            result: result.result,
            error: result.error,
            pageContext: result.pageContext,
          },
          timestamp: Date.now(),
        });
        break;
      }

      case 'page.context': {
        const payload = msg.payload as { taskId?: string; tabId?: number };
        try {
          // Retry across navigation so observation works right after a page load.
          const pageContext =
            payload.tabId != null
              ? (await getPageContextRetry(payload.tabId)) ?? (await getPageContext(payload.tabId))
              : await getPageContext();
          sendWs({
            id: crypto.randomUUID(),
            type: 'page.context.result',
            payload: { taskId: payload.taskId, pageContext },
            timestamp: Date.now(),
          });
        } catch (err) {
          sendWs({
            id: crypto.randomUUID(),
            type: 'error',
            payload: { code: 'PAGE_CONTEXT_ERROR', message: errMsg(err) },
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'task.update': {
        const task = (msg.payload as { task: Task }).task;
        // Reaches popup/options.
        chrome.runtime.sendMessage({ type: 'TASK_UPDATE', task }).catch(() => {});
        // Push directly to the task's bound tab (top frame) so the floating UI keeps
        // updating live even after the page has navigated to a different URL.
        if (task.tabId != null) {
          chrome.tabs
            .sendMessage(task.tabId, { type: 'TASK_UPDATE', task }, { frameId: 0 })
            .catch(() => {});
        }
        break;
      }

      case 'agent.event': {
        const payload = msg.payload as {
          taskId: string;
          tabId?: number;
          kind: 'delta' | 'done';
          text?: string;
        };
        const relayed = {
          type: 'AGENT_EVENT',
          taskId: payload.taskId,
          event: { kind: payload.kind, text: payload.text },
        };
        chrome.runtime.sendMessage(relayed).catch(() => {});
        if (payload.tabId != null) {
          chrome.tabs.sendMessage(payload.tabId, relayed, { frameId: 0 }).catch(() => {});
        }
        break;
      }

      case 'pong':
        break;
    }
  };

  ws.onclose = (event) => {
    if (event.code !== 1000 && !lastError) {
      lastError = `WebSocket closed unexpectedly (code ${event.code})`;
    }
    sessionId = null;
    logClient('warn', 'ws', `WebSocket closed (code=${event.code})`);
    broadcastStatus({ connected: false });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectBackend, 3000);
  };

  ws.onerror = () => {
    lastError = `Failed to reach ${BACKEND_WS} — is the server running? (npm run dev:server)`;
    logClient('error', 'ws', lastError);
    ws?.close();
  };
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BACKEND_HTTP}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Server error routes respond with `{ error }`; tolerate `{ message }` too.
    const err = await res.json().catch(() => null);
    const detail =
      (err as { error?: string; message?: string } | null)?.error ??
      (err as { error?: string; message?: string } | null)?.message ??
      res.statusText;
    throw new Error(detail);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Messages from popup / options / content scripts
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case 'CONNECT_BACKEND':
        connectBackend();
        return { connected: ws?.readyState === WebSocket.OPEN, sessionId, lastError };

      case 'GET_BACKEND_STATUS':
        return { connected: ws?.readyState === WebSocket.OPEN, sessionId, lastError };

      case 'GET_ACTIVE_TASK': {
        // Find a non-terminal task bound to the caller's tab, so a reloaded/navigated
        // page can resume showing the in-progress task.
        const tabId = _sender.tab?.id;
        if (tabId == null) return { task: null };
        try {
          const data = (await apiRequest('/api/tasks')) as { tasks?: Task[] };
          const active = ['pending', 'planning', 'running', 'paused', 'waiting_confirmation'];
          const live = (data.tasks ?? [])
            .filter((t) => t.tabId === tabId && active.includes(t.status))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          return { task: live ?? null, agentDriven: wasAgentNav(tabId) };
        } catch {
          return { task: null, agentDriven: false };
        }
      }

      case 'GET_PAGE_CONTEXT': {
        const tab = await getActiveTab();
        if (!tab?.id) throw new Error('No active tab');
        return { pageContext: await getPageContext(tab.id) };
      }

      case 'CREATE_TASK': {
        const tab = await getActiveTab();
        const pageContext = tab?.id ? await getPageContext(tab.id) : undefined;
        return apiRequest('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            userRequest: message.userRequest,
            sessionId: message.sessionId,
            requestMode: message.requestMode,
            tabId: tab?.id,
            url: tab?.url,
            pageContext,
            attachments: message.attachments,
            kind: message.kind ?? 'once',
            loopIntervalMs: message.loopIntervalMs,
            loopMaxIterations: message.loopMaxIterations,
          }),
        });
      }

      case 'START_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/start`, { method: 'POST' });
      case 'PAUSE_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/pause`, { method: 'POST' });
      case 'RESUME_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/resume`, { method: 'POST' });
      case 'CANCEL_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/cancel`, { method: 'POST' });
      case 'CONFIRM_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/confirm`, {
          method: 'POST',
          body: JSON.stringify({ confirmed: message.confirmed }),
        });
      case 'STEER_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/steer`, {
          method: 'POST',
          body: JSON.stringify({ text: message.text }),
        });
      case 'CONTINUE_TASK':
        return apiRequest(`/api/tasks/${message.taskId}/continue`, { method: 'POST' });
      case 'SUGGEST_ACTIONS':
        return apiRequest('/api/suggest', {
          method: 'POST',
          body: JSON.stringify({ pageContext: message.pageContext, exclude: message.exclude }),
        });
      case 'GET_TASK':
        return apiRequest(`/api/tasks/${message.taskId}`);
      case 'LIST_TASKS':
        return apiRequest('/api/tasks');

      case 'LIST_SESSIONS':
        return apiRequest('/api/sessions');
      case 'CREATE_SESSION':
        return apiRequest('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ title: message.title }),
        });
      case 'GET_SESSION':
        return apiRequest(`/api/sessions/${message.sessionId}`);
      case 'RENAME_SESSION':
        return apiRequest(`/api/sessions/${message.sessionId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: message.title }),
        });
      case 'DELETE_SESSION':
        return apiRequest(`/api/sessions/${message.sessionId}`, { method: 'DELETE' });

      case 'LIST_WORKFLOWS':
        return apiRequest('/api/workflows');
      case 'RUN_WORKFLOW': {
        const tab = await getActiveTab();
        return apiRequest(`/api/workflows/${message.workflowId}/run`, {
          method: 'POST',
          body: JSON.stringify({ params: message.params ?? {}, tabId: tab?.id, url: tab?.url, loopIntervalMs: message.loopIntervalMs }),
        });
      }
      case 'GET_WORKFLOW':
        return apiRequest(`/api/workflows/${message.workflowId}`);
      case 'UPDATE_WORKFLOW':
        return apiRequest(`/api/workflows/${message.workflowId}`, {
          method: 'PATCH',
          body: JSON.stringify(message.updates ?? {}),
        });
      case 'DELETE_WORKFLOW':
        return apiRequest(`/api/workflows/${message.workflowId}`, { method: 'DELETE' });
      case 'SAVE_AS_WORKFLOW':
        return apiRequest(`/api/tasks/${message.taskId}/save-as-workflow`, {
          method: 'POST',
          body: JSON.stringify({
            name: message.name,
            description: message.description,
            triggers: message.triggers,
          }),
        });

      case 'START_RECORDING': {
        await ensureRecordingLoaded();
        const tab = _sender.tab ?? (await getActiveTab());
        const tabId = tab?.id;
        if (tabId == null) return { ok: false, error: 'no active tab' };
        recording = { tabId, tabIds: [tabId], startUrl: tab?.url ?? '', actions: [], narration: [] };
        await persistRecording();
        chrome.tabs
          .sendMessage(tabId, { type: 'RECORD_CONTROL', args: { action: 'start' } }, { frameId: 0 })
          .catch(() => {});
        return { ok: true, recording: true };
      }

      case 'RECORD_ACTION': {
        await ensureRecordingLoaded();
        // Accept actions from any tab in the recording session.
        if (recording && message.action && isSessionTab(_sender.tab?.id)) {
          recording.actions.push(message.action as RecordedAction);
          void persistRecording();
        }
        return { ok: true };
      }

      case 'NARRATION': {
        await ensureRecordingLoaded();
        // Spoken narration/guidance from any session tab is timestamped and stored
        // for the "understand" pass to align onto the nearest recorded step.
        if (recording && message.item && isSessionTab(_sender.tab?.id)) {
          recording.narration.push(message.item as RecordingNarration);
          void persistRecording();
        }
        return { ok: true };
      }

      case 'STOP_RECORDING': {
        await ensureRecordingLoaded();
        const data = recording;
        // Turn off the recorder in every session tab, not just the origin.
        const stopTabs = data?.tabIds ?? (_sender.tab?.id != null ? [_sender.tab.id] : []);
        for (const tabId of stopTabs) {
          chrome.tabs
            .sendMessage(tabId, { type: 'RECORD_CONTROL', args: { action: 'stop' } }, { frameId: 0 })
            .catch(() => {});
        }
        recording = null;
        await persistRecording();
        return {
          ok: true,
          actions: data?.actions ?? [],
          narration: data?.narration ?? [],
          startUrl: data?.startUrl ?? '',
          count: data?.actions.length ?? 0,
        };
      }

      case 'GET_RECORD_STATE':
        await ensureRecordingLoaded();
        return {
          recording: Boolean(recording),
          count: recording?.actions.length ?? 0,
          startUrl: recording?.startUrl,
        };

      case 'UNDERSTAND_RECORDING': {
        const tab = await getActiveTab();
        const pageContext = tab?.id ? await getPageContext(tab.id) : undefined;
        return apiRequest('/api/recordings/understand', {
          method: 'POST',
          body: JSON.stringify({
            actions: message.actions,
            narration: message.narration,
            startUrl: message.startUrl,
            pageContext,
          }),
        });
      }

      case 'REFINE_VOICE':
        return apiRequest('/api/voice/refine', {
          method: 'POST',
          body: JSON.stringify({ transcript: message.transcript }),
        });

      case 'EDIT_RECORDING': {
        const tab = await getActiveTab();
        const pageContext = tab?.id ? await getPageContext(tab.id) : undefined;
        return apiRequest('/api/recordings/edit', {
          method: 'POST',
          body: JSON.stringify({
            name: message.name,
            steps: message.steps,
            params: message.params,
            instruction: message.instruction,
            targetStepId: message.targetStepId,
            pageContext,
          }),
        });
      }

      case 'SAVE_RECORDING':
        return apiRequest('/api/recordings/save', {
          method: 'POST',
          body: JSON.stringify({
            name: message.name,
            description: message.description,
            steps: message.steps,
            params: message.params,
            startUrl: message.startUrl,
            triggers: message.triggers,
          }),
        });

      case 'DEMO_RECORDING': {
        const tab = await getActiveTab();
        return apiRequest('/api/recordings/demo', {
          method: 'POST',
          body: JSON.stringify({
            name: message.name,
            steps: message.steps,
            params: message.params,
            startUrl: message.startUrl,
            tabId: tab?.id,
            url: tab?.url,
          }),
        });
      }

      case 'OPEN_OPTIONS': {
        // Content scripts can't call this API; the background page can.
        if (chrome.runtime.openOptionsPage) {
          await chrome.runtime.openOptionsPage();
        } else {
          await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
        }
        return { ok: true };
      }

      case 'GET_SERVER_CONFIG':
        return apiRequest('/api/config');
      case 'SET_SERVER_CONFIG':
        return apiRequest('/api/config', {
          method: 'PUT',
          body: JSON.stringify(message.config ?? {}),
        });

      case 'CLIENT_LOG': {
        const e = message.entry as Partial<ClientLogEntry> | undefined;
        if (e && typeof e.message === 'string') {
          logClient(e.level ?? 'info', e.category ?? 'ui', e.message, e.data, e.taskId);
        }
        return { ok: true };
      }
      case 'FLUSH_CLIENT_LOGS':
        await flushClientLogs();
        return { ok: true };
      case 'GET_DEBUG_BUNDLE':
        await flushClientLogs();
        return apiRequest(`/api/debug/bundle${message.taskId ? `?taskId=${message.taskId}` : ''}`);
      case 'GET_DEBUG_LOGS':
        return apiRequest(`/api/debug/logs?limit=${message.limit ?? 500}`);
      case 'CLEAR_DEBUG_LOGS':
        return apiRequest('/api/debug/logs', { method: 'DELETE' });

      case 'PAGE_LOADED': {
        const url = message.url as string;

        // Capture cross-page navigations authoritatively here (not in the content
        // script): the click that triggers a navigation often unloads the page
        // before its RECORD_ACTION can flush, and the fresh page's content script
        // may miss the transition. PAGE_LOADED fires reliably on every top-frame
        // load, so a recording never loses the page it moved to.
        await ensureRecordingLoaded();
        if (isSessionTab(_sender.tab?.id) && url) {
          pushNavigate(url);
          // Make sure the freshly-loaded session tab has its capture listeners on
          // (belt-and-suspenders alongside the content script's own self-start).
          chrome.tabs
            .sendMessage(
              _sender.tab!.id!,
              { type: 'RECORD_CONTROL', args: { action: 'start' } },
              { frameId: 0 }
            )
            .catch(() => {});
        }

        if (!autorunEnabled) return { ran: 0, reason: 'autorun disabled' };
        if (autorunWhitelist.length && !autorunWhitelist.some((p) => p && url.includes(p))) {
          return { ran: 0, reason: 'not whitelisted' };
        }
        const last = recentAutorun.get(url) ?? 0;
        if (Date.now() - last < AUTORUN_COOLDOWN_MS) return { ran: 0, reason: 'cooldown' };
        try {
          const data = (await apiRequest(
            `/api/workflows/match?url=${encodeURIComponent(url)}`
          )) as { workflows?: Array<{ id: string }> };
          const matches = data.workflows ?? [];
          if (!matches.length) return { ran: 0 };
          recentAutorun.set(url, Date.now());
          const tabId = _sender.tab?.id;
          for (const wf of matches) {
            await apiRequest(`/api/workflows/${wf.id}/run`, {
              method: 'POST',
              body: JSON.stringify({ params: {}, tabId, url }),
            });
          }
          return { ran: matches.length };
        } catch (err) {
          return { ran: 0, error: errMsg(err) };
        }
      }

      default:
        return { error: `Unknown message: ${message.type}` };
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: errMsg(err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initNetworkCapture();
void ensureRecordingLoaded();
void loadSettings().then(connectBackend);

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    sendWs({ id: crypto.randomUUID(), type: 'ping', payload: {}, timestamp: Date.now() });
  }
}, 30000);

console.log('[AI Browser Agent] Service worker started');
