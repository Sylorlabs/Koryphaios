import { describe, expect, test } from 'bun:test';
import {
  devinQuotaGroupsFrom,
  parseDevinAccountStatus,
  readDevinCredentials,
} from '../devin-account';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Shape captured live from GetUserStatus on devin 3000.14.30821 (Max plan).
const LIVE_RESPONSE = {
  userStatus: {
    pro: true,
    teamStatus: 'USER_TEAM_STATUS_APPROVED',
    email: 'user@example.com',
    teamsTier: 'TEAMS_TIER_DEVIN_MAX',
    planStatus: {
      planInfo: {
        teamsTier: 'TEAMS_TIER_DEVIN_MAX',
        planName: 'Max',
        monthlyPromptCredits: -1,
        isDevin: true,
        billingStrategy: 'BILLING_STRATEGY_QUOTA',
        hideDailyQuota: true,
        devinInfo: {
          accountDisplayName: 'exampleuser',
          apiUrl: 'https://api.devin.ai',
          requestUsageAction: {
            kind: 'KIND_TEXT_ONLY',
            label: 'Ask your account admin to raise it',
          },
        },
      },
      planStart: '2026-11-19T04:37:42Z',
      planEnd: '2026-12-19T04:37:42Z',
      availablePromptCredits: -1,
      dailyQuotaRemainingPercent: 63,
      weeklyQuotaRemainingPercent: 42,
      overageBalanceMicros: '-105537',
      dailyQuotaResetAtUnix: '1795075200',
      weeklyQuotaResetAtUnix: '1795334400',
      acuConsumed: 11,
      acuLimit: 400,
    },
  },
};

describe('parseDevinAccountStatus', () => {
  test('reads plan, tier, quota windows and reset times', () => {
    const snap = parseDevinAccountStatus(LIVE_RESPONSE, 1_700_000_000_000);
    expect(snap.status).toBe('fresh');
    expect(snap.planName).toBe('Max');
    expect(snap.tierLabel).toBe('Devin Max');
    expect(snap.planType).toBe('Devin Max');
    expect(snap.email).toBe('user@example.com');
    expect(snap.accountDisplayName).toBe('exampleuser');
    expect(snap.planEnd).toBe('2026-12-19T04:37:42Z');
    expect(snap.dailyQuota).toEqual({
      remainingPercent: 63,
      resetAtMs: 1_795_075_200_000,
      hidden: true,
    });
    expect(snap.weeklyQuota).toEqual({
      remainingPercent: 42,
      resetAtMs: 1_795_334_400_000,
      hidden: false,
    });
    expect(snap.acuConsumed).toBe(11);
    expect(snap.acuLimit).toBe(400);
    expect(snap.overageBalanceMicros).toBe(-105_537);
    expect(snap.requestUsageActionLabel).toBe('Ask your account admin to raise it');
  });

  test('rejects responses without a userStatus', () => {
    expect(() => parseDevinAccountStatus({ code: 'invalid_argument' }, 0)).toThrow();
    expect(() => parseDevinAccountStatus(null, 0)).toThrow();
    expect(() => parseDevinAccountStatus({}, 0)).toThrow();
  });

  test('tolerates missing quota fields instead of inventing limits', () => {
    const snap = parseDevinAccountStatus(
      { userStatus: { planStatus: { planInfo: { planName: 'Core' } } } },
      0,
    );
    expect(snap.planType).toBe('Core');
    expect(snap.dailyQuota).toBeUndefined();
    expect(snap.weeklyQuota).toBeUndefined();
  });
});

describe('readDevinCredentials', () => {
  test('picks api key and server url from the TOML and defaults the server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devin-creds-'));
    const file = join(dir, 'credentials.toml');
    writeFileSync(
      file,
      'windsurf_api_key = "devin-session-token$abc"\napi_server_url = "https://server.example.com"\n',
    );
    expect(readDevinCredentials(file)).toEqual({
      apiKey: 'devin-session-token$abc',
      apiServerUrl: 'https://server.example.com',
    });
    writeFileSync(file, 'windsurf_api_key = "tok"\n');
    expect(readDevinCredentials(file)?.apiServerUrl).toBe('https://server.codeium.com');
    writeFileSync(file, 'other = "x"\n');
    expect(readDevinCredentials(file)).toBeNull();
    expect(readDevinCredentials(join(dir, 'missing.toml'))).toBeNull();
  });
});

describe('devinQuotaGroupsFrom', () => {
  test('exposes reported windows with plan context in the description', () => {
    const snap = parseDevinAccountStatus(LIVE_RESPONSE, 1_700_000_000_000);
    const groups = devinQuotaGroupsFrom(snap)!;
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.name).toContain('exampleuser');
    expect(group.description).toContain('Devin Max');
    expect(group.description).toContain('ACU 11/400');
    const daily = group.buckets.find((b) => b.id === 'daily')!;
    expect(daily.remainingFraction).toBeCloseTo(0.63);
    expect(daily.resetTime).toBe(new Date(1_795_075_200_000).toISOString());
    expect(daily.name).toContain('hidden');
    const weekly = group.buckets.find((b) => b.id === 'weekly')!;
    expect(weekly.remainingFraction).toBeCloseTo(0.42);
  });

  test('returns null when the account is unavailable', () => {
    expect(devinQuotaGroupsFrom({ source: 'devin-account', status: 'unavailable' })).toBeNull();
  });
});
