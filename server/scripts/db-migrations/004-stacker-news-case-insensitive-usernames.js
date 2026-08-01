/**
 * Stacker News usernames are case-insensitive. Preserve that identity invariant
 * in PostgreSQL as well as in service-level normalization.
 */
export async function up(client) {
  await client.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_stacker_news_accounts_username_ci ON stacker_news_accounts (LOWER(username))',
  );
}
