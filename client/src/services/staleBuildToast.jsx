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
 * is running (#4694).
 *
 * No Reload button, because reloading ON ITS OWN re-serves the same stale dist
 * and changes nothing — but the copy must not say reloading never helps either:
 * after the rebuild it names first, a reload is exactly what puts this tab on
 * the new bundle. Restarting the server instead drops the socket, and the
 * reconnect frame clears this toast (see services/socket.js).
 */
export function showBuildDriftToast() {
  toast(
    <div className="flex flex-col gap-0.5">
      <span>UI and server were built from different commits.</span>
      <span className="text-xs opacity-80">
        Rebuild the client and reload, or restart the server from the checkout you are editing.
      </span>
    </div>,
    { id: 'portos-build-drift', duration: Infinity, label: 'UI and server built from different commits' },
  );
}
