const key = 'ade:pending-mutation-v1';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function mutationId(storage: StoragePort, method: string, params: unknown): string {
  const fingerprint = JSON.stringify([method, params]);
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (saved?.fingerprint === fingerprint && typeof saved.id === 'string') return saved.id;
  } catch {}
  const id = crypto.randomUUID();
  storage.setItem(key, JSON.stringify({ fingerprint, id }));
  return id;
}

export function confirmMutation(storage: StoragePort): void { storage.removeItem(key); }
