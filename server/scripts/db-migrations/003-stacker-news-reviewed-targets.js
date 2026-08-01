/**
 * Bind every review to the external account and destination that the moderator
 * actually saw, while allowing terminal actions to be submitted for a new review.
 */
export async function up(client) {
  await client.query("ALTER TABLE stacker_news_actions ADD COLUMN IF NOT EXISTS reviewed_target JSONB NOT NULL DEFAULT '{}'::jsonb");
  await client.query(
    `UPDATE stacker_news_actions a
     SET reviewed_target=jsonb_build_object(
       'username', ac.username,
       'territorySlug', COALESCE((SELECT t.slug FROM stacker_news_territories t WHERE t.id=a.territory_id), ''),
       'remoteItemId', COALESCE((SELECT i.remote_id FROM stacker_news_items i WHERE i.id=a.item_id), '')
     )
     FROM stacker_news_accounts ac
     WHERE ac.id=a.account_id AND a.reviewed_target='{}'::jsonb`,
  );
  await client.query('DROP INDEX IF EXISTS idx_stacker_news_actions_idempotency_key');
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_stacker_news_actions_active_idempotency_key ON stacker_news_actions (idempotency_key) WHERE state IN ('pending_review','approved','executing')",
  );
}
