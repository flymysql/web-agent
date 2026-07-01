import { extractPageContext, getVisibleText, resolveSelector, querySelectorDeep } from './page-context.js';

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isElementVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

function isClickable(el: Element): boolean {
  if (!isElementVisible(el)) return false;
  const disabled = (el as HTMLButtonElement).disabled;
  const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
  return !disabled && !ariaDisabled;
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

function dispatchKey(target: Element | Document, combo: string): void {
  const parts = combo.split('+').map((p) => p.trim());
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const init: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
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
  scroller.scrollTop = 0;
  await sleep(120);
  let guard = 0;
  for (;;) {
    pushSlice();
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    if (atBottom || guard++ > 250) break;
    scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
    await sleep(120);
  }
  pushSlice();
  scroller.scrollTop = original;
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
  const scroller = findScrollable(base);

  let text: string;
  let scrolled = false;
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 40) {
    text = await accumulateByScrolling(scroller);
    scrolled = true;
  } else {
    text = getVisibleText(selector);
  }

  const result: Record<string, unknown> = { text };
  if (scrolled) result.scrolledContainer = true;
  if (canvasNote) result.note = canvasNote;
  return { success: true, result };
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
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        const beforeGlobal = globalDigest();
        const beforeEl = elementSig(el);
        el.click();
        // Wait for the page to settle, watching for navigation or any DOM change.
        const changed = await waitForClickEffect(beforeGlobal, beforeEl, el, 1200);
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
            error: `点击 "${selector}" 没有产生任何可见效果（页面未跳转、DOM 未变化）。该目标很可能是无效链接或不是真正的可点击元素。请换一个选择器、点击它所在的整行/父元素，或改用其它方式（如 evaluate）触发。`,
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
        if (editable) {
          if (clear) el.textContent = '';
          el.textContent = (el.textContent ?? '') + text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
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
          setter ? setter.call(input, next) : (input.value = next);
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
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
        const el = (await resolveReady(selector, { visible: true })) as HTMLSelectElement;
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
        for (const type of ['mouseover', 'mouseenter', 'mousemove'] as const) {
          el.dispatchEvent(new MouseEvent(type, opts));
        }
        return { success: true, result: { hovered: selector } };
      }

      case 'setChecked': {
        const selector = args.selector as string;
        const checked = (args.checked as boolean) ?? true;
        if (!selector) return { success: false, error: 'selector is required' };
        const el = (await resolveReady(selector, { visible: true })) as HTMLInputElement;
        if (el.checked !== checked) {
          el.checked = checked;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { success: true, result: { selector, checked: el.checked } };
      }

      case 'uploadFile': {
        const selector = args.selector as string;
        const name = args.name as string;
        const content = args.content as string;
        const mime = (args.mime as string) ?? 'text/plain';
        if (!selector || !name || content === undefined) {
          return { success: false, error: 'selector, name and content are required' };
        }
        const el = resolveSelector(selector) as HTMLInputElement;
        if (el.type !== 'file') return { success: false, error: 'target is not a file input' };
        const file = new File([content], name, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, result: { selector, name, size: content.length } };
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
        const dt = new DataTransfer();
        const fire = (el: Element, type: string, x: number, y: number) =>
          el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        fire(s, 'dragstart', sr.x + sr.width / 2, sr.y + sr.height / 2);
        fire(t, 'dragenter', tr.x + tr.width / 2, tr.y + tr.height / 2);
        fire(t, 'dragover', tr.x + tr.width / 2, tr.y + tr.height / 2);
        fire(t, 'drop', tr.x + tr.width / 2, tr.y + tr.height / 2);
        fire(s, 'dragend', tr.x + tr.width / 2, tr.y + tr.height / 2);
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
