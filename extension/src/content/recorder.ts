import type { RecordedAction } from '@ai-browser-agent/shared';
import { recordSelector, describeElement } from './page-context.js';

// The agent's own floating UI lives in an open shadow root on this host; events
// originating there must never be recorded (otherwise stopping the recording or
// clicking the panel would become "steps").
const AGENT_ROOT_ID = 'ai-browser-agent-root';

let recording = false;
// Coalesces a burst of keystrokes in one field into a single `type` action with
// the field's final value, instead of one action per character.
let pendingType: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

export function isRecording(): boolean {
  return recording;
}

function send(action: RecordedAction): void {
  try {
    void chrome.runtime.sendMessage({ type: 'RECORD_ACTION', action });
  } catch {
    /* background unavailable — recording degrades gracefully */
  }
}

/** Emit one recorded action; injects the target's selector into args when present. */
function record(tool: string, args: Record<string, unknown>, el?: Element): void {
  const selector = el ? recordSelector(el) : (args.selector as string | undefined);
  const finalArgs = selector && !('selector' in args) ? { selector, ...args } : args;
  send({
    tool,
    args: finalArgs,
    selector,
    label: el ? describeElement(el) : undefined,
    url: location.href,
    at: Date.now(),
  });
}

function isAgentUI(e: Event): boolean {
  const path = (e.composedPath?.() ?? []) as EventTarget[];
  return path.some((t) => t instanceof Element && t.id === AGENT_ROOT_ID);
}

function isTextEntry(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(t);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function fieldValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.textContent ?? '';
}

/** Resolve a click to the closest meaningful interactive element. */
function meaningfulTarget(el: Element | null): Element | null {
  if (!el) return null;
  const interactive =
    typeof el.closest === 'function'
      ? el.closest('a,button,[role="button"],input,select,textarea,label,[onclick],[tabindex]')
      : null;
  return interactive ?? el;
}

function flushPendingType(): void {
  if (!pendingType) return;
  const { el, timer } = pendingType;
  clearTimeout(timer);
  pendingType = null;
  record('type', { text: fieldValue(el), clear: true }, el);
}

function scheduleTypeFlush(el: HTMLElement): void {
  if (pendingType && pendingType.el !== el) flushPendingType();
  if (pendingType) clearTimeout(pendingType.timer);
  pendingType = { el, timer: setTimeout(flushPendingType, 900) };
}

function onClick(e: Event): void {
  if (!recording || isAgentUI(e)) return;
  const el = meaningfulTarget(e.target as Element);
  if (!el) return;
  // Text fields, dropdowns and checkboxes are captured via input/change instead,
  // so we don't record a redundant click on them.
  if (isTextEntry(el) || el instanceof HTMLSelectElement) return;
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return;
  flushPendingType();
  record('click', {}, el);
}

function onInput(e: Event): void {
  if (!recording || isAgentUI(e)) return;
  const el = e.target as Element;
  if (isTextEntry(el)) scheduleTypeFlush(el as HTMLElement);
}

function onChange(e: Event): void {
  if (!recording || isAgentUI(e)) return;
  const el = e.target as Element;
  if (el instanceof HTMLSelectElement) {
    flushPendingType();
    record('selectOption', { value: el.value }, el);
  } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    flushPendingType();
    record('setChecked', { checked: el.checked }, el);
  } else if (isTextEntry(el)) {
    // `change` fires on blur for text inputs — finalize the coalesced value now.
    flushPendingType();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (!recording || isAgentUI(e)) return;
  if (e.key !== 'Enter') return;
  const el = e.target as Element;
  if (!isTextEntry(el)) return;
  // Enter in a multi-line textarea inserts a newline rather than submitting.
  if (el instanceof HTMLTextAreaElement) return;
  flushPendingType();
  record('pressKey', { key: 'Enter' }, el);
}

export function startRecording(): void {
  if (recording) return;
  recording = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeydown, true);
}

export function stopRecording(): void {
  if (!recording) return;
  flushPendingType();
  recording = false;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('input', onInput, true);
  document.removeEventListener('change', onChange, true);
  document.removeEventListener('keydown', onKeydown, true);
}
