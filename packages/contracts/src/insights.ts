import type { Provider } from './index.js';

export type InsightPeriod = 7 | 30;
export interface UsageCounts {
  runs: number;
  measured: number;
  input: number;
  output: number;
  cachedInput: number;
  completed: number;
}
export interface UsageInsights {
  asOf: string;
  timeZone: string;
  totals: UsageCounts;
  days: (UsageCounts & { date: string })[];
  profiles: (UsageCounts & { profileId: string; provider: Provider })[];
  tasks: { started: number; completed: number; accepted: number };
}
