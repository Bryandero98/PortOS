// Stacker News community stewardship. Account identity and community rules are
// machine-local runtime configuration; credentials are AES-GCM ciphertext only.
export const stackerNewsDdl = [
  `CREATE TABLE IF NOT EXISTS stacker_news_accounts (
    id UUID PRIMARY KEY,
    label TEXT NOT NULL,
    username TEXT NOT NULL,
    api_key_enc TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    monitoring_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    text_model TEXT NOT NULL DEFAULT '',
    vision_model TEXT NOT NULL DEFAULT '',
    rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (username)
  )`,
  `CREATE TABLE IF NOT EXISTS stacker_news_territories (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES stacker_news_accounts (id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    is_owned BOOLEAN NOT NULL DEFAULT FALSE,
    rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    remote_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stacker_news_territories_account ON stacker_news_territories (account_id)`,
  `CREATE TABLE IF NOT EXISTS stacker_news_items (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES stacker_news_accounts (id) ON DELETE CASCADE,
    territory_id UUID REFERENCES stacker_news_territories (id) ON DELETE SET NULL,
    remote_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    content_hash TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, remote_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stacker_news_items_account_received ON stacker_news_items (account_id, received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS stacker_news_analyses (
    id UUID PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES stacker_news_items (id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'deterministic',
    model TEXT NOT NULL DEFAULT '',
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stacker_news_analyses_item ON stacker_news_analyses (item_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS stacker_news_actions (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES stacker_news_accounts (id) ON DELETE CASCADE,
    item_id UUID REFERENCES stacker_news_items (id) ON DELETE SET NULL,
    territory_id UUID REFERENCES stacker_news_territories (id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    review_note TEXT NOT NULL DEFAULT '',
    executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stacker_news_actions_account_state ON stacker_news_actions (account_id, state, created_at DESC)`,
];
