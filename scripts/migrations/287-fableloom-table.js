/**
 * Registration stub for the fableloom_stories table (FableLoom branching
 * narratives). The table itself is created idempotently by ensureSchema at
 * boot (server/lib/db/schema/pipeline.js) — this stub exists so the applied
 * ledger records when the domain arrived on an install. Mirrors
 * 212-games-table.js.
 */

export default {
  async up() {
    console.log('🧶 fableloom_stories: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
