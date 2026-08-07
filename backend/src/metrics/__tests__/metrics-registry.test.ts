import { describe, test, expect, beforeEach } from 'bun:test';

import { getMetricsRegistry } from '../index';

/**
 * Tests for the MetricsRegistry and its Prometheus exposition format.
 *
 * The MetricsRegistry class itself is not exported, so we exercise it
 * through the `getMetricsRegistry()` singleton. To keep tests isolated
 * from accumulated singleton state, each test registers uniquely-named
 * metrics (the `registerCounter` / `registerGauge` / `registerHistogram`
 * methods are public) and asserts that the generated output *contains*
 * the expected lines.
 */
describe('MetricsRegistry', () => {
  let registry: ReturnType<typeof getMetricsRegistry>;

  beforeEach(() => {
    registry = getMetricsRegistry();
  });

  // 1. Counter increments
  test('counter increments are reflected in Prometheus output', () => {
    registry.registerCounter('test_counter_inc', 'Test counter for increments', []);
    registry.incCounter('test_counter_inc', {}, 1);
    registry.incCounter('test_counter_inc', {}, 2);

    const output = registry.generateMetrics();

    expect(output).toContain('# HELP test_counter_inc Test counter for increments');
    expect(output).toContain('# TYPE test_counter_inc counter');
    // 1 + 2 = 3
    expect(output).toContain('test_counter_inc 3');
  });

  // 2. Histogram observations
  test('histogram observations produce correct bucket counts and sum', () => {
    const buckets = [0.1, 0.5, 1, 2, 5];
    registry.registerHistogram('test_histogram_obs', 'Test histogram', [], buckets);

    // Observe three values: 0.05, 0.3, 1.5
    registry.observeHistogram('test_histogram_obs', {}, 0.05);
    registry.observeHistogram('test_histogram_obs', {}, 0.3);
    registry.observeHistogram('test_histogram_obs', {}, 1.5);

    const output = registry.generateMetrics();

    expect(output).toContain('# HELP test_histogram_obs Test histogram');
    expect(output).toContain('# TYPE test_histogram_obs histogram');

    // Bucket counts: values <= bucket
    // le=0.1 -> 1 (0.05)
    expect(output).toContain('test_histogram_obs_bucket{le="0.1"} 1');
    // le=0.5 -> 2 (0.05, 0.3)
    expect(output).toContain('test_histogram_obs_bucket{le="0.5"} 2');
    // le=1 -> 2
    expect(output).toContain('test_histogram_obs_bucket{le="1"} 2');
    // le=2 -> 3 (0.05, 0.3, 1.5)
    expect(output).toContain('test_histogram_obs_bucket{le="2"} 3');
    // le=5 -> 3
    expect(output).toContain('test_histogram_obs_bucket{le="5"} 3');
    // +Inf -> 3
    expect(output).toContain('test_histogram_obs_bucket{le="+Inf"} 3');

    // Sum: 0.05 + 0.3 + 1.5 = 1.85
    expect(output).toContain('test_histogram_obs_sum 1.85');
    // Count
    expect(output).toContain('test_histogram_obs_count 3');
  });

  // 3. Gauge set and inc
  test('gauge set then inc reflects both operations', () => {
    registry.registerGauge('test_gauge_set_inc', 'Test gauge for set and inc', []);
    registry.setGauge('test_gauge_set_inc', {}, 10);
    registry.incGauge('test_gauge_set_inc', {}, 5);

    const output = registry.generateMetrics();

    expect(output).toContain('# HELP test_gauge_set_inc Test gauge for set and inc');
    expect(output).toContain('# TYPE test_gauge_set_inc gauge');
    // 10 + 5 = 15
    expect(output).toContain('test_gauge_set_inc 15');
  });

  // 4. Prometheus format correctness
  test('output has HELP and TYPE lines with correct metric types', () => {
    registry.registerCounter('test_fmt_counter', 'Format counter', []);
    registry.registerGauge('test_fmt_gauge', 'Format gauge', []);
    registry.registerHistogram('test_fmt_histogram', 'Format histogram', [], [0.1, 1]);

    const output = registry.generateMetrics();

    expect(output).toContain('# HELP test_fmt_counter Format counter');
    expect(output).toContain('# TYPE test_fmt_counter counter');

    expect(output).toContain('# HELP test_fmt_gauge Format gauge');
    expect(output).toContain('# TYPE test_fmt_gauge gauge');

    expect(output).toContain('# HELP test_fmt_histogram Format histogram');
    expect(output).toContain('# TYPE test_fmt_histogram histogram');
  });

  // 5. handleMetrics returns Response
  test('handleMetrics returns a Response with status 200 and correct Content-Type', async () => {
    const response = registry.handleMetrics();

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; version=0.0.4');

    // Body should be non-empty and parseable as text
    const text = await response.text();
    expect(text.length).toBeGreaterThan(0);
  });

  // 6. Empty registry still produces valid output
  test('a registry with no observations still emits HELP/TYPE for default metrics', () => {
    // The singleton always registers default metrics in its constructor.
    // Even with no observations on a freshly-constructed registry, the
    // HELP/TYPE lines must be present. We verify the default metrics here.
    const output = registry.generateMetrics();

    // process_uptime_seconds is always emitted
    expect(output).toContain('# HELP process_uptime_seconds Process uptime in seconds');
    expect(output).toContain('# TYPE process_uptime_seconds gauge');

    // Default counters
    expect(output).toContain('# HELP http_requests_total Total HTTP requests');
    expect(output).toContain('# TYPE http_requests_total counter');

    expect(output).toContain('# HELP auth_attempts_total Authentication attempts');
    expect(output).toContain('# TYPE auth_attempts_total counter');

    // Default histogram
    expect(output).toContain('# HELP http_request_duration_seconds HTTP request duration');
    expect(output).toContain('# TYPE http_request_duration_seconds histogram');

    // Default gauge
    expect(output).toContain('# HELP credentials_stored Total credentials stored');
    expect(output).toContain('# TYPE credentials_stored gauge');
  });

  // 7. Labels are correctly formatted
  test('counter labels are formatted as key="value" in Prometheus output', () => {
    // Use a unique route so this label set is distinct from any other test.
    registry.incCounter('http_requests_total', {
      method: 'GET',
      route: '/test-labels-format-check',
      status: '200',
    });

    const output = registry.generateMetrics();

    // Labels should appear in key="value" format, comma-separated.
    expect(output).toContain(
      'http_requests_total{method="GET",route="/test-labels-format-check",status="200"}',
    );
  });
});
