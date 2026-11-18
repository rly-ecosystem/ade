import type { Provider } from './index.js';
import type { TokenUsage } from './handoff.js';

export interface UsageSource { id: string; name: string; provider: Provider }
export interface QuotaWindow { label: string; used: number; resetAt: string | null }
export interface PlanQuota {
  asOf: string;
  plan: string | null;
  windows: QuotaWindow[];
  credits: string | null;
  extraSpend: string | null;
  resetCredits: number | null;
  note: string | null;
}
export interface DeviceRow extends TokenUsage { sessions: number }
export interface DeviceUsage {
  asOf: string;
  totals: DeviceRow;
  days: (DeviceRow & { date: string })[];
  profiles: (DeviceRow & { profileId: string; provider: Provider })[];
  models: (DeviceRow & { model: string; provider: Provider })[];
  partial: boolean;
}
