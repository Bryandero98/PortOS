import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import HfTokenBanner, { GatedModelList, HF_SOURCE_LABEL } from '../imageGen/HfTokenBanner';

/**
 * Prerequisite notice for an image-to-3D target that needs gated Hugging Face
 * access. Driven by the CENTRAL token store (GET /image-gen/setup/hf-token-status)
 * — the same one the Image Gen page writes — so a user who already pasted a token
 * isn't told to go set one up in a terminal. With no token, the inline
 * paste-and-save banner appears instead of instructions. Either way the gated
 * repos stay listed: a token doesn't grant access until their terms are accepted
 * on the user's HF account.
 *
 * Shared by the 3D generate page (gated repos for the SELECTED target) and
 * Models → 3D (gated repos across every installable target).
 *
 * `tokenPresent` is TRI-STATE — `null` means "status still loading", not
 * "absent". Rendering the needs-setup banner on `null` would flash a false alarm
 * at a user who already has a token.
 */
export default function Image3dHfAccessNotice({ models, tokenPresent, tokenSource, onSaved }) {
  // Escape hatch for the stale/invalid-token case: `isHfAuthError` in the runner
  // also matches `401` / `Invalid user token`, and its guidance now says to add a
  // token *on this page* — so the paste form has to stay reachable even when one is
  // already configured, or that instruction is impossible to follow here. Mirrors
  // MidiGatedModal's "Use a different token".
  const [replacing, setReplacing] = useState(false);

  if (!models?.length) return null;
  if (tokenPresent === null) return null;

  const handleSaved = () => { setReplacing(false); onSaved?.(); };

  if (!tokenPresent || replacing) {
    return <HfTokenBanner models={models} onSaved={handleSaved} />;
  }

  return (
    <div className="rounded-lg border border-port-border bg-port-bg/40 p-3 text-xs text-gray-400">
      <div className="flex items-center gap-1.5 font-medium text-port-success">
        <KeyRound className="h-3.5 w-3.5" />
        Hugging Face token configured
        {HF_SOURCE_LABEL[tokenSource] ? ` (${HF_SOURCE_LABEL[tokenSource]})` : ''}
      </div>
      <p className="mt-1">
        Accept the terms for these gated models on your Hugging Face account if you haven’t — a token alone
        doesn’t grant access:
      </p>
      <GatedModelList models={models} linkClassName="text-port-accent hover:underline" />
      <button
        type="button"
        onClick={() => setReplacing(true)}
        className="mt-2 text-xs underline text-gray-400 hover:text-white"
      >
        Use a different token
      </button>
    </div>
  );
}
