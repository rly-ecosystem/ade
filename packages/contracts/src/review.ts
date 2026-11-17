export interface ReviewReport { verdict: 'ready' | 'changes_required' | 'blocked'; summary: string; }
export function parseReviewReport(text: string): ReviewReport | null {
  const lines = text.trim().split('\n'), records = lines.filter(line => line.startsWith('ADE_REVIEW_RESULT '));
  if (records.length !== 1 || lines.at(-1) !== records[0]) return null;
  try {
    const value: unknown = JSON.parse(records[0]!.slice('ADE_REVIEW_RESULT '.length));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'summary,verdict') return null;
    const report = value as { verdict: unknown; summary: unknown };
    if (typeof report.summary !== 'string' || !report.summary.trim() || report.summary.length > 2000) return null;
    return report.verdict === 'ready' || report.verdict === 'changes_required' || report.verdict === 'blocked' ? report as ReviewReport : null;
  } catch { return null; }
}
export function reviewText(text: string): string {
  const report = parseReviewReport(text);
  if (!report) return text;
  return text.slice(0, text.lastIndexOf('ADE_REVIEW_RESULT ')).trimEnd() || report.summary;
}
