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

function buildSelector(el: Element, index: number): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const name = el.getAttribute('name');
  if (name && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) {
    return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
  }
  return `[data-ai-agent-id="el-${index}"]`;
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
  const htmlEl = el as HTMLElement;
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

export function extractPageContext(): PageContext {
  const interactiveNodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS))
    .filter(isVisible)
    .slice(0, MAX_ELEMENTS);

  const interactiveElements = interactiveNodes.map((el, i) => toInteractiveElement(el, i));

  const formFields = interactiveElements.filter((el) =>
    ['input', 'select', 'textarea'].includes(el.tag) ||
    el.role === 'textbox'
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
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function resolveSelector(selector: string): Element {
  if (selector.startsWith('el-')) {
    selector = `[data-ai-agent-id="${selector}"]`;
  }
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}
