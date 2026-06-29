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

/** Tolerant lookup: accepts el-N ids and pierces shadow roots. */
function findEl(selector: string): Element | null {
  try {
    return resolveSelector(selector);
  } catch {
    return null;
  }
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
        const el = resolveSelector(selector) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        el.click();
        await sleep(300);
        return { success: true, result: { clicked: selector } };
      }

      case 'type': {
        const selector = args.selector as string;
        const text = args.text as string;
        const clear = (args.clear as boolean) ?? true;
        if (!selector || text === undefined) {
          return { success: false, error: 'selector and text are required' };
        }
        const el = resolveSelector(selector) as HTMLElement;
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

      case 'readText': {
        const selector = args.selector as string | undefined;
        const text = getVisibleText(selector);
        return { success: true, result: { text } };
      }

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
        const el = resolveSelector(selector) as HTMLSelectElement;
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
        const style = document.createElement('style');
        style.setAttribute('data-agent-injected', 'true');
        style.textContent = css;
        (document.head ?? document.documentElement).appendChild(style);
        return { success: true, result: { injected: css.length } };
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
        const target = sel ? resolveSelector(sel) : (document.activeElement ?? document.body);
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
        const el = resolveSelector(selector) as HTMLInputElement;
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
