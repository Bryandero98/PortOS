// MeatSpace POST run/attempt DDL (#4441) — normalized, machine-local practice
// evidence. These rows are intentionally excluded from federation and the
// generic record-audit stream: they can contain personal performance history.
export const postDdl = [
  `CREATE TABLE IF NOT EXISTS post_runs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('benchmark', 'test', 'training')),
    local_day DATE NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('planned', 'in_progress', 'completed')),
    planned JSONB NOT NULL DEFAULT '{}'::jsonb,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_runs_mode_day ON post_runs (mode, local_day DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_post_runs_started ON post_runs (started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS post_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES post_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    module TEXT NOT NULL,
    drill_type TEXT NOT NULL,
    difficulty JSONB,
    config_version TEXT,
    correct BOOLEAN,
    score DOUBLE PRECISION CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    latency_ms BIGINT NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    completion DOUBLE PRECISION CHECK (completion IS NULL OR (completion >= 0 AND completion <= 1)),
    hint_used BOOLEAN NOT NULL DEFAULT FALSE,
    confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    input_mode TEXT NOT NULL DEFAULT 'unknown',
    scorer_provenance TEXT NOT NULL DEFAULT 'unknown',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_attempts_run ON post_attempts (run_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_post_attempts_skill ON post_attempts (module, drill_type)`,
];
