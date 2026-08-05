import { describe, expect, it } from 'vitest';
import { threejsSculptSpecSchema } from './threejsModel.js';
import { buildThreejsCoverageFeedback, evaluateThreejsPartCoverage } from './threejsModelCoverage.js';

const box = (size = 1) => ({ type: 'box', width: size, height: size, depth: size });

// Every fixture goes through the real schema first: the evaluator's contract is
// "already validated", so a test that skipped parsing would exercise a shape the
// evaluator never sees (missing `children` defaults, unnormalized priorities).
const makeSpec = ({ parts, detailInventory }) => threejsSculptSpecSchema.parse({
  schemaVersion: 1,
  name: 'Example Rig',
  summary: 'Placeholder spec used to exercise the assembly-coverage gate.',
  subjectType: 'object',
  camera: { position: [3, 2, 4] },
  materials: { shell: { color: '#334455' } },
  lights: [{ type: 'directional', intensity: 2 }],
  parts,
  detailInventory,
});

const detail = (feature, implementationPartIds, priority) => ({
  feature,
  evidence: `${feature} is visible in the reference image.`,
  implementationPartIds,
  priority,
});

const codes = (coverage) => coverage.findings.map((finding) => finding.code);

describe('evaluateThreejsPartCoverage', () => {
  it('reports nothing when every promised feature has its own geometry', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [
        { id: 'hull', name: 'Hull', geometry: box(2), material: 'shell' },
        { id: 'lens', name: 'Lens', geometry: box(0.4), material: 'shell' },
      ],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Recessed lens', ['lens'], 'identity'),
      ],
    }));

    expect(coverage.findings).toEqual([]);
    expect(coverage).toMatchObject({ errorCount: 0, warningCount: 0, noteCount: 0 });
  });

  it('errors when two identity features collapse onto the same single part', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [{ id: 'hull', name: 'Hull', geometry: box(2), material: 'shell' }],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Recessed lens', ['hull'], 'identity'),
      ],
    }));

    expect(codes(coverage)).toEqual(['fused-parts']);
    expect(coverage.errorCount).toBe(1);
    expect(coverage.findings[0]).toMatchObject({
      severity: 'error',
      partIds: ['hull'],
      features: ['Boxy hull', 'Recessed lens'],
    });
    expect(coverage.findings[0].message).toContain('Hull');
  });

  it('warns about geometry no detail entry claims', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [
        { id: 'hull', name: 'Hull', geometry: box(2), material: 'shell' },
        { id: 'antenna', name: 'Antenna', geometry: box(0.2), material: 'shell' },
      ],
      detailInventory: [detail('Boxy hull', ['hull'], 'identity')],
    }));

    expect(codes(coverage)).toEqual(['orphan-geometry']);
    expect(coverage.findings[0]).toMatchObject({
      severity: 'warning',
      count: 1,
      partIds: ['antenna'],
    });
    expect(coverage.errorCount).toBe(0);
  });

  it('does not let one detail on a bare group launder the whole tree', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [{
        id: 'robot',
        name: 'Robot',
        children: [
          { id: 'head', name: 'Head', geometry: box(0.8), material: 'shell' },
          { id: 'torso', name: 'Torso', geometry: box(1.4), material: 'shell' },
        ],
      }],
      detailInventory: [detail('Overall robot form', ['robot'], 'identity')],
    }));

    expect(codes(coverage)).toEqual(['orphan-geometry']);
    expect(coverage.findings[0].partIds).toEqual(['head', 'torso']);
  });

  it('treats minor relief folded into its implemented parent as a note, not an error', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [{
        id: 'hull',
        name: 'Hull',
        geometry: box(2),
        material: 'shell',
        children: [{
          id: 'stria',
          name: 'Stria',
          geometry: box(0.05),
          material: 'shell',
          explodeWithParent: true,
        }],
      }],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Fine surface stria', ['stria'], 'minor'),
      ],
    }));

    expect(codes(coverage)).toEqual(['folded-detail']);
    expect(coverage).toMatchObject({ errorCount: 0, warningCount: 0, noteCount: 1 });
    expect(coverage.findings[0].message).toContain('Hull');
  });

  it('does not also call folded minor relief unbuilt when its locator part carries no geometry', () => {
    // The child part is a pure locator — the relief itself lives in the parent
    // mesh. Reporting "nothing was built for it" alongside "folding it in is
    // correct" would hand the refinement pass two opposite instructions.
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [{
        id: 'hull',
        name: 'Hull',
        geometry: box(2),
        material: 'shell',
        children: [{ id: 'striaAnchor', name: 'Stria anchor' }],
      }],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Fine surface stria', ['striaAnchor'], 'minor'),
      ],
    }));

    expect(codes(coverage)).toEqual(['folded-detail']);
    expect(coverage).toMatchObject({ errorCount: 0, warningCount: 0, noteCount: 1 });
  });

  it('still errors on an identity feature riding a geometry-less locator under a built parent', () => {
    // Same shape as the folded-relief case, but the subject's identity rides on
    // it — a defining feature with no mesh of its own is the fused-model failure
    // this gate exists to catch, not a modeling shortcut.
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [{
        id: 'hull',
        name: 'Hull',
        geometry: box(2),
        material: 'shell',
        children: [{ id: 'lensAnchor', name: 'Lens anchor' }],
      }],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Recessed lens', ['lensAnchor'], 'identity'),
      ],
    }));

    expect(codes(coverage)).toEqual(['unbuilt-detail']);
    expect(coverage.findings[0]).toMatchObject({ severity: 'error', partIds: ['lensAnchor'] });
  });

  it('treats a minor detail sharing an identity feature\'s part as a note', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [{ id: 'hull', name: 'Hull', geometry: box(2), material: 'shell' }],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Faint scuffing', ['hull'], 'minor'),
      ],
    }));

    expect(codes(coverage)).toEqual(['folded-detail']);
    expect(coverage.errorCount).toBe(0);
  });

  it('errors on an identity feature whose parts contain no geometry at all', () => {
    const coverage = evaluateThreejsPartCoverage(makeSpec({
      parts: [
        { id: 'hull', name: 'Hull', geometry: box(2), material: 'shell' },
        { id: 'mast', name: 'Radio mast', children: [{ id: 'mastTip', name: 'Mast tip' }] },
      ],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Tall radio mast', ['mast'], 'identity'),
      ],
    }));

    expect(codes(coverage)).toEqual(['unbuilt-detail']);
    expect(coverage.findings[0]).toMatchObject({ severity: 'error', partIds: ['mast'] });
  });

  it('tiers an unbuilt feature by how much identity rides on it', () => {
    const build = (priority) => evaluateThreejsPartCoverage(makeSpec({
      parts: [
        { id: 'hull', name: 'Hull', geometry: box(2), material: 'shell' },
        { id: 'mast', name: 'Radio mast' },
      ],
      detailInventory: [
        detail('Boxy hull', ['hull'], 'identity'),
        detail('Tall radio mast', ['mast'], priority),
      ],
    }));

    expect(build('major').findings[0]).toMatchObject({ severity: 'warning' });
    expect(build('minor').findings[0]).toMatchObject({ severity: 'note' });
  });
});

describe('buildThreejsCoverageFeedback', () => {
  it('returns empty for a missing, clean, or warning-only coverage result', () => {
    expect(buildThreejsCoverageFeedback(null)).toBe('');
    expect(buildThreejsCoverageFeedback({ findings: [] })).toBe('');
    expect(buildThreejsCoverageFeedback({
      findings: [{ severity: 'warning', message: 'unattributed geometry' }],
    })).toBe('');
  });

  it('lists only the error findings for the next refinement pass', () => {
    const feedback = buildThreejsCoverageFeedback({
      findings: [
        { severity: 'error', message: 'two features collapsed onto "Hull"' },
        { severity: 'warning', message: 'unattributed geometry' },
        { severity: 'error', message: 'nothing was built for "Radio mast"' },
      ],
    });

    expect(feedback).toContain('1. two features collapsed onto "Hull"');
    expect(feedback).toContain('2. nothing was built for "Radio mast"');
    expect(feedback).not.toContain('unattributed geometry');
  });
});
