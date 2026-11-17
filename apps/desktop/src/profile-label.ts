import type { AccountProfiles } from '../../../packages/contracts/src/accounts.js';
import type { Provider } from '../../../packages/contracts/src/index.js';
export function profileLabel(accounts: AccountProfiles | null | undefined, id: string | null | undefined, provider: Provider): string {
  return accounts?.profiles.find(profile => profile.id === id)?.name || (!id || id.startsWith('shared-') ? 'Текущий CLI ' + (provider === 'codex' ? 'Codex' : 'Claude') : 'Профиль ' + id.slice(0, 8));
}
