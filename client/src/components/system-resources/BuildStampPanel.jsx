import { useEffect, useState } from 'react';
import { AlertTriangle, GitCommitHorizontal } from 'lucide-react';
import Pill from '../ui/Pill';
import Banner from '../ui/Banner';
import * as api from '../../services/api';
import {
  SERVED_BUILD_ID,
  TRUSTED_BUNDLE_STAMP,
  compareBuildStamps,
  describeBuild
} from '../../lib/buildStamp.js';
import { timeAgo } from '../../utils/formatters';

/**
 * Which code is actually running — the git commit of the server process, and of
 * the bundle this browser loaded (#4694). Why `version` cannot answer this: see
 * the module header of `server/lib/buildIdentity.js`.
 *
 * Fetched from `/api/system/build` rather than read off the health payload: peers
 * scrape `/health/details` and persist it verbatim, so the stamp deliberately
 * does not ride it (see that route's comment).
 *
 * The mismatch banner is the point of the panel — it turns "my change isn't
 * showing up" from a debugging session into a visible fact. The same comparison
 * runs unprompted on every page via the `build:id` socket frame; this is the
 * read-out, not the only detector.
 */
export default function BuildStampPanel({ uptimeFormatted }) {
  const [build, setBuild] = useState(null);

  // One fetch on mount, not on the page's 15s health poll: the commit a running
  // process was started from cannot change without a restart, and a restart
  // drops the socket and reloads the page anyway.
  useEffect(() => {
    let live = true;
    api.getSystemBuild({ silent: true })
      .then((data) => { if (live) setBuild(data); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const { state, bundleCommit, serverCommit } = compareBuildStamps(TRUSTED_BUNDLE_STAMP, build);

  const serverLabel = describeBuild({
    commit: serverCommit,
    branch: build?.branch,
    dirty: build?.dirty
  });
  const bundleLabel = describeBuild({
    commit: TRUSTED_BUNDLE_STAMP?.commit,
    branch: TRUSTED_BUNDLE_STAMP?.branch
  });

  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
        <GitCommitHorizontal size={16} />
        Running build
      </h3>

      {state === 'mismatch' && (
        <Banner tone="warning" size="md" icon={AlertTriangle} align="start" className="mb-3">
          <div>
            This page was built from <span className="font-mono">{bundleCommit}</span> but the API is
            running <span className="font-mono">{serverCommit}</span>. The UI is stale relative to the
            server it is calling — rebuild the client (<span className="font-mono">npm run build</span>)
            or restart the server from the checkout you are editing.
          </div>
        </Banner>
      )}

      <dl className="space-y-2 text-sm">
        <StampRow
          label="Server"
          value={serverLabel}
          // `dirty` is read once at boot, so the whole row describes the tree the
          // process STARTED from — said plainly rather than implying a live read.
          hint={uptimeFormatted ? `at start · up ${uptimeFormatted}` : 'at start'}
        />
        <StampRow
          label="This page"
          value={bundleLabel}
          hint={bundleHint()}
        />
      </dl>

      <p className="mt-3 text-xs text-gray-500">{footnote(state, build)}</p>
    </section>
  );
}

function bundleHint() {
  // Under `npm run dev` the Vite define is frozen at dev-server start while HMR
  // serves every commit since, so reporting it would be actively misleading.
  if (!SERVED_BUILD_ID) return 'dev server — no fixed bundle';
  return TRUSTED_BUNDLE_STAMP?.builtAt ? `built ${timeAgo(TRUSTED_BUNDLE_STAMP.builtAt)}` : null;
}

function footnote(state, build) {
  if (state === 'mismatch') return null;
  if (state === 'unknown') {
    return !SERVED_BUILD_ID
      ? 'Running from the Vite dev server, so there is no built bundle to compare against the server.'
      : 'Commit unknown on at least one side (no git metadata), so bundle/server drift cannot be checked here.';
  }
  // Matching commits are not the whole story: the comparison is commit-only, and
  // the server tree can carry uncommitted edits that no commit id reflects.
  // Claiming "this is the code that is running" there would be a false assurance
  // in exactly the debugging session this panel exists to end.
  return build?.dirty === false
    ? 'Bundle and server agree — what you are looking at is the code that is running.'
    : 'Bundle and server are on the same commit, but the server tree has changes that commit does not include.';
}

function StampRow({ label, value, hint }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {value
          ? <span className="font-mono text-xs text-gray-200">{value}</span>
          : <Pill tone="note" size="xs" bordered={false}>unknown</Pill>}
        {hint && <span className="text-[10px] text-gray-600">{hint}</span>}
      </dd>
    </div>
  );
}
