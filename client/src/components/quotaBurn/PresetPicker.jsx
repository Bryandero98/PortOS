/**
 * Prompt-preset picker for `agent-prompt` burn jobs.
 *
 * A burn window is spent unattended, so the quality of the work prompt IS the
 * quality of the feature — and a blank textarea labeled "what should this
 * provider spend its remaining quota on?" is a hard question to answer well at
 * configuration time. The server ships worked answers
 * (`server/lib/quotaBurnPresets.js`); this is how they get picked.
 *
 * Two modes, chosen by whether the caller passes `value`:
 *
 * - **Bound** (a job row): `value` is the id of the preset whose prompt the row
 *   STILL matches verbatim, derived by the caller — nothing on disk records a
 *   preset id. So the control reports a fact rather than a memory: it shows the
 *   preset while the text is that preset's, and falls back to the placeholder
 *   the moment the user edits the prompt into something else. Leaving it blank
 *   at all times (the original behavior) made picking a preset look like a
 *   no-op, because the only visible effect was 60 lines below the fold.
 * - **One-shot action** (the family's "add a preset job"): no `value`, so the
 *   select snaps back to its placeholder after firing — it adds a NEW step
 *   rather than describing an existing one.
 */

import { inputClass } from './fields';

export default function PresetPicker({ id, label, presets, onPick, hint, value = '' }) {
  // Deliberately unfiltered by the row's current job type: a preset carries the
  // job type it needs, so picking one CONVERTS the step rather than being
  // inapplicable to it. Filtering hid the control entirely on a non-agent row,
  // leaving delete-and-re-add as the only way to turn a step into an audit.
  const rows = presets || [];
  if (!rows.length) return null;

  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {label}
      <select
        id={id}
        className={inputClass}
        // Guarded against a stale id: a `value` no match exists for would leave
        // React's <select> on whatever option the browser picked instead.
        value={rows.some((preset) => preset.id === value) ? value : ''}
        onChange={(event) => {
          const picked = rows.find((preset) => preset.id === event.target.value);
          if (picked) onPick(picked);
        }}
      >
        <option value="">Choose a preset…</option>
        {rows.map((preset) => (
          <option key={preset.id} value={preset.id} title={preset.summary}>
            {preset.label} — {preset.summary}
          </option>
        ))}
      </select>
      {hint && <span className="block mt-1 text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}
