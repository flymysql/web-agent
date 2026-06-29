import type { PageContext, InteractiveElement } from '@ai-browser-agent/shared';

const MAX_VISIBLE_TEXT = 8000;
const MAX_ELEMENTS = 100;

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
    return false;
  }
  return true;
}

/** Looks like a framework-generated unstable id (random hashes), unsafe for replay. */
function isStableId(id: string): boolean {
  if (!id) return false;
  if (id.length > 40) return false;
  // reject ids that are mostly random hex/digits
  if (/^[0-9]/.test(id)) return false;
  if (/[a-f0-9]{8,}/i.test(id) && !/[-_]/.test(id)) return false;
  return true;
}

/** Build a structural CSS path with :nth-of-type, stable across reloads. */
function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    if (node.id && isStableId(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

function inShadow(el: Element): boolean {
  return el.getRootNode() instanceof ShadowRoot;
}

/** Prefer the most stable selector available; fall back to data-ai-agent-id tag. */
function buildSelector(el: Element, index: number): string {
  const tagFallback = `[data-ai-agent-id="el-${index}"]`;
  // Elements inside a shadow root can't be reached by a document-level CSS path,
  // so rely on the tagged attribute (resolveSelector pierces shadow roots).
  if (inShadow(el)) return tagFallback;

  if (el.id && isStableId(el.id)) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const name = el.getAttribute('name');
  if (name && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) {
    return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
  }
  const path = cssPath(el);
  // Verify uniqueness; if the structural path is unique, prefer it (survives reloads).
  try {
    if (path && document.querySelectorAll(path).length === 1) return path;
  } catch {
    /* invalid selector, fall through */
  }
  return tagFallback;
}

function tagElement(el: Element, index: number): string {
  const attr = 'data-ai-agent-id';
  if (!el.hasAttribute(attr)) {
    el.setAttribute(attr, `el-${index}`);
  }
  return buildSelector(el, index);
}

function extractText(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 200);
}

function toInteractiveElement(el: Element, index: number): InteractiveElement {
  const rect = el.getBoundingClientRect();
  return {
    id: `el-${index}`,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') ?? undefined,
    type: el.getAttribute('type') ?? undefined,
    text: extractText(el) || undefined,
    placeholder: el.getAttribute('placeholder') ?? undefined,
    name: el.getAttribute('name') ?? undefined,
    href: el.getAttribute('href') ?? undefined,
    selector: tagElement(el, index),
    visible: isVisible(el),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Collect matching elements across the document and any open shadow roots. */
function collectDeep(selector: string, root: Document | ShadowRoot, out: Element[]): void {
  out.push(...Array.from(root.querySelectorAll(selector)));
  const all = root.querySelectorAll('*');
  for (const host of Array.from(all)) {
    const sr = (host as HTMLElement).shadowRoot;
    if (sr) collectDeep(selector, sr, out);
  }
  // Same-origin iframes: descend into their document (cross-origin throws → skip).
  const frames = root.querySelectorAll('iframe, frame');
  for (const f of Array.from(frames)) {
    try {
      const doc = (f as HTMLIFrameElement).contentDocument;
      if (doc) collectDeep(selector, doc, out);
    } catch {
      /* cross-origin frame, not accessible */
    }
  }
}

/** querySelector that pierces open shadow roots. */
export function querySelectorDeep(
  selector: string,
  root: Document | ShadowRoot = document
): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  const all = root.querySelectorAll('*');
  for (const host of Array.from(all)) {
    const sr = (host as HTMLElement).shadowRoot;
    if (sr) {
      const found = querySelectorDeep(selector, sr);
      if (found) return found;
    }
  }
  const frames = root.querySelectorAll('iframe, frame');
  for (const f of Array.from(frames)) {
    try {
      const doc = (f as HTMLIFrameElement).contentDocument;
      if (doc) {
        const found = querySelectorDeep(selector, doc);
        if (found) return found;
      }
    } catch {
      /* cross-origin frame */
    }
  }
  return null;
}

export function extractPageContext(): PageContext {
  const collected: Element[] = [];
  collectDeep(INTERACTIVE_SELECTORS, document, collected);
  const interactiveNodes = collected.filter(isVisible).slice(0, MAX_ELEMENTS);

  const interactiveElements = interactiveNodes.map((el, i) => toInteractiveElement(el, i));

  const formFields = interactiveElements.filter(
    (el) => ['input', 'select', 'textarea'].includes(el.tag) || el.role === 'textbox'
  );

  const links = interactiveElements
    .filter((el) => el.tag === 'a' && el.href)
    .slice(0, 50)
    .map((el) => ({
      text: el.text ?? '',
      href: el.href ?? '',
      selector: el.selector,
    }));

  const bodyText = document.body?.innerText ?? '';
  const visibleText = bodyText.replace(/\s+/g, ' ').trim().slice(0, MAX_VISIBLE_TEXT);

  return {
    url: location.href,
    title: document.title,
    visibleText,
    interactiveElements,
    formFields,
    links,
    timestamp: Date.now(),
  };
}

export function getVisibleText(selector?: string): string {
  if (!selector) {
    return (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  }
  const el = querySelectorDeep(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function resolveSelector(selector: string): Element {
  if (selector.startsWith('el-')) {
    const tagged = querySelectorDeep(`[data-ai-agent-id="${selector}"]`);
    if (tagged) return tagged;
    throw new Error(`Element not found: ${selector}`);
  }
  const el = querySelectorDeep(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}
