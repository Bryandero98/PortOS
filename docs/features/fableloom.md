# FableLoom — Branching Narratives

FableLoom is the Create-section workspace for branching narratives: stories a
reader plays through by *chatting their intent* rather than picking from a
fixed menu. A loom holds one or more episodes (like a series holds episodes);
each episode is a directed graph of scene nodes with multiple endings. Every
transition out of a scene is labeled with a reader **intent** ("sneak past the
guard") plus example phrasings — at read time an LLM matches the reader's
free-text message against those intents and moves them through the graph, or
answers in-world without leaving the scene when nothing matches.

## Concepts

| Term | Meaning |
|---|---|
| **Loom** | A branching-narrative story (`loom-*`): name/logline/premise, optional `universeId` + `seriesId` links, episodes. |
| **Episode** | One playable graph (`ep-*`): title, synopsis (feeds generation), `startNodeId`, nodes. |
| **Scene node** | One story beat (`node-*`): prose, image prompt + rendered image, ending flag/label, transitions. |
| **Transition** | An intent-labeled edge (`tr-*`): `intent`, `triggers` (example phrasings), spoiler-safe `description`, `targetNodeId`. |

## Surfaces

- **`/fableloom`** — index: create/delete looms, link a universe (canon +
  style for AI) and optionally a pipeline series.
- **`/fableloom/:loomId/:episodeId/:nodeId?`** — the visual editor: an SVG
  scene-graph canvas (BFS-layered; drag to reposition, positions persist),
  a scene editor rail (prose, endings, intent paths, scene image), and a
  structure/review rail when nothing is selected. `?play=1` opens the reader
  drawer.
- **Play drawer** — the reader chat. Sessions are client-side state
  (restart is free; nothing persists server-side).

## AI lanes (all direct user actions; stage prompts in `data/prompts/stages/`)

| Stage | What it does |
|---|---|
| `fableloom-weave-episode` | Generates a full episode graph (scenes, intents, triggers, endings) from the loom premise + episode synopsis + linked-universe canon. |
| `fableloom-branch-node` | Grows N new intent-labeled branches out of one scene. |
| `fableloom-play-turn` | Resolves one reader message: `move` through a matched transition or `stay` with in-world narration. |
| `fableloom-review` | Story-editor critique (intent clarity, branch coherence, ending payoff) layered over the deterministic checks. |

Deterministic graph validation (no LLM) lives in
`server/lib/fableLoomGraph.js` — reachability from the opening scene, dead
ends, dangling transitions, unreachable endings, duplicate/empty intents —
and renders in the editor's Structure panel via
`GET /api/fableloom/:id/episodes/:episodeId/validate`.

## Scene images

Each node carries an `imagePrompt`; **Generate** posts to the shared
`/api/image-gen/generate` queue with a `fableLoom: { loomId, episodeId,
nodeId }` destination tag. The completion hook
(`server/services/fableLoomSceneImageHook.js`) files the finished render onto
the node durably — even if the editor unmounted mid-render — with
newest-render-wins per node. The loom's `styleNotes` are appended to the
prompt for a consistent look.

## Storage

`fableloom_stories` (db-primary; one row per loom, full record in `data`
JSONB, `universe_id`/`series_id` mirrored as soft refs). **Machine-local — no
federation**: no dataSync category, no sync cursor, hard deletes (same posture
as Games / Writers Room). Service: `server/services/fableLoom/` (records /
weave / store / db); routes: `server/routes/fableLoom.js` (`/api/fableloom`).

## Relationship to the series pipeline

A loom can *link* to a pipeline series (`seriesId`) but is its own record
type — branching narratives don't run the linear issue/stage pipeline
(manuscript formats, autopilot, federation semantics don't apply to a graph).
Deeper integration (a branching series type surfaced inside series
management) is deliberately deferred.
