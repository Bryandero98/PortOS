import toast from '../components/ui/Toast';

/**
 * Sticky toast shown when the server's build id no longer matches the build
 * id the current tab was served with. Manual reload — we don't auto-refresh
 * because the user might be mid-typing in a form.
 */
export function showStaleBuildToast() {
  toast(
    <div className="flex items-center gap-3">
      <span>New build available.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-2 py-1 rounded bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
      >
        Reload
      </button>
    </div>,
    { id: 'portos-stale-build', duration: Infinity, label: 'New build available' },
  );
}

/**
 * Sticky toast for the OTHER staleness: this tab matches the bundle on disk,
 * but that bundle was built from a different git commit than the server process
 * is running (#4694). Deliberately offers no Reload button — reloading re-serves
 * the same stale dist and changes nothing. The remedy is a rebuild or a restart,
 * so the toast names it instead of offering an action that would not work.
 */
export function showBuildDriftToast() {
  toast(
    <div className="flex flex-col gap-0.5">
      <span>UI and server were built from different commits.</span>
      <span className="text-xs opacity-80">
        Rebuild the client or restart the server — reloading will not help.
      </span>
    </div>,
    { id: 'portos-build-drift', duration: Infinity, label: 'UI and server built from different commits' },
  );
}
