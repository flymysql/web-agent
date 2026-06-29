import { v4 as uuidv4 } from 'uuid';
import type { AuditEntry, RiskLevel } from '@ai-browser-agent/shared';
import { getToolDefinition, DANGEROUS_KEYWORDS } from '@ai-browser-agent/shared';

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

export function requiresConfirmation(
  tool: string,
  args: Record<string, unknown>,
  stepDescription?: string
): { required: boolean; reason?: string } {
  const def = getToolDefinition(tool);
  if (def?.requiresConfirmation) {
    return { required: true, reason: `Tool ${tool} requires confirmation` };
  }

  // Only scan intent-bearing fields, NOT payloads like code/css/html/body —
  // otherwise CSS/JS containing words like "post"/"remove" cause false positives.
  const SCAN_FIELDS = ['selector', 'url', 'text', 'value', 'title', 'message', 'name', 'attribute', 'query'];
  const argText = SCAN_FIELDS.map((k) => String((args as Record<string, unknown>)[k] ?? '')).join(' ');
  const textToCheck = [stepDescription ?? '', argText].join(' ').toLowerCase();

  for (const kw of DANGEROUS_KEYWORDS) {
    if (textToCheck.includes(kw)) {
      return { required: true, reason: `Detected dangerous keyword: ${kw}` };
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
