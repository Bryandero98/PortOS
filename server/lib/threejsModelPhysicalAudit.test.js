import { describe, expect, it } from 'vitest';
import {
  buildThreejsPhysicalAuditFeedback,
  evaluateThreejsPhysicalAudit,
} from './threejsModelPhysicalAudit.js';

describe('threejsModelPhysicalAudit', () => {
  it('returns clean result for null/empty spec', () => {
    const res = evaluateThreejsPhysicalAudit(null);
    expect(res).toEqual({
      findings: [],
      errorCount: 0,
      warningCount: 0,
      noteCount: 0,
      evaluatedPartCount: 0,
      evaluatedPoseCount: 0,
    });
  });

  it('evaluates clean static model without findings', () => {
    const spec = {
      name: 'Clean Box',
      parts: [
        {
          id: 'base',
          name: 'Base',
          geometry: { type: 'box', width: 2, height: 1, depth: 2 },
          position: [0, 0.5, 0],
          children: [
            {
              id: 'top',
              name: 'Top',
              geometry: { type: 'sphere', radius: 0.5 },
              position: [0, 0.8, 0],
            },
          ],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.evaluatedPartCount).toBe(2);
    expect(res.evaluatedPoseCount).toBe(1);
    expect(res.errorCount).toBe(0);
    expect(res.warningCount).toBe(0);
    expect(res.findings).toEqual([]);
    expect(buildThreejsPhysicalAuditFeedback(res)).toBe('');
  });

  it('flags non-uniform parent scale and names the affected non-relief descendants', () => {
    const spec = {
      name: 'Scaled Parent Spec',
      parts: [
        {
          id: 'torso',
          name: 'Torso',
          geometry: { type: 'box', width: 2, height: 1, depth: 1 },
          position: [0, 0.5, 0],
          scale: [3, 1, 0.2],
          children: [
            {
              id: 'head',
              name: 'Head',
              geometry: { type: 'sphere', radius: 0.5 },
              position: [0, 1, 0],
            },
            {
              id: 'panel_lines',
              name: 'Panel Lines',
              explodeWithParent: true,
              geometry: { type: 'box', width: 1, height: 0.01, depth: 0.01 },
            },
          ],
        },
      ],
    };

    const res = evaluateThreejsPhysicalAudit(spec);
    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      severity: 'warning',
      partIds: ['torso', 'head'],
      affectedDescendantNames: ['Head'],
      anisotropyRatio: 15,
    });
    expect(finding.message).toContain('Torso');
    expect(finding.message).toContain('Head');
    expect(finding.message).toContain('anisotropy ratio 15.00');
    expect(buildThreejsPhysicalAuditFeedback(res)).toContain('box width/height/depth');
  });

  it('ignores relief-only children when a parent is deliberately non-uniform', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Relief Parent Spec',
      parts: [{
        id: 'blade',
        name: 'Blade',
        geometry: { type: 'box', width: 2, height: 0.2, depth: 1 },
        position: [0, 0.1, 0],
        scale: [4, 1, 0.5],
        children: [{
          id: 'serrations',
          name: 'Serrations',
          explodeWithParent: true,
          geometry: { type: 'box', width: 1, height: 0.1, depth: 0.1 },
        }],
      }],
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
  });

  it('traverses empty organizational groups but reports only geometry-bearing descendants', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Organizational Group Spec',
      parts: [{
        id: 'body',
        name: 'Body',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
        children: [{
          id: 'rig',
          name: 'Rig',
          children: [{
            id: 'head',
            name: 'Head',
            geometry: { type: 'sphere', radius: 0.5 },
          }],
        }],
      }],
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      partIds: ['body', 'head'],
      affectedDescendantNames: ['Head'],
    });
    expect(finding.message).not.toContain('Rig');
  });

  it('caps descendant names in feedback-sized finding messages', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Many Descendants Spec',
      parts: [{
        id: 'root',
        name: 'Root',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
        children: Array.from({ length: 9 }, (_, index) => ({
          id: `child-${index + 1}`,
          name: `Child ${index + 1}`,
          geometry: { type: 'sphere', radius: 0.1 },
        })),
      }],
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding.message).toContain('(+1 more)');
    expect(finding.message).not.toContain('Child 9');
  });

  it('checks animated scale channel endpoints against nested parts', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Animated Scale Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        position: [0, 0.5, 0],
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
          position: [0, 0.8, 0],
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [{
            id: 'stretch-housing',
            name: 'Stretch housing',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: {
              scale: { from: [1, 1, 1], to: [3, 1, 0.2] },
            },
          }],
        }],
      },
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      clipId: 'deploy',
      sequenceId: 'stretch-housing',
      partIds: ['housing', 'lens'],
      affectedDescendantNames: ['Lens'],
      anisotropyRatio: 15,
    });
    expect(finding.message).toContain('[3, 1, 0.2]');
    expect(finding.message).toContain('Deploy');
    expect(finding.message).toContain('stretch-housing');
  });

  it('does not flag a non-uniformly scaled leaf without descendants', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Scaled Leaf Spec',
      parts: [{
        id: 'plate',
        name: 'Plate',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
      }],
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
  });

  it('uses a one-percent tolerance for non-uniform scale', () => {
    const withScale = (scale) => evaluateThreejsPhysicalAudit({
      name: 'Tolerance Spec',
      parts: [{
        id: 'parent',
        name: 'Parent',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale,
        children: [{
          id: 'child',
          name: 'Child',
          geometry: { type: 'sphere', radius: 0.5 },
        }],
      }],
    });

    expect(withScale([1, 1, 1.005]).findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
    expect(withScale([1, 1, 1.02]).findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(1);
  });

  it('does not flag a uniformly animated parent scale', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Uniform Animation Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'inflate',
          name: 'Inflate',
          durationSeconds: 2,
          sequences: [{
            id: 'inflate-housing',
            name: 'Inflate housing',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: { scale: { from: [1, 1, 1], to: [2, 2, 2] } },
          }],
        }],
      },
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
  });

  it('coalesces an animated duplicate when the rest pose is already more anisotropic', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Duplicate Scale Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [{
            id: 'repeat-scale',
            name: 'Repeat scale',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: { scale: { from: [1, 1, 1], to: [3, 1, 0.2] } },
          }],
        }],
      },
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(1);
  });

  it('detects floating part touching nothing', () => {
    const spec = {
      name: 'Floating Spec',
      parts: [
        {
          id: 'ground_plate',
          name: 'Ground Plate',
          geometry: { type: 'box', width: 2, height: 0.2, depth: 2 },
          position: [0, 0.1, 0],
        },
        {
          id: 'floating_sphere',
          name: 'Floating Orb',
          geometry: { type: 'sphere', radius: 0.5 },
          position: [5, 5, 5],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.warningCount).toBeGreaterThanOrEqual(1);
    const finding = res.findings.find((f) => f.code === 'floating-part');
    expect(finding).toBeDefined();
    expect(finding.partIds).toContain('floating_sphere');
    expect(finding.message).toContain('Floating Orb');

    const feedback = buildThreejsPhysicalAuditFeedback(res);
    expect(feedback).toContain('Floating Orb');
    expect(feedback).not.toContain('For non-uniform parent scale findings');
  });

  it('detects buried geometry inside another part', () => {
    const spec = {
      name: 'Buried Spec',
      parts: [
        {
          id: 'container',
          name: 'Outer Container',
          geometry: { type: 'box', width: 4, height: 4, depth: 4 },
          position: [0, 2, 0],
        },
        {
          id: 'swallowed',
          name: 'Inner Gem',
          geometry: { type: 'box', width: 1, height: 1, depth: 1 },
          position: [0, 2, 0],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.errorCount).toBeGreaterThanOrEqual(1);
    const finding = res.findings.find((f) => f.code === 'buried-geometry');
    expect(finding).toBeDefined();
    expect(finding.partIds).toEqual(['swallowed', 'container']);
  });

  it('detects coplanar surfaces causing z-fighting', () => {
    const spec = {
      name: 'Coplanar Spec',
      parts: [
        {
          id: 'block1',
          name: 'Left Block',
          geometry: { type: 'box', width: 2, height: 2, depth: 2 },
          position: [-1, 1, 0],
        },
        {
          id: 'block2',
          name: 'Right Block',
          geometry: { type: 'box', width: 2, height: 2, depth: 2 },
          position: [1, 1, 0],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    const finding = res.findings.find((f) => f.code === 'coplanar-surface');
    expect(finding).toBeDefined();
    expect(finding.partIds).toContain('block1');
    expect(finding.partIds).toContain('block2');
  });

  it('exempts hidden parts (visible: false) from floating and buried checks', () => {
    const spec = {
      name: 'Hidden Parts Spec',
      parts: [
        {
          id: 'main',
          name: 'Main',
          geometry: { type: 'box', width: 2, height: 1, depth: 2 },
          position: [0, 0.5, 0],
        },
        {
          id: 'hidden_float',
          name: 'Hidden Float',
          geometry: { type: 'sphere', radius: 0.5 },
          position: [10, 10, 10],
          visible: false,
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.partIds.includes('hidden_float'))).toHaveLength(0);
  });

  it('exempts parent/child and declared attachments from false positives', () => {
    const spec = {
      name: 'Attachment Spec',
      articulation: {
        attachmentPartIds: ['strapped_pack'],
      },
      parts: [
        {
          id: 'torso',
          name: 'Torso',
          geometry: { type: 'box', width: 2, height: 3, depth: 1 },
          position: [0, 1.5, 0],
        },
        {
          id: 'strapped_pack',
          name: 'Backpack',
          geometry: { type: 'box', width: 1, height: 1, depth: 0.5 },
          position: [0, 1.5, 0.5],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.code === 'floating-part')).toHaveLength(0);
    expect(res.findings.filter((f) => f.code === 'buried-geometry')).toHaveLength(0);
  });

  it('evaluates rotated parts and transforms correctly', () => {
    const spec = {
      name: 'Rotated Spec',
      parts: [
        {
          id: 'base',
          name: 'Base',
          geometry: { type: 'box', width: 2, height: 0.2, depth: 2 },
          position: [0, 0.1, 0],
        },
        {
          id: 'tilted_arm',
          name: 'Tilted Arm',
          geometry: { type: 'box', width: 0.2, height: 2, depth: 0.2 },
          position: [0, 0.5, 0],
          rotationDegrees: [0, 0, 45],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.code === 'floating-part')).toHaveLength(0);
  });

  it('detects unprovenanced transitions in animated clip poses', () => {
    const spec = {
      name: 'Animated Spec',
      parts: [
        {
          id: 'hull',
          name: 'Hull',
          geometry: { type: 'box', width: 4, height: 1, depth: 4 },
          position: [0, 0.5, 0],
        },
        {
          id: 'pop_part',
          name: 'Popping Cannon',
          geometry: { type: 'cylinder', radiusTop: 0.2, radiusBottom: 0.2, height: 1 },
          position: [0, 5, 0],
          visible: false,
        },
      ],
      animation: {
        clips: [
          {
            id: 'deploy',
            name: 'Deploy',
            durationSeconds: 2,
            sequences: [
              {
                id: 'appear',
                name: 'Appear Sequence',
                partId: 'pop_part',
                startSeconds: 1,
                endSeconds: 2,
                channels: {
                  visible: { from: false, to: true },
                },
              },
            ],
          },
        ],
      },
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.evaluatedPoseCount).toBeGreaterThan(1);
    const finding = res.findings.find((f) => f.code === 'unprovenanced-transition');
    expect(finding).toBeDefined();
    expect(finding.partIds).toContain('pop_part');
    expect(finding.clipId).toBe('deploy');
    expect(finding.sequenceId).toBe('appear');
    expect(finding.timeSeconds).toBe(1);
  });
});
