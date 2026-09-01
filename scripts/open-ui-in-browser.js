#!/usr/bin/env node
// Open the PortOS dashboard in the PortOS-managed Chrome instance.
// Used after setup.sh / update.sh / update.ps1 finish PM2 boot so the user
// lands on the dashboard without having to manually open a tab.
//
// Fail-soft: every failure path logs and exits 0 — never break setup/update
// because Chrome happens to be unreachable.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { getCliSetupGuide } from './setup-guide.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { dir: CERT_DIR } = certPaths(join(ROOT, 'data'));
const API_PORT = Number(process.env.PORT) || 5555;
const HTTP_LOOPBACK_PORT = Number(process.env.PORTOS_HTTP_PORT) || 5553;

// First-boot startup can take a while: the server binds, opens the DB pool,
// loads the brain index, attaches Socket.IO, then health responds. 90s is
// roomy for a fresh checkout on slow disks; if PortOS still isn't up, the
// user has bigger problems than the auto-open script.
const API_TIMEOUT_MS = 90_000;
// `update.sh`/`update.ps1` do a full `pm2 delete` + `pm2 start` of every
// ecosystem app, including portos-browser — so Chrome is a COLD launch here,
// racing the exact moment CPU/disk are busiest (npm install, client build).
// browser/server.js's own launch-wait is 10s; a single fixed-timeout attempt
// from here regularly lost that race and left Chrome open with no tab
// pointed anywhere. Retry navigate on a short interval instead of trying once.
const NAVIGATE_RETRY_TOTAL_MS = 60_000;
const NAVIGATE_RETRY_INTERVAL_MS = 2_000;
const NAVIGATE_ATTEMPT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 500;

async function poll(checkFn, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.warn(`⚠️  ${label} didn't respond within ${timeoutMs / 1000}s — skipping auto-open. Check \`pm2 logs portos-server\` for startup errors.`);
  return false;
}

async function ping(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const ok = await fetchImpl(url, { signal: controller.signal })
    .then(r => r.ok)
    .catch(() => false);
  clearTimeout(timeout);
  return ok;
}

/**
 * POST `navigateUrl` on a fixed interval until it succeeds or the overall
 * budget expires. A single early failure (Chrome still cold-launching, CDP
 * not listening yet) must not be treated as final — the caller only gets one
 * shot at auto-opening the dashboard per restart, so this has to outlast the
 * slowest realistic Chrome cold-start rather than the fastest.
 * @param {object} opts
 * @param {string} opts.navigateUrl - the PortOS `/api/browser/navigate` endpoint
 * @param {string} opts.targetUrl - the dashboard URL to open
 * @param {number} opts.totalTimeoutMs - overall retry budget
 * @param {number} opts.intervalMs - delay between attempts
 * @param {number} opts.attemptTimeoutMs - abort timeout for a single attempt
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ok: boolean, status?: number, body?: string, error?: string}>}
 */
export async function navigateWithRetry({
  navigateUrl,
  targetUrl,
  totalTimeoutMs,
  intervalMs,
  attemptTimeoutMs,
  fetchImpl = fetch,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
  const deadline = Date.now() + totalTimeoutMs;
  let lastFailure = { ok: false, error: 'navigate was never attempted' };
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    let networkError = null;
    const res = await fetchImpl(navigateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
      signal: controller.signal,
    }).catch(err => { networkError = err; return null; });
    clearTimeout(timer);

    if (res) {
      if (res.ok) return { ok: true, status: res.status };
      const body = await res.text().catch(() => '');
      lastFailure = { ok: false, status: res.status, body: body.slice(0, 200) };
    } else {
      lastFailure = { ok: false, error: networkError?.message || 'unknown fetch error' };
    }

    if (Date.now() + intervalMs >= deadline) return lastFailure;
    await sleep(intervalMs);
  }
}

async function main() {
  // Share the same cert predicate the server's HTTPS gate uses (file presence
  // AND PEM parseability). A presence-only check would route us to :5553 even
  // when corrupt PEMs forced the server back to plain HTTP-on-:5555, so the
  // poll would time out on a port the server never bound.
  const HTTPS_MODE = hasTailscaleCert(CERT_DIR);

  // When HTTPS is on, :5555 speaks TLS only — plain http:// requests hit a TLS
  // mismatch and time out. The loopback HTTP mirror on :5553 serves the same
  // app and skips the cert warning, so startup polling always stays local even
  // when the final browser destination is the trusted MagicDNS origin.
  const LOCAL_BASE = HTTPS_MODE
    ? `http://localhost:${HTTP_LOOPBACK_PORT}`
    : `http://localhost:${API_PORT}`;
  // Poll through loopback so certificate trust never delays startup detection,
  // but land the browser on the real MagicDNS origin when a trusted Tailscale
  // cert exists. That is the URL remote devices use and the secure context where
  // microphone/browser APIs work; opening the mirror hid this final setup step.
  // The shared walkthrough also proves that Tailscale is currently connected and
  // the cert matches its current MagicDNS name; a stale cert alone must not send
  // the managed browser to an unreachable host.
  const setupGuide = await getCliSetupGuide({ assumeActive: HTTPS_MODE });
  const TARGET_URL = setupGuide.trustedUrl || LOCAL_BASE;

  const apiHealthUrl = `${LOCAL_BASE}/api/system/health`;
  const navigateUrl = `${LOCAL_BASE}/api/browser/navigate`;

  const apiReady = await poll(() => ping(apiHealthUrl), 'PortOS API', API_TIMEOUT_MS);
  if (!apiReady) process.exit(0);

  const result = await navigateWithRetry({
    navigateUrl,
    targetUrl: TARGET_URL,
    totalTimeoutMs: NAVIGATE_RETRY_TOTAL_MS,
    intervalMs: NAVIGATE_RETRY_INTERVAL_MS,
    attemptTimeoutMs: NAVIGATE_ATTEMPT_TIMEOUT_MS,
  });

  if (!result.ok) {
    const detail = result.error || `HTTP ${result.status}: ${result.body}`;
    console.warn(`⚠️  Could not auto-open the dashboard within ${NAVIGATE_RETRY_TOTAL_MS / 1000}s (${detail}) — open it manually: ${TARGET_URL}`);
    process.exit(0);
  }

  console.log(`🌐 Opened ${TARGET_URL} in PortOS browser`);
  process.exit(0);
}

if (isDirectlyInvoked(import.meta.url)) await main();
