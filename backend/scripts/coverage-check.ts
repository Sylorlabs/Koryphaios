/**
 * Coverage threshold enforcer for Bun's built-in coverage reporter.
 *
 * Runs `bun test --coverage --coverage-reporter=text`, parses the "All files"
 * summary line, and exits non-zero when coverage falls below the configured
 * thresholds. Designed to be used as a CI gate via `bun run test:coverage`.
 *
 * Thresholds start just below the current baseline and should be ratcheted
 * upward as test coverage improves. Do NOT lower them without explicit approval.
 */

const LINE_COVERAGE_THRESHOLD = 55;
const FUNCTION_COVERAGE_THRESHOLD = 58;

const envLines = process.env.COVERAGE_LINES_THRESHOLD;
const envFunctions = process.env.COVERAGE_FUNCTIONS_THRESHOLD;
const lineThreshold = envLines ? Number(envLines) : LINE_COVERAGE_THRESHOLD;
const functionThreshold = envFunctions ? Number(envFunctions) : FUNCTION_COVERAGE_THRESHOLD;

const testEnv = {
  ...process.env,
  SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa',
  NODE_ENV: 'test',
};

const proc = Bun.spawn(['bun', 'test', '--coverage', '--coverage-reporter=text'], {
  cwd: import.meta.dir.replace('/scripts', ''),
  stdout: 'pipe',
  stderr: 'pipe',
  env: testEnv,
});

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

// Bun writes the coverage table to stdout. Find the "All files" summary row.
// Format: "All files  |  59.26 |  63.76 |"
const allFilesMatch = stdout.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);

if (!allFilesMatch) {
  console.error('coverage-check: could not parse "All files" coverage summary from output.');
  console.error('--- stdout (last 2000 chars) ---');
  console.error(stdout.slice(-2000));
  console.error('--- stderr (last 2000 chars) ---');
  console.error(stderr.slice(-2000));
  process.exit(2);
}

const lineCoverage = parseFloat(allFilesMatch[1]);
const functionCoverage = parseFloat(allFilesMatch[2]);

let failed = false;
const failures: string[] = [];

if (lineCoverage < lineThreshold) {
  failed = true;
  failures.push(`line coverage ${lineCoverage}% < threshold ${lineThreshold}%`);
}
if (functionCoverage < functionThreshold) {
  failed = true;
  failures.push(`function coverage ${functionCoverage}% < threshold ${functionThreshold}%`);
}

console.log(`Coverage: lines=${lineCoverage}% (threshold ${lineThreshold}%), functions=${functionCoverage}% (threshold ${functionThreshold}%)`);

if (failed) {
  console.error('coverage-check FAILED: ' + failures.join('; '));
  process.exit(1);
}

console.log('coverage-check PASSED');

// Propagate the underlying test exit code so real test failures are not masked.
if (exitCode !== 0) {
  console.error(`coverage-check: underlying test suite exited with code ${exitCode}`);
  process.exit(exitCode);
}
