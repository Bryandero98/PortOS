import { CloudOff } from 'lucide-react';

/**
 * "N notes aren't downloaded yet" banner for any Obsidian vault reader.
 *
 * Vault readers skip notes macOS has evicted to iCloud rather than blocking on an
 * un-downloadable read (see `server/lib/icloudFile.js`), and report how many they
 * skipped as `skippedUnavailable`. Without surfacing that, a search over a
 * freshly-synced Mac shows "no results" for a query whose answer is sitting in an
 * un-downloaded note — presenting an incomplete answer as authoritative.
 *
 * Renders nothing when the count is 0/absent, so callers can drop it in
 * unconditionally.
 */
export default function OfflineNotesNotice({ count, className = '' }) {
  const skipped = Number(count) || 0;
  if (skipped < 1) return null;
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ${className}`}
    >
      <CloudOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        {skipped} note{skipped === 1 ? '' : 's'} {skipped === 1 ? 'is' : 'are'} stored in iCloud but not
        downloaded to this Mac, so {skipped === 1 ? 'it was' : 'they were'} left out of these results. A
        download was requested — reload in a moment to include {skipped === 1 ? 'it' : 'them'}.
      </span>
    </div>
  );
}
