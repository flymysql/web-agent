import { extractPageContext, getVisibleText, resolveSelector, querySelectorDeep } from './page-context.js';

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tools that change the page. After one of these runs we let the DOM settle
 * before snapshotting, so the context the agent sees reflects async/lazy updates
 * (a click that swaps a panel, a select that reveals fields, an upload that
 * enables a submit button) instead of the pre-mutation state.
 */
export const MUTATING_TOOLS = new Set([
  'click', 'type', 'selectOption', 'setChecked', 'pressKey', 'drag', 'uploadFile',
  'doubleClick', 'rightClick', 'clear', 'setRange', 'hover',
]);

/**
 * Wait for the DOM to go quiet after an action: resolve once no mutations have
 * fired for `idleMs`, or after `maxMs` regardless. Cheap and site-agnostic — it
 * just observes when the page stops mutating so lazy/async content is captured.
 */
export async function settleDom(maxMs = 1200, idleMs = 220): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        observer.disconnect();
      } catch {
        /* already gone */
      }
      resolve();
    };
    const bump = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleMs);
    };
    // Watch only node add/remove (the signal that new content actually landed).
    // Deliberately NOT attributes/characterData: animated pages (spinners, live
    // timers, search-suggest overlays) churn those every frame, which would keep
    // resetting the idle timer and force us to burn the full timeout every step.
    const observer = new MutationObserver(bump);
    const hardTimer = setTimeout(finish, maxMs);
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      finish();
      return;
    }
    bump();
  });
}

function isElementVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') {
    return false;
  }
  // Near-zero opacity (e.g. 1e-05) is a common trick to keep an inert duplicate
  // node in the tree; treat it as invisible so we never target it. `=== '0'`
  // alone misses "0.00001".
  const op = parseFloat(style.opacity);
  if (!Number.isNaN(op) && op <= 0.01) return false;
  return true;
}

function isClickable(el: Element): boolean {
  if (!isElementVisible(el)) return false;
  const disabled = (el as HTMLButtonElement).disabled;
  const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
  return !disabled && !ariaDisabled;
}

/** ARIA/native roles that behave like a clickable control across sites. */
const CLICKABLE_SELECTOR =
  "a[href],button,summary,[onclick],[tabindex]," +
  "[role='button'],[role='link'],[role='tab'],[role='menuitem']," +
  "[role='menuitemcheckbox'],[role='menuitemradio'],[role='option']," +
  "[role='switch'],[role='checkbox'],[role='radio'],[role='treeitem']";

/**
 * The element itself, or the nearest ancestor that looks like the real clickable
 * control. Text/label matches (and even el-N ids) often land on an inert inner
 * node (a <span> inside a <div role=tab>, an icon inside a card) whose click
 * handler actually sits on a parent — clicking the leaf is a no-op. We look for a
 * native/ARIA/tabindex control first, then fall back to a BOUNDED walk for a
 * cursor:pointer ancestor (getComputedStyle is costly, so at most a few levels).
 * Site-agnostic: keys off roles and cursor style, never specific markup.
 */
function clickableTarget(el: Element): HTMLElement {
  try {
    const byAttr = el.closest?.(CLICKABLE_SELECTOR) as HTMLElement | null;
    if (byAttr) return byAttr;
  } catch {
    /* invalid selector engine edge — ignore */
  }
  let node: Element | null = el;
  for (let i = 0; i < 4 && node; i++) {
    try {
      if (getComputedStyle(node).cursor === 'pointer') return node as HTMLElement;
    } catch {
      /* ignore */
    }
    node = node.parentElement;
  }
  return el as HTMLElement;
}

/**
 * Fire a realistic pointer gesture, not just a bare click. Many SPA controls
 * (tabs, menus, custom buttons) switch on pointerdown/mousedown rather than the
 * click event, so `el.click()` alone silently does nothing. We dispatch the full
 * sequence (pointerdown → mousedown → pointerup → mouseup) and then call the
 * native `el.click()` exactly once for the click event + default action
 * (link navigation / form submit). Site-agnostic.
 */
function fireClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const cx = Math.floor(rect.left + rect.width / 2);
  const cy = Math.floor(rect.top + rect.height / 2);
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const hasPointer = typeof PointerEvent === 'function';
  const pointer = (type: string, buttons: number): void => {
    try {
      el.dispatchEvent(
        new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons })
      );
    } catch {
      /* ignore */
    }
  };
  const mouse = (type: string, buttons: number): void => {
    try {
      el.dispatchEvent(new MouseEvent(type, { ...base, buttons }));
    } catch {
      /* ignore */
    }
  };
  if (hasPointer) pointer('pointerover', 0);
  mouse('mouseover', 0);
  if (hasPointer) pointer('pointerdown', 1);
  mouse('mousedown', 1);
  if (hasPointer) pointer('pointerup', 0);
  mouse('mouseup', 0);
  // Native activation → fires the click handlers AND default action once.
  try {
    el.click();
  } catch {
    mouse('click', 0);
  }
}

/**
 * Whether a control is ALREADY in its selected/active/checked state. Clicking a
 * tab/toggle that's already selected legitimately produces no DOM change, which
 * must NOT be mistaken for a "dead element" no-op — the desired state simply
 * already holds, so the action has effectively succeeded. Site-agnostic: relies
 * on ARIA state and common active-class conventions, not any specific page.
 */
function isAlreadyActiveControl(el: Element): boolean {
  const host = el.closest('[aria-selected],[aria-pressed],[aria-checked],[aria-current],[role="tab"]') ?? el;
  const truthy = (v: string | null): boolean => v != null && v !== 'false';
  if (
    host.getAttribute('aria-selected') === 'true' ||
    host.getAttribute('aria-pressed') === 'true' ||
    host.getAttribute('aria-checked') === 'true' ||
    truthy(host.getAttribute('aria-current'))
  ) {
    return true;
  }
  const cls = typeof (host as HTMLElement).className === 'string' ? (host as HTMLElement).className.toLowerCase() : '';
  if (/(^|[\s_-])(active|selected|current)([\s_-]|$)/.test(cls)) return true;
  const input = el as HTMLInputElement;
  if ((input.type === 'radio' || input.type === 'checkbox') && input.checked) return true;
  return false;
}

/**
 * Cheap page-wide fingerprint: URL + element count + visible-text length.
 * Any real effect of a click (navigation, content swap, dropdown injecting
 * nodes, etc.) shifts at least one of these.
 */
function globalDigest(): string {
  return [
    location.href,
    document.getElementsByTagName('*').length,
    (document.body?.innerText ?? '').length,
  ].join('|');
}

/**
 * Signature of the clicked element itself, to catch in-place toggles
 * (checkbox/radio, aria-expanded/pressed/selected, value, class) that may not
 * move the page-wide digest.
 */
function elementSig(el: Element | null): string {
  if (!el || !el.isConnected) return 'gone';
  const input = el as HTMLInputElement;
  return [
    el.className,
    el.getAttribute('aria-expanded') ?? '',
    el.getAttribute('aria-pressed') ?? '',
    el.getAttribute('aria-selected') ?? '',
    typeof input.checked === 'boolean' ? String(input.checked) : '',
    input.value ?? '',
  ].join('|');
}

/** Poll briefly after a click for any observable effect on the page or target. */
async function waitForClickEffect(
  beforeGlobal: string,
  beforeEl: string,
  el: Element,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(150);
    try {
      if (globalDigest() !== beforeGlobal) return true;
      if (elementSig(el) !== beforeEl) return true;
    } catch {
      // Document is being torn down → a navigation is in progress → counts as a change.
      return true;
    }
  }
  return false;
}

/** Tolerant lookup: accepts el-N ids and pierces shadow roots. */
function findEl(selector: string): Element | null {
  try {
    return resolveSelector(selector);
  } catch {
    return null;
  }
}

/**
 * Resolve a selector, briefly waiting for the target to appear and (optionally)
 * become visible/clickable before acting. Late- or lazy-loaded content is the
 * usual reason a valid selector isn't present the instant we act — polling makes
 * every interaction robust against it, for both the live agent and deterministic
 * workflow replays (where the page may not have finished loading yet). If the
 * element resolves but never satisfies visibility within the budget, the resolved
 * node is returned so the caller can still scroll it into view; if it never
 * resolves, the standard not-found error surfaces.
 */
async function resolveReady(
  selector: string,
  opts: { visible?: boolean; clickable?: boolean; timeoutMs?: number } = {}
): Promise<Element> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const start = Date.now();
  let last: Element | null = null;
  for (;;) {
    const el = findEl(selector);
    if (el) {
      last = el;
      const okVisible = !opts.visible || isElementVisible(el);
      const okClickable = !opts.clickable || isClickable(el);
      if (okVisible && okClickable) return el;
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleep(150);
  }
  if (last) return last;
  return resolveSelector(selector);
}

async function waitForCondition(args: Record<string, unknown>): Promise<ToolResult> {
  const rawSelector = args.selector as string | undefined;
  const text = args.text as string | undefined;
  const urlIncludes = args.urlIncludes as string | undefined;
  const state = (args.state as string) ?? 'visible';
  const timeoutMs = (args.timeoutMs as number) ?? 10000;
  const start = Date.now();

  if (!rawSelector && !text && !urlIncludes) {
    const ms = Math.min(timeoutMs, 1000);
    await sleep(ms);
    return { success: true, result: { waited: true, ms } };
  }

  while (Date.now() - start < timeoutMs) {
    if (urlIncludes && location.href.includes(urlIncludes)) {
      return { success: true, result: { found: true, url: location.href } };
    }
    if (rawSelector) {
      const el = findEl(rawSelector);
      if (el) {
        const ok =
          state === 'attached'
            ? true
            : state === 'clickable'
              ? isClickable(el)
              : isElementVisible(el);
        if (ok) return { success: true, result: { found: true, selector: rawSelector, state } };
      }
    }
    if (text) {
      const bodyText = document.body?.innerText ?? '';
      if (bodyText.includes(text)) return { success: true, result: { found: true, text } };
    }
    await sleep(150);
  }

  return {
    success: false,
    error: `Timeout (${timeoutMs}ms) waiting for ${rawSelector ?? text ?? urlIncludes ?? 'condition'}`,
  };
}

/**
 * Best-effort KeyboardEvent.code for a key. Handlers that read `event.code`
 * (game controls, shortcut libs) need the physical-key code, not the key value:
 * digits are Digit<n>, letters Key<L>, everything else passes through (Enter,
 * ArrowLeft, Escape, …). Site-agnostic.
 */
function keyCodeFor(key: string): string {
  if (key.length === 1) {
    if (key >= '0' && key <= '9') return `Digit${key}`;
    if (/[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`;
  }
  return key;
}

function dispatchKey(target: Element | Document, combo: string): void {
  const parts = combo.split('+').map((p) => p.trim());
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const init: KeyboardEventInit = {
    key,
    code: keyCodeFor(key),
    bubbles: true,
    cancelable: true,
    ctrlKey: mods.includes('control') || mods.includes('ctrl'),
    metaKey: mods.includes('meta') || mods.includes('cmd'),
    shiftKey: mods.includes('shift'),
    altKey: mods.includes('alt'),
  };
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    target.dispatchEvent(new KeyboardEvent(type, init));
  }
}

/** Is this element a real scroll container with clipped (scrollable) content? */
function isScrollable(el: Element): boolean {
  const s = getComputedStyle(el);
  const oy = s.overflowY;
  return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 40;
}

/** Find the scroll container to sweep: the element, a scrollable descendant, or an ancestor. */
function findScrollable(el: Element): HTMLElement | null {
  if (isScrollable(el)) return el as HTMLElement;
  let best: HTMLElement | null = null;
  const descendants = el.querySelectorAll('*');
  const cap = Math.min(descendants.length, 3000);
  for (let i = 0; i < cap; i++) {
    const d = descendants[i];
    if (isScrollable(d) && (!best || d.scrollHeight > best.scrollHeight)) best = d as HTMLElement;
  }
  if (best) return best;
  let p: Element | null = el.parentElement;
  while (p) {
    if (isScrollable(p)) return p as HTMLElement;
    p = p.parentElement;
  }
  return null;
}

/**
 * Wall-clock cap on any scroll-sweep read. An infinite feed never reaches a
 * bottom and keeps yielding new rows, so without a time budget the sweep would
 * run until the 60s tool-execution timeout and fail the whole task. We stop well
 * under that and return whatever was accumulated (partial but useful).
 */
const SWEEP_BUDGET_MS = 8000;

/**
 * Read all text from a scroll container by sweeping it top→bottom and
 * accumulating unique lines. Virtualized lists (logs, long tables) keep only the
 * visible rows in the DOM, so a single textContent read misses everything
 * off-screen — scrolling forces each slice to render. Site-agnostic.
 */
async function accumulateByScrolling(scroller: HTMLElement): Promise<string> {
  const original = scroller.scrollTop;
  const seen = new Set<string>();
  const lines: string[] = [];
  const pushSlice = (): void => {
    const chunk = (scroller as HTMLElement).innerText ?? scroller.textContent ?? '';
    for (const raw of chunk.split('\n')) {
      const line = raw.replace(/[ \t]+/g, ' ').trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  };
  const step = Math.max(100, scroller.clientHeight - 40);
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  scroller.scrollTop = 0;
  await sleep(120);
  let guard = 0;
  let stale = 0;
  for (;;) {
    const before = lines.length;
    pushSlice();
    if (Date.now() > deadline) break;
    // Static content is fully in the DOM already, so the first read captures it
    // all and further scrolling yields nothing new — stop early instead of
    // uselessly scrolling to the bottom. Lazy/virtualized lists keep yielding
    // new rows, so we keep sweeping while it stays productive.
    const gained = lines.length - before;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    if (atBottom || guard++ > 250) break;
    if (gained < 2) {
      if (++stale >= 2) break;
    } else {
      stale = 0;
    }
    scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
    await sleep(120);
  }
  pushSlice();
  scroller.scrollTop = original;
  return lines.join('\n').slice(0, 20000);
}

/**
 * Sweep the WHOLE PAGE (window-level scroll) top→bottom, accumulating unique
 * lines. Many feeds scroll the window (not an overflow:auto descendant) and only
 * render items as they enter the viewport (IntersectionObserver / virtualization),
 * so a single body.innerText read is dominated by the always-mounted chrome
 * (nav/footer) and misses the list. Scrolling forces each slice to render.
 * Restores the original scroll position. Site-agnostic.
 */
async function accumulateByScrollingWindow(): Promise<string> {
  const originalY = window.scrollY;
  const seen = new Set<string>();
  const lines: string[] = [];
  const pushSlice = (): void => {
    const chunk = document.body?.innerText ?? '';
    for (const raw of chunk.split('\n')) {
      const line = raw.replace(/[ \t]+/g, ' ').trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  };
  const viewport = window.innerHeight || 800;
  const step = Math.max(200, viewport - 60);
  const maxY = (): number =>
    Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0) - viewport;
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  window.scrollTo({ top: 0 });
  await sleep(150);
  let guard = 0;
  let stale = 0;
  for (;;) {
    const before = lines.length;
    pushSlice();
    if (Date.now() > deadline) break;
    // See accumulateByScrolling: bail out once scrolling stops revealing new text
    // (static page already fully captured), keep going while it's productive.
    const gained = lines.length - before;
    if (window.scrollY >= maxY() - 4 || guard++ > 250) break;
    if (gained < 2) {
      if (++stale >= 2) break;
    } else {
      stale = 0;
    }
    window.scrollTo({ top: Math.min(window.scrollY + step, maxY()) });
    await sleep(150);
  }
  pushSlice();
  window.scrollTo({ top: originalY });
  return lines.join('\n').slice(0, 20000);
}

/** Flag a region that renders on a <canvas> (terminal/chart) — no DOM text to read. */
function detectCanvasArea(el: Element): string | undefined {
  const canvases = el.querySelectorAll('canvas');
  if (!canvases.length) return undefined;
  const txtLen = (el.textContent ?? '').replace(/\s+/g, '').length;
  let bigCanvas = false;
  for (const c of Array.from(canvases)) {
    const r = (c as HTMLElement).getBoundingClientRect();
    if (r.width * r.height > 40000) {
      bigCanvas = true;
      break;
    }
  }
  return bigCanvas && txtLen < 200
    ? '该区域主要由 <canvas> 渲染（可能是终端/图表/绘制型内容），无法通过 DOM 提取文本。'
    : undefined;
}

async function readTextRich(selector?: string): Promise<ToolResult> {
  let base: Element | null;
  if (selector) {
    base = findEl(selector);
    if (!base) return { success: false, error: `Element not found: ${selector}` };
  } else {
    base = document.body ?? document.documentElement;
  }

  const canvasNote = detectCanvasArea(base);

  let text: string;
  let scrolled = false;

  const inner = findScrollable(base);
  const innerScrollable = !!inner && inner.scrollHeight > inner.clientHeight + 40;
  const docEl = (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  const docScrollable = !docEl ? false : docEl.scrollHeight > docEl.clientHeight + 40;
  // Sweep an inner scroller only when it clearly holds more than the page itself
  // (a real scroll region), or when the caller targeted a specific selector.
  // Otherwise sweep the WINDOW so lazy/virtualized feed items get rendered —
  // this is what a single body.innerText snapshot misses.
  const useInner =
    innerScrollable &&
    (selector
      ? true
      : inner !== document.body && inner !== document.documentElement && inner!.scrollHeight > docEl.scrollHeight);

  if (useInner) {
    text = await accumulateByScrolling(inner!);
    scrolled = true;
  } else if (!selector && docScrollable) {
    text = await accumulateByScrollingWindow();
    scrolled = true;
  } else {
    text = getVisibleText(selector);
  }

  const result: Record<string, unknown> = { text };
  if (scrolled) result.scrolledContainer = true;
  if (canvasNote) result.note = canvasNote;
  return { success: true, result };
}

/** Common file extension → MIME, so a generated file gets a sensible type. */
function mimeFromName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
    html: 'text/html', md: 'text/markdown', js: 'text/javascript', css: 'text/css',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  };
  return map[ext] ?? 'text/plain';
}

/** Build a File from either a data: URL (binary, e.g. an image) or plain text. */
function fileFromContent(name: string, content: string, mime?: string): File {
  const m = content.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (m) {
    const type = mime || m[1] || mimeFromName(name);
    const isB64 = !!m[2];
    const data = m[3];
    if (isB64) {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], name, { type });
    }
    return new File([decodeURIComponent(data)], name, { type });
  }
  return new File([content], name, { type: mime || mimeFromName(name) });
}

/**
 * Whether this exact element IS or DIRECTLY fronts a file input (the element
 * itself, a tied/ wrapping label, or a file input nested inside it). Stricter
 * than resolveFileInput (no ancestor walk) so the click guardrail won't
 * misfire on an unrelated button that merely shares a form with an upload.
 */
function frontsFileInput(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === 'file') return el;
  if (el instanceof HTMLLabelElement) {
    const forId = el.getAttribute('for');
    if (forId) {
      const ctrl = document.getElementById(forId);
      if (ctrl instanceof HTMLInputElement && ctrl.type === 'file') return ctrl;
    }
  }
  const nested = el.querySelector?.('input[type="file"]');
  return nested instanceof HTMLInputElement ? nested : null;
}

/**
 * Resolve the real <input type=file> to set, given a selector that may point at
 * the input itself OR at the styled button/label/area that fronts it (the common
 * pattern that hides the real input). Site-agnostic DOM traversal.
 */
function resolveFileInput(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === 'file') return el;
  // A <label for=…> (or wrapping label) tied to a file input.
  if (el instanceof HTMLLabelElement) {
    const forId = el.getAttribute('for');
    if (forId) {
      const ctrl = document.getElementById(forId);
      if (ctrl instanceof HTMLInputElement && ctrl.type === 'file') return ctrl;
    }
    const inner = el.querySelector('input[type="file"]');
    if (inner instanceof HTMLInputElement) return inner;
  }
  // A file input nested inside the clicked button/area.
  const nested = el.querySelector?.('input[type="file"]');
  if (nested instanceof HTMLInputElement) return nested;
  // Walk a few ancestors (upload widgets wrap the input near the trigger).
  let node: Element | null = el;
  for (let i = 0; node && i < 4; i++) {
    const found = node.querySelector?.('input[type="file"]');
    if (found instanceof HTMLInputElement) return found;
    node = node.parentElement;
  }
  return null;
}

export async function executeBrowserTool(
  tool: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'extractPage':
        return { success: true, result: extractPageContext() };

      case 'click': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { clickable: true })) as HTMLElement;
        // Guardrail: clicking a file input (or a button/label that fronts one)
        // opens the OS file dialog, which no page/extension code can drive — the
        // task would stall waiting for the user. Redirect to uploadFile instead.
        if (frontsFileInput(el)) {
          return {
            success: false,
            error:
              '这是文件上传控件，点击会弹出无法操控的系统文件选择框。请改用 uploadFile 工具（直接把文件写入输入框，不弹窗）：' +
              `uploadFile({"selector":"${selector}","name":"<文件名>","content":"<你生成的内容或 data: URL>"}）。`,
            result: { redirectToUploadFile: true, selector },
          };
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        const beforeGlobal = globalDigest();
        const beforeEl = elementSig(el);
        fireClick(el);
        // Wait for the page to settle, watching for navigation or any DOM change.
        let changed = await waitForClickEffect(beforeGlobal, beforeEl, el, 1200);
        if (!changed) {
          // The matched node is often an inert inner element (text/icon) whose real
          // handler lives on a parent (very common in React/Vue). Retry ONCE on the
          // nearest clickable ancestor before giving up.
          const target = clickableTarget(el);
          if (target !== el) {
            const bg2 = globalDigest();
            const be2 = elementSig(target);
            fireClick(target);
            changed = await waitForClickEffect(bg2, be2, target, 1200);
          }
        }
        if (!changed) {
          // A no-change click on a control that's already selected/active is NOT a
          // dead element — the desired state already holds. Report success so the
          // agent moves on (e.g. reads the panel) instead of thrashing selectors.
          if (isAlreadyActiveControl(el)) {
            return {
              success: true,
              result: { clicked: selector, alreadyActive: true, note: '该元素已处于选中/激活状态，无需再次点击' },
            };
          }
          // The click resolved but produced no observable effect — almost always a
          // dead/JS-routed link or the wrong element. Report a soft failure so the
          // agent stops re-clicking the same target and tries another approach.
          return {
            success: false,
            error:
              `点击 "${selector}" 没有产生任何可见效果（页面未跳转、DOM 未变化）。` +
              `可能它不是真正的可点击元素，或该站点忽略脚本触发的点击。请不要反复点同一个目标：` +
              `① 换一个更精确的元素（点击整行/父级，或页面上下文里的 el-N）；` +
              `② 如果这是标签页/导航/筛选项，且其目标反映在 URL 上（<a href>，或可从当前 URL 推断的查询参数/路径），` +
              `改用 navigate 直接跳转到该 URL——这比反复点击或用脚本点击更可靠。`,
            result: { clicked: selector, noOp: true },
          };
        }
        return { success: true, result: { clicked: selector } };
      }

      case 'type': {
        const selector = args.selector as string;
        const text = args.text as string;
        const clear = (args.clear as boolean) ?? true;
        if (!selector || text === undefined) {
          return { success: false, error: 'selector and text are required' };
        }
        const el = (await resolveReady(selector, { visible: true })) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        const editable =
          el.isContentEditable || el.getAttribute('contenteditable') === 'true';
        const lastChar = text.slice(-1) || 'a';
        const keyInit: KeyboardEventInit = {
          bubbles: true,
          cancelable: true,
          key: lastChar,
          code: keyCodeFor(lastChar),
        };
        if (editable) {
          if (clear) {
            // Prefer a native "select-all + delete" so rich editors update their
            // own model; fall back to clearing the DOM directly.
            try {
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(el);
              sel?.removeAllRanges();
              sel?.addRange(range);
              if (!document.execCommand('delete')) el.textContent = '';
            } catch {
              el.textContent = '';
            }
          }
          el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
          // execCommand('insertText') drives the browser's native editing pipeline
          // (fires beforeinput+input, moves the caret), which rich contenteditable
          // editors (Slate/ProseMirror/Draft) honor. Fall back to a synthetic
          // beforeinput + textContent append only if that path is unavailable.
          let inserted = false;
          try {
            inserted = document.execCommand('insertText', false, text);
          } catch {
            inserted = false;
          }
          if (!inserted) {
            const bi = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: text,
            });
            if (el.dispatchEvent(bi)) {
              el.textContent = (el.textContent ?? '') + text;
              el.dispatchEvent(
                new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
              );
            }
          }
          el.dispatchEvent(new KeyboardEvent('keyup', keyInit));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          const setter = Object.getOwnPropertyDescriptor(
            input instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype,
            'value'
          )?.set;
          if (clear) {
            setter ? setter.call(input, '') : (input.value = '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const next = (clear ? '' : input.value) + text;
          // Bracket the value change with real keyboard + beforeinput events so
          // keystroke-driven widgets (autocomplete/combobox filters, search-as-you-
          // type) react, while the native value setter keeps controlled inputs in sync.
          input.dispatchEvent(new KeyboardEvent('keydown', keyInit));
          input.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: text,
            })
          );
          setter ? setter.call(input, next) : (input.value = next);
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          input.dispatchEvent(new KeyboardEvent('keyup', keyInit));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { success: true, result: { typed: text.length, selector } };
      }

      case 'scroll': {
        const direction = (args.direction as string) ?? 'down';
        const amount = (args.amount as number) ?? 400;
        const selector = args.selector as string | undefined;
        const target = selector ? resolveSelector(selector) : window;
        const opts: ScrollToOptions = { behavior: 'smooth' };

        if (target === window) {
          switch (direction) {
            case 'up':
              window.scrollBy({ top: -amount, behavior: 'smooth' });
              break;
            case 'top':
              window.scrollTo({ top: 0, ...opts });
              break;
            case 'bottom':
              window.scrollTo({ top: document.body.scrollHeight, ...opts });
              break;
            default:
              window.scrollBy({ top: amount, behavior: 'smooth' });
          }
        } else {
          (target as Element).scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'smooth' });
        }
        return { success: true, result: { direction, amount } };
      }

      case 'wait':
        return waitForCondition(args);

      case 'readText':
        return readTextRich(args.selector as string | undefined);

      case 'getAttribute': {
        const selector = args.selector as string;
        const attribute = args.attribute as string;
        if (!selector || !attribute) {
          return { success: false, error: 'selector and attribute are required' };
        }
        const el = resolveSelector(selector);
        const value = el.getAttribute(attribute);
        return { success: true, result: { attribute, value } };
      }

      case 'selectOption': {
        const selector = args.selector as string;
        const value = args.value as string;
        if (!selector || !value) {
          return { success: false, error: 'selector and value are required' };
        }
        const resolved = (await resolveReady(selector, { visible: true })) as HTMLElement;
        // Custom (non-native) dropdowns are just a button/listbox of clickable
        // options — there is no <select> to set. Guide the agent to the generic
        // click-to-open + click-option flow instead of a dead-end error.
        if (!(resolved instanceof HTMLSelectElement)) {
          return {
            success: false,
            error:
              `"${selector}" 不是原生 <select>，无法直接设值。这是自定义下拉框：请先 click 它展开，` +
              `再 click 目标选项（用 text=${value} 或页面里的 [role=option]/el-N 选择器）。`,
            result: { notNativeSelect: true, selector },
          };
        }
        const el = resolved;
        const option = Array.from(el.options).find(
          (o) => o.value === value || o.text === value
        );
        if (!option) return { success: false, error: `Option not found: ${value}` };
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, result: { selected: option.value } };
      }

      case 'setStyle': {
        const selector = args.selector as string;
        const styles = (args.styles as Record<string, unknown>) ?? {};
        const all = (args.all as boolean) ?? false;
        if (!selector) return { success: false, error: 'selector is required' };
        const els = all ? Array.from(document.querySelectorAll(selector)) : [resolveSelector(selector)];
        let count = 0;
        for (const el of els) {
          const style = (el as HTMLElement).style;
          for (const [k, v] of Object.entries(styles)) {
            const prop = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
            style.setProperty(prop, String(v), 'important');
          }
          count++;
        }
        return { success: true, result: { styled: count, selector } };
      }

      case 'setText': {
        const selector = args.selector as string;
        const text = args.text as string;
        if (!selector || text === undefined) return { success: false, error: 'selector and text are required' };
        const el = resolveSelector(selector) as HTMLElement;
        el.textContent = text;
        return { success: true, result: { selector, length: text.length } };
      }

      case 'setHTML': {
        const selector = args.selector as string;
        const html = args.html as string;
        if (!selector || html === undefined) return { success: false, error: 'selector and html are required' };
        const el = resolveSelector(selector) as HTMLElement;
        el.innerHTML = html;
        return { success: true, result: { selector, length: html.length } };
      }

      case 'setAttribute': {
        const selector = args.selector as string;
        const name = args.name as string;
        const value = String(args.value ?? '');
        const all = (args.all as boolean) ?? false;
        if (!selector || !name) return { success: false, error: 'selector and name are required' };
        const els = all ? Array.from(document.querySelectorAll(selector)) : [resolveSelector(selector)];
        els.forEach((el) => el.setAttribute(name, value));
        return { success: true, result: { selector, name, count: els.length } };
      }

      case 'removeElement': {
        const selector = args.selector as string;
        const all = (args.all as boolean) ?? false;
        if (!selector) return { success: false, error: 'selector is required' };
        const els = all ? Array.from(document.querySelectorAll(selector)) : [resolveSelector(selector)];
        els.forEach((el) => el.remove());
        return { success: true, result: { selector, removed: els.length } };
      }

      case 'getHTML': {
        const selector = args.selector as string | undefined;
        const el = (selector ? resolveSelector(selector) : document.body) as HTMLElement;
        const html = el?.outerHTML ?? '';
        return { success: true, result: { html: html.slice(0, 8000), truncated: html.length > 8000 } };
      }

      case 'injectCSS': {
        const css = args.css as string;
        if (!css) return { success: false, error: 'css is required' };
        const id = (args.id as string | undefined)?.trim();
        // Re-injecting with the same id replaces the previous block so themes
        // don't pile up into an un-undoable mess.
        if (id) {
          document
            .querySelectorAll(`style[data-agent-injected][data-agent-css-id="${CSS.escape(id)}"]`)
            .forEach((el) => el.remove());
        }
        const style = document.createElement('style');
        style.setAttribute('data-agent-injected', 'true');
        if (id) style.setAttribute('data-agent-css-id', id);
        style.textContent = css;
        (document.head ?? document.documentElement).appendChild(style);
        return { success: true, result: { injected: css.length, id: id ?? null } };
      }

      case 'clearInjectedCSS': {
        const id = (args.id as string | undefined)?.trim();
        const selector = id
          ? `style[data-agent-injected][data-agent-css-id="${CSS.escape(id)}"]`
          : 'style[data-agent-injected]';
        const nodes = document.querySelectorAll(selector);
        nodes.forEach((el) => el.remove());
        return { success: true, result: { removed: nodes.length, id: id ?? null } };
      }

      case 'expect': {
        const sel = args.selector as string | undefined;
        const text = args.text as string | undefined;
        const urlIncludes = args.urlIncludes as string | undefined;
        const attribute = args.attribute as string | undefined;
        const equals = args.equals as string | undefined;
        const failures: string[] = [];
        if (urlIncludes && !location.href.includes(urlIncludes)) {
          failures.push(`url "${location.href}" lacks "${urlIncludes}"`);
        }
        if (text && !(document.body?.innerText ?? '').includes(text)) {
          failures.push(`page text missing "${text}"`);
        }
        if (sel) {
          const el = findEl(sel);
          if (!el) failures.push(`element not found: ${sel}`);
          else if (attribute) {
            const actual = el.getAttribute(attribute);
            if (equals !== undefined && actual !== equals) {
              failures.push(`${sel}@${attribute}="${actual}" !== "${equals}"`);
            }
          } else if (!isElementVisible(el)) {
            failures.push(`element not visible: ${sel}`);
          }
        }
        if (failures.length) return { success: false, error: `expect failed: ${failures.join('; ')}` };
        return { success: true, result: { ok: true } };
      }

      case 'pressKey': {
        const key = args.key as string;
        if (!key) return { success: false, error: 'key is required' };
        const sel = args.selector as string | undefined;
        const target = sel ? await resolveReady(sel, { visible: true }) : (document.activeElement ?? document.body);
        (target as HTMLElement)?.focus?.();
        dispatchKey(target ?? document, key);
        return { success: true, result: { pressed: key } };
      }

      case 'hover': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = resolveSelector(selector) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
        // Pointer events first for pointer-driven hover menus, then the classic
        // mouse events; many popovers/tooltips listen to one or the other.
        if (typeof PointerEvent === 'function') {
          for (const type of ['pointerover', 'pointerenter', 'pointermove'] as const) {
            el.dispatchEvent(new PointerEvent(type, { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          }
        }
        for (const type of ['mouseover', 'mouseenter', 'mousemove'] as const) {
          el.dispatchEvent(new MouseEvent(type, opts));
        }
        return { success: true, result: { hovered: selector } };
      }

      case 'doubleClick': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { clickable: true })) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
        for (const type of ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick'] as const) {
          el.dispatchEvent(new MouseEvent(type, opts));
        }
        return { success: true, result: { doubleClicked: selector } };
      }

      case 'rightClick': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { visible: true })) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, button: 2, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('contextmenu', opts));
        return { success: true, result: { rightClicked: selector } };
      }

      case 'focus': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { visible: true })) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        el.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        return { success: true, result: { focused: selector } };
      }

      case 'clear': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { visible: true })) as HTMLElement;
        el.focus();
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
          el.textContent = '';
        } else {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          const setter = Object.getOwnPropertyDescriptor(
            input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
          )?.set;
          setter ? setter.call(input, '') : (input.value = '');
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, result: { cleared: selector } };
      }

      case 'setRange': {
        const selector = args.selector as string;
        const value = args.value;
        if (!selector || value === undefined) return { success: false, error: 'selector and value are required' };
        const el = (await resolveReady(selector, { visible: true })) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const v = String(value);
        setter ? setter.call(el, v) : (el.value = v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, result: { selector, value: el.value } };
      }

      case 'scrollIntoView': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, {})) as HTMLElement;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(150);
        return { success: true, result: { scrolledIntoView: selector, visible: isElementVisible(el) } };
      }

      case 'setChecked': {
        const selector = args.selector as string;
        const checked = (args.checked as boolean) ?? true;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { visible: true })) as HTMLInputElement;
        if (el.checked !== checked) {
          // A real click keeps controlled checkboxes/radios (React/Vue) in sync —
          // directly assigning .checked can be reverted on the next render. Fall
          // back to the native checked setter + events if the click didn't take.
          el.focus();
          fireClick(el);
          if (el.checked !== checked) {
            const setter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'checked'
            )?.set;
            setter ? setter.call(el, checked) : (el.checked = checked);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        return { success: true, result: { selector, checked: el.checked } };
      }

      case 'uploadFile': {
        const selector = args.selector as string;
        const name = args.name as string;
        const content = args.content as string;
        const mime = args.mime as string | undefined;
        if (!selector || !name || content === undefined) {
          return { success: false, error: 'selector, name and content are required' };
        }
        // Accept a selector pointing at the styled button/label/area too, and
        // resolve to the real (often hidden) <input type=file> behind it. Setting
        // files programmatically NEVER opens the OS dialog.
        const target = await resolveReady(selector, {});
        let input = resolveFileInput(target);
        if (!input) {
          // Last resort: if the page has exactly one file input, use it.
          const all = Array.from(document.querySelectorAll('input[type="file"]'));
          if (all.length === 1) input = all[0] as HTMLInputElement;
        }
        if (!input) {
          return {
            success: false,
            error:
              '未找到 <input type=file>。请把 selector 指向文件输入框本身或其外层上传按钮/区域；' +
              '不要 click 上传按钮（会弹出无法操控的系统文件框）。',
          };
        }
        const file = fileFromContent(name, content, mime);
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, result: { selector, name, size: file.size, type: file.type } };
      }

      case 'storage': {
        const action = args.action as string;
        const area = (args.area as string) === 'session' ? sessionStorage : localStorage;
        const key = args.key as string | undefined;
        const value = args.value as string | undefined;
        switch (action) {
          case 'get':
            if (!key) return { success: false, error: 'key is required' };
            return { success: true, result: { key, value: area.getItem(key) } };
          case 'set':
            if (!key) return { success: false, error: 'key is required' };
            area.setItem(key, value ?? '');
            return { success: true, result: { key, set: true } };
          case 'remove':
            if (!key) return { success: false, error: 'key is required' };
            area.removeItem(key);
            return { success: true, result: { key, removed: true } };
          case 'getAll': {
            const out: Record<string, string> = {};
            for (let i = 0; i < area.length; i++) {
              const k = area.key(i);
              if (k) out[k] = area.getItem(k) ?? '';
            }
            return { success: true, result: { entries: out } };
          }
          default:
            return { success: false, error: `Unknown storage action: ${action}` };
        }
      }

      case 'drag': {
        const source = args.sourceSelector as string;
        const target = args.targetSelector as string;
        if (!source || !target) return { success: false, error: 'sourceSelector and targetSelector are required' };
        const s = resolveSelector(source) as HTMLElement;
        const t = resolveSelector(target) as HTMLElement;
        s.scrollIntoView({ block: 'center', behavior: 'instant' });
        const sr = s.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        const sx = sr.x + sr.width / 2;
        const sy = sr.y + sr.height / 2;
        const tx = tr.x + tr.width / 2;
        const ty = tr.y + tr.height / 2;
        const beforeDrag = globalDigest();

        // Path 1: native HTML5 drag-and-drop (elements with draggable=true).
        const dt = new DataTransfer();
        const fireDrag = (el: Element, type: string, x: number, y: number): void => {
          el.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y })
          );
        };
        fireDrag(s, 'dragstart', sx, sy);
        fireDrag(t, 'dragenter', tx, ty);
        fireDrag(t, 'dragover', tx, ty);
        fireDrag(t, 'drop', tx, ty);
        fireDrag(s, 'dragend', tx, ty);

        // Path 2: pointer/mouse fallback. Most modern DnD libraries (react-dnd,
        // dnd-kit, SortableJS) are pointer-based and ignore HTML5 DragEvents, so if
        // nothing changed, replay the gesture as a pointer drag with interpolated
        // moves. Site-agnostic — just standard pointer/mouse events.
        await sleep(150);
        if (globalDigest() === beforeDrag) {
          const hasPointer = typeof PointerEvent === 'function';
          const at = (
            el: Element,
            type: string,
            x: number,
            y: number,
            buttons: number,
            usePointer: boolean
          ): void => {
            const init: MouseEventInit = {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: Math.round(x),
              clientY: Math.round(y),
              button: 0,
              buttons,
            };
            try {
              el.dispatchEvent(
                usePointer && hasPointer
                  ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
                  : new MouseEvent(type, init)
              );
            } catch {
              /* ignore */
            }
          };
          at(s, 'pointerdown', sx, sy, 1, true);
          at(s, 'mousedown', sx, sy, 1, false);
          const steps = 6;
          for (let i = 1; i <= steps; i++) {
            const x = sx + ((tx - sx) * i) / steps;
            const y = sy + ((ty - sy) * i) / steps;
            const overEl = document.elementFromPoint(Math.round(x), Math.round(y)) ?? t;
            at(overEl, 'pointermove', x, y, 1, true);
            at(overEl, 'mousemove', x, y, 1, false);
            await sleep(20);
          }
          at(t, 'pointerup', tx, ty, 0, true);
          at(t, 'mouseup', tx, ty, 0, false);
        }
        return { success: true, result: { dragged: true, from: source, to: target } };
      }

      case 'inspect': {
        const selector = args.selector as string;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = resolveSelector(selector) as HTMLElement;
        const cs = window.getComputedStyle(el);
        const styleKeys = ['display', 'color', 'background-color', 'font-size', 'position', 'visibility', 'z-index'];
        const styles: Record<string, string> = {};
        for (const k of styleKeys) styles[k] = cs.getPropertyValue(k);
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
        const r = el.getBoundingClientRect();
        return {
          success: true,
          result: {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            attributes: attrs,
            styles,
            rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            html: el.outerHTML.slice(0, 1200),
          },
        };
      }

      default:
        return { success: false, error: `Unknown browser tool: ${tool}` };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
