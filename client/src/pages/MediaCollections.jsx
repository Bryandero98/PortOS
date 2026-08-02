import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, FolderOpen, Inbox, Trash2, Image as ImageIcon, Film, Search } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listMediaCollections, createMediaCollection, deleteMediaCollection,
  listVideoHistory, listImageGallery,
} from '../services/api';
import { buildUnsortedCollection } from '../lib/unsorted';
import {
  applyCollectionView, splitCollectionName, collectionItemCount,
  COLLECTION_SORTS, DEFAULT_COLLECTION_SORT, normalizeCollectionSort,
} from '../lib/mediaCollectionList';
import { middleTruncate } from '../utils/formatters';
import MediaImage from '../components/MediaImage';
import SyncBadge from '../components/sync/SyncBadge';
import { useSyncIntegrity, syncBadgeStatus } from '../hooks/useSyncIntegrity';

// Cap for the card title AFTER the auto-creator prefix moves to its badge.
// Middle-truncating at this length keeps the trailing date/qualifier — the only
// thing distinguishing sibling auto-generated names — visible, which a plain
// end-clip (`line-clamp`) always eats.
const TITLE_MAX_CHARS = 34;

// Resolve a collection's cover-thumbnail URL. Default = newest item by
// addedAt; user-pinned coverKey wins when set. We need full image/video
// records to build the thumbnail src, so the page fetches both lists once
// and shares them across cards via a Map lookup.
const resolveCover = (collection, imagesByName, videosById) => {
  const items = collection.items || [];
  if (items.length === 0) return null;

  const lookup = (it) => {
    if (it.kind === 'image') {
      const img = imagesByName.get(it.ref);
      return img ? (img.path || `/data/images/${img.filename}`) : null;
    }
    const vid = videosById.get(it.ref);
    return vid?.thumbnail ? `/data/video-thumbnails/${vid.thumbnail}` : null;
  };

  if (collection.coverKey) {
    const pinned = items.find((it) => `${it.kind}:${it.ref}` === collection.coverKey);
    if (pinned) {
      const url = lookup(pinned);
      if (url) return url;
    }
  }
  // Fallback: single O(n) pass for the most-recently-added item that has a
  // renderable thumbnail. Sorting all items is O(n log n) and gets expensive
  // on collections approaching ITEMS_MAX (5000).
  let bestUrl = null;
  let bestTs = -Infinity;
  for (const it of items) {
    const url = lookup(it);
    if (!url) continue;
    const ts = new Date(it.addedAt || 0).getTime();
    if (ts > bestTs) { bestTs = ts; bestUrl = url; }
  }
  return bestUrl;
};

export default function MediaCollections() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [imagesByName, setImagesByName] = useState(new Map());
  const [videosById, setVideosById] = useState(new Map());

  // Sync integrity — no peers prop (the page doesn't fetch peers itself),
  // so the hook fetches instances internally.
  const sync = useSyncIntegrity('mediaCollection');

  const refresh = async () => {
    setLoading(true);
    const [cols, images, videos] = await Promise.all([
      listMediaCollections().catch(() => []),
      listImageGallery().catch(() => []),
      listVideoHistory().catch(() => []),
    ]);
    setCollections(Array.isArray(cols) ? cols : []);
    setImagesByName(new Map((images || []).map((i) => [i.filename, i])));
    setVideosById(new Map((videos || []).map((v) => [v.id, v])));
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const created = await createMediaCollection({ name: trimmed }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to create');
      return null;
    });
    setCreating(false);
    if (created) {
      setCollections((prev) => [...prev, created]);
      setName('');
      toast.success(`Created "${created.name}"`);
    }
  };

  const handleDelete = async (collection) => {
    setCollections((prev) => prev.filter((c) => c.id !== collection.id));
    await deleteMediaCollection(collection.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      refresh();
    });
  };

  const images = useMemo(() => Array.from(imagesByName.values()), [imagesByName]);
  const videos = useMemo(() => Array.from(videosById.values()), [videosById]);
  const unsorted = useMemo(
    () => buildUnsortedCollection(collections, images, videos),
    [collections, images, videos],
  );

  const enriched = useMemo(() => {
    // Pinned synthetic "Unsorted" entry first, then real collections.
    const all = [unsorted, ...collections];
    return all.map((c) => {
      const counts = (c.items || []).reduce((acc, it) => {
        acc[it.kind] = (acc[it.kind] || 0) + 1;
        return acc;
      }, { image: 0, video: 0 });
      // Lift the shared auto-creator prefix ("Creative Director: ") out of the
      // title into its own badge, then middle-truncate what's left — otherwise
      // every auto-generated card renders the same clipped prefix and the
      // trailing project name/date that tells them apart is what gets cut.
      const { badge, title } = splitCollectionName(c.name);
      return {
        ...c,
        cover: resolveCover(c, imagesByName, videosById),
        counts,
        badge,
        displayTitle: middleTruncate(title, TITLE_MAX_CHARS),
      };
    });
  }, [collections, unsorted, imagesByName, videosById]);

  // Filter/sort state lives in the URL so a filtered grid is shareable and
  // survives a back-navigation from a collection. `empty=1` OPTS IN to showing
  // empty collections — the default (param absent) hides them, because an empty
  // auto-created collection has nothing to open.
  const query = searchParams.get('q') || '';
  const sort = normalizeCollectionSort(searchParams.get('sort'));
  const hideEmpty = searchParams.get('empty') !== '1';

  const updateParams = useCallback((patch, { replace = false } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace });
  }, [setSearchParams]);

  // Search + sort first, then apply "hide empty" as a slice of that result, so
  // the "N empty hidden" count only ever names rows the toggle removed — not
  // rows the search already dropped.
  const matching = useMemo(
    () => applyCollectionView(enriched, { query, sort, hideEmpty: false }),
    [enriched, query, sort],
  );
  const visible = useMemo(
    () => (hideEmpty ? matching.filter((c) => collectionItemCount(c) > 0) : matching),
    [matching, hideEmpty],
  );
  const hiddenEmptyCount = matching.length - visible.length;

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="flex gap-2 items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          aria-label="New collection name"
          placeholder="New collection name"
          className="flex-1 bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        />
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="px-3 py-2 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-40"
        >
          <Plus className="w-4 h-4" /> Create
        </button>
      </form>

      {/* Filter row. Stacks under `sm` so the search box keeps a usable width
          on a phone instead of sharing one line with the sort + toggle. */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <label htmlFor="collection-search" className="sr-only">Search collections</label>
          <input
            id="collection-search"
            type="search"
            value={query}
            onChange={(e) => updateParams({ q: e.target.value }, { replace: true })}
            placeholder="Search collections…"
            className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
          />
        </div>
        <label htmlFor="collection-sort" className="sr-only">Sort collections</label>
        <select
          id="collection-sort"
          value={sort}
          onChange={(e) => updateParams({ sort: e.target.value === DEFAULT_COLLECTION_SORT ? '' : e.target.value })}
          className="bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        >
          {COLLECTION_SORTS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-400 px-1 py-2 cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => updateParams({ empty: e.target.checked ? '' : '1' })}
            className="accent-port-accent"
          />
          Hide empty
        </label>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : enriched.length === 0 ? (
        <div className="text-gray-500 text-sm bg-port-card border border-port-border rounded-lg p-6 text-center">
          No collections yet. Create one above, or use the folder icon on any image/video card to start a new collection.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-gray-500 text-sm bg-port-card border border-port-border rounded-lg p-6 text-center space-y-2">
          <div>
            {hiddenEmptyCount > 0
              ? `No collections with items match${query ? ' that search' : ''}.`
              : 'No collections match that search.'}
          </div>
          {hiddenEmptyCount > 0 && (
            <button
              type="button"
              onClick={() => updateParams({ empty: '1' })}
              className="text-port-accent hover:underline"
            >
              Show {hiddenEmptyCount} empty {hiddenEmptyCount === 1 ? 'collection' : 'collections'}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {hiddenEmptyCount > 0 && (
            <div className="text-xs text-gray-500">
              {hiddenEmptyCount} empty {hiddenEmptyCount === 1 ? 'collection' : 'collections'} hidden.{' '}
              <button type="button" onClick={() => updateParams({ empty: '1' })} className="text-port-accent hover:underline">
                Show
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {visible.map((c) => (
              <div
                key={c.id}
                className={`bg-port-card border rounded-xl overflow-hidden flex flex-col ${c.synthetic ? 'border-port-accent/40' : 'border-port-border'}`}
              >
                <Link
                  to={`/media/collections/${encodeURIComponent(c.id)}`}
                  className="block aspect-square bg-port-bg relative"
                >
                  {c.cover ? (
                    // A cover can point at a pruned video thumbnail or an unpulled
                    // peer asset; MediaImage degrades to the syncing tile instead
                    // of the browser's broken-image icon.
                    <MediaImage src={c.cover} alt={c.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-600">
                      {c.synthetic ? <Inbox className="w-12 h-12" /> : <FolderOpen className="w-12 h-12" />}
                    </div>
                  )}
                </Link>
                <div className="p-2 space-y-1.5 flex-1 flex flex-col">
                  {c.badge && (
                    <span className="inline-block self-start text-[9px] uppercase tracking-wide text-gray-400 bg-port-bg border border-port-border rounded px-1.5 py-0.5">
                      {c.badge}
                    </span>
                  )}
                  <Link to={`/media/collections/${encodeURIComponent(c.id)}`} className="text-sm text-white hover:text-port-accent break-words" title={c.name}>
                    {c.displayTitle}
                  </Link>
                  <div className="flex items-center gap-2 text-[10px] text-gray-500">
                    {c.counts.image > 0 && <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" />{c.counts.image}</span>}
                    {c.counts.video > 0 && <span className="flex items-center gap-1"><Film className="w-3 h-3" />{c.counts.video}</span>}
                    {c.counts.image === 0 && c.counts.video === 0 && <span>Empty</span>}
                  </div>
                  <div className="flex-1" />
                  <div className="flex items-center justify-between gap-1">
                    {!c.synthetic && (
                      <SyncBadge
                        status={syncBadgeStatus(sync, c.id)}
                        onClick={() => navigate(`/media/collections/${encodeURIComponent(c.id)}/sync`)}
                      />
                    )}
                    {!c.synthetic && (
                      <button
                        type="button"
                        onClick={() => handleDelete(c)}
                        className="px-1.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error text-[10px] rounded flex items-center gap-1"
                        title="Delete collection"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
