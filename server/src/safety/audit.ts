import { v4 as uuidv4 } from 'uuid';
import type { AuditEntry, RiskLevel } from '@ai-browser-agent/shared';
import { getToolDefinition } from '@ai-browser-agent/shared';

const auditLog: AuditEntry[] = [];

const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credit[_-]?card/i,
  /cvv/i,
  /ssn/i,
  /social[_-]?security/i,
];

export function maskSensitiveValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (SENSITIVE_PATTERNS.some((p) => p.test(key))) {
    return '***MASKED***';
  }
  return value;
}

export function maskArgs(args: Record<string, unknown>): {
  masked: Record<string, unknown>;
  maskedFields: string[];
} {
  const masked: Record<string, unknown> = {};
  const maskedFields: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    const maskedValue = maskSensitiveValue(key, value);
    masked[key] = maskedValue;
    if (maskedValue === '***MASKED***') {
      maskedFields.push(key);
    }
  }

  return { masked, maskedFields };
}

/**
 * Tools that are inherently safe (read-only observation or plain navigation).
 * These NEVER require confirmation — opening pages, reading content, scrolling,
 * waiting and searching are all low-risk by the user's own definition.
 */
const SAFE_TOOLS = new Set([
  'extractPage', 'observePage', 'readText', 'getText', 'getHTML', 'getAttribute',
  'scroll', 'wait', 'expect', 'screenshot', 'navigate', 'hover', 'inspect',
  'consoleLogs', 'network', 'webSearch', 'imageSearch', 'storage', 'cookie',
  'tab', 'pressKey', 'notify', 'delegate',
]);

/**
 * Genuinely destructive financial intents that should always pause. These are
 * scanned even inside typed content because such words rarely appear there.
 */
const CONFIRM_KEYWORDS = [
  'pay ', 'payment', 'checkout', 'place order', 'confirm order',
  'transfer', 'withdraw', 'credit card',
  '支付', '付款', '下单', '转账', '提现', '删除账户', '注销账户', '确认支付',
];

/**
 * Verbs that signal a state-CHANGING commit: persisting, publishing, or deleting
 * content (create / update / delete). Site-agnostic and multi-language. These are
 * matched only against INTENT signals (the step rationale and the target
 * selector/labels) — NOT against authored `text`/`value` content, so writing an
 * article that merely mentions “保存” or “删除” never trips the gate.
 */
const MUTATION_KEYWORDS = [
  'publish', 'unpublish', 'submit', 'save ', 'delete', 'remove', 'discard',
  'overwrite', 'upload', 'archive', 'btnpublish', 'btnsave', 'btnsubmit', 'btndelete',
  '发布', '发表', '提交', '保存', '删除', '移除', '丢弃', '覆盖', '上传', '归档', '下架', '存草稿',
];

/** State-changing HTTP methods (GET/HEAD/OPTIONS are safe reads). */
const WRITE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Signatures that show a piece of `evaluate` JS is WRITING / committing rather
 * than just reading the page (which is the common, safe use of evaluate).
 */
const MUTATING_CODE_PATTERNS = [
  /\.submit\s*\(/i,
  /\.click\s*\(/i,
  /\.value\s*=[^=]/i,
  /\.innerHTML\s*=[^=]/i,
  /\.innerText\s*=[^=]/i,
  /\.textContent\s*=[^=]/i,
  /\.checked\s*=[^=]/i,
  /\.setValue\s*\(/i,
  /dispatchEvent\s*\(/i,
  /execCommand\s*\(/i,
  /\.remove\s*\(\s*\)/i,
  /removeChild/i,
  /(local|session)Storage\.(setItem|removeItem|clear)/i,
  /\bfetch\s*\(/i,
  /XMLHttpRequest/i,
  /sendBeacon/i,
];

export function requiresConfirmation(
  tool: string,
  args: Record<string, unknown>,
  stepDescription?: string
): { required: boolean; reason?: string } {
  const def = getToolDefinition(tool);
  if (def?.requiresConfirmation) {
    return { required: true, reason: `Tool ${tool} requires confirmation` };
  }

  // Low-risk navigation / read tools proceed without asking the user.
  if (SAFE_TOOLS.has(tool)) {
    return { required: false };
  }

  // Network writes: any non-GET HTTP method can change server-side state.
  if (tool === 'httpRequest') {
    const method = String((args as Record<string, unknown>).method ?? 'GET').toUpperCase();
    if (WRITE_HTTP_METHODS.has(method)) {
      return { required: true, reason: `将发送 ${method} 请求（可能修改服务器数据），需要确认` };
    }
  }

  // The evaluate escape hatch can do ANYTHING — gate it when the script writes
  // state (submits a form, sets values, deletes nodes, POSTs, etc.). Read-only
  // evaluate (querying/returning values) stays unconfirmed so exploration flows.
  if (tool === 'evaluate') {
    const code = String((args as Record<string, unknown>).code ?? '');
    const codeLower = code.toLowerCase();
    if (
      MUTATING_CODE_PATTERNS.some((re) => re.test(code)) ||
      MUTATION_KEYWORDS.some((kw) => codeLower.includes(kw.trim().toLowerCase()))
    ) {
      return { required: true, reason: '将通过脚本修改页面或提交数据，需要确认' };
    }
  }

  // Intent scan for a commit/destructive action. Only look at the agent's stated
  // rationale and the ACTION TARGET (selector + any button label/title) — never
  // the authored `text`/`value`, so page content can't cause false positives.
  const INTENT_FIELDS = ['selector', 'title', 'message'];
  const intentText = [stepDescription ?? '', ...INTENT_FIELDS.map((k) => String((args as Record<string, unknown>)[k] ?? ''))]
    .join(' ')
    .toLowerCase();
  for (const kw of MUTATION_KEYWORDS) {
    if (intentText.includes(kw.trim().toLowerCase())) {
      return { required: true, reason: `可能新增/修改/删除内容的操作（${kw.trim()}）需要确认` };
    }
  }

  // Financial/destructive keywords: scan intent AND content (rare there anyway).
  const CONTENT_FIELDS = ['text', 'value', 'title', 'message'];
  const contentText = [stepDescription ?? '', ...CONTENT_FIELDS.map((k) => String((args as Record<string, unknown>)[k] ?? ''))]
    .join(' ')
    .toLowerCase();
  for (const kw of CONFIRM_KEYWORDS) {
    if (contentText.includes(kw)) {
      return { required: true, reason: `高风险操作（${kw.trim()}）需要确认` };
    }
  }

  if (def?.riskLevel === 'high') {
    return { required: true, reason: `High risk tool: ${tool}` };
  }

  return { required: false };
}

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const full: AuditEntry = {
    ...entry,
    id: uuidv4(),
    timestamp: Date.now(),
  };
  auditLog.push(full);
  if (auditLog.length > 10000) {
    auditLog.splice(0, auditLog.length - 10000);
  }
  return full;
}

export function getAuditLog(limit = 100): AuditEntry[] {
  return auditLog.slice(-limit).reverse();
}

export function getAuditForTask(taskId: string): AuditEntry[] {
  return auditLog.filter((e) => e.taskId === taskId);
}

export function assessToolRisk(tool: string, args: Record<string, unknown>): RiskLevel {
  const def = getToolDefinition(tool);
  const confirmation = requiresConfirmation(tool, args);
  if (confirmation.required) return 'high';
  return def?.riskLevel ?? 'low';
}
