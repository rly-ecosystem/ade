import type { Provider } from '../../contracts/src/index.js';
import type { TokenUsage } from '../../contracts/src/handoff.js';

export function tokenUsage(provider: Provider, raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const count = (key: string, optional = false) => value[key] === undefined && optional ? 0 : typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 ? value[key] as number : NaN;
  const cachedInput = count(provider === 'codex' ? 'cachedInputTokens' : 'cache_read_input_tokens', true);
  const cacheWrite = count(provider === 'codex' ? 'cacheWriteInputTokens' : 'cache_creation_input_tokens', true);
  const input = provider === 'codex' ? count('inputTokens') : count('input_tokens') + cachedInput + cacheWrite;
  const output = count(provider === 'codex' ? 'outputTokens' : 'output_tokens');
  if (![input, output, cachedInput, cacheWrite].every(Number.isSafeInteger) || cachedInput > input || cacheWrite > input) return null;
  return { input, output, cachedInput, cacheWrite };
}
