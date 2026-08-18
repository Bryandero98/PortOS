import { useMemo, useCallback } from 'react';
import MediaLightbox from './MediaLightbox';
import { getMediaNavProps } from '../../lib/mediaNavigation';
import { computeImageVariantGroup } from './variants';
import { updateImagePrompt, updateVideoPrompt } from '../../services/apiImageVideo';

// Thin wrapper around MediaLightbox that owns the consistent wiring every
// page repeated by hand: open/close, prev/next nav, and the annotation
// lookup/patch dance. Page-specific handlers pass through as-is.
//
// MediaLightbox already gates SendToVideo / Clean on `!isVideo` and
// Continue on `isVideo`. Remix works for both kinds — callers should
// dispatch by `item.kind` inside their handler (see useMediaPreviewActions).
//
// Nav props win over handlers (spread order) so a stray `onPrevious`/`onNext`
// in a caller can't accidentally shadow the wrapper's navigation contract.
export default function MediaPreview({
  preview,
  setPreview,
  items,
  annotations,
  updateAnnotation,
  onPromptSaved,
  ...handlers
}) {
  const navProps = useMemo(
    () => getMediaNavProps(items, preview, setPreview),
    [items, preview, setPreview]
  );
  // Original-vs-cleaned toggle. Computed from the same `items` list that
  // drives prev/next nav — so if the cleaned copy was auto-filed into this
  // page's source collection, both variants are present and the toggle
  // appears. Returns null for non-image previews or single-variant items.
  const variantGroup = useMemo(
    () => computeImageVariantGroup(preview, items),
    [preview, items]
  );
  const onSelectVariant = useCallback((nextItem) => {
    if (!nextItem) return;
    setPreview(nextItem);
  }, [setPreview]);
  const savePrompt = useCallback(async (item, prompt) => {
    const result = item.kind === 'image'
      ? await updateImagePrompt(item.filename, prompt, { silent: true })
      : await updateVideoPrompt(item.id, prompt, { silent: true });
    const nextPrompt = result?.prompt || '(no prompt)';
    setPreview((current) => current?.key === item.key
      ? { ...current, prompt: nextPrompt, raw: { ...current.raw, prompt: result?.prompt || '' } }
      : current);
    onPromptSaved?.(item, nextPrompt);
    return result;
  }, [onPromptSaved, setPreview]);
  return (
    <MediaLightbox
      item={preview}
      onClose={() => setPreview(null)}
      annotation={annotations?.[preview?.key] ?? null}
      onAnnotationChange={preview && updateAnnotation ? (patch) => updateAnnotation(preview.key, patch) : undefined}
      onPromptChange={savePrompt}
      variantGroup={variantGroup}
      onSelectVariant={onSelectVariant}
      {...handlers}
      {...navProps}
    />
  );
}
