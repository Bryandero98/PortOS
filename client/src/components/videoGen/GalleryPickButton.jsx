/**
 * The "open the gallery picker" trigger shared by every gallery-image slot on
 * the Video Gen form — the frame panels, the multi-keyframe rows, and the
 * IC-LoRA reference rows. Each one hands the click back to the page, which owns
 * the single GalleryImagePicker modal and records which slot the pick lands in.
 *
 * `filled` flips both the copy and the accessible name together (WCAG 2.5.3 —
 * a voice-control user says what they can see), so a slot that already holds an
 * image invites a swap rather than a first pick.
 */
import { Images } from 'lucide-react';

export default function GalleryPickButton({ label, filled = false, onClick }) {
  const action = filled ? 'change image' : 'pick from gallery';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} — ${action}`}
      className="w-full flex items-center justify-center gap-2 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-300 hover:text-white hover:border-port-accent focus:outline-none focus:border-port-accent"
    >
      <Images className="w-3.5 h-3.5" />
      {filled ? 'Change image…' : 'Pick from gallery…'}
    </button>
  );
}
