import { AlertTriangle, GitCommitHorizontal } from 'lucide-react';
import Pill from '../ui/Pill';
import Banner from '../ui/Banner';
import { BUNDLE_STAMP, compareBuildStamps, describeBuild } from '../../lib/buildStamp.js';
import { timeAgo } from '../../utils/formatters';

/**
 * Which code is actually running — the git commit of the server process, and of
 * the bundle this browser loaded (#4694). Why `version` cannot answer this: see
 * the module header of `server/lib/buildIdentity.js`.
 *
 * The mismatch banner is the point of the panel: it turns "my change isn't
 * showing up" from a debugging session into a visible fact. The same comparison
 * also runs unprompted on every page via the `build:id` socket frame — this is
 * the read-out, not the only detector.
 */
export default function BuildStampPanel({ build, uptimeFormatted }) {
  const { state, bundleCommit, serverCommit } = compareBuildStamps(BUNDLE_STAMP, build);

  const serverLabel = describeBuild({
    commit: serverCommit,
    branch: build?.branch,
    dirty: build?.dirty
  });
  const bundleLabel = describeBuild({ commit: BUNDLE_STAMP?.commit, branch: BUNDLE_STAMP?.branch });

  // Rendered even when both sides are unknown (a tarball install with no git),
  // so "we could not tell" is visible rather than looking like a missing feature.
  const footnote = state === 'match'
    ? 'Bundle and server agree — what you are looking at is the code that is running.'
    : state === 'unknown'
      ? 'Commit unknown on at least one side (no git metadata), so bundle/server drift cannot be checked here.'
      : null;

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
          // The server's `dirty` is read once at boot, so the whole row
          // describes the tree the process STARTED from — labelled as such
          // rather than implying a live read of the working tree.
          hint={uptimeFormatted ? `at start · up ${uptimeFormatted}` : 'at start'}
        />
        <StampRow
          label="This page"
          value={bundleLabel}
          hint={BUNDLE_STAMP?.builtAt ? `built ${timeAgo(BUNDLE_STAMP.builtAt)}` : null}
        />
      </dl>

      {footnote && <p className="mt-3 text-xs text-gray-500">{footnote}</p>}
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
