/**
 * Disassembly + part-picking maths for the procedural sculpt spec
 * (`server/lib/threejsModel.js`), shared by the Three.js Models preview.
 *
 * Explode and the picker MUST agree on what "a part" is — if they disagree,
 * both are wrong (you separate one thing and select another). That single
 * definition lives here:
 *
 * - A part flagged `explodeWithParent` is **surface relief** (serrations, stria,
 *   trim, port floors). It rides its parent: it never moves on its own, and a
 *   click on it resolves up to the part it belongs to. Without this, a
 *   disassembly shatters into a comb of loose slivers.
 * - A part whose (non-relief) descendants carry the geometry is a **container**:
 *   it is descended through, and its children are the things that move.
 * - Anything else that is not relief is a **leaf**: it moves as one rigid unit
 *   (with its relief) and selects on its own.
 *
 * Separation is a layout **scale about the model centre**, not a uniform outward
 * push: pushing every part the same distance slides the arrangement without ever
 * opening a gap between neighbours, so parts that touched still touch. Each
 * unit's offset from the centre is scaled (≈2x at full explode) plus a base
 * clearance, so parts sitting near the centre — where the scaling term vanishes —
 * still separate.
 */

import * as THREE from 'three';

/** Layout size at full explode, as a multiple of the assembled layout. */
export const EXPLODE_LAYOUT_SCALE = 2;

/** Extra separation at full explode, as a fraction of the assembled radius. */
export const EXPLODE_BASE_CLEARANCE = 0.18;

const EPSILON = 1e-9;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const childrenOf = (part) => (Array.isArray(part?.children) ? part.children : []);

/** Surface relief: rides its parent for both movement and selection. */
export const isReliefPart = (part) => part?.explodeWithParent === true;

// Relief is deliberately invisible here: a leaf whose only geometry-bearing
// children are relief is still a leaf, because that relief moves with it.
const carriesMovableGeometry = (part) => {
  if (isReliefPart(part)) return false;
  if (part?.geometry) return true;
  return childrenOf(part).some(carriesMovableGeometry);
};

/** True when a part is descended through rather than moved as one unit. */
export const isContainerPart = (part) => childrenOf(part).some(carriesMovableGeometry);

const localMatrix = (part) => {
  const position = new THREE.Vector3(...(part?.position || [0, 0, 0]));
  const euler = new THREE.Euler(...(part?.rotationDegrees || [0, 0, 0]).map((degrees) => THREE.MathUtils.degToRad(degrees)));
  const scale = new THREE.Vector3(...(part?.scale || [1, 1, 1]));
  return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(euler), scale);
};

/**
 * Walk the tree to the parts that actually move, carrying each one's model-space
 * position and the parent basis its offset has to be expressed in (offsets are
 * applied to the part's own `position`, which lives in parent space).
 */
const collectExplodeUnits = (parts) => {
  const units = [];
  const walk = (list, parentMatrix) => {
    for (const part of list || []) {
      if (isReliefPart(part)) continue;
      const matrix = parentMatrix.clone().multiply(localMatrix(part));
      if (isContainerPart(part)) {
        walk(childrenOf(part), matrix);
        continue;
      }
      units.push({
        id: part.id,
        position: new THREE.Vector3().setFromMatrixPosition(matrix),
        parentMatrix,
      });
    }
  };
  walk(parts, new THREE.Matrix4());
  return units;
};

// Parts stacked exactly on the centre have no outward direction of their own.
// Spread them deterministically (Fibonacci sphere) so a symmetric model still
// comes apart instead of every centre part translating together.
const fallbackDirection = (index, count) => {
  const y = count > 1 ? 1 - ((2 * index) / (count - 1)) : 0;
  const radius = Math.sqrt(Math.max(0, 1 - (y * y)));
  const theta = GOLDEN_ANGLE * index;
  const direction = new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
  return direction.lengthSq() > EPSILON ? direction.normalize() : new THREE.Vector3(0, 1, 0);
};

// A world-space delta becomes a parent-space delta through the inverse of the
// parent's basis. A degenerate (zero-scaled) parent has no inverse — fall back
// to the world delta rather than emitting NaN positions.
const toParentSpace = (delta, parentMatrix) => {
  const basis = new THREE.Matrix3().setFromMatrix4(parentMatrix);
  if (Math.abs(basis.determinant()) < EPSILON) return delta.clone();
  return delta.clone().applyMatrix3(basis.clone().invert());
};

/**
 * Explode layout for a spec's parts at `amount` (0 assembled → 1 fully apart).
 *
 * Returns the per-part offsets to add to each unit's `position`, the ids of the
 * units that moved, and `growth` — how much the layout actually grew, measured
 * from the moved parts rather than guessed, so the camera can re-fit on real
 * change instead of on every slider tick.
 */
export function computeExplodeLayout(parts, amount = 0) {
  const units = collectExplodeUnits(parts);
  const unitIds = units.map((unit) => unit.id);
  const progress = clamp01(amount);
  // One unit has nothing to separate from, and any offset would just translate
  // the whole model out of frame.
  if (progress <= 0 || units.length < 2) return { offsets: {}, unitIds, growth: 1 };

  const box = new THREE.Box3();
  for (const unit of units) box.expandByPoint(unit.position);
  const centre = box.getCenter(new THREE.Vector3());
  const assembledRadius = units.reduce((max, unit) => Math.max(max, unit.position.distanceTo(centre)), 0);

  const offsets = {};
  let explodedRadius = 0;
  units.forEach((unit, index) => {
    const delta = unit.position.clone().sub(centre);
    const distance = delta.length();
    const direction = distance > EPSILON ? delta.clone().divideScalar(distance) : fallbackDirection(index, units.length);
    // Scale the offset about the centre (the term that opens gaps between
    // neighbours), then add the clearance that covers parts at the centre.
    const scaled = distance * (EXPLODE_LAYOUT_SCALE - 1) * progress;
    const clearance = (assembledRadius || 1) * EXPLODE_BASE_CLEARANCE * progress;
    const worldOffset = direction.multiplyScalar(scaled + clearance);
    explodedRadius = Math.max(explodedRadius, unit.position.clone().add(worldOffset).distanceTo(centre));
    offsets[unit.id] = toParentSpace(worldOffset, unit.parentMatrix).toArray();
  });

  return {
    offsets,
    unitIds,
    growth: assembledRadius > EPSILON ? explodedRadius / assembledRadius : 1,
  };
}

/**
 * Flatten the part tree into the lookups the picker needs.
 *
 * - `owners[id]` — the part a click on `id` selects: itself, or the nearest
 *   non-relief ancestor when `id` is surface relief.
 * - `ancestry[id]` — root-to-self id chain, so "is this part inside the
 *   selection?" (subtree highlight) is a membership test.
 * - `names[id]` — readable part name for the selection label.
 */
export function buildPartSelectionIndex(parts) {
  const owners = {};
  const ancestry = {};
  const names = {};
  const walk = (list, chain, owner) => {
    for (const part of list || []) {
      if (!part?.id) continue;
      const selfChain = [...chain, part.id];
      const selfOwner = isReliefPart(part) ? (owner ?? part.id) : part.id;
      owners[part.id] = selfOwner;
      ancestry[part.id] = selfChain;
      names[part.id] = part.name || part.id;
      walk(childrenOf(part), selfChain, selfOwner);
    }
  };
  walk(parts, [], null);
  return { owners, ancestry, names };
}
