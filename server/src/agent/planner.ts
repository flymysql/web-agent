import type { PageContext, PlanStep, TaskPlan } from '@ai-browser-agent/shared';
import { assessRiskFromText, getToolDefinition } from '@ai-browser-agent/shared';
import { summarizePageContext } from '../tools/registry.js';
import { generatePlanWithLLM } from '../llm/provider.js';

function makeStep(
  description: string,
  tool: string,
  args: Record<string, unknown> = {}
): PlanStep {
  const def = getToolDefinition(tool);
  const riskLevel = def?.riskLevel ?? assessRiskFromText(description);
  return {
    id: crypto.randomUUID(),
    description,
    tool,
    args,
    riskLevel,
    requiresConfirmation: riskLevel === 'high' || (def?.requiresConfirmation ?? false),
  };
}

function ruleBasedPlan(userRequest: string, pageContext?: PageContext): TaskPlan {
  const req = userRequest.toLowerCase();
  const steps: PlanStep[] = [];

  steps.push(makeStep('Extract current page context', 'extractPage'));

  if (req.includes('link') || req.includes('链接')) {
    steps.push(makeStep('Read all links from page', 'readText'));
    if (req.includes('click') || req.includes('点击')) {
      steps.push(makeStep('Scroll to find more links', 'scroll', { direction: 'down' }));
    }
  }

  if (req.includes('form') || req.includes('表单') || req.includes('fill') || req.includes('填写')) {
    const fields = pageContext?.formFields ?? [];
    if (fields.length > 0) {
      fields.slice(0, 5).forEach((f) => {
        steps.push(
          makeStep(`Fill field: ${f.name ?? f.placeholder ?? f.selector}`, 'type', {
            selector: f.selector,
            text: `[value for ${f.name ?? f.placeholder ?? 'field'}]`,
          })
        );
      });
    } else {
      steps.push(makeStep('Scroll to find form fields', 'scroll', { direction: 'down' }));
    }
  }

  if (req.includes('scroll') || req.includes('滚动')) {
    steps.push(makeStep('Scroll down the page', 'scroll', { direction: 'down', amount: 500 }));
  }

  if (req.includes('wait') || req.includes('等待')) {
    steps.push(makeStep('Wait for page content', 'wait', { timeoutMs: 5000 }));
  }

  if (req.includes('monitor') || req.includes('监控') || req.includes('check') || req.includes('检查')) {
    steps.push(makeStep('Extract page for monitoring', 'extractPage'));
    steps.push(makeStep('Wait before next check', 'wait', { timeoutMs: 3000 }));
  }

  if (req.includes('read') || req.includes('extract') || req.includes('提取') || req.includes('读取') || req.includes('总结')) {
    steps.push(makeStep('Read page text content', 'readText'));
  }

  if (req.includes('click') || req.includes('点击') || req.includes('button') || req.includes('按钮')) {
    const buttons = pageContext?.interactiveElements.filter(
      (el) => el.tag === 'button' || el.role === 'button'
    ) ?? [];
    if (buttons.length > 0) {
      steps.push(
        makeStep(`Click: ${buttons[0].text ?? buttons[0].selector}`, 'click', {
          selector: buttons[0].selector,
        })
      );
    }
  }

  if (req.includes('fetch') || req.includes('api') || req.includes('请求')) {
    steps.push(
      makeStep('Fetch data via backend', 'fetch', {
        url: 'https://httpbin.org/get',
        method: 'GET',
      })
    );
  }

  if (steps.length <= 1) {
    steps.push(makeStep('Read page text for analysis', 'readText'));
    steps.push(makeStep('Summarize findings', 'notify', {
      title: 'Task Complete',
      message: 'Page content has been extracted and analyzed.',
    }));
  }

  return {
    goal: userRequest,
    steps,
    estimatedDuration: `${steps.length * 3}s`,
    risks: steps.filter((s) => s.riskLevel === 'high').map((s) => s.description),
  };
}

export async function createPlan(
  userRequest: string,
  pageContext?: PageContext
): Promise<TaskPlan> {
  const llmPlan = await generatePlanWithLLM(userRequest, pageContext);
  if (llmPlan) return llmPlan;
  return ruleBasedPlan(userRequest, pageContext);
}

export function replanFromFailure(
  userRequest: string,
  pageContext: PageContext | undefined,
  failedStep: PlanStep,
  error: string
): PlanStep[] {
  return [
    makeStep('Re-extract page after failure', 'extractPage'),
    makeStep(`Retry: ${failedStep.description} (previous error: ${error})`, failedStep.tool, {
      ...failedStep.args,
    }),
  ];
}

export { summarizePageContext };
