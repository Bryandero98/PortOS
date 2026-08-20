/**
 * Local-daemon requirements checklist for one provider card.
 *
 * `ProviderRuntimeStatus` (its sibling) answers "is the CLI binary installed?".
 * This answers the other half for a provider backed by a local daemon: is
 * llama.cpp / Ollama / LM Studio / MTPLX installed, is it actually running at
 * the endpoint this provider points at, and is it serving the model this
 * provider asks for. Without it, a missing daemon or an un-downloaded model only
 * surfaced as `Cannot connect to API: Unable to connect` inside a dead agent
 * transcript.
 *
 * `readiness` is one entry of the map from `GET /api/providers/readiness`
 * (`{ kind, label, endpoint, ready, checks, manageUrl, docsUrl }`). Renders
 * nothing without one, so providers with no local dependency — and cards drawn
 * before the fetch resolves — show no checklist at all.
 */

import { Link } from 'react-router';
import { CheckCircle2, HelpCircle, Wrench, XCircle } from 'lucide-react';
import Pill from '../ui/Pill';

const ICONS = {
  true: { Icon: CheckCircle2, cls: 'text-port-success' },
  false: { Icon: XCircle, cls: 'text-port-error' },
  // `ok: null` — a check the server could not evaluate yet (the model list
  // cannot be read while the server is down). Shown as unknown rather than as a
  // failure, so the user chases the check that IS actionable.
  null: { Icon: HelpCircle, cls: 'text-gray-500' },
};

/**
 * Render `text` with `backtick`-quoted spans as inline code. The server writes
 * check details in that shape so model ids and binary names read as literals
 * rather than as prose.
 */
function CodeText({ text }) {
  if (typeof text !== 'string' || text === '') return null;
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) => (
        i % 2 === 1
          ? <code key={i} className="text-gray-300 font-mono break-all">{part}</code>
          : <span key={i}>{part}</span>
      ))}
    </>
  );
}

export default function ProviderReadiness({ readiness, className = '' }) {
  if (!readiness || !Array.isArray(readiness.checks) || readiness.checks.length === 0) return null;
  const { label, endpoint, ready, checks, manageUrl, docsUrl } = readiness;

  if (ready) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>
        <Pill tone="success" size="xs" icon={CheckCircle2} title={`${label} is running at ${endpoint}.`}>
          {label} ready
        </Pill>
      </div>
    );
  }

  const blocked = checks.filter((check) => check.ok !== true).length;

  return (
    <div className={`text-xs rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2 space-y-1.5 ${className}`}>
      <p className="text-port-warning font-semibold flex items-center gap-1.5">
        <Wrench size={12} />
        {label} setup incomplete — {blocked} requirement{blocked === 1 ? '' : 's'} unmet
      </p>
      <ul className="space-y-1">
        {checks.map((check) => {
          const { Icon, cls } = ICONS[String(check.ok)] || ICONS.null;
          return (
            <li key={check.id} className="flex items-start gap-1.5">
              <Icon size={12} className={`${cls} mt-0.5 shrink-0`} />
              <span className="text-gray-300 break-words">
                <CodeText text={check.label} />
                {check.detail && <span className="text-gray-500"> — <CodeText text={check.detail} /></span>}
                {check.fixHint && (
                  <span className="block text-port-warning/90"><CodeText text={check.fixHint} /></span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        {manageUrl && (
          <Link to={manageUrl} className="text-port-accent hover:text-port-accent/80 underline underline-offset-2">
            Open Local LLM settings
          </Link>
        )}
        {docsUrl && (
          <a href={docsUrl} target="_blank" rel="noreferrer" className="text-port-accent hover:text-port-accent/80 underline underline-offset-2">
            {label} setup docs
          </a>
        )}
      </div>
    </div>
  );
}
