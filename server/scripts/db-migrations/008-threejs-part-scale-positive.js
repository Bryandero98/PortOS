/**
 * Repair non-positive `parts[].scale` components on Three.js model specs already
 * in Postgres (#3484).
 *
 * `partSchema.scale` used to be a plain `finite` triple, so a provider-authored
 * `[1, -1, 1]` validated and stored: a negative component reverses the winding
 * order, which renders the part inside-out (lit from within, silhouette intact)
 * rather than erroring, and `[1, 0, 1]` collapses it to an invisible plane. The
 * schema now floors every component at 1e-4, which fixes new generations but
 * would turn an already-stored spec into a hard parse failure the next time
 * `buildThreejsFactorySource()` runs — i.e. the download button on a model an
 * older install generated between v2.34.0 and now would start 500ing, with no
 * in-app remedy short of regenerating. This normalizes those rows instead.
 *
 * The repair is deliberately conservative — it makes the stored spec
 * representable without restyling the model:
 *   - a negative component takes its magnitude (`Math.abs`). The size was the
 *     intent; the sign was the normals bug, and dropping it un-flips the part.
 *   - a zero or sub-floor component is raised to the floor, which keeps it
 *     visually degenerate exactly as it renders today rather than popping a
 *     hidden part back to full size.
 *
 * The floor is a frozen point-in-time copy of `MIN_PART_SCALE` in
 * `server/lib/threejsModel.js` rather than an import: a migration is a
 * point-in-time transform and must not shift if that bound is later retuned.
 *
 * `updated_at` is deliberately NOT bumped — this is a derived normalization, not
 * a user edit, and the models list orders by it. Three.js models are not
 * federated (no `schemaVersions` entry, no peer-sync fan-out), so there is no LWW
 * clock or checksum to disturb either.
 *
 * Tombstoned models are included: they can be restored, and a restored model
 * should not be the one record whose export still throws.
 *
 * Idempotent: a spec whose scales are already positive is skipped, so a re-run
 * writes nothing.
 */

const MIN_PART_SCALE = 1e-4;

const repairComponent = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.max(Math.abs(value), MIN_PART_SCALE);
};

/**
 * Rewrite one part subtree, returning the SAME reference when nothing changed so
 * the caller can tell a repaired row from an untouched one.
 */
const repairPart = (part) => {
  if (!part || typeof part !== 'object') return part;

  const scale = Array.isArray(part.scale) ? part.scale.map(repairComponent) : part.scale;
  const scaleChanged = Array.isArray(part.scale)
    && scale.some((value, index) => value !== part.scale[index]);

  const children = Array.isArray(part.children) ? part.children.map(repairPart) : part.children;
  const childrenChanged = Array.isArray(part.children)
    && children.some((child, index) => child !== part.children[index]);

  if (!scaleChanged && !childrenChanged) return part;
  return { ...part, scale, children };
};

export async function up(client) {
  const { rows } = await client.query(
    `SELECT id, data FROM threejs_models
     WHERE jsonb_typeof(data->'spec'->'parts') = 'array'
       AND jsonb_array_length(data->'spec'->'parts') > 0`,
  );
  let touched = 0;
  for (const row of rows) {
    const parts = row.data?.spec?.parts;
    if (!Array.isArray(parts)) continue;
    const repaired = parts.map(repairPart);
    if (repaired.every((part, index) => part === parts[index])) continue;
    await client.query(
      `UPDATE threejs_models
       SET data = jsonb_set(data, '{spec,parts}', $1::jsonb, false)
       WHERE id = $2`,
      [JSON.stringify(repaired), row.id],
    );
    touched += 1;
  }
  console.log(`🧊 three.js part scale: repaired ${touched} of ${rows.length} model${rows.length === 1 ? '' : 's'} with a scene spec`);
}
