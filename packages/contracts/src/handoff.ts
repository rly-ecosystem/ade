export interface HandoffReport { summary: string; files: string[]; next: string; blockers: string[]; }
export interface TokenUsage { input: number; output: number; cachedInput: number; cacheWrite: number; }
export const ECONOMY = { promptBytes: 32 * 1024, chainPromptBytes: 128 * 1024, outputBytes: 64 * 1024, reportChars: 2000, runs: 6 } as const;

export function parseHandoff(text: string, reviewer = false): HandoffReport | null {
  const lines = text.trim().split('\n').filter(line => line.trim()), records = lines.filter(line => line.startsWith('ADE_HANDOFF '));
  if (records.length !== 1 || records[0]!.length > ECONOMY.reportChars + 12 || lines.at(reviewer ? -2 : -1) !== records[0]) return null;
  if (reviewer && !lines.at(-1)?.startsWith('ADE_REVIEW_RESULT ')) return null;
  try {
    const value = JSON.parse(records[0]!.slice(12));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'blockers,files,next,summary') return null;
    const valid = (input: unknown, max: number) => typeof input === 'string' && !!input.trim() && input.length <= max && !input.includes('\0');
    if (!valid(value.summary, 800) || !valid(value.next, 400)) return null;
    if (!Array.isArray(value.files) || value.files.length > 12 || value.files.some((file: unknown) => !valid(file, 240) || /^(\/|~|[a-zA-Z]:)|[\\\r\n]/.test(file as string) || (file as string).split('/').includes('..'))) return null;
    if (!Array.isArray(value.blockers) || value.blockers.length > 4 || value.blockers.some((item: unknown) => !valid(item, 160))) return null;
    return value as HandoffReport;
  } catch { return null; }
}

export function handoffText(text: string, reviewer = false): string {
  const report = parseHandoff(text, reviewer);
  if (!report) return text;
  return text.slice(0, text.lastIndexOf('ADE_HANDOFF ')).trimEnd() || [report.summary, report.files.join(', '), report.next, ...report.blockers].filter(Boolean).join('\n\n');
}
