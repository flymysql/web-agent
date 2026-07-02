import type { PageContext, InteractiveElement, PageRegion } from '@ai-browser-agent/shared';

const MAX_VISIBLE_TEXT = 8000;
const MAX_ELEMENTS = 120;
// Per-region cap so one huge block (e.g. a long results list) can't consume the
// whole element budget and starve small-but-critical blocks like a filter bar.
const PER_REGION_CAP = 24;
const MAX_REGIONS = 40;
const MAX_HEADINGS = 25;
// The agent's own floating UI lives in an open shadow root on this host. We must
// never collect or target it as "page content" — otherwise the agent sees its
// own buttons/input and starts operating on itself.
const AGENT_ROOT_ID = 'ai-browser-agent-root';

function clean(s: string, max = 120): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') {
    return false;
  }
  // Near-zero opacity (e.g. 1e-05) is a common trick to keep an inert duplicate
  // node in the tree; `=== '0'` alone misses "0.00001". Treat it as invisible.
  const op = parseFloat(style.opacity);
  if (!Number.isNaN(op) && op <= 0.01) return false;
  return true;
}

/**
 * Is the element actually reachable by a real click at its center — i.e. NOT
 * covered/pushed behind other content (e.g. a duplicate node with z-index:-1)?
 * Offscreen elements can't be hit-tested, so we don't penalize them here.
 * Site-agnostic; used only to break ties among a small set of text matches.
 */
function isHittable(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return true;
  const top = document.elementFromPoint(cx, cy);
  if (!top) return true;
  return el === top || el.contains(top) || top.contains(el);
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

let recordIndexCounter = 0;

/** A concise, quote-safe needle for a `:has-text('…')` selector. */
function textNeedle(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, 40).replace(/['"\\]/g, '');
}

/** How many VISIBLE clickable elements' text/aria contain this needle. */
function clickableLabelMatches(needle: string): number {
  const n = needle.toLowerCase();
  const pool = document.querySelectorAll("a,button,[role='button'],summary,input,textarea,label");
  let count = 0;
  for (const el of Array.from(pool)) {
    if (!isVisible(el)) continue;
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
    const val = String((el as { value?: unknown }).value ?? '').toLowerCase();
    if (t.includes(n) || aria.includes(n) || val.includes(n)) {
      count++;
      if (count > 1) break;
    }
  }
  return count;
}

/**
 * Build the most stable selector for a user-interacted element while recording.
 *
 * Unlike the agent's live-DOM selectors, a RECORDED selector must survive a full
 * page reload during replay. So we only emit reload-durable forms — never the
 * `data-ai-agent-id` tag fallback (that attribute is set in-memory and is gone on
 * the freshly loaded replay page) and we prefer a text/label anchor for clickable
 * targets, which the resolver matches among visible controls even when lazy-loaded
 * content has shifted structural positions (`:nth-of-type`) around.
 */
export function recordSelector(el: Element): string {
  if (el.id && isStableId(el.id)) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const name = el.getAttribute('name');
  if (name && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;

  // Is there a unique structural path? (Reliable only if siblings don't shift.)
  const path = inShadow(el) ? '' : cssPath(el);
  let pathUnique = false;
  try {
    pathUnique = !!path && document.querySelectorAll(path).length === 1;
  } catch {
    /* invalid selector */
  }

  // Text anchor for a clickable target (itself or nearest clickable ancestor).
  const target = isActionable(el) ? el : actionableAncestor(el);
  const needle = target ? textNeedle(accessibleName(target as Element)) : '';
  if (target && needle.length >= 2) {
    const tag = (target as Element).tagName.toLowerCase();
    const textSel = `${tag}:has-text('${needle}')`;
    // Prefer the text anchor when it uniquely identifies a control, or when we
    // have no unique structural path to trust anyway.
    if (clickableLabelMatches(needle) === 1 || !pathUnique) return textSel;
  }

  if (path) return path;

  // Nothing reload-durable is available (e.g. an unlabeled element in a shadow
  // root). Fall back to the tagged attribute; it only resolves within the same
  // live DOM, but it's better than an empty selector.
  const attr = 'data-ai-agent-id';
  if (!el.hasAttribute(attr)) el.setAttribute(attr, `el-rec-${recordIndexCounter++}`);
  return `[data-ai-agent-id="${el.getAttribute(attr)}"]`;
}

/** Human-meaningful label for a recorded target (accessible name / text). */
export function describeElement(el: Element): string {
  return accessibleName(el);
}

function extractText(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 200);
}

/** Resolve id references (aria-labelledby / label[for]) within the element's own
 * tree first, then fall back to the top document. */
function textFromIds(el: Element, ids: string): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts = ids
    .split(/\s+/)
    .map((id) => {
      if (!id) return '';
      const ref =
        (root as Document | ShadowRoot).querySelector?.(`#${CSS.escape(id)}`) ??
        document.getElementById(id);
      return ref?.textContent ?? '';
    })
    .join(' ');
  return clean(parts);
}

/**
 * Compute a human-meaningful name for a control, so the agent understands what
 * a button/link/field is FOR — not just its raw tag. Site-agnostic: derives
 * only from standard accessibility conventions.
 */
function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return clean(aria);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = textFromIds(el, labelledby);
    if (t) return t;
  }

  if (el.id) {
    try {
      const root = el.getRootNode() as Document | ShadowRoot;
      const lab = (root as ParentNode).querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
      if (lab?.textContent?.trim()) return clean(lab.textContent);
    } catch {
      /* invalid id for selector */
    }
  }

  const wrapLabel = typeof el.closest === 'function' ? el.closest('label') : null;
  if (wrapLabel?.textContent?.trim()) return clean(wrapLabel.textContent);

  const text = clean(el.textContent ?? '');
  if (text) return text;

  const title = el.getAttribute('title');
  if (title?.trim()) return clean(title);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return clean(placeholder);
  const alt = el.getAttribute('alt');
  if (alt?.trim()) return clean(alt);
  const val = (el as { value?: unknown }).value;
  if (typeof val === 'string' && val.trim()) return clean(val);
  return '';
}

function isDisabled(el: Element): boolean {
  if ((el as { disabled?: unknown }).disabled === true) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

function expandedState(el: Element): boolean | undefined {
  const v = el.getAttribute('aria-expanded');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function boolAttr(el: Element, prop: 'required' | 'readOnly', aria: string): boolean | undefined {
  if ((el as unknown as Record<string, unknown>)[prop] === true) return true;
  const v = el.getAttribute(aria);
  if (v === 'true') return true;
  return undefined;
}

/** Checked state for native checkbox/radio or any aria-checked custom widget. */
function checkedState(el: Element): boolean | undefined {
  const input = el as HTMLInputElement;
  if (input.type === 'checkbox' || input.type === 'radio') return input.checked;
  const v = el.getAttribute('aria-checked');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function selectedState(el: Element): boolean | undefined {
  const v = el.getAttribute('aria-selected');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** True for a file-picker input, regardless of visibility (often hidden). */
function isFileInputEl(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === 'file';
}

/** Current value of a form control, truncated; never leaks a password field. */
function controlValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password' || el.type === 'file') return undefined;
    return el.value ? clean(el.value, 80) : undefined;
  }
  if (el instanceof HTMLTextAreaElement) return el.value ? clean(el.value, 80) : undefined;
  if (el instanceof HTMLSelectElement) return el.value ? clean(el.value, 80) : undefined;
  return undefined;
}

function toInteractiveElement(el: Element, index: number, regionId?: string): InteractiveElement {
  const rect = el.getBoundingClientRect();
  const name = accessibleName(el);
  const expanded = expandedState(el);
  const isFile = isFileInputEl(el);
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
    accessibleName: name || undefined,
    regionId,
    disabled: isDisabled(el) || undefined,
    expanded,
    checked: checkedState(el),
    selected: selectedState(el),
    value: controlValue(el),
    required: boolAttr(el, 'required', 'aria-required'),
    readOnly: boolAttr(el, 'readOnly', 'aria-readonly'),
    isFileInput: isFile || undefined,
    accepts: isFile ? el.getAttribute('accept') ?? undefined : undefined,
    hasPopup: el.getAttribute('aria-haspopup') ?? undefined,
    current: el.getAttribute('aria-current') ?? undefined,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

// --- Region (semantic block) detection -----------------------------------
// Generic ARIA container roles that mark a meaningful block. No site-specific
// labels — the category is inferred purely from DOM semantics.
const CONTAINER_ROLES = new Set([
  'navigation', 'search', 'main', 'banner', 'contentinfo', 'complementary',
  'region', 'form', 'dialog', 'alertdialog', 'toolbar', 'tablist', 'tabpanel',
  'list', 'listbox', 'table', 'grid', 'treegrid', 'menu', 'menubar', 'article',
  'feed', 'group',
]);

// Native semantic tags → generic role.
const TAG_ROLE: Record<string, string> = {
  main: 'main',
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  section: 'region',
  dialog: 'dialog',
  table: 'table',
};

const REGION_QUERY =
  'main, nav, header, footer, aside, form, section, dialog, table, [role], [aria-modal="true"]';

/** The generic role for a candidate container, or null if it is not a region. */
function regionRole(el: Element): string | null {
  const explicit = (el.getAttribute('role') ?? '').toLowerCase();
  if (explicit && CONTAINER_ROLES.has(explicit)) return explicit;
  if (el.getAttribute('aria-modal') === 'true') return 'dialog';
  const tag = el.tagName.toLowerCase();
  if (tag in TAG_ROLE) {
    // A bare <section> with no name is everywhere and mostly noise; only treat
    // it as a region when it carries an accessible name or a heading.
    if (tag === 'section') {
      const named =
        el.hasAttribute('aria-label') ||
        el.hasAttribute('aria-labelledby') ||
        !!el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (!named) return null;
    }
    return TAG_ROLE[tag];
  }
  return null;
}

/** A short label for a region: accessible name, else nearest heading text. */
function regionLabel(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return clean(aria, 80);
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = textFromIds(el, labelledby);
    if (t) return t.slice(0, 80);
  }
  const heading = el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
  if (heading?.textContent?.trim()) return clean(heading.textContent, 80);
  return '';
}

interface RegionInfo {
  host: Element;
  region: PageRegion;
}

/** Collect visible region hosts (deep) and assign ids in document order. */
function collectRegions(): { regions: RegionInfo[]; hostToId: Map<Element, string> } {
  const candidates: Element[] = [];
  collectDeep(REGION_QUERY, document, candidates);
  const seen = new Set<Element>();
  const regions: RegionInfo[] = [];
  const hostToId = new Map<Element, string>();
  let idx = 0;
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    if ((el as HTMLElement).id === AGENT_ROOT_ID) continue;
    if (el.closest?.(`#${AGENT_ROOT_ID}`)) continue;
    const role = regionRole(el);
    if (!role) continue;
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const id = `region-${idx++}`;
    const region: PageRegion = {
      id,
      role,
      label: regionLabel(el) || undefined,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    regions.push({ host: el, region });
    hostToId.set(el, id);
  }
  return { regions, hostToId };
}

/** Nearest ancestor region host for an element, piercing shadow roots / frames. */
function regionHostOf(el: Element, hostToId: Map<Element, string>): string | undefined {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 80) {
    const id = hostToId.get(node);
    if (id) return id;
    let parent: Element | null = node.parentElement;
    if (!parent) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        parent = root.host as Element;
      } else {
        const fe = node.ownerDocument?.defaultView?.frameElement as Element | null;
        parent = fe ?? null;
      }
    }
    node = parent;
    depth++;
  }
  return undefined;
}

/** Heading outline (h1-h6 and role=heading), visible, in document order. */
function collectHeadings(): Array<{ level: number; text: string }> {
  const nodes: Element[] = [];
  collectDeep('h1,h2,h3,h4,h5,h6,[role="heading"]', document, nodes);
  const out: Array<{ level: number; text: string }> = [];
  for (const el of nodes) {
    if ((el as HTMLElement).id === AGENT_ROOT_ID) continue;
    if (el.closest?.(`#${AGENT_ROOT_ID}`)) continue;
    if (!isVisible(el)) continue;
    const text = clean(el.textContent ?? '', 100);
    if (!text) continue;
    const tag = el.tagName.toLowerCase();
    let level = tag.length === 2 && tag[0] === 'h' ? Number(tag[1]) : NaN;
    if (Number.isNaN(level)) {
      const ariaLevel = Number(el.getAttribute('aria-level'));
      level = Number.isFinite(ariaLevel) && ariaLevel > 0 ? ariaLevel : 2;
    }
    out.push({ level, text });
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

/** Pick the topmost visible dialog region (the layer the agent should focus on). */
function findActiveDialog(regions: RegionInfo[]): string | undefined {
  const dialogs = regions.filter(
    (r) => r.region.role === 'dialog' || r.region.role === 'alertdialog'
  );
  if (!dialogs.length) return undefined;
  // Prefer the one with the highest stacking context; fall back to last in DOM.
  let best = dialogs[dialogs.length - 1];
  let bestZ = -Infinity;
  for (const d of dialogs) {
    const z = Number(window.getComputedStyle(d.host).zIndex);
    const eff = Number.isFinite(z) ? z : 0;
    if (eff >= bestZ) {
      bestZ = eff;
      best = d;
    }
  }
  best.region.modalTop = true;
  return best.region.id;
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
  // Custom (non-native) controls common in SPAs — tabs, menus, options, toggles.
  // Without these the real control (often a <div role="tab">) is invisible to the
  // agent, forcing it to guess a text= selector that lands on an inert inner node.
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="treeitem"]',
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

/**
 * Latest text from live regions (aria-live / role=alert|status). These carry the
 * page's own feedback after an action — validation errors, toasts, "saved!",
 * "no results" — which is exactly the dynamic signal the agent needs but that a
 * static element list misses. Site-agnostic: pure ARIA convention.
 */
function collectAnnouncements(): string[] {
  // Light query on the main document only (no deep '*' shadow walk): live regions
  // are near-universally in the top document, and a full-tree traversal here would
  // add real cost on large pages for a rarely-present feature.
  let nodes: Element[] = [];
  try {
    nodes = Array.from(
      document.querySelectorAll(
        '[aria-live="polite"],[aria-live="assertive"],[role="alert"],[role="status"],output'
      )
    );
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of nodes) {
    if ((el as HTMLElement).id === AGENT_ROOT_ID || el.closest?.(`#${AGENT_ROOT_ID}`)) continue;
    if (!isVisible(el)) continue;
    const text = clean(el.textContent ?? '', 160);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

/** Iframes on the top document, flagging whether their content is reachable. */
function collectIframes(): Array<{ selector: string; sameOrigin: boolean; title?: string }> {
  const out: Array<{ selector: string; sameOrigin: boolean; title?: string }> = [];
  const frames = Array.from(document.querySelectorAll('iframe, frame'));
  let i = 0;
  for (const f of frames) {
    if ((f as HTMLElement).closest?.(`#${AGENT_ROOT_ID}`)) continue;
    if (!isVisible(f)) continue;
    let sameOrigin = false;
    try {
      sameOrigin = !!(f as HTMLIFrameElement).contentDocument;
    } catch {
      sameOrigin = false;
    }
    const title =
      f.getAttribute('title')?.trim() ||
      f.getAttribute('aria-label')?.trim() ||
      f.getAttribute('name')?.trim() ||
      undefined;
    out.push({ selector: tagElement(f, 10000 + i), sameOrigin, title });
    if (++i >= 10) break;
  }
  return out;
}

/** A scroll container with clipped content (virtualized lists, log/code panels). */
function isScrollableEl(el: Element): boolean {
  try {
    const s = getComputedStyle(el);
    const oy = s.overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 40;
  } catch {
    return false;
  }
}

/**
 * Inner scroll containers the agent may need to sweep to reveal off-screen rows.
 *
 * PERFORMANCE: `getComputedStyle` is expensive and, on a large/dynamic page (an
 * infinite feed, a search-suggest overlay), calling it for thousands of elements
 * per snapshot stalls every step. So we first apply a CHEAP geometry pre-filter
 * (a scroll container must clip meaningful content: scrollHeight ≫ clientHeight)
 * — pure layout reads that the browser batches into a single reflow — and only
 * then confirm the (few) candidates' overflow style. Everything is capped and
 * wrapped so a pathological page degrades to "no scrollables", never a hang.
 */
function collectScrollables(): Array<{ selector: string; label?: string; canScrollDown: boolean }> {
  try {
    const all = document.getElementsByTagName('*');
    const scanCap = Math.min(all.length, 4000);
    const candidates: Element[] = [];
    for (let i = 0; i < scanCap && candidates.length < 60; i++) {
      const el = all[i];
      // Cheap: only elements that visibly clip a good chunk of content qualify.
      if (el.clientHeight > 60 && el.scrollHeight > el.clientHeight + 200) {
        candidates.push(el);
      }
    }
    const found: Array<{ el: Element; area: number }> = [];
    for (const el of candidates) {
      if ((el as HTMLElement).id === AGENT_ROOT_ID || el.closest?.(`#${AGENT_ROOT_ID}`)) continue;
      if (!isScrollableEl(el)) continue; // getComputedStyle only on the few candidates
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 10000) continue;
      found.push({ el, area: r.width * r.height });
    }
    found.sort((a, b) => b.area - a.area);
    const out: Array<{ selector: string; label?: string; canScrollDown: boolean }> = [];
    for (let i = 0; i < found.length && out.length < 6; i++) {
      const el = found[i].el;
      const canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      out.push({
        selector: tagElement(el, 11000 + i),
        label: accessibleName(el) || undefined,
        canScrollDown,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Text contributed by an element's OWN direct text nodes (not descendants). */
function directText(el: Element): string {
  let s = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) s += node.textContent ?? '';
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Bounded capture of "clickable-looking" NON-semantic controls. Modern SPAs
 * (React/Vue/…) build tabs, filter chips, custom buttons and card actions from
 * bare <div>/<span> that carry a click handler but NO native/ARIA semantics — so
 * INTERACTIVE_SELECTORS misses them and the agent is left guessing `text=` that
 * lands on the wrong or an inert node. We surface such controls by their computed
 * cursor:pointer, which is the one reliable, site-agnostic signal a bare element
 * is meant to be clicked. Kept cheap: only leaf-ish elements with a SHORT own-text
 * label pay for a getComputedStyle call, and both the scan and the output are
 * hard-capped so this can't regress performance on large pages.
 */
function collectClickable(already: Set<Element>): Element[] {
  const out: Element[] = [];
  try {
    const all = document.getElementsByTagName('*');
    const scanCap = Math.min(all.length, 3000);
    for (let i = 0; i < scanCap && out.length < 40; i++) {
      const el = all[i];
      if (already.has(el)) continue;
      // Want leaf-ish controls (a tab/chip/button label), not big containers.
      if (el.childElementCount > 3) continue;
      const text = directText(el);
      if (!text || text.length > 24) continue;
      if ((el as HTMLElement).id === AGENT_ROOT_ID || el.closest?.(`#${AGENT_ROOT_ID}`)) continue;
      // Already at/inside a semantic control we captured — avoid duplicates.
      try {
        if (el.closest(ACTIONABLE_SELECTOR)) continue;
      } catch {
        /* ignore selector-engine edge */
      }
      if (!isVisible(el)) continue;
      let cursor = '';
      try {
        cursor = getComputedStyle(el).cursor;
      } catch {
        continue;
      }
      if (cursor !== 'pointer') continue;
      out.push(el);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function extractPageContext(): PageContext {
  const { regions, hostToId } = collectRegions();

  const collected: Element[] = [];
  collectDeep(INTERACTIVE_SELECTORS, document, collected);
  // Surface non-semantic clickable controls (SPA tabs/chips/custom buttons) that
  // have no native/ARIA affordance, so the agent gets a real el-N selector for
  // them instead of guessing a text= selector that hits an inert node.
  for (const el of collectClickable(new Set(collected))) collected.push(el);
  // Keep file inputs even when hidden: sites routinely hide the real
  // <input type=file> behind a styled button, but the agent must still SEE it so
  // it can upload via that input instead of clicking the button (which opens the
  // OS file dialog it cannot control).
  const visibleNodes = collected.filter((el) => isVisible(el) || isFileInputEl(el));

  // Per-region budget: keep up to PER_REGION_CAP per block (and a separate cap
  // for elements outside any region) so a giant list can't crowd out the rest.
  const perRegionCount = new Map<string, number>();
  const chosen: Array<{ el: Element; regionId?: string }> = [];
  for (const el of visibleNodes) {
    if (chosen.length >= MAX_ELEMENTS) break;
    const regionId = regionHostOf(el, hostToId);
    const bucket = regionId ?? '__none__';
    const count = perRegionCount.get(bucket) ?? 0;
    if (count >= PER_REGION_CAP) continue;
    perRegionCount.set(bucket, count + 1);
    chosen.push({ el, regionId });
  }

  const interactiveElements = chosen.map((c, i) => toInteractiveElement(c.el, i, c.regionId));

  // Attach element counts and drop regions that ended up empty and unlabeled
  // (pure structural noise), keeping the list focused for the model.
  for (const r of regions) {
    r.region.elementCount = perRegionCount.get(r.region.id) ?? 0;
  }
  const activeDialogRegionId = findActiveDialog(regions);
  const keptRegions = regions
    .filter(
      (r) =>
        (r.region.elementCount ?? 0) > 0 ||
        !!r.region.label ||
        r.region.id === activeDialogRegionId
    )
    .slice(0, MAX_REGIONS)
    .map((r) => r.region);

  const formFields = interactiveElements.filter(
    (el) => ['input', 'select', 'textarea'].includes(el.tag) || el.role === 'textbox'
  );

  const links = interactiveElements
    .filter((el) => el.tag === 'a' && el.href)
    .slice(0, 50)
    .map((el) => ({
      text: el.accessibleName ?? el.text ?? '',
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
    regions: keptRegions,
    headings: collectHeadings(),
    activeDialogRegionId,
    announcements: collectAnnouncements(),
    iframes: collectIframes(),
    scrollables: collectScrollables(),
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
 *   text=Submit
 *   button:has-text('Submit')
 *   a:contains("Details")
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

/**
 * Roles/attributes that mark a real clickable control, including the custom
 * (non-native) controls modern SPAs build from <div>/<span>. Kept in sync with
 * the click tool's own detection so text= resolution and the click no-op retry
 * agree on "what is clickable". Site-agnostic.
 */
const CLICKABLE_ROLE_SELECTOR =
  "[role='button'],[role='link'],[role='tab'],[role='menuitem']," +
  "[role='menuitemcheckbox'],[role='menuitemradio'],[role='option']," +
  "[role='switch'],[role='checkbox'],[role='radio'],[role='treeitem']";

const ACTIONABLE_SELECTOR = `a[href],button,summary,[onclick],input,select,textarea,[tabindex],${CLICKABLE_ROLE_SELECTOR}`;

const ANCESTOR_SELECTOR = `a[href],button,summary,[onclick],[tabindex],${CLICKABLE_ROLE_SELECTOR}`;

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
    return el.closest(ANCESTOR_SELECTOR);
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
    // 1b) among visible, prefer the one actually on top (not covered / z-index:-1),
    //     so a hidden duplicate that reports as visible still loses to the real one.
    const ah = av === 0 && isHittable(a.el) ? 0 : 1;
    const bh = bv === 0 && isHittable(b.el) ? 0 : 1;
    if (ah !== bh) return ah - bh;
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
      `from the page context, or text matching like button:has-text('<label>') or text=<label>.`
  );
}
