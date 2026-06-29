import { DEFAULT_BACKEND_URL, DEFAULT_WS_URL } from '@ai-browser-agent/shared';
import type { PageContext, Task, WsMessage } from '@ai-browser-agent/shared';

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
      func: (src: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
          const fn = new Function(`return (async () => {\n${src}\n})()`);
          return Promise.resolve(fn()).then(
            (v: unknown) => ({ ok: true, value: v }),
            (e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) })
          );
        } catch (e) {
          return { ok: false, error: String((e as Error)?.message ?? e) };
        }
      },
      args: [code],
    });
    const out = results?.[0]?.result as { ok: boolean; value?: unknown; error?: string } | undefined;
    if (!out) return { success: false, error: 'No result returned from page' };
    if (!out.ok) return { success: false, error: out.error ?? 'evaluate failed' };
    let value = out.value;
    try {
      JSON.stringify(value);
    } catch {
      value = String(value);
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
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      await chrome.tabs.update(tabId, { url });
    }
    await waitForTabComplete(tabId, timeoutMs);
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
    return { success: false, error: errMsg(err) };
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
      const t = await chrome.tabs.create({ url: url || undefined });
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
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message ?? res.statusText);
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
          return { task: live ?? null };
        } catch {
          return { task: null };
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
            tabId: tab?.id,
            url: tab?.url,
            pageContext,
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
          body: JSON.stringify({ params: message.params ?? {}, tabId: tab?.id, url: tab?.url }),
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
void loadSettings().then(connectBackend);

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    sendWs({ id: crypto.randomUUID(), type: 'ping', payload: {}, timestamp: Date.now() });
  }
}, 30000);

console.log('[AI Browser Agent] Service worker started');
