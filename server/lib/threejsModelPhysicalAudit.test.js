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
