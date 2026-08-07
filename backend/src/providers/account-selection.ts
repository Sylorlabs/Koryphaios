/**
 * Resolves which discovered CLI accounts are allowed to supply models and run
 * requests. An empty selection is meaningful only after the user has changed
 * a saved-account switch; before then, every discovered account is enabled.
 */
export function selectConfiguredAccounts<T extends { id: string }>(
  discovered: T[],
  fallbackOrder: string[] | undefined,
  accountSelectionConfigured: boolean | undefined,
): T[] {
  if (!accountSelectionConfigured) return discovered;

  const byId = new Map(discovered.map((account) => [account.id, account]));
  return (fallbackOrder ?? [])
    .map((id) => byId.get(id))
    .filter((account): account is T => account !== undefined);
}
