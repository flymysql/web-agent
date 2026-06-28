import type { PlanStep, TaskPlan, PageContext } from '@ai-browser-agent/shared';
import { toolsToJsonSchema, getToolDefinition } from '@ai-browser-agent/shared';

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function generatePlanWithLLM(
  userRequest: string,
  pageContext?: PageContext
): Promise<TaskPlan | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const tools = toolsToJsonSchema();

  const systemPrompt = `You are a browser automation planner. Given a user request and page context, output a JSON plan with steps.
Each step must use one of these tools: extractPage, click, type, scroll, wait, readText, getAttribute, selectOption, fetch, notify.
Output ONLY valid JSON in this format:
{
  "goal": "string",
  "steps": [
    {
      "description": "string",
      "tool": "toolName",
      "args": {}
    }
  ],
  "estimatedDuration": "string",
  "risks": ["string"]
}`;

  const pageSummary = pageContext
    ? `Page: ${pageContext.title}\nURL: ${pageContext.url}\nLinks: ${pageContext.links.length}\nForms: ${pageContext.formFields.length}\nText preview: ${pageContext.visibleText.slice(0, 1000)}`
    : 'No page context available';

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Request: ${userRequest}\n\n${pageSummary}\n\nAvailable tools:\n${JSON.stringify(tools, null, 2)}`,
    },
  ];

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      console.warn('[LLM] Plan generation failed:', res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      goal: string;
      steps: Array<{ description: string; tool: string; args?: Record<string, unknown> }>;
      estimatedDuration?: string;
      risks?: string[];
    };

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
  } catch (err) {
    console.warn('[LLM] Error:', err);
    return null;
  }
}
