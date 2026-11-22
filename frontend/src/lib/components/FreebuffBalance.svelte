<script lang="ts">
  import type { FreebuffAccountSnapshot } from '@koryphaios/shared';
  import { freebuffBaseRate, freebuffHoursFromFreebucks } from '$lib/utils/freebuff-pricing';
  let { account }: { account?: FreebuffAccountSnapshot } = $props();
  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  let balance = $derived(account?.hours);
  // The live rate table decides whether these numbers are hours or Freebucks:
  // with no reported rate there is nothing to convert against, so the panel
  // stays with the provider's own unit instead of inventing hours.
  let baseRate = $derived(freebuffBaseRate(balance?.prices));
  let dailyRemaining = $derived(
    freebuffHoursFromFreebucks(balance?.daily.remaining, baseRate),
  );
  let dailyLimit = $derived(freebuffHoursFromFreebucks(balance?.daily.limit, baseRate));
  let available = $derived(freebuffHoursFromFreebucks(balance?.balance, baseRate));
  let wallet = $derived(freebuffHoursFromFreebucks(balance?.wallet.balance, baseRate));
  let claimable = $derived(
    freebuffHoursFromFreebucks(balance?.claimableGrantHours, baseRate),
  );
  let unit = $derived(baseRate === undefined ? 'Freebucks' : 'hours');
  let remainingPercent = $derived(
    balance && balance.daily.limit > 0
      ? Math.min(100, Math.max(0, (balance.daily.remaining / balance.daily.limit) * 100))
      : 0,
  );
</script>

<section
  aria-label="Freebuff hours"
  class="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-[11px]"
>
  <div class="flex items-center justify-between gap-3">
    <span class="font-semibold text-[var(--color-text-secondary)]">Hours</span>
    <span class="text-[11px] text-[var(--color-text-muted)]">
      {account?.status === 'fresh'
        ? 'Live account hours'
        : account?.status === 'stale'
          ? 'Last reported hours · stale'
          : 'Hours unavailable'}
    </span>
  </div>
  {#if balance}
    {#if account?.planType}
      <div class="flex items-center justify-between">
        <span class="text-[var(--color-text-secondary)]">Plan</span>
        <span class="font-medium text-[var(--color-text-primary)]">{account.planType}</span>
      </div>
    {/if}
    <div class="flex items-center justify-between">
      <span class="text-[var(--color-text-secondary)]">Available {unit}</span>
      <strong class="font-mono text-[var(--color-accent)]"
        >{format(available ?? balance.balance)}</strong
      >
    </div>
    {#if balance.daily.resetsAt}
      <div class="flex items-center justify-between">
        <span class="text-[var(--color-text-secondary)]">Daily reset</span>
        <span class="font-mono text-[var(--color-text-primary)]"
          >{new Date(balance.daily.resetsAt).toLocaleString()}</span
        >
      </div>
    {/if}
    <div class="flex items-center justify-between">
      <span class="text-[var(--color-text-secondary)]">Daily {unit} remaining</span>
      <span class="font-mono text-[var(--color-text-primary)]"
        >{format(dailyRemaining ?? balance.daily.remaining)} / {format(
          dailyLimit ?? balance.daily.limit,
        )}</span
      >
    </div>
    {#if balance.daily.limit > 0}
      <div
        role="meter"
        aria-label="Daily hours remaining"
        aria-valuemin={0}
        aria-valuemax={dailyLimit ?? balance.daily.limit}
        aria-valuenow={dailyRemaining ?? balance.daily.remaining}
        class="h-2 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
      >
        <div
          class="h-full rounded-full bg-[var(--color-accent)]"
          style:width={`${remainingPercent}%`}
        ></div>
      </div>
    {/if}
    <div class="flex items-center justify-between">
      <span class="text-[var(--color-text-secondary)]">Wallet {unit} included</span>
      <span class="font-mono text-[var(--color-text-primary)]"
        >{format(wallet ?? balance.wallet.balance)}</span
      >
    </div>
    {#if balance.claimableGrantHours !== undefined}
      <div class="flex items-center justify-between">
        <span class="text-[var(--color-text-secondary)]">Claimable earned {unit}</span>
        <span class="font-mono text-[var(--color-text-primary)]"
          >{format(claimable ?? balance.claimableGrantHours)}</span
        >
      </div>
    {/if}
    {#if balance.quotaExempt}
      <p class="text-[11px] text-[var(--color-text-muted)]">
        This account is exempt from hour quota enforcement.
      </p>
    {/if}
    {#if account?.updatedAt}
      <p class="text-[11px] text-[var(--color-text-muted)]">
        Reported {new Date(account.updatedAt).toLocaleString()}.{baseRate === undefined
          ? ' Freebuff has not reported a rate for this account yet, so these are the provider Freebucks.'
          : ' Converted with the account’s live 1× model rate.'}
      </p>
    {/if}
  {/if}
  {#if account?.note || !account}
    <p class="text-[11px] text-[var(--color-text-muted)]">
      {account?.note ?? 'Refresh billing to retrieve this CLI account’s hour balance.'}
    </p>
  {/if}
</section>
