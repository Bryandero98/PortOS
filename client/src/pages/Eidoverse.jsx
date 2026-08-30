import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Orbit, RotateCcw, Settings } from 'lucide-react';
import { Link } from 'react-router';
import PageHeader from '../components/PageHeader';
import BrailleSpinner from '../components/BrailleSpinner';
import {
  getApp,
  getInstanceFeatures,
  startApp,
  startEidoverseHost,
} from '../services/api';

const silent = { silent: true };
const RUNNING_STATUSES = new Set(['online', 'launching', 'unknown']);

const failedStart = (result) => Object.values(result?.results || {})
  .find((entry) => entry?.success === false);

export const hostUrlFor = (host, setup, location = window.location) => {
  if (location.protocol === 'https:') {
    if (host.protocol !== 'https') {
      throw new Error('PortOS is using HTTPS, but the Eidoverse host could not load the shared certificate.');
    }
    return `https://${location.hostname}:${host.port}/`;
  }
  return `http://${location.hostname}:${setup.uiPort}/`;
};

export default function Eidoverse() {
  const requestGeneration = useRef(0);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [appId, setAppId] = useState(null);

  const prepare = useCallback(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => requestGeneration.current === generation;
    const updatePhase = (next) => { if (isCurrent()) setPhase(next); };

    setPhase('loading');
    setError('');
    setHostUrl('');

    const load = async () => {
      const featureState = await getInstanceFeatures(silent);
      const feature = featureState.features?.find((entry) => entry.id === 'eidoverse');
      const setup = feature?.setup;
      if (!setup?.installed) return { phase: 'setup', appId: setup?.appId || null };
      if (!setup.appId) throw new Error('Eidoverse is installed but its managed-app record is unavailable.');

      const app = await getApp(setup.appId, silent);
      if (!RUNNING_STATUSES.has(app.overallStatus)) {
        updatePhase('starting');
        const result = await startApp(setup.appId, silent);
        const failure = failedStart(result);
        if (failure) throw new Error(failure.error || 'PortOS could not start Eidoverse Worlds.');
      }

      updatePhase('connecting');
      const host = await startEidoverseHost(silent);
      if (!host?.running) throw new Error('The Eidoverse host did not start.');
      return {
        phase: 'ready',
        appId: setup.appId,
        hostUrl: hostUrlFor(host, setup),
      };
    };

    load().then((result) => {
      if (!isCurrent()) return;
      setPhase(result.phase);
      setAppId(result.appId);
      setHostUrl(result.hostUrl || '');
    }, (reason) => {
      if (!isCurrent()) return;
      setPhase('error');
      setError(reason?.message || 'Eidoverse Worlds could not be loaded.');
    });
  }, []);

  useEffect(() => {
    prepare();
    return () => { requestGeneration.current += 1; };
  }, [prepare]);

  const actions = (
    <>
      {hostUrl && (
        <a
          href={hostUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white"
        >
          <ExternalLink size={15} aria-hidden="true" />
          Open full screen
        </a>
      )}
      {appId && (
        <Link
          to={`/apps/${appId}/overview`}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white"
        >
          <Settings size={15} aria-hidden="true" />
          Manage app
        </Link>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <PageHeader
        icon={Orbit}
        title="Eidoverse Worlds"
        subtitle="A shared 3D world for you and your agents"
        actions={actions}
        className="bg-port-bg"
      />

      {phase === 'ready' && (
        <iframe
          src={hostUrl}
          title="Eidoverse Worlds"
          className="min-h-0 w-full flex-1 border-0 bg-black"
          allow="camera; microphone; fullscreen; gamepad; xr-spatial-tracking"
          allowFullScreen
        />
      )}

      {['loading', 'starting', 'connecting'].includes(phase) && (
        <div className="flex flex-1 items-center justify-center p-6" role="status">
          <BrailleSpinner
            text={phase === 'starting'
              ? 'Starting Eidoverse Worlds'
              : (phase === 'connecting' ? 'Connecting to Eidoverse Worlds' : 'Loading Eidoverse Worlds')}
          />
        </div>
      )}

      {phase === 'setup' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <section className="max-w-lg rounded-xl border border-port-border bg-port-card p-6 text-center">
            <Orbit className="mx-auto mb-3 h-10 w-10 text-port-accent" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-white">Install Eidoverse Worlds</h2>
            <p className="mt-2 text-sm text-gray-400">
              Install and enable the managed app from PortOS Features before opening this world.
            </p>
            <Link
              to="/settings/features"
              className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
            >
              <Settings size={16} aria-hidden="true" />
              Open Features
            </Link>
          </section>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <section className="max-w-lg rounded-xl border border-port-error/50 bg-port-card p-6 text-center" role="alert">
            <h2 className="text-lg font-semibold text-white">Eidoverse Worlds did not load</h2>
            <p className="mt-2 text-sm text-port-error">{error}</p>
            <button
              type="button"
              onClick={prepare}
              className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
            >
              <RotateCcw size={16} aria-hidden="true" />
              Retry
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
