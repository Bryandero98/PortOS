/**
 * Prompt-conditioner picker for models that offer a choice (#4081).
 *
 * MiniMax H3 reads the unnormalized hidden state after Qwen3-VL language layer
 * 49 and never evaluates the rest of the language model, so the conditioner can
 * be swapped for another checkpoint carrying the same layers — which changes how
 * the model *reads* a prompt without touching the diffusion weights. This is the
 * control for that choice.
 *
 * Presentational: options, selection, and download status are all owned by the
 * VideoGen page. Rendered only when the model actually offers more than one
 * option (the server decorates the list per model), so no runtime check lives
 * here.
 *
 * A substitute is a separate multi-GB pull, so its Download badge sits inline
 * with the select rather than behind the collapsed Advanced panel — the user has
 * to see the cost at the moment they pick it, and the page gates Generate on the
 * same status.
 */
import ModelDownloadBadge from '../media/ModelDownloadBadge';
import { formatBytes } from '../../utils/formatters.js';

const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

export default function TextEncoderPicker({
  options = [],
  value,
  onChange,
  status = null,
  onDownload,
  onCancel,
  disabled = false,
}) {
  if (options.length < 2) return null;
  const selected = options.find((option) => option.id === value) || options[0];
  // Formatted from the option's exact published byte count rather than a second
  // "~N GB" literal on the registry entry, so the option text, the Download
  // button and the post-download "Available · N" badge can never disagree.
  const sizeLabel = selected.sizeBytes ? formatBytes(selected.sizeBytes) : null;
  // Built-in conditioners ship inside the model's own weights, so they have no
  // separate download of their own to badge.
  const needsDownload = !selected.builtIn && (status === null || status.cached === false || status.downloading);

  return (
    <div className="mt-2">
      <label htmlFor="video-text-encoder" className="block text-xs font-medium text-gray-400 mb-1">
        Text encoder
      </label>
      <select
        id="video-text-encoder"
        value={selected.id}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={inputCls}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {option.sizeBytes ? ` (~${formatBytes(option.sizeBytes)} download)` : ''}
          </option>
        ))}
      </select>
      {selected.description && (
        <p className="text-[10px] text-gray-500 leading-snug mt-1">{selected.description}</p>
      )}
      {/* An uncensored conditioner is a deliberate choice, not a default —
          state what changed rather than leaving it to the model card. */}
      {selected.advisory && (
        <p className="text-[10px] text-port-warning leading-snug mt-1">{selected.advisory}</p>
      )}
      {needsDownload && (
        <div className="mt-1">
          <ModelDownloadBadge
            status={status}
            onDownload={() => onDownload?.(selected.id)}
            onCancel={onCancel}
            estimateLabel={sizeLabel ? `~${sizeLabel}` : undefined}
          />
        </div>
      )}
    </div>
  );
}
