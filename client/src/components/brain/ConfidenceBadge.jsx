import { getConfidenceColor } from './constants';

/**
 * Classifier confidence as a colored percentage.
 *
 * Renders nothing when `confidence` is undefined — an entry no model classified
 * (a URL filed to Links, or any capture taken with auto-classify off) has no
 * score to show, and a hard-coded 0% would read as "the AI was certain it was
 * wrong" rather than "no AI was involved".
 */
export default function ConfidenceBadge({ confidence }) {
  if (confidence === undefined) return null;
  return (
    <span className={`text-xs ${getConfidenceColor(confidence)}`}>
      {Math.round(confidence * 100)}%
    </span>
  );
}
