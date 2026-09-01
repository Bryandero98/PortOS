/**
 * Read-only security preflight for the pr-reviewer pipeline.
 *
 * This is deliberately a direct local completion path rather than a normal
 * CoS agent. A normal agent provider brings a filesystem/process harness with
 * it, even when its prompt says "read-only". This preflight reads public PR
 * metadata and diffs through `gh`, then sends the diff to a local
 * OpenAI-compatible endpoint with no tools in the request body and no checkout
 * or execution of the contributor branch.
 */

import { createHash } from 'node:crypto'
import { execGh, ensureForgeReachable } from './github.js'
import { getProviderById } from './providers.js'
import { listModels } from './localLlm.js'
import { getModelCapabilities } from './ollamaManager.js'
import { runLocalSecurityScan } from './codeReview.js'
import { getSelfLogin } from './prWatcher.js'
import { getOriginInfo } from '../lib/gitRemote.js'
import { githubApiHost, githubRepoSpec } from '../lib/workTracker.js'
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js'
import { safeJSONParse } from '../lib/fileUtils.js'
import { LOCAL_LLM_REVIEWERS } from '../lib/validation.js'

export const TOOL_FREE_LOCAL_BACKENDS = Object.freeze([...LOCAL_LLM_REVIEWERS])
export const SECURITY_SCAN_MAX_OPEN_PRS = 200
export const SECURITY_SCAN_MAX_DIFF_CHARS = 500_000
export const SECURITY_SCAN_MAX_REPORT_CHARS = 100_000
const TOOL_FREE_LOCAL_TEXT_CAPABILITIES = new Set(['chat', 'completion'])

const failure = (code, extra = {}) => ({ ok: false, passed: false, code, ...extra })
const isHeadRefOid = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)

const modelId = (model) => {
  if (typeof model === 'string') return model.trim()
  if (!model || typeof model !== 'object') return ''
  return String(model.id || model.name || '').trim()
}

const hasToolCapability = (capabilities) => (
  Array.isArray(capabilities)
  && capabilities.some((capability) => String(capability).toLowerCase() === 'tools')
)

const hasTextCapability = (capabilities) => (
  Array.isArray(capabilities)
  && capabilities.some((capability) => TOOL_FREE_LOCAL_TEXT_CAPABILITIES.has(String(capability).toLowerCase()))
)

/**
 * True only for the two canonical, direct local HTTP providers. A renamed or
 * remote provider is intentionally excluded even when its name mentions a
 * local backend: the local model catalog must belong to this PortOS instance.
 */
export function isToolFreeLocalProvider(provider) {
  const id = String(provider?.id || '').toLowerCase()
  if (!TOOL_FREE_LOCAL_BACKENDS.includes(id)) return false
  if (provider?.type !== 'api' || provider?.enabled === false) return false
  const runtime = localRuntimeForProvider(provider)
  return runtime?.kind === id
}

/**
 * Require an installed model with an explicit text capability report that does
 * not list tools. Embedding-only models cannot review a diff, and `null`/missing
 * capability metadata is unknown, not safe.
 */
export function isToolFreeLocalModel(model, provider, installedModels = []) {
  if (!isToolFreeLocalProvider(provider)) return false
  const id = modelId(model)
  if (!id || !Array.isArray(installedModels)) return false
  const installed = installedModels.find((entry) => modelId(entry) === id)
  return hasTextCapability(installed?.capabilities) && !hasToolCapability(installed.capabilities)
}

/**
 * Resolve and validate the explicit Security Scan provider/model pin. This is
 * the server-side counterpart to the UI selection policy; it is also used by
 * the preflight itself, so edited JSON cannot smuggle a CLI/TUI provider or an
 * unverified model into the scan.
 */
export async function resolveToolFreeLocalSecurityModel({ providerId, model } = {}) {
  const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : ''
  const normalizedModel = modelId(model)
  if (!normalizedProviderId || !normalizedModel) return failure('security-scan-pin-required')

  const provider = await getProviderById(normalizedProviderId).catch(() => null)
  if (!isToolFreeLocalProvider(provider)) return failure('security-scan-provider-not-tool-free')

  const runtime = localRuntimeForProvider(provider)
  const installedModels = await listModels(runtime.kind, true).catch(() => null)
  if (!Array.isArray(installedModels)) return failure('security-scan-model-catalog-unavailable')
  let verifiedModels = installedModels
  if (runtime.kind === 'ollama') {
    // `listModels` deliberately stays a cheap catalog read; Ollama's native
    // /api/tags response has no capabilities. Probe only the selected model
    // here instead of making every ordinary model-list consumer pay for an
    // /api/show round-trip per installed model.
    const selectedCapabilities = await getModelCapabilities(normalizedModel).catch(() => null)
    verifiedModels = installedModels.map((entry) => (
      modelId(entry) === normalizedModel
        ? { ...entry, capabilities: selectedCapabilities }
        : entry
    ))
  }
  if (!isToolFreeLocalModel(normalizedModel, provider, verifiedModels)) {
    return failure('security-scan-model-not-verified')
  }

  const selected = verifiedModels.find((entry) => modelId(entry) === normalizedModel)
  return {
    ok: true,
    backend: runtime.kind,
    model: normalizedModel,
    endpoint: runtime.endpoint,
    capabilities: selected.capabilities,
  }
}

export async function listExternalOpenPullRequests(app) {
  const origin = await getOriginInfo(app?.repoPath).catch(() => null)
  const repoSpec = githubRepoSpec(origin)
  if (!repoSpec) return failure('security-scan-not-a-github-repo')

  const forge = await ensureForgeReachable('pr-reviewer security scan', {
    hostname: githubApiHost(origin.host),
  })
  if (!forge.ok) return failure('security-scan-forge-unreachable')

  const defaultBranch = await execGh([
    'repo', 'view', repoSpec, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name',
  ]).catch(() => null)
  if (!defaultBranch?.trim()) return failure('security-scan-default-branch-unresolved')

  const selfLogin = await getSelfLogin(githubApiHost(origin.host))
  if (!selfLogin) return failure('security-scan-self-login-unavailable')

  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec,
    '--base', defaultBranch.trim(), '--state', 'open',
    '--limit', String(SECURITY_SCAN_MAX_OPEN_PRS),
    '--json', 'number,author,url,headRefOid,updatedAt',
  ]).catch(() => null)
  if (raw === null) return failure('security-scan-pr-list-failed')

  const parsed = safeJSONParse(raw, null)
  if (!Array.isArray(parsed)) return failure('security-scan-pr-list-unreadable')
  if (parsed.length >= SECURITY_SCAN_MAX_OPEN_PRS) return failure('security-scan-too-many-open-prs')

  const prs = parsed.map((pr) => ({
    number: pr?.number,
    authorLogin: pr?.author?.login,
    headRefOid: isHeadRefOid(pr?.headRefOid)
      ? pr.headRefOid
      : null,
    updatedAt: pr?.updatedAt || null,
    url: pr?.url || '',
  }))
  if (prs.some((pr) => !Number.isInteger(pr.number) || pr.number < 1 || typeof pr.authorLogin !== 'string' || !pr.authorLogin)) {
    return failure('security-scan-pr-list-unreadable')
  }

  return {
    ok: true,
    repoSpec,
    repoFullName: origin.fullName,
    defaultBranch: defaultBranch.trim(),
    prs: prs.filter((pr) => pr.authorLogin !== selfLogin),
  }
}

/**
 * Return a stable identity for the public PR set that was scanned. The head
 * commit is the important part: the same PR number with a new head must be
 * eligible for a fresh scan, while an unresolved report for the same heads
 * must not burn another local-model call on every scheduler tick.
 *
 * A missing head SHA is not a safe identity. Callers must retry rather than
 * treating an incomplete forge response as the same code under review.
 */
export function securityScanFingerprint(target) {
  if (!target?.ok || !Array.isArray(target.prs)) return null
  if (target.prs.some((pr) => !Number.isInteger(pr?.number) || !isHeadRefOid(pr.headRefOid))) return null
  const identity = {
    repoFullName: target.repoFullName || null,
    defaultBranch: target.defaultBranch || null,
    prs: target.prs
      .map((pr) => ({ number: pr.number, headRefOid: pr.headRefOid }))
      .sort((a, b) => a.number - b.number),
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

const reportChars = (reports) => reports.reduce((total, report) => (
  total
    + (typeof report?.findings === 'string' ? report.findings.length : 0)
    + (typeof report?.modelResponse === 'string' ? report.modelResponse.length : 0)
), 0)

const formatSecurityFindings = (findings) => findings.map((finding) => (
  `${finding.severity} — ${finding.location}: ${finding.reason}`
)).join('\n')

/**
 * Scan every currently-open PR from an external contributor. Any inability to
 * read the current PR, diff, model capabilities, or verdict fails closed.
 * The model only screens for content that could abuse the downstream reviewer
 * or its tools. Its bounded response is retained for the human-facing report,
 * never treated as an instruction, and never forwarded to the code reviewer.
 */
export async function runPrReviewerSecurityScan({ app, providerId, model, effort = null, timeoutMs = 120_000, target = null } = {}) {
  const selected = await resolveToolFreeLocalSecurityModel({ providerId, model })
  if (!selected.ok) return selected

  const resolvedTarget = target || await listExternalOpenPullRequests(app)
  if (!resolvedTarget.ok) return resolvedTarget
  const scanKey = securityScanFingerprint(resolvedTarget)
  if (!scanKey) return failure('security-scan-target-unidentifiable')

  const reviewedPrs = []
  let hasFindings = false
  for (const pr of resolvedTarget.prs) {
    const diff = await execGh(['pr', 'diff', String(pr.number), '--repo', resolvedTarget.repoSpec]).catch(() => null)
    if (diff === null) return failure('security-scan-diff-unavailable', { reviewedPrs })
    if (typeof diff !== 'string' || diff.length > SECURITY_SCAN_MAX_DIFF_CHARS) {
      return failure('security-scan-diff-too-large', { reviewedPrs })
    }
    if (!diff.trim()) return failure('security-scan-empty-diff', { reviewedPrs })

    const verdict = await runLocalSecurityScan({
      backend: selected.backend,
      model: selected.model,
      diff,
      effort,
      timeoutMs,
      baseUrl: selected.endpoint,
    })
    if (!verdict.ok) {
      if (typeof verdict.rawResponse === 'string' && verdict.rawResponse) {
        reviewedPrs.push({
          number: pr.number,
          url: pr.url,
          headRefOid: pr.headRefOid,
          updatedAt: pr.updatedAt,
          passed: false,
          safe: false,
          findings: 'The model response could not be validated as a safe model-abuse verdict.',
          securityFindings: [],
          modelResponse: verdict.rawResponse,
          modelResponseTruncated: verdict.rawResponseTruncated === true,
        })
      }
      return failure('security-scan-verdict-unavailable', { reviewedPrs, scanKey })
    }

    const report = {
      number: pr.number,
      url: pr.url,
      headRefOid: pr.headRefOid,
      updatedAt: pr.updatedAt,
      passed: verdict.safe === true,
      safe: verdict.safe === true,
      findings: verdict.safe === true ? 'No findings.' : formatSecurityFindings(verdict.findings),
      securityFindings: verdict.findings,
      modelResponse: verdict.rawResponse,
    }
    reviewedPrs.push(report)
    if (reportChars(reviewedPrs) > SECURITY_SCAN_MAX_REPORT_CHARS) {
      return failure('security-scan-report-too-large', { reviewedPrs, scanKey })
    }
    if (!report.safe) hasFindings = true
  }

  if (hasFindings) {
    return {
      ok: true,
      passed: false,
      code: 'security-scan-findings',
      backend: selected.backend,
      model: selected.model,
      repoFullName: resolvedTarget.repoFullName,
      defaultBranch: resolvedTarget.defaultBranch,
      scanKey,
      reviewedPrs,
      reports: reviewedPrs,
    }
  }

  return {
    ok: true,
    passed: true,
    code: 'security-scan-passed',
    backend: selected.backend,
    model: selected.model,
    repoFullName: resolvedTarget.repoFullName,
    defaultBranch: resolvedTarget.defaultBranch,
    scanKey,
    reviewedPrs,
    reports: reviewedPrs,
  }
}
