import { useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Lock,
  RefreshCw,
} from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import {
  handleSelfRestart,
  PORTOS_APP_ID,
  provisionTailnetCert,
  restartApp,
} from '../../services/api';
import { useLocalStorageBool } from '../../hooks/useLocalStorageBool';

export default function TailnetHelpBanner({ tailnetInfo, networkExposure }) {
  const [collapsed, setCollapsed] = useLocalStorageBool('portos-tailnet-help-collapsed', false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState(null);
  const [restarting, setRestarting] = useState(false);

  const toggle = () => setCollapsed((prev) => !prev);

  const provision = async (e) => {
    e.stopPropagation();
    setProvisioning(true);
    setProvisionResult(null);
    const result = await provisionTailnetCert().catch(() => null);
    setProvisioning(false);
    if (!result?.ok) return; // request() already toasted the error
    setProvisionResult(result);
    toast.success(result.message);
  };

  const trustedHttpsPort = networkExposure?.bind?.port || 5555;

  const restartPortos = async () => {
    setRestarting(true);
    const result = await restartApp(PORTOS_APP_ID, { silent: true }).catch((error) => {
      toast.error(error.message || 'Could not restart PortOS');
      return null;
    });
    if (!result) {
      setRestarting(false);
      return;
    }
    if (!result.selfRestart) {
      toast.error('PortOS did not accept the restart request');
      setRestarting(false);
      return;
    }

    const targetHost = provisionResult.hostname || tailnetInfo?.self;
    const targetOrigin = `https://${targetHost}:${trustedHttpsPort}`;
    handleSelfRestart({ targetOrigin });
  };

  const status = tailnetInfo === null
    ? { label: 'Tailscale DNS not detected', tone: 'warn', detail: 'Install Tailscale and enable MagicDNS in your tailnet admin to auto-suggest peer DNS names.' }
    : tailnetInfo?.suffix
      ? { label: `MagicDNS: ${tailnetInfo.suffix}`, tone: 'ok', detail: tailnetInfo.self ? `This instance: ${tailnetInfo.self}` : null }
      : { label: 'Tailscale running but MagicDNS suffix not found', tone: 'warn', detail: 'Enable MagicDNS in your tailnet admin console (login.tailscale.com/admin/dns).' };

  const ToneIcon = status.tone === 'ok' ? CheckCircle2 : AlertCircle;
  const toneClass = status.tone === 'ok' ? 'text-port-success' : 'text-port-warning';
  const trustedHttpsHost = networkExposure?.httpsEnabled && networkExposure?.cert?.mode === 'tailscale'
    ? networkExposure.cert.tailscaleHost || tailnetInfo?.self || null
    : null;
  const trustedHttpsUrl = trustedHttpsHost ? `https://${trustedHttpsHost}:${trustedHttpsPort}` : null;

  // Only offer the one-click provision button when Tailscale is actually
  // detected and we have a MagicDNS hostname for this instance — otherwise
  // the API call will fail with the same "enable MagicDNS first" guidance.
  const canProvision = !!tailnetInfo?.self;

  if (trustedHttpsHost) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <Lock size={16} className="text-port-success shrink-0" />
          <div className="flex-1 min-w-[220px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-white">Tailnet DNS &amp; trusted HTTPS</span>
              <Pill tone="success" size="xs" bordered={false} icon={CheckCircle2}>
                Running on Tailscale HTTPS
              </Pill>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Currently running on HTTPS with Tailscale DNS.
            </p>
          </div>
          {trustedHttpsUrl && (
            <a
              href={trustedHttpsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-port-accent hover:text-port-accent/80 font-mono"
              title={`Open ${trustedHttpsUrl}`}
            >
              {trustedHttpsHost}
              <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-xl">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 p-4 text-left"
      >
        <Lock size={16} className="text-port-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white">Tailnet DNS &amp; trusted HTTPS</span>
            <Pill tone="bare" size="xs" bordered={false} icon={ToneIcon} className={`${toneClass} bg-port-bg`}>
              {status.label}
            </Pill>
          </div>
        </div>
        {collapsed ? <ChevronRight size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 -mt-1 text-xs text-gray-400 space-y-2">
          {status.detail && (
            <div className="flex items-start gap-1.5">
              <Info size={11} className="mt-0.5 text-gray-500 shrink-0" />
              <span className="font-mono">{status.detail}</span>
            </div>
          )}
          <p>
            By default, federation traffic uses <span className="font-mono text-gray-300">http://{`<ip>`}:5555</span>. Setting a Tailscale MagicDNS host on a peer
            switches that hop to <span className="font-mono text-gray-300">https://{`<host>`}.{tailnetInfo?.suffix || `<tailnet>`}.ts.net</span> with a
            browser-trusted Let&apos;s Encrypt cert provisioned by Tailscale.
          </p>
          <ol className="list-decimal list-inside space-y-1 text-gray-500">
            <li>On each instance, enable MagicDNS + HTTPS Certificates in your tailnet admin (<span className="font-mono">login.tailscale.com/admin/dns</span>).</li>
            <li>
              Click <span className="text-port-accent">Enable HTTPS</span> below to fetch the cert via Tailscale
              (or run <span className="font-mono text-gray-300">npm run setup:cert</span> from a shell).
            </li>
            <li>Below, click <span className="text-port-accent">use {`<host>`}</span> on each peer to switch the link to HTTPS. Or click <span className="text-gray-400">use IP only</span> to revert.</li>
          </ol>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              onClick={provision}
              disabled={provisioning || !canProvision}
              title={canProvision
                ? `Run \`tailscale cert\` for ${tailnetInfo.self} and write data/certs/{cert,key}.pem`
                : 'Enable MagicDNS in your tailnet admin first, then reload this page'}
              className="inline-flex items-center gap-1.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded text-xs font-medium transition-colors min-h-[40px] sm:min-h-0"
            >
              <Lock size={12} />
              {provisioning ? 'Provisioning…' : 'Enable HTTPS'}
            </button>
            {provisionResult?.ok && (
              <>
                <span className="inline-flex items-center gap-1 text-[11px] text-port-success">
                  <CheckCircle2 size={11} />
                  {provisionResult.requiresRestart
                    ? 'Cert installed — restart PortOS to activate HTTPS'
                    : 'Cert installed and live'}
                </span>
                {provisionResult.requiresRestart && (
                  <button
                    onClick={restartPortos}
                    disabled={restarting}
                    className="inline-flex items-center gap-1.5 border border-port-accent text-port-accent hover:bg-port-accent/10 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded text-xs font-medium transition-colors min-h-[40px] sm:min-h-0"
                  >
                    <RefreshCw size={12} className={restarting ? 'animate-spin' : ''} />
                    {restarting ? 'Restarting…' : 'Restart PortOS'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
