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
 * (`{ kind, label, endpoint, ready, checks, manageUrl, setup }`).
 * Renders nothing without one, so providers with no local dependency — and
 * cards drawn before the fetch resolves — show no checklist at all.
 *
 * Every unmet check is fixed from this banner: a one-click daemon setup
 * (`setup.action`), a "use the served model as default" button when the
 * running server answers under a different id, or an in-app Local LLM
 * settings link. Vendor setup docs are never the way forward.
 */

import { Link } from 'react-router';
import { CheckCircle2, HelpCircle, Wand2, Wrench, XCircle } from 'lucide-react';
import Banner from '../ui/Banner';
import Pill from '../ui/Pill';

const ICONS = {
  true: { Icon: CheckCircle2, cls: 'text-port-success' },
  false: { Icon: XCircle, cls: 'text-port-error' },
  // `ok: null` — a check the server could not evaluate yet (the model list
  // cannot be read while the server is down). Shown as unknown rather than as a
  // failure, so the user chases the check that IS actionable.
  null: { Icon: HelpCircle, cls: 'text-gray-500' },
};

const ACTION_CLASS = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors font-medium';

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

export default function ProviderReadiness({ readiness, onAutoSetup, onUseServedModel, className = '' }) {
  if (!readiness || !Array.isArray(readiness.checks) || readiness.checks.length === 0) return null;
  const { label, endpoint, ready, checks, manageUrl, setup } = readiness;

  if (ready) {
    return (
      <Pill tone="success" size="xs" icon={CheckCircle2} className={className} title={`${label} is running at ${endpoint}.`}>
        {label} ready
      </Pill>
    );
  }

  const blocked = checks.filter((check) => check.ok !== true).length;

  return (
    <Banner
      tone="warning"
      size="sm"
      icon={Wrench}
      className={className}
      title={`${label} setup incomplete — ${blocked} requirement${blocked === 1 ? '' : 's'} unmet`}
    >
      <ul className="space-y-1 mt-1">
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
                {check.id === 'model' && check.ok === false && onUseServedModel
                  && Array.isArray(check.servedModels) && check.servedModels.length > 0 && (
                  <span className="flex flex-wrap gap-1.5 mt-1.5">
                    {check.servedModels.slice(0, 3).map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onUseServedModel(id)}
                        className={ACTION_CLASS}
                        title={`Set this provider's default model to ${id} so it matches what ${label} is serving.`}
                      >
                        Use {id} as default
                      </button>
                    ))}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 pt-1.5">
        {setup?.action && onAutoSetup && (
          <button
            type="button"
            onClick={() => onAutoSetup(setup)}
            className={ACTION_CLASS}
            title={`PortOS runs this on ${endpoint} for you — no terminal needed.`}
          >
            <Wand2 size={12} />
            {setup.actionLabel}
          </button>
        )}
        {manageUrl && (
          <Link to={manageUrl} className={ACTION_CLASS}>Open the LLMs page</Link>
        )}
      </div>
    </Banner>
  );
}
