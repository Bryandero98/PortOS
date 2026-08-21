import { AlertTriangle, GitCommitHorizontal } from 'lucide-react';
import Pill from '../ui/Pill';
import Banner from '../ui/Banner';
import { compareBuildStamps, describeBuild } from '../../lib/buildStamp.js';
import { timeAgo } from '../../utils/formatters';

// `__BUILD_STAMP__` is a Vite build-time define (see client/vite.config.js).
// It is genuinely absent under vitest and under any non-bundled consumer, so it
// is read through `typeof` rather than referenced bare — a bare reference throws
// a ReferenceError instead of degrading to the 'unknown' state.
function readBundleStamp() {
  return typeof __BUILD_STAMP__ === 'undefined' ? null : __BUILD_STAMP__;
}

/**
 * Which code is actually running — the git commit of the server process, and of
 * the bundle this browser loaded (#4694).
 *
 * `version` cannot answer this: by project rule package.json's version reflects
 * the last release and is identical across every development commit and every
 * worktree, so a server restarted from a stale checkout looks exactly like a
 * current one. The mismatch banner is the point of the panel — it turns "my
 * change isn't showing up" from a debugging session into a visible fact.
 */
export default function BuildStampPanel({ build }) {
  const bundle = readBundleStamp();
  const { state, bundleCommit, serverCommit } = compareBuildStamps(bundle, build);

  const serverLabel = describeBuild({
    commit: build?.shortCommit || build?.commit,
    branch: build?.branch,
    dirty: build?.dirty
  });
  const bundleLabel = describeBuild({ commit: bundle?.commit, branch: bundle?.branch });

  // Nothing to say at all — a tarball install with no git on either side. Render
  // the panel anyway rather than hiding it, so "we could not tell" is visible
  // instead of looking like the feature is missing.
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
          hint={build?.builtAt ? `started ${timeAgo(build.builtAt)}` : null}
        />
        <StampRow
          label="This page"
          value={bundleLabel}
          hint={bundle?.builtAt ? `built ${timeAgo(bundle.builtAt)}` : null}
        />
      </dl>

      {state === 'match' && (
        <p className="mt-3 text-xs text-gray-500">
          Bundle and server agree — what you are looking at is the code that is running.
        </p>
      )}
      {state === 'unknown' && (
        <p className="mt-3 text-xs text-gray-500">
          Commit unknown on at least one side (no git metadata), so bundle/server drift cannot be
          checked here.
        </p>
      )}
    </section>
  );
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
