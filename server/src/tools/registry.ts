import type { PageContext } from '@ai-browser-agent/shared';
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
      case 'fetch': {
        const url = args.url as string;
        const method = (args.method as string) ?? 'GET';
        const headers = (args.headers as Record<string, string>) ?? {};
        const body = args.body as string | undefined;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const res = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const text = await res.text();
        return {
          success: res.ok,
          result: {
            status: res.status,
            statusText: res.statusText,
            body: text.slice(0, 10000),
          },
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      }

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

export function summarizePageContext(ctx: PageContext): string {
  const lines = [
    `URL: ${ctx.url}`,
    `Title: ${ctx.title}`,
    `Links: ${ctx.links.length}`,
    `Interactive elements: ${ctx.interactiveElements.length}`,
    `Form fields: ${ctx.formFields.length}`,
    '',
    'Visible text (truncated):',
    ctx.visibleText.slice(0, 2000),
  ];

  if (ctx.links.length > 0) {
    lines.push('', 'Top links:');
    ctx.links.slice(0, 10).forEach((l) => {
      lines.push(`- ${l.text || '(no text)'} → ${l.href}`);
    });
  }

  if (ctx.formFields.length > 0) {
    lines.push('', 'Form fields:');
    ctx.formFields.slice(0, 10).forEach((f) => {
      lines.push(`- ${f.tag}${f.type ? `[${f.type}]` : ''} ${f.name ?? f.placeholder ?? f.text ?? f.selector}`);
    });
  }

  return lines.join('\n');
}
