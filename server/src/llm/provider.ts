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

const HISTORY_WINDOW = 14;

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
  /** When the agent cannot proceed without input from the user. */
  needsInput?: boolean;
  /** The question to ask when needsInput is true. */
  question?: string;
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

async function chatCompletion(
  messages: LLMMessage[],
  label = 'llm',
  opts: { jsonMode?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const { baseUrl, apiKey, model, extraHeaders, extraBody, maxTokens, timeoutMs } = llmConfig();
  const jsonMode = opts.jsonMode !== false;
  const effMaxTokens = opts.maxTokens ?? maxTokens;
  const maxRetries = parseInt(process.env.LLM_MAX_RETRIES ?? '3', 10);

  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  debugLog({
    source: 'llm',
    level: 'info',
    category: `${label}.request`,
    message: `→ ${model} (${messages.length} msgs, ${promptChars} chars)`,
    data: { baseUrl, model, maxTokens, system: messages[0]?.content?.slice(0, 300) },
  });

  let res: Response | undefined;
  let attempt = 0;
  const startedAt = Date.now();

  // Retry transient throttling/availability errors (429, 502/503/504) with
  // exponential backoff; honour a Retry-After header when the server sends one.
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
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
          max_tokens: effMaxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
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
        data: { durationMs: Date.now() - startedAt, model, attempt },
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

    if (response.ok) {
      res = response;
      break;
    }

    const status = response.status;
    const retryable = status === 429 || status === 502 || status === 503 || status === 504;
    if (retryable && attempt < maxRetries) {
      const retryAfter = parseFloat(response.headers.get('retry-after') ?? '');
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      debugLog({
        source: 'llm',
        level: 'warn',
        category: `${label}.retry`,
        message: `LLM ${status}, retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${maxRetries})`,
        data: { baseUrl, status },
      });
      await new Promise((r) => setTimeout(r, backoffMs));
      attempt++;
      continue;
    }

    const detail = await response.text().catch(() => response.statusText);
    debugLog({
      source: 'llm',
      level: 'error',
      category: `${label}.http`,
      message: `LLM request failed (${status})`,
      data: { baseUrl, status, detail: detail.slice(0, 500), durationMs: Date.now() - startedAt, attempt },
    });
    const hint = status === 429
      ? ' 上游限流/配额(429)。请稍后重试,或在 cc-switch 切换可用的提供方/模型。'
      : '';
    throw new Error(`LLM request failed (${status}) at ${baseUrl}: ${detail.slice(0, 300)}${hint}`);
  }

  const data = (await res!.json()) as {
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

/**
 * Streaming variant: emits content deltas via onDelta as they arrive (SSE).
 * Falls back to a single delta if the endpoint does not stream (non event-stream
 * response). Returns the full concatenated text.
 */
export async function streamChatCompletion(
  messages: LLMMessage[],
  label: string,
  onDelta: (delta: string) => void,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const { baseUrl, apiKey, model, extraHeaders, extraBody, maxTokens, timeoutMs } = llmConfig();
  const effMaxTokens = opts.maxTokens ?? maxTokens;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: effMaxTokens,
        stream: true,
        ...extraBody,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`LLM request failed (${res.status}) at ${baseUrl}: ${detail.slice(0, 300)}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    // Endpoint doesn't stream: read the whole body and emit once.
    if (!res.body || !contentType.includes('event-stream')) {
      const data = (await res.json().catch(() => null)) as
        | { choices?: Array<{ message?: { content?: string } }> }
        | null;
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (content) onDelta(content);
      return content;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* ignore keep-alive / non-JSON lines */
        }
      }
    }
    debugLog({
      source: 'llm',
      level: 'info',
      category: `${label}.stream`,
      message: `← ${model} streamed (${full.length} chars, ${Date.now() - startedAt}ms)`,
    });
    return full;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A precise, human-readable note of the current local date/time so the model
 * never has to guess "today". Models otherwise hallucinate the current date,
 * which breaks any "today/yesterday/this week" date reasoning.
 */
function currentDateTimeNote(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const tz = `UTC${sign}${Math.floor(Math.abs(offsetMin) / 60)}`;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `当前日期时间：${date} ${pad(d.getHours())}:${pad(d.getMinutes())} ${weekday}（${tz}）。涉及“今天/昨天/本周/最近”等时间判断时，必须以此为准，不要自行猜测当前日期。`;
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
      content: `${currentDateTimeNote()}\n\nRequest: ${userRequest}${historyBlock}\n\n${pageSummary}`,
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

export interface IntentResult {
  kind: 'chat' | 'agent' | 'clarify';
  /** For kind === 'chat': a direct conversational answer. */
  answer?: string;
  /** For kind === 'clarify': the question to ask the user. */
  question?: string;
  /** For kind === 'agent': a concise, actionable goal for the agent. */
  goal?: string;
}

const ROUTER_SYSTEM_PROMPT = `You are the intent router for a browser assistant that lives on the user's current web page.
Classify the user's latest message into exactly one of:
- "chat": the user is chatting, greeting, or asking a QUESTION you can answer directly (what can you do, explain this page, general knowledge, summarize the visible content). No page actions are needed. Put a concise, helpful Chinese reply in "answer".
- "agent": the user wants you to DO something in the browser (navigate, click, fill a form, extract+process data, automate a flow, change the page, multi-page collection). Put a concise actionable goal in "goal".
- "clarify": it IS a task, but it is underspecified or cannot be inferred from the current page (missing target, ambiguous object, needs info you do not have). Put ONE short Chinese question in "question".
Prefer "chat" for meta/conversational questions ("你能做什么", "这页讲了啥"). Prefer "clarify" over guessing and flailing when a task lacks a concrete target on this page.
Respond ONLY with JSON: { "kind": "chat"|"agent"|"clarify", "answer"?: "...", "question"?: "...", "goal"?: "..." }`;

export async function routeIntent(
  userRequest: string,
  pageContext?: PageContext,
  conversationContext?: string
): Promise<IntentResult> {
  const pageSummary = pageContext
    ? `Page: ${pageContext.title}\nURL: ${pageContext.url}\nText preview: ${pageContext.visibleText.slice(0, 800)}`
    : 'No page context available';
  const historyBlock = conversationContext ? `\n\n对话历史:\n${conversationContext.slice(0, 1000)}` : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
    { role: 'user', content: `${currentDateTimeNote()}\n\n用户消息: ${userRequest}${historyBlock}\n\n${pageSummary}` },
  ];
  const content = await chatCompletion(messages, 'router', { maxTokens: 800 });
  const parsed = parseJsonLoose<IntentResult>(content, 'the intent');
  const kind = parsed.kind === 'chat' || parsed.kind === 'clarify' ? parsed.kind : 'agent';
  return { kind, answer: parsed.answer, question: parsed.question, goal: parsed.goal };
}

const CHAT_SYSTEM_PROMPT = `你是用户网页里的智能助手。用简洁、友好的中文回答用户的问题或闲聊。
如果问题与当前页面有关,基于提供的页面内容回答;如果用户问你能做什么,简要说明你可以:理解页面、导航、点击/填写表单、提取与汇总内容、跨页采集、按需自动化并保存为可复用的工作流。
不要编造页面上不存在的信息;不要谎称你执行了任何操作(本次只是回答,没有真正操作页面)。`;

export async function answerChat(
  userRequest: string,
  pageContext?: PageContext,
  conversationContext?: string,
  onDelta?: (delta: string) => void
): Promise<string> {
  const pageSummary = pageContext
    ? `当前页面: ${pageContext.title} (${pageContext.url})\n可见内容预览:\n${pageContext.visibleText.slice(0, 1500)}`
    : '(无页面上下文)';
  const historyBlock = conversationContext ? `\n\n对话历史:\n${conversationContext.slice(0, 1200)}` : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: `${currentDateTimeNote()}\n\n${userRequest}${historyBlock}\n\n${pageSummary}` },
  ];
  if (onDelta) {
    return streamChatCompletion(messages, 'chat', onDelta);
  }
  return chatCompletion(messages, 'chat', { jsonMode: false });
}

const SUGGEST_SYSTEM_PROMPT = `你是网页智能助手。根据用户当前所在页面的真实内容，提出 3-4 条「在这个页面上我可以帮你做的具体操作」。
要求：
- 必须贴合该页面的实际内容与功能（结合标题、URL、可见文本、可交互元素来判断这是什么页面、能做什么），不要给放之四海皆准的空话。
- label：给用户看的简短中文按钮文字（≤12 字）；prompt：点击后填入输入框的完整中文指令（清晰、可直接执行）。
- 优先具体、有价值的操作（例如「触发 build 工作流」「总结这篇文档要点」「导出这张表格」「帮我填写并提交这个表单」「翻页采集全部条目」），避免雷同与空泛。
- 只输出 JSON：{"suggestions":[{"label":"…","prompt":"…"}]}。`;

/**
 * Generate page-specific "what can I do here" suggestions from the live page
 * content. Returns [] on any failure so the caller can fall back to heuristics.
 */
export async function suggestPageActions(
  pageContext: PageContext,
  exclude: string[] = []
): Promise<Array<{ label: string; prompt: string }>> {
  const els = pageContext.interactiveElements
    .slice(0, 25)
    .map((el) => `${el.tag}${el.type ? `[${el.type}]` : ''} ${(el.text ?? el.placeholder ?? el.name ?? '').slice(0, 40)}`.trim())
    .filter((s) => s)
    .join('; ');
  const excludeNote = exclude.length
    ? `\n\n用户想「换一批」，请给出与以下已展示项不同的新建议（不要重复这些 label）：${exclude.slice(0, 20).join('、')}`
    : '';
  const summary =
    `标题: ${pageContext.title}\nURL: ${pageContext.url}\n` +
    `可见内容预览:\n${pageContext.visibleText.slice(0, 1200)}\n\n` +
    `页面上的可交互元素(部分): ${els}${excludeNote}`;
  const messages: LLMMessage[] = [
    { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
    { role: 'user', content: summary },
  ];
  const content = await chatCompletion(messages, 'router', { maxTokens: 600 });
  const parsed = parseJsonLoose<{ suggestions?: Array<{ label?: string; prompt?: string }> }>(
    content,
    'the suggestions'
  );
  return (parsed.suggestions ?? [])
    .filter(
      (s): s is { label: string; prompt: string } =>
        !!s && typeof s.label === 'string' && typeof s.prompt === 'string' && !!s.label.trim() && !!s.prompt.trim()
    )
    .map((s) => ({ label: s.label.trim().slice(0, 16), prompt: s.prompt.trim() }))
    .slice(0, 4);
}

const AGENT_SYSTEM_PROMPT = `You are a web automation agent operating one step at a time.
Given the GOAL, the CURRENT PAGE, and the HISTORY of actions already taken, decide the SINGLE next action.
Available tools:
${TOOLS_BRIEF}
Selectors should come from the current page's interactive elements (use their selector field).
SELECTOR STRATEGY: prefer the el-N ids and selectors listed under INTERACTIVE ELEMENTS. When you want an element by its visible label and don't have a clean CSS path, you MAY use text matching: text=Run workflow or button:has-text('Run workflow') (these ARE supported). Do NOT keep retrying combinator/sibling guesses like a:has-text('x') ~ button. Never repeat a selector that just failed — switch to a text selector or a different listed element.
ANTI-LOOP: if clicking a link sends you to the wrong page and you navigate back only to click it again, STOP — that link is not the path to the goal. Pick a different element on the current page, or use needsInput to ask the user.
The CURRENT PAGE section below is ALWAYS refreshed for you before every decision — you can already see the page's text, links and interactive elements. Therefore NEVER call extractPage/observe just to "read" or "get" the page; that wastes a step. Act directly (click a specific link, navigate, type, etc.) or finish with done.
The plan is only a rough hint — adapt freely to what the page actually shows. If reality differs from the plan, change course to reach the GOAL instead of following the plan literally.
Do NOT repeat an action that already failed or produced no progress; try a DIFFERENT selector, link, or tool. If you already have the information the goal needs, set done=true and put the answer in "summary".
For a multi-item goal (e.g. "summarize every article in a series", OR "for each order list the buyer name & address"): first gather the list of item URLs from the current page, then DELEGATE one item at a time, ALWAYS passing the url: delegate({"url":"/post/123/","title":"...","goal":"summarize this article"}). Each result is stored automatically and shown to you under "进度". NEVER re-delegate an item already listed there, and do NOT open/read items yourself — let sub-agents do it. When every item is collected, simply set done=true; the system AUTO-SYNTHESIZES all collected items into the final answer, so you do NOT need to write the combined summary yourself.
CRAWL VIA LINKS (very important): if the GOAL needs a field (buyer name, address, price, phone, status, detail text…) that is NOT present on the current list/index page, do NOT keep re-running evaluate/getHTML on the list hoping it appears — it won't. The data lives on each row's DETAIL page. Collect each row's detail link (from the page's links/interactive elements, or read the row's <a href>), then DELEGATE one row at a time with that url and a goal like "extract the buyer name and shipping address from this order". The sub-agent opens the detail page, extracts the fields, and the result is stored + auto-synthesized. If a row has no obvious link, click into the first row to learn the detail-URL pattern, then delegate the rest by url. Treat "evaluate returned empty/!found twice" as the signal to switch to this crawl-by-detail-page approach instead of repeating it.
Open a different page with navigate (do not guess URLs into clicks). After any action that triggers loading, use wait (selector/text/urlIncludes) before reading the result. Before declaring done, use expect to verify the goal actually holds.
GITHUB ACTIONS — to MANUALLY run a workflow: the trigger button only exists on the workflow's definition page https://github.com/<owner>/<repo>/actions/workflows/<file>.yml — NOT on a run page (/actions/runs/<id> only offers "Re-run jobs"). If you land on a /actions/runs/… page you clicked a run entry by mistake; navigate to the .yml URL or click the workflow's name in the LEFT sidebar (its link is a[href*='/actions/workflows/']) instead of a text= match (which also matches run titles). On the workflow page, "Run workflow" is a DROPDOWN: first click the dropdown toggle (button:has-text('Run workflow') or summary), then in the panel click the green submit button (button[type=submit] with text "Run workflow"). github.com blocks evaluate via CSP — never use evaluate there; use clicks / getHTML instead.
If the goal is genuinely underspecified or the needed target/info simply is not reachable from the pages you can see (so continuing would just be blind guessing), STOP and ASK the user ONE concise question instead of clicking around randomly.
BUT ask sparingly and never as a stall: BEFORE using needsInput, check the conversation history AND the current page — if the answer (or a sensible default) is already inferable, just USE it and proceed, briefly stating the assumption you made. For informational/"how do I write X" questions, prefer giving a concrete answer with the value filled in (note any assumption) over asking for an exact token. Map obvious user inputs yourself (e.g. a city name like "深圳" → the value "shenzhen" that already appears in the page/path; "上海" → "shanghai"). NEVER re-ask a question the user has already effectively answered in the thread — adopt their reply and continue; asking the same thing twice is a bug.
DATE/TIME: the user message starts with 『当前日期时间』 — that is the real current local date/time. Always use it for any "今天/昨天/本周/最近" reasoning (e.g. filling a date filter with today's date). NEVER guess or hallucinate the current date.
DATE RANGE FILTERS: when filtering by a single day (e.g. "今天的订单"), a date range needs a real span — set the START to that day 00:00:00 and the END to that day 23:59:59 (or the next day 00:00:00). NEVER set start and end to the SAME instant (e.g. both 2026-06-30 00:00:00) — a zero-width range matches nothing and returns 0 results. If a "today" filter returns 0 but the page clearly shows recent orders, suspect the range/time-of-day is wrong and fix the end bound before concluding there are no orders.
EVALUATE: keep evaluate code SHORT, self-contained, and syntactically valid, and make the LAST expression the value you want back (e.g. JSON.stringify(result)). If an evaluate throws a syntax/parse error ("Unexpected token …") or returns empty twice, do NOT resend the same code — simplify it, or read the data from the already-provided page text/interactive elements instead. Often the data you need to count/sum is already visible in CURRENT PAGE; prefer reading it over fragile DOM scraping.
Respond ONLY with valid JSON, one of:
{ "thought": "one short sentence (≤25 words)", "done": false, "action": { "tool": "toolName", "args": { } } }
{ "thought": "why finished", "done": true, "summary": "what was accomplished" }
{ "thought": "why blocked", "needsInput": true, "question": "你想…?（用中文问一个具体问题）" }
You have FULL power to modify the page yourself — do NOT tell the user to open the console or do it manually. For theming / colors / dark mode, STRONGLY prefer a single injectCSS call with grouped CSS rules that target many elements at once (one rule can cover buttons, links, inputs, etc.) instead of many per-element setStyle calls.
DARK MODE — do it the safe way: the most reliable, never-breaks-text dark theme is a root filter, e.g. injectCSS({"id":"theme","css":"html{background:#fff!important;filter:invert(0.92) hue-rotate(180deg)!important} img,video,picture,canvas,svg,[style*=\\"background-image\\"]{filter:invert(1) hue-rotate(180deg)!important}"}). NEVER write "* { background/color !important }" or set background AND color to the same family on a universal selector — that makes text the same colour as its background and the page goes blank. ALWAYS pass a stable id like "theme" to injectCSS so re-applying replaces the previous block instead of stacking.
RECOVERY — if the user says text/content disappeared, the page is blank, or your styling looks broken: do NOT layer on more CSS. FIRST call clearInjectedCSS (no args) to remove everything you injected and restore the original page, then if needed re-apply a corrected, safer version. If two attempts at a visual change don't satisfy the user, clearInjectedCSS and ask them what they want instead of guessing again.
Keep each injectCSS payload focused and not excessively long; if a theme needs a lot of CSS, split it across a few injectCSS calls rather than one giant string (huge JSON values can get truncated). Use setStyle/setText/setHTML/setAttribute/removeElement only for targeted one-off DOM changes; use getHTML to inspect structure; and use evaluate to run arbitrary JavaScript as a last resort. Prefer the most specific tool and actually perform the task. To access the internet use webSearch (find pages/info), imageSearch (returns DIRECT image URLs for pictures), or httpRequest (call any HTTP API) — these run through the browser and have network access. To put a picture on the page, FIRST call imageSearch to get a real working image URL, THEN injectCSS with background-image:url(...) — never invent image URLs. ALL network access MUST go through these browser tools — there is NO server-side fetch.
Set done=true when the goal is achieved, or when it cannot proceed. Avoid repeating a failed action; try an alternative. Keep your "thought" to ONE concise sentence — do not write long explanations.`;

export async function decideNextAction(
  goal: string,
  pageContext: PageContext,
  history: AgentHistoryItem[],
  planHint?: TaskPlan,
  conversationContext?: string,
  correction?: string,
  progress?: string
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
        .slice(0, 10)
        .map((s, i) => `${i + 1}. ${s.description} [${s.tool}]`)
        .join('\n')}`
    : '';

  const ctxBlock = conversationContext
    ? `\n\n会话历史(此前任务与结果):\n${conversationContext.slice(0, 800)}`
    : '';

  const messages: LLMMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${currentDateTimeNote()}\n\nGOAL: ${goal}${hint}${ctxBlock}${progress ? `\n\n进度（以下条目已采集完成，切勿重复处理）：\n${progress}` : ''}\n\nCURRENT PAGE:\n${summarizePageContext(pageContext)}\n\nINTERACTIVE ELEMENTS (selector → text):\n${pageContext.interactiveElements
        .slice(0, 25)
        .map((el) => `${el.selector} → ${el.tag}${el.type ? `[${el.type}]` : ''} ${(el.text ?? el.placeholder ?? el.name ?? '').slice(0, 60)}`)
        .join('\n')}\n\nHISTORY:\n${historyText}${correction ? `\n\n⚠️ 重要提醒：${correction}` : ''}`,
    },
  ];

  // A per-step decision is a short JSON (a thought + one action). Cap the output
  // hard so a rambling / thinking-mode model can't generate endlessly and blow
  // past the request timeout — this is the per-step latency budget, not the
  // global LLM_MAX_TOKENS (which stays large for chat/summaries).
  const agentMaxTokens = parseInt(process.env.LLM_AGENT_MAX_TOKENS ?? '2048', 10);
  const content = await chatCompletion(messages, 'agent', { maxTokens: agentMaxTokens });
  const parsed = parseJsonLoose<AgentDecision>(content, 'the next action');

  return {
    thought: parsed.thought ?? '',
    done: Boolean(parsed.done),
    summary: parsed.summary,
    action: parsed.action,
    needsInput: Boolean(parsed.needsInput),
    question: parsed.question,
  };
}

/**
 * Reduce step: synthesize many collected items into one cohesive deliverable.
 * Uses plain-text mode (not JSON) so the model can write a rich summary.
 */
export async function generateSummaryWithLLM(
  goal: string,
  items: { title?: string; content: string }[]
): Promise<string> {
  const body = items
    .map((it, i) => `【${i + 1}. ${it.title ?? '(无标题)'}】\n${it.content}`)
    .join('\n\n');
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        '你是一个严谨的内容分析助手。基于用户提供的多条素材，产出结构清晰、忠于原文、用中文书写的整体分析与逐条要点总结。不要编造素材以外的信息。',
    },
    {
      role: 'user',
      content: `任务目标：${goal}\n\n已采集素材（共 ${items.length} 条）：\n${body}\n\n请输出：1) 整体分析；2) 逐条要点（标题 + 一两句概括）。`,
    },
  ];
  return chatCompletion(messages, 'synthesis', { jsonMode: false });
}
