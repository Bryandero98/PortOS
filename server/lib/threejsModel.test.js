import { describe, expect, it } from 'vitest';
import {
  buildThreejsFactorySource,
  storedThreejsSculptSpecSchema,
  threejsGeometrySchema,
  threejsSculptSpecSchema,
} from './threejsModel.js';

const squareOutline = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const validExtrude = () => ({
  type: 'extrude',
  outline: squareOutline,
  holes: [[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]],
  depth: 0.4,
});
const validTube = () => ({
  type: 'tube',
  path: [[0, 0, 0], [0, 1, 0.5], [0.6, 1.6, 0]],
  radius: 0.08,
});

const validSpec = () => ({
  schemaVersion: 1,
  name: 'Example Crate',
  summary: 'A beveled-looking shipping crate assembled from nested boxes.',
  subjectType: 'object',
  limitations: ['The hidden rear panel is inferred.'],
  background: '#111827',
  camera: { position: [4, 3, 5], target: [0, 0, 0], fov: 42 },
  materials: {
    body: { type: 'standard', color: '#8b5a2b', metalness: 0, roughness: 0.7 },
    trim: { type: 'physical', color: '#d4af37', metalness: 0.8, roughness: 0.25 },
  },
  lights: [
    { type: 'ambient', color: '#ffffff', intensity: 0.4 },
    { type: 'directional', color: '#ffffff', intensity: 2, position: [4, 6, 3] },
  ],
  parts: [{
    id: 'crateBody',
    name: 'Crate body',
    geometry: { type: 'box', width: 2, height: 1.4, depth: 1.2 },
    material: 'body',
    position: [0, 0.7, 0],
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    children: [{
      id: 'frontTrim',
      name: 'Front trim',
      geometry: { type: 'box', width: 1.8, height: 0.1, depth: 0.08 },
      material: 'trim',
      position: [0, 0, 0.64],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [],
    }],
  }],
  sockets: [{ name: 'lidPivot', parentPartId: 'crateBody', position: [0, 0.7, -0.6], rotationDegrees: [0, 0, 0] }],
  detailInventory: [{
    feature: 'Gold front trim',
    evidence: 'A narrow metallic band crosses the visible front panel.',
    implementationPartIds: ['frontTrim'],
    priority: 'identity',
  }],
});

describe('threejsSculptSpecSchema', () => {
  it('accepts a bounded hierarchy and fills material/part defaults', () => {
    const parsed = threejsSculptSpecSchema.parse(validSpec());
    expect(parsed.materials.body.emissive).toBe('#000000');
    expect(parsed.parts[0].castShadow).toBe(true);
    expect(parsed.parts[0].children[0].id).toBe('frontTrim');
  });

  it('rejects unknown material and detail references', () => {
    const spec = validSpec();
    spec.parts[0].material = 'missing';
    spec.detailInventory[0].implementationPartIds = ['notARealPart'];
    const result = threejsSculptSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      'unknown material: missing',
      'unknown detail part: notARealPart',
    ]));
  });

  it('rejects out-of-range custom geometry indices', () => {
    const spec = validSpec();
    spec.parts[0].geometry = {
      type: 'custom',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 4],
    };
    const result = threejsSculptSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('exceeds vertex count'))).toBe(true);
  });

  it('accepts extrude and tube parts and fills their construction defaults', () => {
    const spec = validSpec();
    spec.parts[0].geometry = validExtrude();
    spec.parts[0].children[0].geometry = validTube();
    const parsed = threejsSculptSpecSchema.parse(spec);
    expect(parsed.parts[0].geometry).toMatchObject({
      bevelEnabled: false, bevelSegments: 2, curveSegments: 8, steps: 1,
    });
    expect(parsed.parts[0].children[0].geometry).toMatchObject({
      tubularSegments: 64, radialSegments: 12, closed: false, curveType: 'centripetal', tension: 0.5,
    });
  });

  it('fills physical material channel defaults', () => {
    const parsed = threejsSculptSpecSchema.parse(validSpec());
    expect(parsed.materials.trim).toMatchObject({
      ior: 1.5, transmission: 0, thickness: 0, sheen: 0, iridescence: 0, anisotropy: 0,
    });
  });

  it('defaults an omitted part scale to an untouched [1, 1, 1]', () => {
    const spec = validSpec();
    delete spec.parts[0].scale;
    delete spec.parts[0].children[0].scale;
    const parsed = threejsSculptSpecSchema.parse(spec);
    expect(parsed.parts[0].scale).toEqual([1, 1, 1]);
    expect(parsed.parts[0].children[0].scale).toEqual([1, 1, 1]);
  });

  // A zero component collapses the part to an invisible plane and a negative one
  // reflects it — neither throws at render time (three.js flips the front face for a
  // negative determinant), so the schema is the only place they can be caught.
  it('rejects a negative or zero part scale component, at any depth', () => {
    for (const bad of [[1, -1, 1], [1, 0, 1], [-1, -1, -1]]) {
      const spec = validSpec();
      spec.parts[0].scale = bad;
      const result = threejsSculptSpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'parts.0.scale.1'
        || issue.path.join('.') === 'parts.0.scale.0')).toBe(true);

      const nested = validSpec();
      nested.parts[0].children[0].scale = bad;
      expect(threejsSculptSpecSchema.safeParse(nested).success).toBe(false);
    }
  });

  it('keeps accepting a legacy stored scale that the authoring contract now rejects', () => {
    for (const legacy of [[1, -1, 1], [1, 0, 1], [1, 5e-5, 1]]) {
      const spec = validSpec();
      spec.parts[0].children[0].scale = legacy;
      expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);
      expect(storedThreejsSculptSpecSchema.parse(spec).parts[0].children[0].scale).toEqual(legacy);
    }
  });

  it('rejects a near-zero part scale below the floor but accepts the floor itself', () => {
    const tooSmall = validSpec();
    tooSmall.parts[0].scale = [1, 5e-5, 1];
    expect(threejsSculptSpecSchema.safeParse(tooSmall).success).toBe(false);

    const atFloor = validSpec();
    atFloor.parts[0].scale = [1, 1e-4, 1];
    expect(threejsSculptSpecSchema.parse(atFloor).parts[0].scale).toEqual([1, 1e-4, 1]);
  });

  it('rejects out-of-range physical material channels', () => {
    const spec = validSpec();
    spec.materials.trim.ior = 4;
    spec.materials.trim.transmission = 1.5;
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe('threejsGeometrySchema extrude/tube validation', () => {
  it('rejects an outline or hole that encloses no area', () => {
    const collinear = [[0, 0], [1, 0], [2, 0], [3, 0]];
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), outline: collinear }).success).toBe(false);
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), holes: [collinear] }).success).toBe(false);
  });

  it('rejects a self-crossing outline or hole', () => {
    // Non-zero shoelace area, but the lobes cross so the interior is undefined.
    const crossing = [[0, 0], [2, 4], [4, 0], [0, 3], [4, 3]];
    const result = threejsGeometrySchema.safeParse({ ...validExtrude(), outline: crossing });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('must not cross itself'))).toBe(true);
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), holes: [crossing] }).success).toBe(false);
  });

  it('rejects an outline with fewer than three points', () => {
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), outline: [[0, 0], [1, 1]] }).success).toBe(false);
  });

  it('rejects a hole that falls outside the outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [[[5, 5], [6, 5], [6, 6], [5, 6]]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('falls outside the outline'))).toBe(true);
  });

  // An L-shape: the bounding box covers the notch, so a bounds-only containment
  // check would accept a hole floating in empty space outside the outline.
  const lShapedOutline = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];

  it('rejects a hole sitting in the notch of a concave outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      outline: lShapedOutline,
      holes: [[[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('falls outside the outline'))).toBe(true);
  });

  it('rejects a hole whose vertices are inside but whose edge leaves the outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      outline: lShapedOutline,
      holes: [[[0.5, 0.5], [2.5, 0.5], [0.5, 2.5]]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('falls outside the outline'))).toBe(true);
  });

  it('rejects overlapping and nested holes', () => {
    const overlapping = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [
        [[-0.6, -0.4], [0.1, -0.4], [0.1, 0.4], [-0.6, 0.4]],
        [[-0.1, -0.4], [0.6, -0.4], [0.6, 0.4], [-0.1, 0.4]],
      ],
    });
    expect(overlapping.success).toBe(false);
    expect(overlapping.error.issues.some((issue) => issue.message.includes('overlaps hole 0'))).toBe(true);

    const nested = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [
        [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]],
        [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]],
      ],
    });
    expect(nested.success).toBe(false);
    expect(nested.error.issues.some((issue) => issue.message.includes('overlaps hole 0'))).toBe(true);
  });

  it('accepts disjoint holes inside the outline', () => {
    expect(threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [
        [[-0.7, -0.3], [-0.3, -0.3], [-0.3, 0.3], [-0.7, 0.3]],
        [[0.3, -0.3], [0.7, -0.3], [0.7, 0.3], [0.3, 0.3]],
      ],
    }).success).toBe(true);
  });

  it('rejects a closed tube that cannot enclose a loop', () => {
    const twoPoint = threejsGeometrySchema.safeParse({
      type: 'tube', radius: 0.1, closed: true, path: [[0, 0, 0], [1, 0, 0]],
    });
    expect(twoPoint.success).toBe(false);
    expect(twoPoint.error.issues.some((issue) => issue.message.includes('three non-collinear points'))).toBe(true);

    const collinear = threejsGeometrySchema.safeParse({
      type: 'tube', radius: 0.1, closed: true, path: [[0, 0, 0], [1, 1, 1], [3, 3, 3]],
    });
    expect(collinear.success).toBe(false);
    expect(collinear.error.issues.some((issue) => issue.message.includes('three non-collinear points'))).toBe(true);
  });

  it('accepts a two-point open tube path', () => {
    expect(threejsGeometrySchema.safeParse({
      type: 'tube', radius: 0.1, path: [[0, 0, 0], [1, 0, 0]],
    }).success).toBe(true);
  });

  it('accepts a hole fully inside a concave outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      outline: lShapedOutline,
      holes: [[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tube path that repeats a point consecutively', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validTube(),
      path: [[0, 0, 0], [0, 0, 0], [1, 0, 0]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('repeat the same point consecutively'))).toBe(true);
  });

  it('rejects a closed tube path that repeats its first point at the end', () => {
    const result = threejsGeometrySchema.safeParse({
      type: 'tube',
      radius: 0.1,
      closed: true,
      path: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('must not repeat its first point'))).toBe(true);
  });

  it('accepts a closed tube path with distinct endpoints', () => {
    expect(threejsGeometrySchema.safeParse({ ...validTube(), closed: true }).success).toBe(true);
  });
});
describe('buildThreejsFactorySource', () => {
  it('exports a deterministic Group factory from validated data', () => {
    const source = buildThreejsFactorySource(validSpec());
    expect(source).toContain("import * as THREE from 'three'");
    expect(source).toContain('export function createExampleCrateModel()');
    expect(source).toContain('root.userData.sculptRuntime');
    expect(source).toContain("case 'custom'");
    expect(source).toContain('new THREE.MeshBasicMaterial(unlit)');
  });

  it('emits extrude, tube, and physical-channel construction', () => {
    const spec = validSpec();
    spec.parts[0].geometry = validExtrude();
    spec.parts[0].children[0].geometry = validTube();
    const source = buildThreejsFactorySource(spec);
    expect(source).toContain('new THREE.ExtrudeGeometry(shape');
    expect(source).toContain('shape.holes.push(new THREE.Path(');
    expect(source).toContain('new THREE.CatmullRomCurve3(');
    expect(source).toContain('new THREE.TubeGeometry(curve');
    for (const channel of ['ior', 'transmission', 'thickness', 'sheen', 'iridescence', 'anisotropy']) {
      expect(source).toContain(`${channel}: definition.${channel},`);
    }
  });

  // A spec an older install stored under the looser bound must stay exportable —
  // tightening what a provider may author cannot retroactively take Copy/Download
  // away from a `ready` model — and it exports verbatim, since neither dropping
  // the sign nor flooring the zero is a repair this module is entitled to make.
  it('still exports a stored spec whose part scale predates the authoring bound', () => {
    const legacy = validSpec();
    legacy.parts[0].children[0].scale = [1, -1, 0];
    expect(threejsSculptSpecSchema.safeParse(legacy).success).toBe(false);

    const source = buildThreejsFactorySource(legacy);
    expect(source.replace(/\s+/g, '')).toContain('"scale":[1,-1,0]');
  });

  it('reports a malformed stored spec as a 400 naming the offending path', () => {
    const broken = validSpec();
    broken.parts[0].material = 'missing';
    let thrown = null;
    try {
      buildThreejsFactorySource(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toMatch(/parts\.0\.material: unknown material: missing/);
    expect(thrown?.status).toBe(400);
    expect(thrown?.code).toBe('VALIDATION_ERROR');
  });
});
