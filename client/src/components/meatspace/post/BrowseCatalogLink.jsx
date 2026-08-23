import { Link } from 'react-router';
import { ArrowRight, Compass } from 'lucide-react';

/**
 * The "there is more than what's on this page" link into the Practice Library.
 *
 * Every POST surface that shows a FILTERED view — the launcher's enabled-drill
 * summaries, the Practice Plan's topic toggles — needs one, because each of them
 * reads as the complete inventory and isn't. One component so the three call
 * sites can't drift in prose or styling.
 */
export default function BrowseCatalogLink({ label = 'Browse every test type', hint }) {
  return (
    <Link
      to="/post/explore"
      className="flex items-center justify-between gap-2 px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-400 hover:text-white hover:border-port-accent/60 transition-colors"
    >
      <span className="flex items-center gap-2 min-w-0">
        <Compass size={14} className="shrink-0 text-port-accent" />
        <span className="min-w-0">
          {hint && <span className="text-gray-500">{hint} </span>}
          {label}
        </span>
      </span>
      <ArrowRight size={14} className="shrink-0" />
    </Link>
  );
}
