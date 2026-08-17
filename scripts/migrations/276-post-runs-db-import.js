/**
 * Register the normalized POST run/attempt migration (#4441).
 *
 * The real legacy-file import needs a confirmed healthy PostgreSQL connection,
 * while this migration runner executes before the DB gate. The POST store runs
 * `server/scripts/migratePostRunsToDB.js` on its first PostgreSQL-backed access;
 * that importer is independently marker-gated and idempotent.
 */
export default {
  async up() {
    console.log('🧪 POST run migration: DB-backed legacy import runs on first POST store access');
  },
};
