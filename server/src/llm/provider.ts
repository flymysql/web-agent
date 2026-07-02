import type {
  PlanStep,
  PlannedStep,
  TaskPlan,
  PageContext,
  TaskAttachment,
  RecordedAction,
  WorkflowStep,
  WorkflowParam,
  WorkflowParamMode,
} from '@ai-browser-agent/shared';
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

/** OpenAI-compatible multimodal content parts (used only when vision is on). */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** Character length of a message's content for logging (text parts only). */
function contentChars(content: string | ContentPart[]): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
}

/**
 * Vision is an OPTIONAL, pluggable layer. It stays fully off unless LLM_VISION
 * is truthy AND the configured model can see images. When off, every code path
 * behaves exactly as the text-only pipeline did.
 */
export function isVisionEnabled(): boolean {
  const v = (process.env.LLM_VISION ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function visionDetail(): 'low' | 'high' | 'auto' {
  const d = (process.env.LLM_VISION_DETAIL ?? 'low').toLowerCase();
  return d === 'high' || d === 'auto' ? d : 'low';
}

/**
 * Build a user message body: plain text by default; when vision is enabled and
 * one or more image dataURLs are supplied (viewport screenshot and/or attached
 * images), attach them as image parts (low detail = server-side downsampling,
 * keeping cost/latency bounded).
 */
function buildUserContent(text: string, images?: Array<string | undefined>): string | ContentPart[] {
  const imgs = (images ?? []).filter((u): u is string => typeof u === 'string' && u.startsWith('data:'));
  if (imgs.length === 0 || !isVisionEnabled()) return text;
  return [
    { type: 'text', text },
    ...imgs.map<ContentPart>((url) => ({ type: 'image_url', image_url: { url, detail: visionDetail() } })),
  ];
}

/**
 * Turn user-attached files into extra model input. Text files become a labelled
 * text block; images either flow to the vision channel (when enabled) or are
 * noted by name so the model knows they exist but can't be read.
 */
function summarizeAttachments(attachments?: TaskAttachment[]): { textBlock: string; images: string[] } {
  if (!attachments || attachments.length === 0) return { textBlock: '', images: [] };
  const parts: string[] = [];
  const images: string[] = [];
  for (const a of attachments) {
    if (a.kind === 'text' && a.text) {
      parts.push(`【${a.name}】\n${a.text}`);
    } else if (a.kind === 'image') {
      if (isVisionEnabled() && a.dataUrl) images.push(a.dataUrl);
      else parts.push(`[图片: ${a.name}]（未开启视觉，无法读取图片内容）`);
    }
  }
  const textBlock = parts.length
    ? `USER FILES（用户附加的文件，作为输入的一部分）:\n${parts.join('\n\n')}`
    : '';
  return { textBlock, images };
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

  const promptChars = messages.reduce((n, m) => n + contentChars(m.content), 0);
  const systemPreview = typeof messages[0]?.content === 'string' ? messages[0].content.slice(0, 300) : undefined;
  debugLog({
    source: 'llm',
    level: 'info',
    category: `${label}.request`,
    message: `→ ${model} (${messages.length} msgs, ${promptChars} chars)`,
    data: { baseUrl, model, maxTokens, system: systemPreview },
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
  conversationContext?: string,
  attachments?: TaskAttachment[]
): Promise<TaskPlan> {
  const pageSummary = pageContext
    ? summarizePageContext(pageContext, { maxTextChars: 1000 })
    : 'No page context available';

  const historyBlock = conversationContext
    ? `\n\n会话历史(此前任务与结果,供参考延续上下文):\n${conversationContext}`
    : '';

  const { textBlock, images } = summarizeAttachments(attachments);
  const filesBlock = textBlock ? `\n\n${textBlock}` : '';

  const messages: LLMMessage[] = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserContent(
        `${currentDateTimeNote()}\n\nRequest: ${userRequest}${filesBlock}${historyBlock}\n\n${pageSummary}`,
        images
      ),
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
- "clarify": it IS a task, but the user's GOAL itself is genuinely ambiguous (you can't tell what outcome they want), NOT merely that some data isn't visible yet. Put ONE short Chinese question in "question".
Prefer "chat" for meta/conversational questions ("你能做什么", "这页讲了啥").
IMPORTANT — do NOT clarify just because the info isn't on screen yet. The page context below is only a snapshot; the agent can expand panels, add columns/fields, scroll, switch views, open detail pages, and read more. If the goal is clear but the needed data might be reachable by interacting with the page (the PAGE REGIONS list shows what blocks/controls exist), choose "agent" and let it explore — do NOT ask the user to do the clicking. Reserve "clarify" for when the target/intent is truly undecidable.
Respond ONLY with JSON: { "kind": "chat"|"agent"|"clarify", "answer"?: "...", "question"?: "...", "goal"?: "..." }`;

export async function routeIntent(
  userRequest: string,
  pageContext?: PageContext,
  conversationContext?: string,
  attachments?: TaskAttachment[]
): Promise<IntentResult> {
  const pageSummary = pageContext
    ? summarizePageContext(pageContext, { maxTextChars: 800 })
    : 'No page context available';
  const historyBlock = conversationContext ? `\n\n对话历史:\n${conversationContext.slice(0, 1000)}` : '';
  const { textBlock, images } = summarizeAttachments(attachments);
  const filesBlock = textBlock ? `\n\n${textBlock}` : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserContent(
        `${currentDateTimeNote()}\n\n用户消息: ${userRequest}${filesBlock}${historyBlock}\n\n${pageSummary}`,
        images
      ),
    },
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
  onDelta?: (delta: string) => void,
  attachments?: TaskAttachment[]
): Promise<string> {
  const pageSummary = pageContext
    ? `当前页面: ${pageContext.title} (${pageContext.url})\n可见内容预览:\n${pageContext.visibleText.slice(0, 1500)}`
    : '(无页面上下文)';
  const historyBlock = conversationContext ? `\n\n对话历史:\n${conversationContext.slice(0, 1200)}` : '';
  const { textBlock, images } = summarizeAttachments(attachments);
  const filesBlock = textBlock ? `\n\n${textBlock}` : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserContent(
        `${currentDateTimeNote()}\n\n${userRequest}${filesBlock}${historyBlock}\n\n${pageSummary}`,
        images
      ),
    },
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
- 优先具体、有价值的操作（例如「总结这篇文档要点」「导出这张表格」「帮我填写并提交这个表单」「翻页采集全部条目」），避免雷同与空泛。
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
READ THE PAGE STRUCTURE FIRST: the CURRENT PAGE section gives you a Heading outline and a "Page regions" list — each region is a semantic block ([navigation]/[search]/[form]/[dialog]/[list]/[table]/[toolbar]/…) with its label and the key controls inside it (shown as "selector → label [tag/role] (state)"). Use this to understand what each block is FOR and which control does what, then pick the right control for the GOAL. States like (collapsed)/(expanded) tell you a panel/menu can be opened; (disabled) means it can't be used yet.
MODAL FOCUS: if a region is marked "(modal, on top)" or the page flags a 置顶弹窗/对话框, operate INSIDE that dialog (or close it first) — do not act on the background behind it.
REACT TO CHANGE: the "最近变化（上一步之后）" block tells you what your LAST action actually did. If it says the page barely changed / didn't hit the target, your selector or approach was wrong — pick a DIFFERENT control or selector, do NOT repeat it. If a dialog/toast/new block appeared, act on it. Also read the "页面提示/状态 (live regions)" block — it is the page's own feedback (validation errors, "no results", "saved"); trust it over your assumptions.
ELEMENT STATE: controls show live state — (checked/unchecked), (selected/current), (expanded/collapsed), (disabled), (required), (value="…"), (haspopup=…). Don't re-toggle something already in the desired state; open (collapsed) panels/(haspopup) menus to reveal more; a (disabled) submit usually means a required field is still empty.
FILE / IMAGE UPLOAD: NEVER click an upload button/area or a file <input> — that opens the operating-system file dialog, which you CANNOT control (the task would stall waiting for the user). Instead find the file input listed under "文件上传控件" (or any input[type=file], even hidden) and call uploadFile with that selector plus a GENERATED file: pass name (e.g. note.txt / data.csv) and content (the text/CSV/JSON you generate yourself). For an image, first get a real image via imageSearch, fetch it with httpRequest, and pass it as a data: URL in content. Respect the input's accept types when choosing the file kind.
Selectors should come from the current page's regions/controls (use their selector field).
SELECTOR STRATEGY: prefer the el-N ids and the selectors listed under Page regions. When you want an element by its visible label and don't have a clean CSS path, you MAY use text matching: text=<label> or tag:has-text('<label>') (these ARE supported). Do NOT keep retrying combinator/sibling guesses like a:has-text('x') ~ button. Never repeat a selector that just failed — switch to a text selector or a different listed control.
ANTI-LOOP: if clicking a link sends you to the wrong page and you navigate back only to click it again, STOP — that link is not the path to the goal. Pick a different element on the current page, or use needsInput to ask the user.
The CURRENT PAGE section below is ALWAYS refreshed for you before every decision — you can already see the page's structure, text and controls. Therefore NEVER call extractPage/observe just to "read" or "get" the page; that wastes a step. Act directly (click a specific control, navigate, type, expand a collapsed panel, etc.) or finish with done.
READ, DON'T PRE-SCROLL: to read/analyze an article or any page whose text is already in the document (posts, docs, diffs, comments), just call readText ONCE — it returns the full text (including everything below the fold; it even sweeps a lazy/virtualized list for you). Do NOT scroll first to "load" a static article — the text is already loaded in the DOM. Reserve scroll for the specific case where new items only appear as you scroll (infinite feeds) AND readText clearly returned too little.
COLLECT & RANK A LIST: when the goal is to gather many rows from a result/list page and then sort/filter/pick top-N (e.g. by a number shown on each row), call readText ONCE to get the whole list as text (it already includes each row's label and its inline numbers), then parse and rank from that text. Do NOT loop scroll + hand-written evaluate to scrape rows one screen at a time — that is slow and error-prone. Only if readText returns clearly too few rows for an infinite feed should you scroll a bit and readText again.
EXPLORE BEFORE ASKING: if the data the GOAL needs isn't visible yet but a region/control could reveal it (an expandable panel, an "add field/column" control, a filter, a different tab/view, or a row's detail page), DO that action yourself instead of asking the user to click. Only ask the user when the GOAL itself is ambiguous — never as a substitute for exploring the page.
The plan is only a rough hint — adapt freely to what the page actually shows. If reality differs from the plan, change course to reach the GOAL instead of following the plan literally.
Do NOT repeat an action that already failed or produced no progress; try a DIFFERENT selector, link, or tool. If you already have the information the goal needs, set done=true and put the answer in "summary".
For a multi-item goal (e.g. "summarize every article in a series", OR "for each order list the buyer name & address"): first gather the list of item URLs from the current page, then DELEGATE one item at a time, ALWAYS passing the url: delegate({"url":"/post/123/","title":"...","goal":"summarize this article"}). Each result is stored automatically and shown to you under "进度". NEVER re-delegate an item already listed there, and do NOT open/read items yourself — let sub-agents do it. When every item is collected, simply set done=true; the system AUTO-SYNTHESIZES all collected items into the final answer, so you do NOT need to write the combined summary yourself.
CRAWL VIA LINKS (very important): if the GOAL needs a field (buyer name, address, price, phone, status, detail text…) that is NOT present on the current list/index page, do NOT keep re-running evaluate/getHTML on the list hoping it appears — it won't. The data lives on each row's DETAIL page. Collect each row's detail link (from the page's links/interactive elements, or read the row's <a href>), then DELEGATE one row at a time with that url and a goal like "extract the buyer name and shipping address from this order". The sub-agent opens the detail page, extracts the fields, and the result is stored + auto-synthesized. If a row has no obvious link, click into the first row to learn the detail-URL pattern, then delegate the rest by url. Treat "evaluate returned empty/!found twice" as the signal to switch to this crawl-by-detail-page approach instead of repeating it.
Open a different page with navigate (do not guess URLs into clicks). After any action that triggers loading, use wait (selector/text/urlIncludes) before reading the result. Before declaring done, use expect to verify the goal actually holds.
SWITCH VIEW VIA URL WHEN CLICKS DON'T WORK: if clicking a tab / segment / filter / nav item produces no page change twice (some sites ignore script-triggered clicks, or route on trusted events only), STOP clicking it and do NOT switch to evaluate to click it — instead switch that view through the URL: use the control's <a href> if it has one, or infer the parameter/path from the CURRENT url (e.g. a query param or segment that encodes which tab/view is active) and navigate there directly. Changing the URL is the reliable way to switch views that resist synthetic clicks.
If the goal is genuinely underspecified or the needed target/info simply is not reachable from the pages you can see (so continuing would just be blind guessing), STOP and ASK the user ONE concise question instead of clicking around randomly.
BUT ask sparingly and never as a stall: BEFORE using needsInput, check the conversation history AND the current page — if the answer (or a sensible default) is already inferable, just USE it and proceed, briefly stating the assumption you made. For informational/"how do I write X" questions, prefer giving a concrete answer with the value filled in (note any assumption) over asking for an exact token. Map obvious user inputs yourself to the corresponding value/token that already appears on the page or in the URL/path, instead of asking for the exact literal. NEVER re-ask a question the user has already effectively answered in the thread — adopt their reply and continue; asking the same thing twice is a bug.
DATE/TIME: the user message starts with 『当前日期时间』 — that is the real current local date/time. Always use it for any "今天/昨天/本周/最近" reasoning (e.g. filling a date filter with today's date). NEVER guess or hallucinate the current date.
SANITY-CHECK RESULTS: if an action's result contradicts what the page plainly shows (e.g. a filter/query returns 0 while matching rows are clearly listed, or a control seems to do nothing), suspect your inputs/parameters are wrong and fix them — don't conclude "empty/impossible" or repeat the same action. Prefer analysing data that is ALREADY on the page over navigating elsewhere to look for an equivalent view; if a view you expected doesn't exist, stop searching for it and work with what's available.
COMMIT SAFELY: actions that PERSIST changes — publish, save, submit a form, delete, or any create/update/delete — are hard to undo for the user and WILL PAUSE for the user's confirmation before running. So prepare EVERYTHING first (fill all fields / write the full content), then do the single commit ONCE; do not repeatedly poke publish/save. When the GOAL is to CREATE something NEW, use the site's own "new / create / add / ＋" affordance (or a blank create URL) — do NOT open and overwrite an EXISTING item, because editing an existing entry replaces the user's data. If you can't find a create affordance (or aren't sure which item is safe to touch), ask the user instead of reusing an existing one.
EVALUATE: keep evaluate code SHORT, self-contained, and syntactically valid, and make the LAST expression the value you want back (e.g. JSON.stringify(result)). If an evaluate throws a syntax/parse error ("Unexpected token …") or returns empty twice, do NOT resend the same code — simplify it, or read the data from the already-provided page text/interactive elements instead. Often the data you need to count/sum is already visible in CURRENT PAGE; prefer reading it over fragile DOM scraping.
Respond ONLY with valid JSON, one of:
{ "thought": "one short sentence (≤25 words)", "done": false, "action": { "tool": "toolName", "args": { } } }
{ "thought": "why finished", "done": true, "summary": "what was accomplished" }
{ "thought": "why blocked", "needsInput": true, "question": "你想…?（用中文问一个具体问题）" }
You have FULL power to modify the page yourself — do NOT tell the user to open the console or do it manually. When restyling, prefer a single injectCSS call with grouped rules (one rule can cover many elements) over many per-element setStyle calls, and ALWAYS pass a stable id so re-applying REPLACES the previous block instead of stacking.
RECOVERY — if a change you made breaks the page (content disappears, blank, looks wrong): do NOT layer on more of the same. FIRST undo it (e.g. clearInjectedCSS with no args to remove everything you injected), then re-apply a corrected version. If two attempts don't satisfy the user, undo and ask what they want instead of guessing again.
Keep each injectCSS payload focused and not excessively long; if a theme needs a lot of CSS, split it across a few injectCSS calls rather than one giant string (huge JSON values can get truncated). Use setStyle/setText/setHTML/setAttribute/removeElement only for targeted one-off DOM changes; use getHTML to inspect structure; and use evaluate to run arbitrary JavaScript as a last resort. Prefer the most specific tool and actually perform the task. To access the internet use webSearch (find pages/info), imageSearch (returns DIRECT image URLs for pictures), or httpRequest (call any HTTP API) — these run through the browser and have network access. To put a picture on the page, FIRST call imageSearch to get a real working image URL, THEN injectCSS with background-image:url(...) — never invent image URLs. ALL network access MUST go through these browser tools — there is NO server-side fetch.
Set done=true when the goal is achieved, or when it cannot proceed. Avoid repeating a failed action; try an alternative. Keep your "thought" to ONE concise sentence — do not write long explanations.`;

export interface AgentPromptInput {
  goal: string;
  pageContext: PageContext;
  history: AgentHistoryItem[];
  planHint?: TaskPlan;
  conversationContext?: string;
  correction?: string;
  progress?: string;
  screenshot?: string;
  attachments?: TaskAttachment[];
  changeSummary?: string;
}

/**
 * Builds the shared user-prompt for an agent decision (single or batched). Both
 * `decideNextAction` and `decideNextBatch` use the identical GOAL / CURRENT PAGE
 * / HISTORY / change / correction assembly — only the system prompt and output
 * contract differ.
 */
function buildAgentUserText(input: AgentPromptInput): {
  userText: string;
  images: (string | undefined)[];
} {
  const {
    goal,
    pageContext,
    history,
    planHint,
    conversationContext,
    correction,
    progress,
    screenshot,
    attachments,
    changeSummary,
  } = input;

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

  const { textBlock, images: attachImages } = summarizeAttachments(attachments);
  const filesBlock = textBlock ? `\n\n${textBlock}` : '';
  const changeBlock = changeSummary ? `\n\n最近变化（上一步之后）：\n${changeSummary}` : '';
  const userText = `${currentDateTimeNote()}\n\nGOAL: ${goal}${hint}${ctxBlock}${filesBlock}${progress ? `\n\n进度（以下条目已采集完成，切勿重复处理）：\n${progress}` : ''}${changeBlock}\n\nCURRENT PAGE:\n${summarizePageContext(pageContext, { withSelectors: true })}\n\nHISTORY:\n${historyText}${correction ? `\n\n⚠️ 重要提醒：${correction}` : ''}`;

  return { userText, images: [screenshot, ...attachImages] };
}

export async function decideNextAction(
  goal: string,
  pageContext: PageContext,
  history: AgentHistoryItem[],
  planHint?: TaskPlan,
  conversationContext?: string,
  correction?: string,
  progress?: string,
  /** Optional viewport screenshot (dataURL); only used when LLM_VISION is on. */
  screenshot?: string,
  /** Files the user attached to the task (text merged into prompt, images to vision). */
  attachments?: TaskAttachment[],
  /** What changed on the page since the previous decision (server-computed diff). */
  changeSummary?: string
): Promise<AgentDecision> {
  const { userText, images } = buildAgentUserText({
    goal,
    pageContext,
    history,
    planHint,
    conversationContext,
    correction,
    progress,
    screenshot,
    attachments,
    changeSummary,
  });
  const messages: LLMMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent(userText, images) },
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

export interface BatchDecision {
  thought: string;
  done: boolean;
  summary?: string;
  needsInput?: boolean;
  question?: string;
  /** 1..N consecutive actions the model is confident can run on THIS page. */
  steps: PlannedStep[];
}

/** Default cap on how many actions one batched decision may emit. */
export function getAgentBatchMax(): number {
  const n = parseInt(process.env.LLM_AGENT_BATCH_MAX ?? '5', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 12);
}

const BATCH_OUTPUT_ADDENDUM = `
BATCHED OUTPUT — VERY IMPORTANT: instead of one action, output the NEXT run of actions you are confident can execute CONSECUTIVELY on THIS SAME page, so they can run WITHOUT asking you again after each one. Rules:
- Emit at most {MAX} actions. Emit FEWER (even just 1) whenever you are not sure the later action's target will exist.
- STOP the batch BEFORE any action whose target only appears AFTER an earlier action changes the page in a way you cannot predict (e.g. after a navigate, after opening a result list, after a submit that loads a new view). Never guess selectors for a page you have not seen — end the batch and you will be called again with that new page.
- For EACH action give a deterministic post-condition in "expect" describing how to tell it worked, preferring (in order): a "selector" that should appear (or {"selector":"…","state":"gone"} for something that should disappear), a "text" the page should then contain, or a "urlIncludes". Use "attribute"+"equals" for a control's state. Only use {"changed":true} when nothing more specific applies.
- Use "verify" (a short natural-language check) ONLY for the rare step where no deterministic "expect" is possible; prefer "expect".
- If the goal is already achieved, return done=true with a summary and an empty steps array. If blocked, return needsInput with a question and empty steps.
Respond ONLY with valid JSON:
{ "thought": "one short sentence (≤25 words)", "done": false, "steps": [ { "tool": "toolName", "args": { }, "expect": { "selector": "…" }, "thought": "why" } ] }
{ "thought": "why finished", "done": true, "summary": "what was accomplished", "steps": [] }
{ "thought": "why blocked", "needsInput": true, "question": "你想…?（用中文问一个具体问题）", "steps": [] }`;

/**
 * Batched variant of decideNextAction: returns a run of consecutive actions,
 * each with a verification, so the orchestrator can execute them optimistically
 * and only call the LLM again when a step's expectation fails (the "stuck point").
 */
export async function decideNextBatch(
  goal: string,
  pageContext: PageContext,
  history: AgentHistoryItem[],
  planHint?: TaskPlan,
  conversationContext?: string,
  correction?: string,
  progress?: string,
  screenshot?: string,
  attachments?: TaskAttachment[],
  changeSummary?: string
): Promise<BatchDecision> {
  const { userText, images } = buildAgentUserText({
    goal,
    pageContext,
    history,
    planHint,
    conversationContext,
    correction,
    progress,
    screenshot,
    attachments,
    changeSummary,
  });
  const max = getAgentBatchMax();
  const system = `${AGENT_SYSTEM_PROMPT}\n${BATCH_OUTPUT_ADDENDUM.replace('{MAX}', String(max))}`;
  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: buildUserContent(userText, images) },
  ];

  const agentMaxTokens = parseInt(process.env.LLM_AGENT_MAX_TOKENS ?? '2048', 10);
  const content = await chatCompletion(messages, 'agent', { maxTokens: agentMaxTokens });
  const parsed = parseJsonLoose<{
    thought?: string;
    done?: boolean;
    summary?: string;
    needsInput?: boolean;
    question?: string;
    steps?: Array<{
      tool?: string;
      args?: Record<string, unknown>;
      expect?: PlannedStep['expect'];
      verify?: string;
      thought?: string;
    }>;
  }>(content, 'the next batch');

  const steps: PlannedStep[] = Array.isArray(parsed.steps)
    ? parsed.steps
        .filter((s): s is { tool: string } & typeof s => !!s && typeof s.tool === 'string' && !!s.tool.trim())
        .slice(0, max)
        .map((s) => ({
          tool: s.tool,
          args: s.args ?? {},
          expect: s.expect,
          verify: typeof s.verify === 'string' ? s.verify : undefined,
          thought: typeof s.thought === 'string' ? s.thought : undefined,
        }))
    : [];

  return {
    thought: parsed.thought ?? '',
    done: Boolean(parsed.done),
    summary: parsed.summary,
    needsInput: Boolean(parsed.needsInput),
    question: parsed.question,
    steps,
  };
}

const VERIFY_SYSTEM_PROMPT = `You verify whether a browser action achieved its intended effect. Given a CHECK to perform and the resulting page, answer strictly whether the check now holds. Be lenient about wording but strict about facts. Respond ONLY with JSON: { "ok": true|false, "reason": "short" }.`;

/**
 * Lightweight semantic verification used ONLY for the rare step whose success
 * cannot be expressed as a deterministic `expect`. One small LLM call.
 */
export async function verifyExpectation(
  check: string,
  pageContext: PageContext
): Promise<{ ok: boolean; reason?: string }> {
  const userText = `CHECK: ${check}\n\nCURRENT PAGE:\n${summarizePageContext(pageContext, {
    maxTextChars: 1500,
  })}`;
  const messages: LLMMessage[] = [
    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ];
  const content = await chatCompletion(messages, 'agent', { maxTokens: 200 });
  const parsed = parseJsonLoose<{ ok?: boolean; reason?: string }>(content, 'the verification');
  return { ok: Boolean(parsed.ok), reason: parsed.reason };
}

const REVIEW_SYSTEM_PROMPT = `你是一个严格的结果审查员。给定用户的原始任务目标和 Agent 打算作为最终结果交付的内容，判断这份结果是否真正、实质性地回答/完成了目标。

判为不合格（ok=false）的典型情况：
- 结果为空，或只是页面导航/页脚/版权/备案号/菜单等与目标无关的样板文字；
- 结果只描述了"执行了哪些操作"，却没有目标要求的实际数据/答案/结论；
- 目标要求"找出 N 个/某类信息"，但结果里没有对应的具体条目或数量明显不足；
- 结果与目标主题明显不相关。

判为合格（ok=true）：结果包含目标所要求的实质内容（哪怕不完整，但确实是相关数据/答案）。

只输出 JSON：{"ok": boolean, "reason": "一句话中文说明", "missing": "若不合格，说明还缺什么/下一步该做什么"}`;

/**
 * Self-review the assembled final result against the goal BEFORE presenting it,
 * so the agent never declares success on empty/irrelevant boilerplate, and a
 * give-up honestly says it found nothing instead of dumping page chrome.
 * Site-agnostic.
 */
export async function reviewResult(
  goal: string,
  result: string
): Promise<{ ok: boolean; reason?: string; missing?: string }> {
  const clipped = result.length > 4000 ? `${result.slice(0, 4000)}…` : result;
  const messages: LLMMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `任务目标：${goal}\n\n拟交付的结果：\n${clipped}` },
  ];
  const content = await chatCompletion(messages, 'agent', { maxTokens: 200 });
  const parsed = parseJsonLoose<{ ok?: boolean; reason?: string; missing?: string }>(
    content,
    'the result review'
  );
  return { ok: Boolean(parsed.ok), reason: parsed.reason, missing: parsed.missing };
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

export interface UnderstoodRecording {
  name: string;
  steps: WorkflowStep[];
  params: WorkflowParam[];
}

/** Turn a captured RecordedAction into a literal WorkflowStep (fallback + prompt input). */
function actionToLiteralStep(a: RecordedAction): WorkflowStep {
  const def = getToolDefinition(a.tool);
  const label = a.label ? `“${a.label}”` : (a.selector ?? '');
  let description: string;
  switch (a.tool) {
    case 'click': description = `点击 ${label}`; break;
    case 'type': description = `在 ${label} 输入文本`; break;
    case 'selectOption': description = `在 ${label} 选择选项`; break;
    case 'setChecked': description = `勾选/取消勾选 ${label}`; break;
    case 'pressKey': description = `在 ${label} 按下 ${String(a.args.key ?? '')}`; break;
    case 'navigate': description = `打开页面 ${String(a.args.url ?? '')}`; break;
    default: description = `${a.tool} ${label}`.trim();
  }
  return {
    id: '',
    description,
    tool: a.tool,
    args: a.args,
    riskLevel: def?.riskLevel ?? 'low',
    requiresConfirmation: def?.requiresConfirmation ?? false,
  };
}

const RECORDING_SYSTEM_PROMPT = `你会把用户在浏览器里的一段“录制操作”整理成一个干净、最小、可复用的工作流。
输入是按时间顺序捕获的动作列表（每个含 tool、args、目标元素的可读 label、当时的页面 url，以及可选的 note——用户录制时口述的旁白/对 agent 的指导）。
规则：
- 输出忠实还原用户意图的有序步骤，去掉冗余/无效动作，把同一输入框的多次输入合并为最终值，删除仅仅是某次点击直接导致的重复 navigate。
- 每个步骤的 "tool" 必须是以下之一：${TOOL_NAMES}。保持 args 里的 selector 原样不变。
- 为每个步骤写一句简短的中文 "description"（这一步达成了什么），不要写与具体站点绑定的套话。若该步骤带 note，用它帮助你更准确地描述意图（note 是提示，不要逐字照抄）。
- 找出用户“输入/选择”的、属于本任务可变输入的值（如搜索词、姓名、日期、数量），在 args 中用 {{占位符}} 替换它们，并在 "params" 里列出。key 用通用的 snake_case，例如 {{query}}、{{keyword}}、{{start_date}}；不要编造站点名。
- 参数取值方式 "mode"：默认 "prompt"（每次运行用 default 或询问）。若某步骤的 note 表达了“这里每次内容不同 / 让 agent 自动生成 / 随机 / 用当天日期”等动态意图，则把该值参数化并设 mode="generate"，并在 "instruction" 用中文写清如何生成；default 仍填用户这次的原始值（用于演示复现）。
- 结构性步骤与 selector 保持原样，只参数化“人工输入的值”。
只输出 JSON：{ "name": "...", "steps": [ { "description": "...", "tool": "...", "args": {...} } ], "params": [ { "key": "...", "label": "...", "mode": "prompt|generate|constant", "instruction": "...", "default": "..." } ] }`;

/**
 * The "understand" pass: given raw recorded actions, ask the LLM to produce a
 * clean, minimal, parameterized workflow. Fully site-agnostic. Falls back to a
 * literal 1:1 mapping when the LLM is unavailable or returns nothing usable.
 */
export async function generalizeRecordingWithLLM(
  actions: RecordedAction[],
  pageContext?: PageContext
): Promise<UnderstoodRecording> {
  const literal = actions.map(actionToLiteralStep).map((s) => ({ ...s, id: crypto.randomUUID() }));
  const fallbackName = `录制的工作流 · ${new Date().toLocaleString()}`;
  const fallback: UnderstoodRecording = { name: fallbackName, steps: literal, params: [] };

  if (!actions.length) return fallback;

  try {
    const compact = actions.slice(0, 80).map((a) => ({
      tool: a.tool,
      args: a.args,
      label: a.label,
      url: a.url,
      ...(a.note ? { note: a.note } : {}),
    }));
    const pageSummary = pageContext ? summarizePageContext(pageContext, { maxTextChars: 500 }) : '';
    const messages: LLMMessage[] = [
      { role: 'system', content: RECORDING_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${currentDateTimeNote()}\n\n录制的动作（共 ${actions.length} 个）：\n${JSON.stringify(
          compact,
          null,
          2
        )}${pageSummary ? `\n\n起始页面参考：\n${pageSummary}` : ''}`,
      },
    ];
    const content = await chatCompletion(messages, 'recording', { maxTokens: 2000 });
    const parsed = parseJsonLoose<{
      name?: string;
      steps?: Array<{ description?: string; tool?: string; args?: Record<string, unknown> }>;
      params?: Array<{ key?: string; label?: string; mode?: string; instruction?: string; default?: string }>;
    }>(content, 'the recording');

    const steps: WorkflowStep[] = (parsed.steps ?? [])
      .filter((s) => s.tool && getToolDefinition(s.tool))
      .map((s) => {
        const def = getToolDefinition(s.tool as string);
        return {
          id: crypto.randomUUID(),
          description: s.description ?? s.tool ?? '',
          tool: s.tool as string,
          args: s.args ?? {},
          riskLevel: def?.riskLevel ?? 'low',
          requiresConfirmation: def?.requiresConfirmation ?? false,
        };
      });

    if (!steps.length) return fallback;

    const normMode = (m?: string): WorkflowParamMode =>
      m === 'generate' || m === 'constant' ? m : 'prompt';
    const params: WorkflowParam[] = (parsed.params ?? [])
      .filter(
        (p): p is { key: string; label?: string; mode?: string; instruction?: string; default?: string } =>
          Boolean(p.key)
      )
      .map((p) => ({
        key: p.key,
        label: p.label ?? p.key,
        mode: normMode(p.mode),
        instruction: p.instruction,
        default: p.default,
      }));

    return { name: parsed.name?.trim() || fallbackName, steps, params };
  } catch (err) {
    debugLog({
      source: 'llm',
      level: 'warn',
      category: 'recording.fallback',
      message: `录制理解失败，改用原样步骤：${err instanceof Error ? err.message : String(err)}`,
    });
    return fallback;
  }
}

export interface EditableRecording {
  name: string;
  steps: WorkflowStep[];
  params: WorkflowParam[];
}

const RECORDING_EDIT_SYSTEM_PROMPT = `你是浏览器工作流编辑器。给你一个由用户录制生成的工作流（名称 + 有序步骤 + 参数），以及一条用户的自然语言修改指令。请根据指令返回修改后的【完整】工作流。
你可以做的修改：
- 修改某一步的 description 或 args（如改选择器、改输入文本、改 URL）。
- 新增 / 删除 / 重新排序步骤。每步的 "tool" 必须是以下合法工具之一：${TOOL_NAMES}。默认保持已有 selector 不变，除非用户明确要求更改。
- 把“每次运行内容不固定”的值改成动态值：把对应 arg 的值替换成 {{key}} 占位符，并在 params 里给出该参数：
  - mode="prompt"：每次运行让用户填写（可用 default 作为默认值）。
  - mode="generate"：每次运行自动生成，instruction 用中文写清“如何生成这个值”（例如“生成一个随机测试邮箱”“用今天的日期，格式 YYYY-MM-DD”）。
  - mode="constant"：固定值，写在 default。
- key 用通用 snake_case（如 {{query}}、{{upload_content}}、{{today}}），不要编造具体站点名或标签。
- params 必须覆盖 steps 里出现的所有 {{占位符}}；已不再使用的参数请删除。
只输出 JSON：{ "name": "...", "steps": [ { "description": "...", "tool": "...", "args": {...} } ], "params": [ { "key": "...", "label": "...", "mode": "prompt|generate|constant", "instruction": "...", "default": "..." } ] }`;

/** Apply a natural-language edit to a recorded/edited workflow. Returns the full updated triple. */
export async function editRecordingWithLLM(
  current: EditableRecording,
  instruction: string,
  opts: { targetStepId?: string; pageContext?: PageContext } = {}
): Promise<EditableRecording> {
  const compactSteps = current.steps.map((s, i) => ({
    index: i + 1,
    id: s.id,
    tool: s.tool,
    description: s.description,
    args: s.args,
  }));
  const compactParams = current.params.map((p) => ({
    key: p.key,
    label: p.label,
    mode: p.mode ?? 'prompt',
    instruction: p.instruction,
    default: p.default,
  }));
  const targetNote = opts.targetStepId
    ? `\n（用户可能特指 id=${opts.targetStepId} 的那一步。）`
    : '';

  const messages: LLMMessage[] = [
    { role: 'system', content: RECORDING_EDIT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${currentDateTimeNote()}\n\n工作流名称：${current.name}\n\n步骤：\n${JSON.stringify(
        compactSteps,
        null,
        2
      )}\n\n参数：\n${JSON.stringify(compactParams, null, 2)}${targetNote}\n\n用户修改指令：${instruction}`,
    },
  ];

  const content = await chatCompletion(messages, 'recording-edit', { maxTokens: 2500 });
  const parsed = parseJsonLoose<{
    name?: string;
    steps?: Array<{ description?: string; tool?: string; args?: Record<string, unknown> }>;
    params?: Array<{ key?: string; label?: string; mode?: string; instruction?: string; default?: string }>;
  }>(content, 'the edited recording');

  const steps: WorkflowStep[] = (parsed.steps ?? [])
    .filter((s) => s.tool && getToolDefinition(s.tool))
    .map((s) => {
      const def = getToolDefinition(s.tool as string);
      return {
        id: crypto.randomUUID(),
        description: s.description ?? s.tool ?? '',
        tool: s.tool as string,
        args: s.args ?? {},
        riskLevel: def?.riskLevel ?? 'low',
        requiresConfirmation: def?.requiresConfirmation ?? false,
      };
    });

  // If the model returned nothing usable, keep the current flow unchanged.
  if (!steps.length) return current;

  const normMode = (m?: string): WorkflowParamMode =>
    m === 'generate' || m === 'constant' ? m : 'prompt';
  const params: WorkflowParam[] = (parsed.params ?? [])
    .filter((p): p is { key: string; label?: string; mode?: string; instruction?: string; default?: string } =>
      Boolean(p.key)
    )
    .map((p) => ({
      key: p.key,
      label: p.label ?? p.key,
      mode: normMode(p.mode),
      instruction: p.instruction,
      default: p.default,
    }));

  return { name: parsed.name?.trim() || current.name, steps, params };
}

/**
 * Produce a single string value at run time from a natural-language instruction
 * (WorkflowParam mode='generate'). Site-agnostic. Returns '' on failure so replay
 * can still proceed (the field is simply left empty).
 */
export async function generateValueWithLLM(
  instruction: string,
  ctx: { pageContext?: PageContext; note?: string } = {}
): Promise<string> {
  const pageSummary = ctx.pageContext ? summarizePageContext(ctx.pageContext, { maxTextChars: 400 }) : '';
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        '你是一个取值生成器。根据用户给出的“生成说明”，产出一个可直接填入表单或用于操作的字符串值。只输出 JSON：{ "value": "..." }，不要解释、不要多余文字。',
    },
    {
      role: 'user',
      content: `${currentDateTimeNote()}\n\n生成说明：${instruction}${ctx.note ? `\n\n上下文：${ctx.note}` : ''}${
        pageSummary ? `\n\n当前页面参考：\n${pageSummary}` : ''
      }`,
    },
  ];
  try {
    const content = await chatCompletion(messages, 'value-gen', { maxTokens: 500 });
    const parsed = parseJsonLoose<{ value?: unknown }>(content, 'the generated value');
    return parsed.value == null ? '' : String(parsed.value);
  } catch (err) {
    debugLog({
      source: 'llm',
      level: 'warn',
      category: 'value-gen.fallback',
      message: `运行时取值生成失败：${err instanceof Error ? err.message : String(err)}`,
    });
    return '';
  }
}

const VOICE_REFINE_SYSTEM_PROMPT = `你会把用户口述（语音转写）的一段话整理成一条简洁、清晰的任务指令。
规则：
- 保留关键实体与意图（对象、条件、数量、时间等），去掉口头语、重复、停顿词、语气词和转写噪声。
- 用与用户相同的语言输出，尽量精炼成一到两句可执行的指令。
- 不要新增用户没有表达的要求，也不要与具体站点绑定地臆测。
只输出整理后的指令文本本身，不要加引号、解释或前后缀。`;

/**
 * Turn a raw speech transcript into a concise, intent-focused instruction.
 * Site-agnostic. Returns the trimmed transcript unchanged on failure.
 */
export async function refineVoiceInstructionWithLLM(transcript: string): Promise<string> {
  const raw = transcript.trim();
  if (!raw) return '';
  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: VOICE_REFINE_SYSTEM_PROMPT },
      { role: 'user', content: raw },
    ];
    const content = await chatCompletion(messages, 'voice-refine', {
      jsonMode: false,
      maxTokens: 500,
    });
    const cleaned = content.trim();
    return cleaned || raw;
  } catch (err) {
    debugLog({
      source: 'llm',
      level: 'warn',
      category: 'voice-refine.fallback',
      message: `语音指令精简失败，返回原文：${err instanceof Error ? err.message : String(err)}`,
    });
    return raw;
  }
}
