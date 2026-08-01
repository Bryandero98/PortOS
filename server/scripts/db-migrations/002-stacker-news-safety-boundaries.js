/**
 * Move preview-build Stacker News credentials out of account configuration and
 * finish provenance/idempotency backfills before enforcing the final contract.
 * Fresh installs already have the final schema, so every branch is a no-op.
 */
export async function up(client) {
  const legacy = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='stacker_news_accounts' AND column_name='api_key_enc'
     ) AS present`,
  );
  if (legacy.rows[0]?.present) {
    await client.query(
      `INSERT INTO stacker_news_credentials (account_id,api_key_enc)
       SELECT id,api_key_enc FROM stacker_news_accounts WHERE api_key_enc IS NOT NULL AND api_key_enc <> ''
       ON CONFLICT (account_id) DO NOTHING`,
    );
    await client.query('ALTER TABLE stacker_news_accounts DROP COLUMN api_key_enc');
  }
  await client.query(
    `UPDATE stacker_news_analyses a SET source_content_hash=i.content_hash
     FROM stacker_news_items i WHERE a.item_id=i.id AND a.source_content_hash=''`,
  );
  await client.query("UPDATE stacker_news_actions SET idempotency_key='legacy:' || id::text WHERE idempotency_key IS NULL OR idempotency_key=''");
  await client.query('ALTER TABLE stacker_news_actions ALTER COLUMN idempotency_key SET NOT NULL');
}
