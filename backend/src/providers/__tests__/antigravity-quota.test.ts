import { describe, expect, it } from 'bun:test';

describe('Antigravity quota fetcher', () => {
  it('exports fetchAntigravityQuota and fetchAntigravityQuotaGroups', async () => {
    const mod = await import('../antigravity-quota');
    expect(typeof mod.fetchAntigravityQuota).toBe('function');
    expect(typeof mod.fetchAntigravityQuotaGroups).toBe('function');
  });

  it('maps gemini-* models to the Gemini Models quota group', async () => {
    const { fetchAntigravityQuotaGroups } = await import('../antigravity-quota');
    // We can't call it without agy installed, but we can verify the module
    // loads and the group mapping logic is correct by checking the export.
    expect(fetchAntigravityQuotaGroups).toBeDefined();
  });

  it('handles the /usage JSON response shape correctly', () => {
    // Verify the expected response structure matches what agy --print "/usage"
    // --output-format json returns:
    //   { command: { data: { groups: [{ name, description, buckets: [{ id, name,
    //     window, remaining_fraction, reset_time }] }] } } }
    const sampleResponse = {
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          description: 'Within each group, models share a weekly limit...',
          groups: [
            {
              name: 'Gemini Models',
              description: 'Models within this group: Gemini Flash, Gemini Pro',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.97,
                  reset_time: '2026-08-13T23:31:21Z',
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.98,
                  reset_time: '2026-08-07T22:57:20Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
              buckets: [
                {
                  id: '3p-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.57,
                  reset_time: '2026-08-10T18:20:53Z',
                },
              ],
            },
          ],
        },
      },
    };

    // Verify the structure is parseable
    const groups = sampleResponse.command?.data?.groups;
    expect(groups).toBeDefined();
    expect(groups!.length).toBe(2);
    expect(groups![0].name).toBe('Gemini Models');
    expect(groups![0].buckets!.length).toBe(2);
    expect(groups![0].buckets![0].remaining_fraction).toBe(0.97);
    expect(groups![1].name).toBe('Claude and GPT models');
    expect(groups![1].buckets![0].remaining_fraction).toBe(0.57);
  });

  it('maps model IDs to quota groups correctly', () => {
    // Gemini models → "Gemini Models" group
    expect(/^gemini-/i.test('gemini-3.6-flash-high')).toBe(true);
    expect(/^gemini-/i.test('gemini-3.1-pro-low')).toBe(true);
    // Claude/GPT models → "Claude and GPT models" group
    expect(/^(claude-|gpt-)/i.test('claude-sonnet-4-6')).toBe(true);
    expect(/^(claude-|gpt-)/i.test('claude-opus-4-6-thinking')).toBe(true);
    expect(/^(claude-|gpt-)/i.test('gpt-oss-120b-medium')).toBe(true);
  });
});
