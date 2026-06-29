import type { PageContext, PlanStep, TaskPlan } from '@ai-browser-agent/shared';
import { getToolDefinition, assessRiskFromText } from '@ai-browser-agent/shared';
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

/**
 * Planning is LLM-only by design — no rule-based fallback. If the configured
 * LLM endpoint is unreachable or misconfigured, the error surfaces to the user.
 */
export async function createPlan(
  userRequest: string,
  pageContext?: PageContext,
  conversationContext?: string
): Promise<TaskPlan> {
  try {
    return await generatePlanWithLLM(userRequest, pageContext, conversationContext);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `规划失败:LLM 不可用或未配置。请设置 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY。原因:${reason}`
    );
  }
}

export function replanFromFailure(
  _userRequest: string,
  _pageContext: PageContext | undefined,
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
