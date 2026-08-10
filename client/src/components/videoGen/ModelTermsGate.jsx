// Restricted-model license gate — the acknowledgement UI for a video model
// whose registry entry carries a `termsGate` (server/lib/videoDisclosure.js).
//
// It lives in its own component because the gate is not a Video Gen page
// concern: any surface that can start a render (the music video director
// board, a future storyboard renderer) must be able to show it. A render
// surface that only reports the server's 403 leaves the user with no way to
// resolve it — so wherever a gated model can be selected, this renders.
//
// Wording comes verbatim from the server's gate block; nothing is authored here.
import { ShieldAlert, CheckCircle } from 'lucide-react';
import FactLink from './FactLink.jsx';

export default function ModelTermsGate({
  termsGate,
  accepted = false,
  onAcceptedChange,
  disabled = false,
  descriptionId,
  inputId = 'model-terms-accept',
}) {
  if (!termsGate || typeof termsGate !== 'object') return null;
  return (
    <section
      id={descriptionId}
      aria-label="Model terms acceptance"
      className={`rounded-xl border px-3 py-3 text-xs ${accepted
        ? 'border-port-success/40 bg-port-success/10 text-gray-300'
        : 'border-port-warning/50 bg-port-warning/10 text-port-warning'}`}
    >
      <div className="flex items-start gap-2">
        {accepted
          ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-port-success" aria-hidden="true" />
          : <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />}
        <div className="min-w-0 space-y-1.5">
          <p className="font-semibold text-gray-200">{termsGate.title || 'Model terms required'}</p>
          <p className="leading-snug">{termsGate.summary}</p>
          {termsGate.licenseUrl && (
            <p>
              <FactLink href={termsGate.licenseUrl}>
                Read the Community License and Acceptable Use Policy
              </FactLink>
            </p>
          )}
          <label htmlFor={inputId} className="flex items-start gap-2 text-gray-200 cursor-pointer">
            <input
              id={inputId}
              type="checkbox"
              checked={accepted}
              disabled={disabled}
              onChange={(event) => onAcceptedChange?.(event.target.checked)}
              className="mt-0.5 rounded disabled:opacity-50"
            />
            <span>{termsGate.acknowledgement}</span>
          </label>
          <p className="text-[10px] text-gray-500">
            PortOS cannot determine your location or legal eligibility. Do not accept if this statement is not true.
            Accepting applies to every render on this install.
          </p>
        </div>
      </div>
    </section>
  );
}
