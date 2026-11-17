import type { Provider } from './index.js';

export type ProfileState = 'signed_out' | 'connected' | 'plan_disabled' | 'needs_sign_in';
export interface AccountProfile {
  id: string; provider: Provider; name: string; mode: 'shared_cli' | 'siwc' | 'isolated_cli';
  enabled: boolean; state: ProfileState; email: string | null; reason: string;
  pending: boolean; needsCode: boolean;
}
export interface AccountProfiles { profiles: AccountProfile[]; selected: Record<Provider, string>; welcomeProfileId?: string | null; }
export type ProfileBindings = Record<Provider, string>;
export const SHARED_PROFILES: ProfileBindings = { codex: 'shared-codex', claude: 'shared-claude' };
export function validProfileId(value: unknown): value is string { return typeof value === 'string' && /^(shared-(codex|claude)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value); }
