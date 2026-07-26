/**
 * Register universe style-reference schema v5.
 *
 * Universe records live as JSONB and are sanitized lazily, so no DDL is
 * required. Existing rows read with `styleReferences: []`; their next normal
 * write persists the v5 shape. Federation gates the wire field separately.
 */
export async function up() {
  console.log('✅ Universe style-reference schema registered (lazy JSONB backfill)');
}
