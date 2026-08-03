# Games

The Game studio binds a managed app to reusable Sprite, Music, and gallery Artwork records, publishes artwork and music into the app repository, compiles immutable versioned asset manifests, and stores user-triggered AI review history.

| File | Purpose |
|---|---|
| `store.js` | PostgreSQL/collectionStore dispatcher plus per-Game write serialization and manifest directory paths. |
| `db.js` | PostgreSQL leaf I/O for `games` JSONB records. |
| `records.js` | Game CRUD, managed-app validation, and sprite/music/artwork bind operations. |
| `publishCore.js` | Shared per-repo-serialized publish lane: path anchoring, occupied-destination guards, atomic writes, SHA-256 provenance stamps. |
| `artwork.js` | Gallery-artwork publish lane over `publishCore.js`. |
| `musicPublish.js` | Music-library audio publish lane over `publishCore.js`. |
| `compile.js` | Deterministic, idempotent asset-manifest compiler with SHA-256 references. |
| `integrity.js` | Bundle preflight, imported-runtime resolution, and current manifest/source hash verification. |
| `feedback.js` | Explicitly user-triggered provider/model/effort feedback and history persistence. |
| `index.js` | Public Game service barrel. |
