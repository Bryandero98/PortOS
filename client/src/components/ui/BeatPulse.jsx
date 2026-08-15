/**
 * BeatPulse — the metronome you can SEE: one dot per beat of the bar, the
 * current one lit.
 *
 * Three surfaces draw this same row (the song `Metronome`, and the SongBook
 * drum + chord play-along transports). They each grew their own copy and had
 * already drifted on lit color and dot size, so the widget lives here once and
 * every host renders it. Rendering only the dots is deliberate: each host pairs
 * them with a different readout ("Bar 3", "2/8 bars", "5/12 chords"), so the
 * text stays with the host.
 *
 * Conventions the copies agreed on and this keeps:
 * - beat 1 is the downbeat and reads a size larger, matching the accented click;
 * - a count-in beat lights amber (`port-warning`) so "not yet" is unmistakable;
 * - unlit dots are `port-border`, i.e. the same weight as any inert chrome.
 *
 * `beat` is 1-based and `null`/`0` when stopped — the audible click is easy to
 * lose under a backing track, so "nothing lit" has to read as stopped.
 */

// Lit dots are `port-success`, not `port-accent`: in the transport bars the
// accent color already means "this control is engaged" (`activeCtrlClass`), and
// a beat dot borrowing it competed with the play button. Green reads as
// "sounding now" and stays clearly distinct from the amber count-in.
const litTone = (countingIn) => (countingIn ? 'bg-port-warning' : 'bg-port-success');

export default function BeatPulse({ beatsPerBar = 4, beat = null, countingIn = false, className = '' }) {
  // A malformed time signature must not blank the row out.
  const beats = Number.isFinite(beatsPerBar) ? Math.max(1, Math.floor(beatsPerBar)) : 4;
  const label = countingIn
    ? `Counting in, beat ${beat || 1}`
    : (beat ? `Beat ${beat}` : 'Stopped');

  return (
    <div
      className={`flex items-center gap-1.5 ${className}`.trim()}
      role="status"
      aria-live="off"
      aria-label={label}
    >
      {Array.from({ length: beats }, (_, i) => {
        const lit = beat === i + 1;
        const downbeat = i === 0;
        return (
          <span
            key={i}
            aria-hidden="true"
            className={`rounded-full transition-transform duration-75 ${
              downbeat ? 'w-3 h-3' : 'w-2 h-2'
            } ${lit ? litTone(countingIn) : 'bg-port-border'} ${lit ? 'scale-125' : 'scale-100'}`}
          />
        );
      })}
    </div>
  );
}
