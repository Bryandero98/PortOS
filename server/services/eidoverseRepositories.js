import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { pathExists, safeJSONParse } from '../lib/fileUtils.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parseGitHubUrl } from '../lib/githubRepoUrl.js';
import {
  DEFAULT_EIDOVERSE_WORLDS_REPO,
  EIDOVERSE_PROCESS_NAME,
  EIDOVERSE_VIDEO_REPO,
  getEidoversePaths,
} from './eidoverse.js';
import { execGitSafe, fetchOrigin, resolveForgeForRepo } from './git.js';
import { execGh } from './github.js';

const WORLDS_UPSTREAM_BRANCH = 'main';
const GH_TIMEOUT_MS = 60_000;

const repoIdentity = (url) => {
  const parsed = parseGitHubUrl(url);
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
  };
};

const WORLDS_UPSTREAM = repoIdentity(DEFAULT_EIDOVERSE_WORLDS_REPO);
const VIDEO_UPSTREAM = repoIdentity(EIDOVERSE_VIDEO_REPO);

const isEidoverseApp = (app) => Boolean(app?.pm2ProcessNames?.includes(EIDOVERSE_PROCESS_NAME));

function assertEidoverseApp(app) {
  if (isEidoverseApp(app)) return;
  throw new ServerError('Repository source management is available only for the managed Eidoverse Worlds app.', {
    status: 400,
    code: 'EIDOVERSE_APP_REQUIRED',
  });
}

const comparisonState = (ahead, behind) => {
  if (ahead > 0 && behind > 0) return 'diverged';
  if (behind > 0) return 'behind';
  if (ahead > 0) return 'ahead';
  return 'current';
};

function parseRevisionCounts(result) {
  if (result.exitCode !== 0) return null;
  const [aheadText, behindText] = result.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10);
  const behind = Number.parseInt(behindText, 10);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
  return { ahead, behind, state: comparisonState(ahead, behind) };
}

async function inspectCheckout({ id, label, repoPath, upstream, upstreamBranch }) {
  const present = typeof repoPath === 'string'
    && repoPath.trim().length > 0
    && await pathExists(join(repoPath, '.git'));
  if (!present) {
    return {
      id,
      label,
      present: false,
      branch: null,
      head: null,
      shortHead: null,
      clean: null,
      origin: null,
      upstream: { fullName: upstream.fullName, branch: upstreamBranch || null },
      localVsOrigin: null,
      remoteFresh: false,
      remoteError: 'Checkout not found',
    };
  }

  const [branchResult, headResult, worktreeResult, origin] = await Promise.all([
    execGitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, { ignoreExitCode: true }),
    execGitSafe(['rev-parse', 'HEAD'], repoPath, { ignoreExitCode: true }),
    execGitSafe(['status', '--porcelain'], repoPath, { ignoreExitCode: true }),
    getOriginInfo(repoPath, { upstreamOwner: upstream.owner, upstreamRepo: upstream.repo }),
  ]);
  const branchName = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const branch = branchName && branchName !== 'HEAD' ? branchName : null;
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const clean = worktreeResult.exitCode === 0 ? worktreeResult.stdout.trim().length === 0 : null;

  const fetchResult = origin.hasOrigin
    ? await fetchOrigin(repoPath).then(
      () => ({ fresh: true, error: null }),
      () => ({ fresh: false, error: 'Could not refresh the remote repository' }),
    )
    : { fresh: false, error: 'No origin remote configured' };

  const originRef = branch ? `refs/remotes/origin/${branch}` : null;
  const [originHeadResult, countsResult] = originRef
    ? await Promise.all([
      execGitSafe(['rev-parse', '--verify', originRef], repoPath, { ignoreExitCode: true }),
      execGitSafe(['rev-list', '--left-right', '--count', `HEAD...${originRef}`], repoPath, { ignoreExitCode: true }),
    ])
    : [null, null];
  const originHead = originHeadResult?.exitCode === 0 ? originHeadResult.stdout.trim() : null;
  const localVsOrigin = countsResult ? parseRevisionCounts(countsResult) : null;

  return {
    id,
    label,
    present: true,
    branch,
    head,
    shortHead: head?.slice(0, 7) || null,
    clean,
    origin: {
      hasOrigin: origin.hasOrigin,
      fullName: origin.fullName,
      url: origin.originUrl,
      isGithub: origin.isGithub,
      isUpstream: origin.isUpstream,
      isFork: origin.isFork,
      head: originHead,
      shortHead: originHead?.slice(0, 7) || null,
    },
    upstream: {
      fullName: upstream.fullName,
      branch: upstreamBranch || branch,
    },
    localVsOrigin,
    remoteFresh: fetchResult.fresh,
    remoteError: fetchResult.error,
  };
}

async function compareForkWithUpstream(checkout) {
  if (!checkout?.origin?.isFork || !checkout.origin.fullName) return null;
  const branch = checkout.upstream.branch || WORLDS_UPSTREAM_BRANCH;
  const basehead = encodeURIComponent(
    `${WORLDS_UPSTREAM.owner}:${branch}...${checkout.origin.fullName.split('/')[0]}:${branch}`,
  );
  const forge = await resolveForgeForRepo(checkout.repoPath).catch(() => null);
  const raw = await execGh([
    'api',
    `repos/${WORLDS_UPSTREAM.fullName}/compare/${basehead}`,
    '--jq',
    '{status: .status, ahead: .ahead_by, behind: .behind_by}',
  ], GH_TIMEOUT_MS, {
    cwd: checkout.repoPath,
    env: forge?.env || process.env,
  }).catch(() => null);
  const parsed = safeJSONParse(raw, null);
  if (!parsed
    || !Number.isInteger(parsed.ahead)
    || !Number.isInteger(parsed.behind)) {
    return {
      available: false,
      ahead: null,
      behind: null,
      state: 'unknown',
      error: 'Could not compare the fork with canonical upstream',
    };
  }
  return {
    available: true,
    ahead: parsed.ahead,
    behind: parsed.behind,
    state: comparisonState(parsed.ahead, parsed.behind),
    error: null,
  };
}

/**
 * Report the two checkouts that make up one Eidoverse installation. No local
 * paths are returned: the app-management UI needs versions and topology, not
 * machine identity. Network failures stay distinct from a confirmed current
 * repository so a stale ref is never presented as "up to date".
 */
export async function getEidoverseRepositorySources(app) {
  assertEidoverseApp(app);
  const registeredCompanions = Array.isArray(app.companionRepoPaths)
    ? app.companionRepoPaths.filter((path) => typeof path === 'string' && path.trim())
    : [];
  const videoPath = getEidoversePaths().video;

  const [worldsBase, video] = await Promise.all([
    inspectCheckout({
      id: 'worlds',
      label: 'Eidoverse Worlds',
      repoPath: app.repoPath,
      upstream: WORLDS_UPSTREAM,
      upstreamBranch: WORLDS_UPSTREAM_BRANCH,
    }),
    inspectCheckout({
      id: 'video',
      label: 'Eidoverse Video',
      repoPath: videoPath,
      upstream: VIDEO_UPSTREAM,
      upstreamBranch: null,
    }),
  ]);
  // Kept server-only above; callers receive no absolute checkout path.
  const worlds = {
    ...worldsBase,
    forkVsUpstream: await compareForkWithUpstream({ ...worldsBase, repoPath: app.repoPath }),
  };

  const updateAvailable = [worlds, video].some((source) => source.localVsOrigin?.behind > 0)
    || (worlds.forkVsUpstream?.behind || 0) > 0;

  return {
    kind: 'eidoverse',
    checkedAt: new Date().toISOString(),
    updateAvailable,
    updatePullsBoth: registeredCompanions.includes(videoPath),
    updateRestartsApp: true,
    sources: [worlds, video],
  };
}

/**
 * Fast-forward the configured Worlds fork from canonical upstream. This is a
 * remote-only action: it never touches the checkout and deliberately omits
 * `--force`, so GitHub refuses instead of discarding fork commits.
 */
export async function syncEidoverseWorldsFork(app) {
  assertEidoverseApp(app);
  const origin = await getOriginInfo(app.repoPath, {
    upstreamOwner: WORLDS_UPSTREAM.owner,
    upstreamRepo: WORLDS_UPSTREAM.repo,
  });
  if (!origin.hasOrigin) {
    throw new ServerError('The Eidoverse Worlds checkout has no Git origin.', {
      status: 400,
      code: 'NO_ORIGIN',
    });
  }
  if (!origin.isGithub) {
    throw new ServerError('Eidoverse fork sync is available only for GitHub origins.', {
      status: 400,
      code: 'NOT_GITHUB',
    });
  }
  if (origin.isUpstream) {
    throw new ServerError(`The Worlds origin is already ${WORLDS_UPSTREAM.fullName}.`, {
      status: 400,
      code: 'ALREADY_UPSTREAM',
    });
  }
  if (!origin.isFork) {
    throw new ServerError(
      `The Worlds origin is not a same-name fork of ${WORLDS_UPSTREAM.fullName}.`,
      { status: 400, code: 'NOT_A_FORK' },
    );
  }

  const forge = await resolveForgeForRepo(app.repoPath).catch(() => null);
  const output = await execGh([
    'repo',
    'sync',
    origin.fullName,
    '--source',
    WORLDS_UPSTREAM.fullName,
    '--branch',
    WORLDS_UPSTREAM_BRANCH,
  ], GH_TIMEOUT_MS, {
    cwd: app.repoPath,
    env: forge?.env || process.env,
  }).catch((error) => {
    if (/fast forward|diverge|non-fast/i.test(error.message || '')) {
      throw new ServerError(
        `The ${origin.fullName} fork has commits that cannot be fast-forwarded from ${WORLDS_UPSTREAM.fullName}. Reconcile those commits on GitHub before syncing.`,
        { status: 409, code: 'FORK_DIVERGED' },
      );
    }
    throw new ServerError(`Could not sync the Eidoverse Worlds fork: ${error.message}`, {
      status: 502,
      code: 'FORK_SYNC_FAILED',
    });
  });

  return {
    synced: true,
    alreadyUpToDate: /up to date/i.test(output),
    fullName: origin.fullName,
    source: WORLDS_UPSTREAM.fullName,
    branch: WORLDS_UPSTREAM_BRANCH,
    message: output.trim(),
  };
}
