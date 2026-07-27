import { Router } from 'express';
import * as usage from '../services/usage.js';
import { getClaudeCodeUsage } from '../services/claudeCodeUsage.js';
import { getProviderQuotas } from '../services/providerUsage.js';
import { getAllProviders } from '../services/providers.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, usageQuerySchema, usageMessagesSchema, usageBackfillSchema } from '../lib/validation.js';
import { backfillMeasuredUsage } from '../services/usageReconciler.js';
import { resolveUsageRange } from '../lib/usageRange.js';

const router = Router();

// GET /api/usage - Usage summary + cost report. Accepts ?period=7d|30d|90d|all
// or an explicit ?from/?to (YYYY-MM-DD, inclusive) for the report window.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(usageQuerySchema, req.query);
  const { from, to } = resolveUsageRange(query);
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const summary = usage.getUsageSummary({ from, to, providers });
  res.json(summary);
}));

// GET /api/usage/providers - Subscription-quota status for every enabled
// provider family (claude, codex, agy, grok). Providers without a queryable
// usage surface report `supported: false`. `?refresh=1` bypasses the cache.
router.get('/providers', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const providers = await getProviderQuotas({ refresh });
  res.json({ providers });
}));

// GET /api/usage/claude-code - Claude Code SUBSCRIPTION rate-limit usage,
// parsed from the CLI's `/usage` output. Kept for back-compat — the usage page
// now reads the generalized /providers endpoint. `?refresh=1` bypasses cache.
router.get('/claude-code', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const data = await getClaudeCodeUsage({ refresh });
  res.json(data);
}));

// GET /api/usage/raw - Get raw usage data
router.get('/raw', asyncHandler(async (req, res) => {
  const data = usage.getUsage();
  res.json(data);
}));

// POST /api/usage/session - Record a session
router.post('/session', asyncHandler(async (req, res) => {
  const { providerId, providerName, model } = req.body;
  const sessionNumber = await usage.recordSession(providerId, providerName, model);
  res.json({ sessionNumber });
}));

// POST /api/usage/messages - Record messages
router.post('/messages', asyncHandler(async (req, res) => {
  const { providerId, model, messageCount, tokenCount, inputTokenCount } = validateRequest(usageMessagesSchema, req.body);
  await usage.recordMessages(providerId, model, messageCount, tokenCount, inputTokenCount);
  res.json({ success: true });
}));

// POST /api/usage/backfill - Re-read the provider CLIs' on-disk transcripts and
// replace estimated day buckets with their measured token counts (input, output,
// and the prompt-cache tiers). Reads local JSONL only — no provider call, no
// tokens spent — but it rewrites recorded history and can walk a large tree, so
// it is reachable ONLY from this explicit user action (never boot, never a
// schedule).
router.post('/backfill', asyncHandler(async (req, res) => {
  const { since } = validateRequest(usageBackfillSchema, req.body ?? {});
  const summary = await backfillMeasuredUsage({ since: since ?? null });
  res.json(summary);
}));

// POST /api/usage/tokens - Record token usage
router.post('/tokens', asyncHandler(async (req, res) => {
  const { inputTokens, outputTokens } = req.body;
  await usage.recordTokens(inputTokens || 0, outputTokens || 0);
  res.json({ success: true });
}));

// DELETE /api/usage - Reset usage data
router.delete('/', asyncHandler(async (req, res) => {
  await usage.resetUsage();
  res.json({ success: true });
}));

export default router;
