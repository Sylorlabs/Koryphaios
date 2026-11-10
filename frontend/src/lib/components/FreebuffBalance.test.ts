import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import FreebuffBalance from './FreebuffBalance.svelte';

afterEach(cleanup);
it('converts provider Freebucks into hours with the live 1x rate', () => {
  render(FreebuffBalance, {
    account: {
      source: 'freebuff-account',
      status: 'fresh',
      updatedAt: 1_790_000_000_000,
      hours: {
        balance: 175,
        daily: { remaining: 150, limit: 200, resetsAt: 1_791_000_000_000 },
        wallet: { balance: 25 },
        claimableGrantHours: 10,
        // The cheapest live model is the 1x rate: 5 Freebucks per session hour.
        prices: { 'm-free': 5, 'm-premium': 50 },
      },
    },
  });
  expect(screen.getByText('Live account hours')).toBeTruthy();
  expect(screen.getByText('Available hours')).toBeTruthy();
  expect(screen.getByText('Daily hours remaining')).toBeTruthy();
  expect(screen.getByText('35')).toBeTruthy();
  expect(screen.getByText('30 / 40')).toBeTruthy();
  expect(screen.getByText('5')).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('30');
  expect(screen.getByText(/live 1× model rate/)).toBeTruthy();
  expect(screen.getByText('Daily reset')).toBeTruthy();
});
it('shows stale values explicitly and preserves a real zero balance', () => {
  render(FreebuffBalance, {
    account: {
      source: 'freebuff-account',
      status: 'stale',
      note: 'Refresh failed',
      hours: {
        balance: 0,
        daily: { remaining: 0, limit: 150, resetsAt: null },
        wallet: { balance: 0 },
        prices: { 'm-free': 5 },
      },
    },
  });
  expect(screen.getByText('Last reported hours · stale')).toBeTruthy();
  expect(screen.getByText('Refresh failed')).toBeTruthy();
  expect(screen.getByText('0 / 30')).toBeTruthy();
});
it('keeps the provider Freebucks when no live rate is reported', () => {
  render(FreebuffBalance, {
    account: {
      source: 'freebuff-account',
      status: 'fresh',
      hours: {
        balance: 60,
        daily: { remaining: 0, limit: 150, resetsAt: null },
        wallet: { balance: 60 },
      },
    },
  });
  expect(screen.getByText('Available Freebucks')).toBeTruthy();
  expect(screen.getByText('Daily Freebucks remaining')).toBeTruthy();
  expect(screen.getByText('0 / 150')).toBeTruthy();
  expect(screen.queryByText(/Available hours/)).toBeNull();
});
it('does not display an invented zero when the account probe fails', () => {
  render(FreebuffBalance, {
    account: { source: 'freebuff-account', status: 'unavailable', note: 'CLI login required' },
  });
  expect(screen.getByText('Hours unavailable')).toBeTruthy();
  expect(screen.getByText('CLI login required')).toBeTruthy();
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.queryByText('0')).toBeNull();
});
