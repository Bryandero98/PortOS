/**
 * Assembly-coverage gate for an already-validated Three.js scene spec.
 *
 * `threejsSculptSpecSchema` proves that every `detailInventory[].implementationPartIds`
 * entry names a real part. It never checks the inverse direction, so a spec can
 * declare eight identity-priority details, point all eight at the same box, or
 * promise a component it never builds, and still validate cleanly — one fused
 * mesh wearing a photograph.
 *
 * This module reads the parsed spec and reports where the assembly does not back
 * the inventory. Its honest limit: it proves the model built what the spec
 * promised, never that the spec promised enough.
 */

// Severity of a promised-but-unbuilt feature scales with how much of the
// subject's identity rides on it. A missing identity feature is a defect; a
// missing minor one is a note, because folding fine relief into a parent mesh
// is a legitimate modeling choice rather than an omission.
const UNBUILT_SEVERITY = { identity: 'error', major: 'warning', minor: 'note' };
const RANKED_PRIORITIES = new Set(['identity', 'major']);
const MAX_NAMES_IN_MESSAGE = 8;

/**
 * Depth-first flatten that carries, per part, the ancestor chain and whether the
 * part's own subtree contains any geometry at all.
 */
function flattenParts(parts) {
  const flat = [];
  const walk = (part, ancestorIds) => {
    const children = (part.children || []).map((child) => walk(child, [...ancestorIds, part.id]));
    const hasGeometry = Boolean(part.geometry);
    const node = {
      id: part.id,
      name: part.name || part.id,
      ancestorIds,
      hasGeometry,
      subtreeHasGeometry: hasGeometry || children.some((child) => child.subtreeHasGeometry),
    };
    flat.push(node);
    return node;
  };
  for (const part of parts || []) walk(part, []);
  return flat;
}

const listNames = (names) => (names.length > MAX_NAMES_IN_MESSAGE
  ? `${names.slice(0, MAX_NAMES_IN_MESSAGE).join(', ')} (+${names.length - MAX_NAMES_IN_MESSAGE} more)`
  : names.join(', '));

/**
 * @param {object} spec a spec that has already passed `threejsSculptSpecSchema`
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number}}
 */
export function evaluateThreejsPartCoverage(spec) {
  const parts = flattenParts(spec?.parts);
  const byId = new Map(parts.map((part) => [part.id, part]));
  const details = Array.isArray(spec?.detailInventory) ? spec.detailInventory : [];
  const implementedIds = new Set(details.flatMap((detail) => detail.implementationPartIds || []));
  const label = (id) => byId.get(id)?.name || id;
  const findings = [];

  // 1. Fusion — details whose ONLY implementing part is the same single part.
  const soleImplementers = new Map();
  for (const detail of details) {
    const ids = detail.implementationPartIds || [];
    if (ids.length !== 1) continue;
    const group = soleImplementers.get(ids[0]) || [];
    group.push(detail);
    soleImplementers.set(ids[0], group);
  }

  // Details already accounted for by a shared-part finding, so the folded-relief
  // pass below cannot report the same detail a second time.
  const groupedDetails = new Set();
  for (const [partId, group] of soleImplementers) {
    if (group.length < 2) continue;
    for (const detail of group) groupedDetails.add(detail);
    const ranked = group.filter((detail) => RANKED_PRIORITIES.has(detail.priority));
    if (ranked.length >= 2) {
      const features = ranked.map((detail) => detail.feature);
      findings.push({
        code: 'fused-parts',
        severity: 'error',
        partIds: [partId],
        features,
        message: `${features.length} promised features collapsed onto the single part "${label(partId)}" (${listNames(features)}). Build each as its own part instead of one fused mesh.`,
      });
      continue;
    }
    // At most one ranked feature owns the part and the rest are minor: relief
    // folded into the piece it rides on. A right answer is not a defect.
    findings.push({
      code: 'folded-detail',
      severity: 'note',
      partIds: [partId],
      features: group.map((detail) => detail.feature),
      message: `${group.length} details share the single part "${label(partId)}" (${listNames(group.map((detail) => detail.feature))}). Folding minor relief into the piece it rides on is expected.`,
    });
  }

  // 2. Orphan geometry — built but claimed by nobody. An ancestor only launders
  // attribution downward when it is itself a claimed *mesh*: letting a bare
  // group count would let one detail on the root claim the entire tree, which is
  // the fused-model failure this gate exists to catch.
  const orphans = parts.filter((part) => part.hasGeometry
    && !implementedIds.has(part.id)
    && !part.ancestorIds.some((id) => implementedIds.has(id) && byId.get(id)?.hasGeometry));
  if (orphans.length > 0) {
    findings.push({
      code: 'orphan-geometry',
      severity: 'warning',
      count: orphans.length,
      partIds: orphans.map((part) => part.id),
      message: `${orphans.length} geometry part(s) are claimed by no detailInventory entry (${listNames(orphans.map((part) => part.name))}). Unattributed geometry cannot be reviewed or refined.`,
    });
  }

  // 3. Minor detail folded into an implemented mesh above it — reported so the
  // reviewer sees the modeling decision, never as a defect. Classified BEFORE
  // the unbuilt pass because the two would otherwise contradict each other on
  // the same detail: a locator part with no geometry of its own whose parent
  // mesh is implemented has not gone unbuilt, it has been folded in.
  const foldedNotes = [];
  const foldedDetails = new Set();
  for (const detail of details) {
    if (detail.priority !== 'minor' || groupedDetails.has(detail)) continue;
    const ids = detail.implementationPartIds || [];
    if (ids.length !== 1) continue;
    const part = byId.get(ids[0]);
    const parentId = part?.ancestorIds.findLast((id) => implementedIds.has(id) && byId.get(id)?.hasGeometry);
    if (!parentId) continue;
    foldedDetails.add(detail);
    foldedNotes.push({
      code: 'folded-detail',
      severity: 'note',
      partIds: [part.id],
      features: [detail.feature],
      message: `"${detail.feature}" is minor relief on "${label(parentId)}". Folding it into its parent is the correct modeling choice.`,
    });
  }

  // 4. Unbuilt details — a promised feature whose parts contain no geometry
  // anywhere in their subtrees and which nothing above them carries either, so
  // nothing was ever built for it.
  for (const detail of details) {
    if (foldedDetails.has(detail)) continue;
    const resolved = (detail.implementationPartIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (resolved.length === 0 || resolved.some((part) => part.subtreeHasGeometry)) continue;
    findings.push({
      code: 'unbuilt-detail',
      severity: UNBUILT_SEVERITY[detail.priority] || 'warning',
      partIds: resolved.map((part) => part.id),
      features: [detail.feature],
      message: `"${detail.feature}" (${detail.priority}) points only at parts with no geometry (${listNames(resolved.map((part) => part.name))}), so nothing was built for it.`,
    });
  }

  findings.push(...foldedNotes);

  const countBy = (severity) => findings.filter((finding) => finding.severity === severity).length;
  return {
    findings,
    errorCount: countBy('error'),
    warningCount: countBy('warning'),
    noteCount: countBy('note'),
  };
}

/**
 * Default refinement feedback derived from a stored coverage result. Only
 * error-severity findings are worth spending another provider run on; a spec
 * with none returns '' so the caller falls back to its own generic wording.
 */
export function buildThreejsCoverageFeedback(coverage) {
  const errors = (coverage?.findings || []).filter((finding) => finding.severity === 'error');
  if (errors.length === 0) return '';
  return [
    'The previous pass failed the assembly-coverage check. Fix these before anything else:',
    ...errors.map((finding, index) => `${index + 1}. ${finding.message}`),
  ].join('\n');
}
