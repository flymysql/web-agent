import type { PageContext, InteractiveElement, PageRegion } from '@ai-browser-agent/shared';
import { isBackendTool } from '@ai-browser-agent/shared';

export async function executeBackendTool(
  tool: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!isBackendTool(tool)) {
    return { success: false, error: `Not a backend tool: ${tool}` };
  }

  try {
    switch (tool) {
      case 'fetch':
        return {
          success: false,
          error:
            'Server-side fetch is disabled. Use the browser tools httpRequest / webSearch / imageSearch instead (they run in the browser and have network access).',
        };

      case 'notify':
        return {
          success: true,
          result: {
            title: args.title,
            message: args.message,
            notified: true,
          },
        };

      default:
        return { success: false, error: `Unknown backend tool: ${tool}` };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One-line label for an interactive element: what it is + what it's for. */
function describeElement(el: InteractiveElement, withSelector: boolean): string {
  const kind = el.role ? `${el.tag}/${el.role}` : el.tag + (el.type ? `[${el.type}]` : '');
  const name = (el.accessibleName ?? el.text ?? el.placeholder ?? el.name ?? '').slice(0, 60);
  const state: string[] = [];
  if (el.disabled) state.push('disabled');
  if (el.expanded === true) state.push('expanded');
  if (el.expanded === false) state.push('collapsed');
  const stateStr = state.length ? ` (${state.join(',')})` : '';
  const label = name || '(no label)';
  return withSelector
    ? `  ${el.selector} → ${label} [${kind}]${stateStr}`
    : `  ${label} [${kind}]${stateStr}`;
}

/**
 * Render the page as a structured outline: heading outline + semantic regions,
 * with each region's key interactive elements grouped under it. This lets the
 * model see WHAT blocks the page has and WHAT each block can do, instead of a
 * flat wall of text plus anonymous buttons. Site-agnostic — regions/roles come
 * from the live DOM, never hardcoded labels.
 */
export function summarizePageContext(
  ctx: PageContext,
  opts: { withSelectors?: boolean; maxTextChars?: number } = {}
): string {
  const withSelectors = opts.withSelectors ?? false;
  const maxText = opts.maxTextChars ?? 900;
  const lines = [
    `URL: ${ctx.url}`,
    `Title: ${ctx.title}`,
    `Regions: ${ctx.regions?.length ?? 0} · Interactive: ${ctx.interactiveElements.length} · Forms: ${ctx.formFields.length} · Links: ${ctx.links.length}`,
  ];

  const activeDialog = ctx.regions?.find((r) => r.id === ctx.activeDialogRegionId);
  if (activeDialog) {
    lines.push(
      '',
      `⚠️ 当前聚焦：置顶弹窗/对话框「${activeDialog.label ?? activeDialog.role}」——优先在此弹窗内操作，除非需要先关闭它。`
    );
  }

  if (ctx.headings?.length) {
    lines.push('', 'Heading outline:');
    ctx.headings.slice(0, 20).forEach((h) => {
      const indent = '  '.repeat(Math.max(0, Math.min(5, h.level - 1)));
      lines.push(`${indent}- ${h.text}`);
    });
  }

  const regions = ctx.regions ?? [];
  if (regions.length) {
    // Group chosen interactive elements by their region for a block-by-block view.
    const byRegion = new Map<string, InteractiveElement[]>();
    const orphans: InteractiveElement[] = [];
    for (const el of ctx.interactiveElements) {
      if (el.regionId) {
        const arr = byRegion.get(el.regionId) ?? [];
        arr.push(el);
        byRegion.set(el.regionId, arr);
      } else {
        orphans.push(el);
      }
    }

    lines.push('', 'Page regions (block → key controls):');
    let elementBudget = withSelectors ? 70 : 45;
    const renderRegion = (r: PageRegion): void => {
      if (elementBudget <= 0) return;
      const head = `▸ [${r.role}]${r.label ? ` ${r.label}` : ''}${r.modalTop ? ' (modal, on top)' : ''} · ${r.elementCount ?? 0} controls`;
      lines.push(head);
      const els = byRegion.get(r.id) ?? [];
      const perRegion = Math.min(els.length, 12, elementBudget);
      for (let i = 0; i < perRegion; i++) {
        lines.push(describeElement(els[i], withSelectors));
        elementBudget--;
      }
      if (els.length > perRegion) lines.push(`  … +${els.length - perRegion} more controls`);
    };
    // Show the active dialog first, then remaining regions in document order.
    if (activeDialog) renderRegion(activeDialog);
    for (const r of regions) {
      if (r.id === activeDialog?.id) continue;
      renderRegion(r);
    }
    if (orphans.length && elementBudget > 0) {
      lines.push('▸ [other] (outside any labeled region)');
      const perRegion = Math.min(orphans.length, 12, elementBudget);
      for (let i = 0; i < perRegion; i++) {
        lines.push(describeElement(orphans[i], withSelectors));
        elementBudget--;
      }
      if (orphans.length > perRegion) lines.push(`  … +${orphans.length - perRegion} more controls`);
    }
  } else {
    // Fallback for pages with no detected regions (or an older extension that
    // didn't send them): keep the previous flat listing.
    if (ctx.links.length > 0) {
      lines.push('', 'Top links:');
      ctx.links.slice(0, 8).forEach((l) => lines.push(`- ${l.text || '(no text)'} → ${l.href}`));
    }
    if (ctx.formFields.length > 0) {
      lines.push('', 'Form fields:');
      ctx.formFields.slice(0, 8).forEach((f) => lines.push(describeElement(f, withSelectors)));
    }
    if (withSelectors && ctx.interactiveElements.length) {
      lines.push('', 'Interactive elements (selector → label):');
      ctx.interactiveElements.slice(0, 25).forEach((el) => lines.push(describeElement(el, true)));
    }
  }

  lines.push('', 'Visible text (truncated):', ctx.visibleText.slice(0, maxText));
  return lines.join('\n');
}
