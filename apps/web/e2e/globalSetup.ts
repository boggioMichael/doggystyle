/**
 * Fail fast with a useful message if the stack is not running: Playwright's
 * default failure ("connection refused" on every test) hides the real cause.
 */
export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4000';
  try {
    // 503 means "up but degraded" (e.g. a dead-lettered job) — still testable.
    // Only an unreachable server should stop the run.
    const res = await fetch(`${baseURL}/api/health`);
    if (res.status !== 200 && res.status !== 503) throw new Error(`health returned ${res.status}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `\nCannot reach Doggystyle at ${baseURL}.\n\n` +
        `Start the app first:\n  .\\start.ps1\n\n` +
        `Underlying error: ${String(err)}\n`,
    );
    throw new Error('Doggystyle is not running');
  }
}
