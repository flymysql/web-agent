import type { PlanStep, TaskPlan, PageContext } from '@ai-browser-agent/shared';
import { getToolDefinition, ALL_TOOLS } from '@ai-browser-agent/shared';
import { summarizePageContext } from '../tools/registry.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { debugLog } from '../debug/logger.js';

const TOOL_NAMES = ALL_TOOLS.map((t) => t.name).join(', ');

/** Compact tool catalogue (sent once in the system prompt instead of full JSON each call). */
const TOOLS_BRIEF = ALL_TOOLS.map((t) => {
  const params = t.parameters.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ');
  return `- ${t.name}(${params}): ${t.description}`;
}).join('\n');

const HISTORY_WINDOW = 12;

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
function parseExtraHeaders(): Record<string, string> {
  const raw = process.env.LLM_EXTRA_HEADERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') headers[k] = v;
    }
    return headers;
  } catch {
    console.warn('[LLM] LLM_EXTRA_HEADERS is not valid JSON, ignoring');
    return {};
  }
}

function parseExtraBody(): Record<string, unknown> {
  const raw = process.env.LLM_EXTRA_BODY;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.warn('[LLM] LLM_EXTRA_BODY is not valid JSON, ignoring');
    return {};
  }
}

/**
 * Models (esp. local "thinking" models) may wrap JSON in <think>…</think>,
 * markdown fences, or prose. Extract the outermost JSON object defensively.
 */
function coerceJson(content: string): string {
  let c = content.trim();
  c = c.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  c = c.replace(/<\/?think>/gi, '').trim();
  c = c.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return extractJsonObject(c);
}

/** Find the first top-level {...} object, matching braces while ignoring braces
 * inside string literals (CSS/JS payloads are full of `}`). If the object is
 * truncated (never closed), returns from the first `{` to the end. */
function extractJsonObject(c: string): string {
  const start = c.indexOf('{');
  if (start === -1) return c;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < c.length; i++) {
    const ch = c[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return c.slice(start, i + 1); }
  }
  return c.slice(start);
}

/** Best-effort repair of a truncated JSON object: close a dangling string and
 * any still-open braces/brackets so JSON.parse can recover the partial value. */
function repairJson(c: string): string {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = c;
  if (esc) out = out.slice(0, -1);
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

/** Escape raw control chars (newlines/tabs) that appear *inside* JSON string
 * literals — the most common reason LLM JSON fails to parse (e.g. multi-line CSS). */
function escapeControlCharsInStrings(input: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function parseJsonLoose<T>(content: string, what: string): T {
  const c = coerceJson(content);
  const escaped = escapeControlCharsInStrings(c);
  const attempts = [c, escaped, repairJson(escaped)];
  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(`[LLM] Failed to parse ${what}. Raw response (truncated):\n`, content.slice(0, 2000));
  debugLog({
    source: 'llm',
    level: 'error',
    category: 'parse',
    message: `Failed to parse ${what}`,
    data: { raw: content.slice(0, 2000) },
  });
  throw new Error(
    `LLM returned invalid JSON for ${what}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

function llmConfig() {
  const rc = getRuntimeConfig();
  const baseUrl = (rc.llmBaseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = rc.llmApiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const model = rc.llmModel || process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const extraHeaders = parseExtraHeaders();
  const extraBody = parseExtraBody();
  const maxTokens = parseInt(process.env.LLM_MAX_TOKENS ?? '2048', 10);
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS ?? '90000', 10);
  return { baseUrl, apiKey, model, extraHeaders, extraBody, maxTokens, timeoutMs };
}

export function describeLLM(): string {
  const { baseUrl, model } = llmConfig();
  return `${model} @ ${baseUrl}`;
}

async function chatCompletion(messages: LLMMessage[], label = 'llm'): Promise<string> {
  const { baseUrl, apiKey, model, extraHeaders, extraBody, maxTokens, timeoutMs } = llmConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  debugLog({
    source: 'llm',
    level: 'info',
    category: `${label}.request`,
    message: `→ ${model} (${messages.length} msgs, ${promptChars} chars)`,
    data: { baseUrl, model, maxTokens, system: messages[0]?.content?.slice(0, 300) },
  });

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...extraBody,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    debugLog({
      source: 'llm',
      level: 'error',
      category: `${label}.error`,
      message: err instanceof Error ? err.message : String(err),
      data: { durationMs: Date.now() - startedAt, model },
    });
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `LLM request timed out after ${timeoutMs}ms. The model may be generating endlessly (thinking mode). ` +
          `Lower LLM_MAX_TOKENS or disable thinking via LLM_EXTRA_BODY.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    debugLog({
      source: 'llm',
      level: 'error',
      category: `${label}.http`,
      message: `LLM request failed (${res.status})`,
      data: { baseUrl, status: res.status, detail: detail.slice(0, 500), durationMs: Date.now() - startedAt },
    });
    throw new Error(`LLM request failed (${res.status}) at ${baseUrl}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  const content = data.choices?.[0]?.message?.content;
  debugLog({
    source: 'llm',
    level: content ? 'info' : 'warn',
    category: `${label}.response`,
    message: `← ${model} (${content?.length ?? 0} chars, ${Date.now() - startedAt}ms)`,
    data: { usage: data.usage, preview: content?.slice(0, 600) },
  });
  if (!content) throw new Error('LLM returned an empty response');
  return content;
}

const PLANNER_SYSTEM_PROMPT = `You are a browser automation planner. Given a user request and page context, output a JSON plan with steps.
Each step must use one of these tools:
${TOOLS_BRIEF}
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
  pageContext?: PageContext,
  conversationContext?: string
): Promise<TaskPlan> {
  const pageSummary = pageContext
    ? `Page: ${pageContext.title}\nURL: ${pageContext.url}\nLinks: ${pageContext.links.length}\nForms: ${pageContext.formFields.length}\nText preview: ${pageContext.visibleText.slice(0, 1000)}`
    : 'No page context available';

  const historyBlock = conversationContext
    ? `\n\n会话历史(此前任务与结果,供参考延续上下文):\n${conversationContext}`
    : '';

  const messages: LLMMessage[] = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Request: ${userRequest}${historyBlock}\n\n${pageSummary}`,
    },
  ];

  const content = await chatCompletion(messages, 'planner');

  const parsed = parseJsonLoose<{
    goal?: string;
    steps?: Array<{ description: string; tool: string; args?: Record<string, unknown> }>;
    estimatedDuration?: string;
    risks?: string[];
  }>(content, 'the plan');

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
Available tools:
${TOOLS_BRIEF}
Selectors should come from the current page's interactive elements (use their selector field).
Open a different page with navigate (do not guess URLs into clicks). After any action that triggers loading, use wait (selector/text/urlIncludes) before reading the result. Before declaring done, use expect to verify the goal actually holds.
Respond ONLY with valid JSON, one of:
{ "thought": "why this action", "done": false, "action": { "tool": "toolName", "args": { } } }
{ "thought": "why finished", "done": true, "summary": "what was accomplished" }
You have FULL power to modify the page yourself — do NOT tell the user to open the console or do it manually. For theming / colors / dark mode, STRONGLY prefer a single injectCSS call with grouped CSS rules that target many elements at once (one rule can cover buttons, links, inputs, etc.) instead of many per-element setStyle calls — it is far more efficient and uses fewer steps. Keep each injectCSS payload focused and not excessively long; if a theme needs a lot of CSS, split it across a few injectCSS calls rather than one giant string (huge JSON values can get truncated). Use setStyle/setText/setHTML/setAttribute/removeElement only for targeted one-off DOM changes; use getHTML to inspect structure; and use evaluate to run arbitrary JavaScript as a last resort. Prefer the most specific tool and actually perform the task. To access the internet use webSearch (find pages/info), imageSearch (returns DIRECT image URLs for pictures), or httpRequest (call any HTTP API) — these run through the browser and have network access. To put a picture on the page, FIRST call imageSearch to get a real working image URL, THEN injectCSS with background-image:url(...) — never invent image URLs. ALL network access MUST go through these browser tools — there is NO server-side fetch.
Set done=true when the goal is achieved, or when it cannot proceed. Avoid repeating a failed action; try an alternative.`;

export async function decideNextAction(
  goal: string,
  pageContext: PageContext,
  history: AgentHistoryItem[],
  planHint?: TaskPlan,
  conversationContext?: string
): Promise<AgentDecision> {
  const shown = history.slice(-HISTORY_WINDOW);
  const omitted = history.length - shown.length;
  const historyText = history.length
    ? (omitted > 0 ? `(… ${omitted} earlier actions omitted)\n` : '') +
      shown
        .map((h, i) => {
          const status = h.success ? 'ok' : `FAILED: ${h.error ?? 'unknown'}`;
          const res = h.result ? ` → ${h.result}` : '';
          return `${omitted + i + 1}. ${h.tool}(${JSON.stringify(h.args)}) [${status}]${res}`;
        })
        .join('\n')
    : '(no actions yet)';

  const hint = planHint?.steps?.length
    ? `\n\nInitial plan (hint only, adapt as needed):\n${planHint.steps
        .map((s, i) => `${i + 1}. ${s.description} [${s.tool}]`)
        .join('\n')}`
    : '';

  const ctxBlock = conversationContext
    ? `\n\n会话历史(此前任务与结果):\n${conversationContext}`
    : '';

  const messages: LLMMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `GOAL: ${goal}${hint}${ctxBlock}\n\nCURRENT PAGE:\n${summarizePageContext(pageContext)}\n\nINTERACTIVE ELEMENTS (selector → text):\n${pageContext.interactiveElements
        .slice(0, 40)
        .map((el) => `${el.selector} → ${el.tag}${el.type ? `[${el.type}]` : ''} ${el.text ?? el.placeholder ?? el.name ?? ''}`)
        .join('\n')}\n\nHISTORY:\n${historyText}`,
    },
  ];

  const content = await chatCompletion(messages, 'agent');
  const parsed = parseJsonLoose<AgentDecision>(content, 'the next action');

  return {
    thought: parsed.thought ?? '',
    done: Boolean(parsed.done),
    summary: parsed.summary,
    action: parsed.action,
  };
}
