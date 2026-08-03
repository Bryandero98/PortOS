import { useState } from 'react';
import { ArrowRight, Save } from 'lucide-react';

/**
 * Shared completion fork for every POST lesson: stop after persisting progress,
 * or persist and immediately continue into the next daily recommendation.
 */
export default function PostCompletionActions({
  onSave,
  onContinue,
  saveLabel = 'Save Progress',
  continueLabel = "Continue Today's Routine",
}) {
  const [pending, setPending] = useState(null);

  function run(kind, action) {
    if (pending || !action) return;
    setPending(kind);
    Promise.resolve()
      .then(action)
      .catch(() => {})
      .finally(() => setPending(null));
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <button
        type="button"
        onClick={() => run('save', onSave)}
        disabled={Boolean(pending)}
        className="flex items-center justify-center gap-2 px-4 py-2.5 bg-port-card border border-port-border hover:border-port-accent disabled:opacity-50 text-white rounded-lg transition-colors"
      >
        <Save size={16} />
        {pending === 'save' ? 'Saving...' : saveLabel}
      </button>
      <button
        type="button"
        onClick={() => run('continue', onContinue)}
        disabled={Boolean(pending)}
        className="flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
      >
        {pending === 'continue' ? 'Saving...' : continueLabel}
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
