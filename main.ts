// The environment lifecycle wiring, coordinated via env/src/wire.ts: open a local ephemeral socket,
// transmit the bound port number to the backend service, then poll until the backend signals completion
// and exit with code zero. Preserve the exact behavior here: this wrapper is provided by the harness.
//
//   1. MAKEFUN_ENV_URL defines the target service base (http://store:8080 in container test setups).
//      Without it, communication is impossible, leading to an immediate exit with code 1.
//   2. Instantiate the local server and invoke listen(0) to allocate an available port dynamically.
//      Never use port 8080 directly as the test harness controls that endpoint.
//   3. Perform a POST request to $MAKEFUN_ENV_URL/register with JSON payload {"port": N}. The orchestrator
//      captures the remote socket origin combined with N to form the base URL for callbacks.
//      The initial registration succeeds; HTTP 409 indicates another worker beat us to it, and this process
//      continues waiting normally.
//   4. Repeatedly query GET $MAKEFUN_ENV_URL/done until the parsed response JSON equals {"done": true}.
//      The harness responds immediately with {"done": false} while tests execute, functioning as a poll.
//      Timeouts or dropped queries trigger brief exponential backoffs; execution never aborts prematurely.
//   5. Terminate the HTTP listener and exit cleanly with code 0, allowing the harness to capture outputs.
//
// main.ts imports only createApp from ./app.ts and relies solely on standard runtime APIs.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Maximum duration allocated for a single registration or poll request before timing out. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Initial pause interval for retry delays, along with the ceiling limit. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Calculate the backoff delay following failed attempts using exponential progression. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Transmit the bound listener port via POST until acknowledged. HTTP 200 and 409 are accepted
 * as successful outcomes; HTTP 400 and 405 are fatal protocol errors that terminate execution.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Query GET /done repeatedly until the returned JSON indicates completion. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Backend not yet ready or request timed out; safely ignore and retry.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Initialize the application server, bind a dynamic port, register, and await completion. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
