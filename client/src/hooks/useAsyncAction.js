import { useState } from 'react';
import toast from '../components/ui/Toast';
import useMounted from './useMounted.js';

/**
 * Wraps an async action with `running` state and toast-on-error.
 *
 * Usage:
 *   const [run, running] = useAsyncAction(async (id) => {
 *     return await someApi(id);
 *   }, { errorMessage: 'Failed to do thing' });
 *   // ...
 *   <button disabled={running} onClick={() => run(thing.id)}>Go</button>
 *
 * The fn return value is what `run` resolves to. If the fn throws, the
 * error is toasted and `run` resolves to `null`. The hook only models a
 * single boolean in-flight flag — keyed/indexed loading states (e.g. "which
 * row is saving") need a different abstraction.
 *
 * The trailing `setRunning(false)` is gated on a `mountedRef` so an action
 * that resolves after the component unmounts (navigate-away mid-request)
 * doesn't call `setState` on an unmounted component — React warns about
 * that and it's a latent memory-leak signal. The guard MUST come from
 * `useMounted`, which re-arms the ref on every effect setup: StrictMode runs
 * mount→cleanup→mount on the same instance (refs survive), so a cleanup-only
 * ref stays false forever and every button in the app would stay stuck in its
 * disabled/spinner state after one click.
 */
export function useAsyncAction(fn, { errorMessage } = {}) {
  const [running, setRunning] = useState(false);
  const mountedRef = useMounted();
  const run = async (...args) => {
    setRunning(true);
    const result = await fn(...args).catch((err) => {
      toast.error(err?.message || errorMessage || 'Action failed');
      return null;
    });
    if (mountedRef.current) setRunning(false);
    return result;
  };
  return [run, running];
}

export default useAsyncAction;
