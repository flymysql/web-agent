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
 * Genuinely destructive intents that should still pause for confirmation.
 * Deliberately tighter than DANGEROUS_KEYWORDS (which also flags benign words
 * like "post"/"send"/"submit" that routinely appear in URLs and link text).
 */
const CONFIRM_KEYWORDS = [
  'pay ', 'payment', 'checkout', 'place order', 'confirm order',
  'transfer', 'withdraw', 'credit card',
  '支付', '付款', '下单', '转账', '提现', '删除账户', '注销账户', '确认支付',
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

  // For action tools (click/type/...), only scan intent-bearing text — NOT
  // url/selector/code/css/html — so navigating to a "/post/" URL or clicking a
  // "下一页" link never trips a false positive. Only truly destructive intent
  // (payment / money transfer) still asks for confirmation.
  const SCAN_FIELDS = ['text', 'value', 'title', 'message'];
  const argText = SCAN_FIELDS.map((k) => String((args as Record<string, unknown>)[k] ?? '')).join(' ');
  const textToCheck = [stepDescription ?? '', argText].join(' ').toLowerCase();

  for (const kw of CONFIRM_KEYWORDS) {
    if (textToCheck.includes(kw)) {
      return { required: true, reason: `高风险操作（${kw}）需要确认` };
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
