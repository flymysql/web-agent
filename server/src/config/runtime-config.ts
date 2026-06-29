import { JsonRepository } from '../persistence/json-repository.js';

/** User-overridable runtime config (set from the extension options page).
 * Values here take precedence over environment variables. */
export interface RuntimeConfig {
  id: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  maxSteps?: number;
}

const repo = new JsonRepository<RuntimeConfig>('config');
const ID = 'runtime';

export function getRuntimeConfig(): RuntimeConfig {
  return repo.get(ID) ?? { id: ID };
}

export function setRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
  const current = getRuntimeConfig();
  const next: RuntimeConfig = { ...current, ...patch, id: ID };
  // Empty strings clear an override (fall back to env).
  for (const k of ['llmBaseUrl', 'llmModel', 'llmApiKey'] as const) {
    if (next[k] === '') delete next[k];
  }
  repo.upsert(next);
  return next;
}

/** Config safe to send to the client (never leak the raw API key). */
export function redactedConfig(): Omit<RuntimeConfig, 'llmApiKey'> & { hasApiKey: boolean } {
  const c = getRuntimeConfig();
  const { llmApiKey, ...rest } = c;
  return { ...rest, hasApiKey: Boolean(llmApiKey) };
}
