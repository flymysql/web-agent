import type { PlanStep, TaskPlan, PageContext } from '@ai-browser-agent/shared';
import { toolsToJsonSchema, getToolDefinition } from '@ai-browser-agent/shared';
import { summarizePageContext } from '../tools/registry.js';

export interface AgentHistoryItem {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  error?: string;
  result?: string;
}

export interface AgentDecision {
  thought: string;
  done: boolean;
  summary?: string;
  action?: { tool: string; args: Record<string, unknown> };
}

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM is configured via OpenAI-compatible env vars so any compatible endpoint
 * works: OpenAI, local runtimes (Ollama, LM Studio), or Chinese providers
 * (DeepSeek, DashScope/Qwen compatible-mode, Zhipu, ...).
 */
function llmConfig() {
  const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  const model = process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return { baseUrl, apiKey, model };
}

export function describeLLM(): string {
  const { baseUrl, model } = llmConfig();
  return `${model} @ ${baseUrl}`;
}

async function chatCompletion(messages: LLMMessage[]): Promise<string> {
  const { baseUrl, apiKey, model } = llmConfig();

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`LLM request failed (${res.status}) at ${baseUrl}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned an empty response');
  return content;
}

const PLANNER_SYSTEM_PROMPT = `You are a browser automation planner. Given a user request and page context, output a JSON plan with steps.
Each step must use one of these tools: extractPage, click, type, scroll, wait, readText, getAttribute, selectOption, fetch, notify.
Output ONLY valid JSON in this format:
{
  "goal": "string",
  "steps": [
    { "description": "string", "tool": "toolName", "args": {} }
  ],
  "estimatedDuration": "string",
  "risks": ["string"]
}`;

export async function generatePlanWithLLM(
  userRequest: string,
  pageContext?: PageContext
): Promise<TaskPlan> {
  const tools = toolsToJsonSchema();
  const pageSummary = pageContext
    ? `Page: ${pageContext.title}\nURL: ${pageContext.url}\nLinks: ${pageContext.links.length}\nForms: ${pageContext.formFields.length}\nText preview: ${pageContext.visibleText.slice(0, 1000)}`
    : 'No page context available';

  const messages: LLMMessage[] = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Request: ${userRequest}\n\n${pageSummary}\n\nAvailable tools:\n${JSON.stringify(tools, null, 2)}`,
    },
  ];

  const content = await chatCompletion(messages);

  let parsed: {
    goal?: string;
    steps?: Array<{ description: string; tool: string; args?: Record<string, unknown> }>;
    estimatedDuration?: string;
    risks?: string[];
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('LLM returned invalid JSON for the plan');
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('LLM plan contains no steps');
  }

  const steps: PlanStep[] = parsed.steps.map((s) => {
    const def = getToolDefinition(s.tool);
    return {
      id: crypto.randomUUID(),
      description: s.description,
      tool: s.tool,
      args: s.args ?? {},
      riskLevel: def?.riskLevel ?? 'low',
      requiresConfirmation: def?.requiresConfirmation ?? false,
    };
  });

  return {
    goal: parsed.goal ?? userRequest,
    steps,
    estimatedDuration: parsed.estimatedDuration,
    risks: parsed.risks,
  };
}

const AGENT_SYSTEM_PROMPT = `You are a web automation agent operating one step at a time.
Given the GOAL, the CURRENT PAGE, and the HISTORY of actions already taken, decide the SINGLE next action.
Available tools: extractPage, click, type, scroll, wait, readText, getAttribute, selectOption, fetch, notify.
Selectors should come from the current page's interactive elements (use their selector field).
Respond ONLY with valid JSON, one of:
{ "thought": "why this action", "done": false, "action": { "tool": "toolName", "args": { } } }
{ "thought": "why finished", "done": true, "summary": "what was accomplished" }
Set done=true when the goal is achieved, or when it cannot proceed. Avoid repeating a failed action; try an alternative.`;

export async function decideNextAction(
  goal: string,
  pageContext: PageContext,
  history: AgentHistoryItem[],
  planHint?: TaskPlan
): Promise<AgentDecision> {
  const tools = toolsToJsonSchema();
  const historyText = history.length
    ? history
        .map((h, i) => {
          const status = h.success ? 'ok' : `FAILED: ${h.error ?? 'unknown'}`;
          const res = h.result ? ` → ${h.result}` : '';
          return `${i + 1}. ${h.tool}(${JSON.stringify(h.args)}) [${status}]${res}`;
        })
        .join('\n')
    : '(no actions yet)';

  const hint = planHint?.steps?.length
    ? `\n\nInitial plan (hint only, adapt as needed):\n${planHint.steps
        .map((s, i) => `${i + 1}. ${s.description} [${s.tool}]`)
        .join('\n')}`
    : '';

  const messages: LLMMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `GOAL: ${goal}${hint}\n\nCURRENT PAGE:\n${summarizePageContext(pageContext)}\n\nINTERACTIVE ELEMENTS (selector → text):\n${pageContext.interactiveElements
        .slice(0, 40)
        .map((el) => `${el.selector} → ${el.tag}${el.type ? `[${el.type}]` : ''} ${el.text ?? el.placeholder ?? el.name ?? ''}`)
        .join('\n')}\n\nHISTORY:\n${historyText}\n\nAvailable tools:\n${JSON.stringify(tools, null, 2)}`,
    },
  ];

  const content = await chatCompletion(messages);
  let parsed: AgentDecision;
  try {
    parsed = JSON.parse(content) as AgentDecision;
  } catch {
    throw new Error('LLM returned invalid JSON for the next action');
  }

  return {
    thought: parsed.thought ?? '',
    done: Boolean(parsed.done),
    summary: parsed.summary,
    action: parsed.action,
  };
}
