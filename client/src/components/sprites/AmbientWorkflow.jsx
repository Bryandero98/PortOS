import { useEffect, useMemo, useState } from 'react';
import { Film, Lock, RefreshCw, Wind } from 'lucide-react';
import toast from '../ui/Toast';
import { lockSpriteReference } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { CorrectionNoteToggle, AMBIENT_REFERENCE_CORRECTION_KEY } from './CorrectionNote.jsx';
import { checkerboardStyle, spriteAssetUrl } from './spriteAssets.js';

/**
 * The identity-root half of a place/object's workflow: describe it, render a
 * candidate, freeze it.
 *
 * A place has one identity root rather than a turnaround + eight anchors, so this
 * stays a dedicated surface — the character affordances would be meaningless
 * here. What it NO LONGER owns (#3136) is the ambient loop itself: that is one
 * animation track among any number the user may define, and it renders through
 * the generic `TrackWorkflow` alongside every other track. Keeping the loop here
 * would have meant a user-defined place animation had no surface at all.
 */
export default function AmbientWorkflow({
  record, reference, renders, hasBackend, mode, onGenerateReference, onChanged,
  corrections = null, onCorrectionChange = null,
}) {
  // Seeded from the manifest's stored design (the server persists it on every
  // ambient-main render) so a REGENERATE carries the design forward instead of
  // starting blank. Load-bearing for the correction note (#3134): the server
  // requires a design input on this target, so a correction typed against an
  // empty field would 400 with DESIGN_INPUT_REQUIRED. Re-seeded on record switch
  // only, so it never fights typing within one sprite.
  const [designPrompt, setDesignPrompt] = useState(reference?.manifest?.designPrompt || '');
  useEffect(() => { setDesignPrompt(reference?.manifest?.designPrompt || ''); }, [record.id]);
  const main = reference?.manifest?.mainReference || null;
  const candidate = useMemo(
    () => (reference?.candidates || []).find((item) => item.target === 'main') || null,
    [reference?.candidates],
  );
  const referenceBusy = Boolean(renders?.pendingJobs?.main);

  const [lock, locking] = useAsyncAction(async () => {
    await lockSpriteReference(record.id, { target: 'main', candidate: candidate.path }, { silent: true });
    toast.success('Ambient reference frozen');
    onChanged();
  }, { errorMessage: 'Could not freeze the ambient reference' });

  // Once frozen there is nothing left for this surface to do — the animation
  // tracks take over, each on its own `TrackWorkflow` section.
  if (main?.locked) return null;

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white"><Wind className="w-4 h-4" /> Identity Reference</h3>
        <span className="text-[11px] text-gray-500">one at-rest still, frozen once</span>
      </div>
      <div className="space-y-2">
        <label htmlFor={`ambient-design-${record.id}`} className="block text-xs text-gray-400">Describe this {record.kind}</label>
        <textarea
          id={`ambient-design-${record.id}`}
          value={designPrompt}
          onChange={(event) => setDesignPrompt(event.target.value)}
          placeholder="A willow tree with long branches moving gently in the wind"
          className="min-h-20 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
        />
        {candidate?.path && (
          <div className="flex items-center gap-2">
            <img className="h-20 w-20 rounded object-contain" style={checkerboardStyle(5)} src={spriteAssetUrl(record.id, candidate.path)} alt="Ambient reference candidate" />
            <button type="button" disabled={locking} onClick={lock} className="flex items-center gap-1 rounded bg-port-accent px-2 py-1.5 text-xs text-white disabled:opacity-50"><Lock className="w-3 h-3" /> Freeze reference</button>
          </div>
        )}
        {/* A correction is ADDITIVE (#3134) — it keeps the design above and
            fixes one thing about the last render, unlike editing the design
            prompt, which replaces the design outright. Only useful once there
            is a render to correct. */}
        {candidate && onCorrectionChange && (
          <CorrectionNoteToggle
            noteKey={AMBIENT_REFERENCE_CORRECTION_KEY}
            label="ambient reference"
            corrections={corrections}
            onChange={onCorrectionChange}
            placeholder="Correction (optional), e.g. the trunk leans too far right"
          />
        )}
        <button
          type="button"
          disabled={!hasBackend || !designPrompt.trim() || referenceBusy}
          onClick={() => onGenerateReference(designPrompt)}
          className="flex items-center gap-1 rounded border border-port-border px-2 py-1.5 text-xs text-gray-200 hover:border-port-accent disabled:opacity-50"
        >
          {referenceBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Film className="w-3 h-3" />}
          {candidate ? 'Regenerate reference' : 'Generate reference'}{mode ? '' : ' (select an image backend)'}
        </button>
      </div>
    </section>
  );
}
