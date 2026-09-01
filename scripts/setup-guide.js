#!/usr/bin/env node
/**
 * PortOS first-run/update walkthrough.
 *
 * Reads the same Tailscale and certificate facts as the runtime API and formats
 * the ordered guide from server/lib/networkExposure.js. It never prompts and
 * never changes state: setup-cert.js owns the safe automatic provisioning
 * attempt, while this script explains the remaining human-only actions.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certPaths } from '../lib/certPaths.js';
import {
  getTailscaleCertHostname,
  readCertMeta,
} from '../lib/certMeta.js';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { buildNetworkSetupGuide } from '../server/lib/networkExposure.js';
import { getTailscaleStatus } from '../server/lib/tailscale.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const { dir: CERT_DIR, meta: META_PATH } = certPaths(DATA_DIR);
const API_PORT = Number(process.env.PORT) || 5555;
const MIRROR_PORT = Number(process.env.PORTOS_HTTP_PORT) || 5553;

const MARK = {
  complete: '✓',
  action: '→',
  blocked: '·',
  unknown: '?',
};

export function formatSetupGuide(guide, { localUrl, setupUrl } = {}) {
  const lines = [
    '===================================',
    '  PortOS Setup Walkthrough',
    '===================================',
    '',
  ];

  for (const step of guide.steps || []) {
    lines.push(`[${MARK[step.status] || '·'}] ${step.title}`);
    lines.push(`    ${step.detail}`);
    if (step.action?.type === 'external' && step.action.url) {
      lines.push(`    ${step.action.label}: ${step.action.url}`);
    } else if (step.action?.type === 'command' && step.action.command) {
      lines.push(`    Run: ${step.action.command}`);
    } else if (step.action?.type === 'provision-cert') {
      lines.push(`    1. Enable HTTPS Certificates: ${step.action.adminUrl}`);
      lines.push('    2. Re-run: npm run setup:cert');
    } else if (step.action?.type === 'restart') {
      lines.push('    Start/restart: npm start (first run) or npm run pm2:restart');
    }
  }

  lines.push('', 'AI provider setup (enable at least one runnable option):');
  lines.push('  • Subscription CLI: use a CLI you already installed and authenticated (Claude Code, Codex, or Antigravity).');
  lines.push('  • API provider: add the key for the paid provider you intend to use.');
  lines.push('  • Local/private: install Ollama or LM Studio plus a model under Models → LLMs.');
  lines.push('  PortOS marks missing CLIs, keys, runtimes, and models in the Setup page; it never enables a paid provider automatically.');
  if (setupUrl) lines.push(`  Open setup: ${setupUrl}`);
  if (guide.trustedUrl) lines.push('', `Trusted PortOS URL: ${guide.trustedUrl}`);
  else if (localUrl) lines.push('', `Local PortOS URL: ${localUrl}`);

  return lines.join('\n');
}

export function formatSetupSummary(guide) {
  if (guide.complete) return `Trusted Tailscale HTTPS ready at ${guide.trustedUrl}`;
  const next = guide.nextStep;
  return next ? `${next.title} — ${next.detail}` : 'Tailscale HTTPS setup needs attention';
}

async function detectActiveHttps() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const response = await fetch(`http://localhost:${MIRROR_PORT}/api/system/health`, {
    signal: controller.signal,
  }).catch(() => null);
  clearTimeout(timer);
  if (!response?.ok) return false;
  const health = await response.json().catch(() => null);
  return health?.scheme === 'https';
}

export async function getCliSetupGuide({ assumeActive = null } = {}) {
  const meta = readCertMeta(META_PATH);
  const certProvisioned = hasTailscaleCert(CERT_DIR);
  const provisionedMode = certProvisioned ? (meta?.mode || 'unknown') : null;
  const provisionedHost = getTailscaleCertHostname(meta);
  // Setup and the pre-restart update phase must not claim a newly written cert
  // is already live. Wrappers pass `--assume-active` only after a successful
  // PortOS restart; a direct invocation confirms the live scheme through the
  // always-public loopback health route before dropping the restart action.
  const httpsActive = certProvisioned && (assumeActive === null
    ? await detectActiveHttps()
    : assumeActive);
  const network = {
    httpsEnabled: httpsActive,
    bind: { port: API_PORT },
    cert: {
      mode: certProvisioned ? provisionedMode : null,
      tailscaleHost: provisionedHost,
      provisioned: certProvisioned,
      provisionedMode,
      provisionedHost,
    },
  };
  const tailscale = await getTailscaleStatus();
  const guide = buildNetworkSetupGuide(network, tailscale);
  const localUrl = certProvisioned
    ? `http://localhost:${MIRROR_PORT}`
    : `http://localhost:${API_PORT}`;
  const browserBase = guide.trustedUrl || localUrl;
  return {
    ...guide,
    localUrl,
    setupUrl: `${browserBase}/capabilities`,
  };
}

async function main() {
  // The Unix wrapper may still auto-install the writable macOS Tailscale CLI
  // after `npm run setup`; defer its one walkthrough until that attempt has
  // finished so users see one current answer rather than an immediately stale
  // checklist followed by a second copy.
  if (process.env.PORTOS_DEFER_SETUP_GUIDE === '1') return;
  const guide = await getCliSetupGuide({
    assumeActive: process.argv.includes('--assume-active') ? true : null,
  });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(guide, null, 2));
    return;
  }
  if (process.argv.includes('--summary')) {
    console.log(formatSetupSummary(guide));
    return;
  }
  console.log(formatSetupGuide(guide, guide));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
