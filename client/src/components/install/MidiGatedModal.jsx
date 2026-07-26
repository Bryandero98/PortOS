/**
 * Gated-repo gate for MuScriptor (audio → MIDI) transcription. MuScriptor's
 * model weights live in a gated HuggingFace repo (MuScriptor/muscriptor-*), so
 * a first transcribe 403s until the user has BOTH accepted the model license
 * AND provided a HuggingFace token. useMidiTranscription opens this when the job
 * streams a `gated_repo` error frame, then `onSaved` re-runs the captured
 * transcription.
 *
 * Two distinct causes reach this modal, so we branch on whether a token is
 * already configured (GET /image-gen/setup/hf-token-status):
 *   - No token → the user still needs to create + paste one (reuse HfTokenBanner,
 *     the same paste-and-save flow the gated image models use).
 *   - Token present → the token is fine; the 403 means the model license hasn't
 *     been accepted yet. Don't nag for a second token — just deep-link the
 *     license page and offer a Retry (with an escape hatch to replace the token
 *     in case the stored one is stale).
 */

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, RotateCw } from 'lucide-react';
import Modal from '../ui/Modal';
import HfTokenBanner, { HF_SOURCE_LABEL } from '../imageGen/HfTokenBanner';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';

export default function MidiGatedModal({ open, repo, onSaved, onClose }) {
  const licenseUrl = repo ? `https://huggingface.co/${repo}` : 'https://huggingface.co';
  const licenseLinkText = licenseUrl.replace(/^https?:\/\//, '');

  // Re-checked each time the modal opens (the hook resets to unknown while closed)
  // so a token saved on a prior pass is reflected. `errorAs: 'absent'` because this
  // modal only opens AFTER a gated-repo 403 — if the status call itself fails, the
  // paste form is the more useful guess than showing nothing.
  const { present: tokenPresent, source: tokenSource } = useHfTokenStatus({ enabled: open, errorAs: 'absent' });
  // Escape hatch: when a token IS present but the license-accept + retry still
  // 403s, the stored token may be invalid — let the user drop to the paste form.
  const [forceTokenEntry, setForceTokenEntry] = useState(false);

  useEffect(() => { if (!open) setForceTokenEntry(false); }, [open]);

  const checking = tokenPresent === null;
  const hasToken = tokenPresent === true;
  // Show the license-only view when a token is already configured and the user
  // hasn't explicitly asked to replace it.
  const licenseOnly = hasToken && !forceTokenEntry;

  const title = licenseOnly ? 'Accept the model license' : 'HuggingFace access required';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      align="top"
      zIndexClassName="z-[9999]"
      ariaLabelledBy="midi-gated-title"
      backdropClassName="bg-black/70 backdrop-blur-sm"
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden"
    >
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-port-border">
        <KeyRound size={18} className="text-port-warning" />
        <h2 id="midi-gated-title" className="text-sm font-semibold text-white">
          {title}
        </h2>
      </div>
      <div className="px-5 py-4">
        {checking ? (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={14} className="animate-spin" />
            Checking HuggingFace access…
          </div>
        ) : licenseOnly ? (
          <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning space-y-3">
            <div>
              Your HuggingFace token is already configured
              {HF_SOURCE_LABEL[tokenSource] ? ` (${HF_SOURCE_LABEL[tokenSource]})` : ''} — but you
              haven&apos;t accepted the license for{' '}
              <a href={licenseUrl} target="_blank" rel="noreferrer" className="underline text-white">
                {licenseLinkText}
              </a>{' '}
              yet. Open that page, agree to share your info with the model owner, then retry.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onSaved}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
              >
                <RotateCw size={14} />
                Retry transcription
              </button>
              <button
                type="button"
                onClick={() => setForceTokenEntry(true)}
                className="text-xs underline text-gray-400 hover:text-white"
              >
                Use a different token
              </button>
            </div>
          </div>
        ) : (
          <HfTokenBanner
            modelLabel={repo || 'MuScriptor'}
            licenseUrl={licenseUrl}
            onSaved={onSaved}
          />
        )}
      </div>
    </Modal>
  );
}
