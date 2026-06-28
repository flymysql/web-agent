import { extractPageContext, getVisibleText, resolveSelector } from './page-context.js';

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(args: Record<string, unknown>): Promise<ToolResult> {
  const selector = args.selector as string | undefined;
  const text = args.text as string | undefined;
  const timeoutMs = (args.timeoutMs as number) ?? 10000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (selector) {
      const el = document.querySelector(selector);
      if (el && el.getBoundingClientRect().width > 0) {
        return { success: true, result: { found: true, selector } };
      }
    }
    if (text) {
      const bodyText = document.body?.innerText ?? '';
      if (bodyText.includes(text)) {
        return { success: true, result: { found: true, text } };
      }
    }
    if (!selector && !text) {
      await sleep(Math.min(timeoutMs, 1000));
      return { success: true, result: { waited: true, ms: Math.min(timeoutMs, 1000) } };
    }
    await sleep(200);
  }

  return { success: false, error: `Timeout waiting for ${selector ?? text ?? 'condition'}` };
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
        return { success: true, result: { clicked: selector } };
      }

      case 'type': {
        const selector = args.selector as string;
        const text = args.text as string;
        const clear = (args.clear as boolean) ?? true;
        if (!selector || text === undefined) {
          return { success: false, error: 'selector and text are required' };
        }
        const el = resolveSelector(selector) as HTMLInputElement | HTMLTextAreaElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        if (clear) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
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
