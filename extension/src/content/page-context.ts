import type { PageContext, InteractiveElement } from '@ai-browser-agent/shared';

const MAX_VISIBLE_TEXT = 8000;
const MAX_ELEMENTS = 100;
// The agent's own floating UI lives in an open shadow root on this host. We must
// never collect or target it as "page content" — otherwise the agent sees its
// own buttons/input and starts operating on itself.
const AGENT_ROOT_ID = 'ai-browser-agent-root';

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
    if ((host as HTMLElement).id === AGENT_ROOT_ID) continue; // skip our own widget
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
  let direct: Element | null = null;
  try {
    direct = root.querySelector(selector);
  } catch {
    // Invalid CSS (e.g. Playwright/jQuery pseudo-selectors). Bail to the
    // caller's text-based fallback instead of throwing a raw SyntaxError.
    return null;
  }
  if (direct) return direct;
  const all = root.querySelectorAll('*');
  for (const host of Array.from(all)) {
    if ((host as HTMLElement).id === AGENT_ROOT_ID) continue; // skip our own widget
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

/**
 * Parses Playwright/jQuery-style text selectors that the model frequently
 * emits but native querySelector rejects:
 *   text=Run workflow
 *   button:has-text('Run workflow')
 *   a:contains("build")
 * Returns the leading CSS portion (or '*') plus the target text.
 */
function parseTextSelector(selector: string): { leading: string; text: string } | null {
  const t1 = selector.match(/^\s*text=\s*["']?(.+?)["']?\s*$/i);
  if (t1) return { leading: '*', text: t1[1].trim() };
  const m = selector.match(
    /([a-zA-Z][\w-]*)?\s*:(?:has-text|contains|-soup-contains)\(\s*["'](.+?)["']\s*\)/i
  );
  if (m) return { leading: (m[1] ?? '').trim() || '*', text: m[2].trim() };
  return null;
}

const ACTIONABLE_SELECTOR = "a[href],button,[role='button'],summary,[onclick],input,select,textarea,[tabindex]";

function isActionable(el: Element): boolean {
  try {
    return el.matches(ACTIONABLE_SELECTOR);
  } catch {
    return false;
  }
}

/** The element itself if clickable, else its nearest clickable ancestor. */
function actionableAncestor(el: Element): Element | null {
  try {
    return el.closest("a[href],button,[role='button'],summary,[onclick]");
  } catch {
    return null;
  }
}

/** 0 = directly clickable, 1 = inside something clickable, 2 = neither. */
function clickableScore(el: Element): number {
  if (isActionable(el)) return 0;
  return actionableAncestor(el) ? 1 : 2;
}

/** Finds the most specific visible element whose text/aria/value matches. */
function resolveByText(leading: string, text: string): Element | null {
  const needle = text.toLowerCase();
  const fallbackPool = "a,button,[role='button'],summary,input,textarea,label,li,span,div,h1,h2,h3";
  let pool: Element[];
  try {
    pool =
      leading && leading !== '*'
        ? Array.from(document.querySelectorAll(leading))
        : Array.from(document.querySelectorAll(fallbackPool));
  } catch {
    pool = Array.from(document.querySelectorAll(fallbackPool));
  }
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const matches = pool
    .map((el) => {
      const t = norm(el.textContent ?? '');
      const aria = norm(el.getAttribute('aria-label') ?? '');
      const val = norm(String((el as { value?: unknown }).value ?? ''));
      const hit = t.includes(needle) || aria.includes(needle) || val.includes(needle);
      const exact = t === needle || aria === needle || val === needle;
      return { el, exact, hit };
    })
    .filter((m) => m.hit);
  if (!matches.length) return null;
  matches.sort((a, b) => {
    // 1) visible first
    const av = isVisible(a.el) ? 0 : 1;
    const bv = isVisible(b.el) ? 0 : 1;
    if (av !== bv) return av - bv;
    // 2) clickable (or inside a clickable) first — avoids matching inert label
    //    text like a heading when a real link/button has the same words.
    const ac = clickableScore(a.el);
    const bc = clickableScore(b.el);
    if (ac !== bc) return ac - bc;
    // 3) an EXACT text match beats a substring (e.g. the "backup-cloudbase"
    //    sidebar link vs a "backup-cloudbase #14: …" run-row link).
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    // 4) then the tightest match (the actual control) over a big container.
    return (a.el.textContent?.length ?? 1e9) - (b.el.textContent?.length ?? 1e9);
  });
  const best = matches[0].el;
  // If the chosen node is plain text inside a link/button, click that instead so
  // the action actually fires (a no-op click on inert text gets us nowhere).
  if (!isActionable(best)) {
    const anc = actionableAncestor(best);
    if (anc && isVisible(anc)) return anc;
  }
  return best;
}

export function resolveSelector(selector: string): Element {
  if (selector.startsWith('el-')) {
    const tagged = querySelectorDeep(`[data-ai-agent-id="${selector}"]`);
    if (tagged) return tagged;
    throw new Error(`Element not found: ${selector}`);
  }

  const textSel = parseTextSelector(selector);
  if (textSel) {
    const byText = resolveByText(textSel.leading, textSel.text);
    if (byText) return byText;
  } else {
    const el = querySelectorDeep(selector);
    if (el) return el;
    // Selector was valid CSS but matched nothing, or was invalid syntax.
    // If it carries a quoted literal, try to recover via text matching.
    const quoted = selector.match(/["']([^"']{2,})["']/);
    if (quoted) {
      const byText = resolveByText('*', quoted[1]);
      if (byText) return byText;
    }
  }

  throw new Error(
    `Element not found for "${selector}". Use a plain CSS selector, an el-N id ` +
      `from the page context, or text matching like button:has-text('Run workflow') or text=Run workflow.`
  );
}
