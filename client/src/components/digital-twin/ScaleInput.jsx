const DEFAULT_LABELS = ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'];
const SHORT_LABELS = ['SD', 'D', 'N', 'A', 'SA'];
const VALUES = [1, 2, 3, 4, 5];

export default function ScaleInput({ labels, value, onChange, disabled, groupLabel }) {
  // A caller-supplied `labels` array may be short or sparse — fall back per position
  // so the accessible name never announces "undefined".
  const labelFor = (val) => labels?.[val - 1] || DEFAULT_LABELS[val - 1];

  return (
    <div className="flex gap-2 justify-center" role="group" aria-label={groupLabel || 'Rating scale'}>
      {VALUES.map((val) => {
        const selected = value === val;
        return (
          <button
            key={val}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={`${val} - ${labelFor(val)}`}
            onClick={() => onChange(val)}
            className={`flex-1 min-w-[48px] min-h-[48px] flex flex-col items-center justify-center rounded-lg border transition-all ${
              selected
                ? 'bg-port-accent border-port-accent text-white'
                : 'bg-port-bg border-port-border text-gray-400 hover:border-gray-500 hover:text-gray-300'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span className="text-lg font-bold">{val}</span>
            <span className="text-[10px] leading-tight mt-0.5 hidden sm:block">{labelFor(val)}</span>
            <span className="text-[10px] leading-tight mt-0.5 sm:hidden">{SHORT_LABELS[val - 1]}</span>
          </button>
        );
      })}
    </div>
  );
}
