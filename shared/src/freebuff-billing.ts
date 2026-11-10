/** Secret-free, provider-reported Freebuff hours. These are never dollar balances. */
export interface FreebuffBalance {
  /** Combined available hours: daily remaining hours plus wallet hours. */
  balance: number;
  daily: { remaining: number; limit: number; resetsAt: number | null };
  wallet: { balance: number };
  /** Provider-owned model metadata returned by the account endpoint. */
  prices?: Record<string, number>;
  claimableGrantHours?: number;
  quotaExempt?: boolean;
}

export interface FreebuffAccountSnapshot {
  source: 'freebuff-account';
  status: 'fresh' | 'stale' | 'unavailable';
  updatedAt?: number;
  /** Normalized live account hours. The provider may call the source field `freebucks`. */
  hours?: FreebuffBalance;
  planType?: string;
  note?: string;
}
