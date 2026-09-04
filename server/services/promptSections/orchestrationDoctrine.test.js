import { describe, it, expect } from 'vitest';
import { buildOrchestrationDoctrineSection } from './orchestrationDoctrine.js';
import { SPEC_PARTS } from '../../lib/orchestrationProfile.js';

const task = (metadata) => ({ id: 'task-1', metadata });

describe('buildOrchestrationDoctrineSection', () => {
  it('renders nothing for a direct-mode task, which is every task by default', () => {
    expect(buildOrchestrationDoctrineSection(task({}))).toBe('');
    expect(buildOrchestrationDoctrineSection(task({
      orchestrationMode: 'direct',
      orchestrationProfile: { architect: { model: 'opus' } },
    }))).toBe('');
    expect(buildOrchestrationDoctrineSection({})).toBe('');
  });

  it('carries all six spec parts, since a delegated lane sees only the spec', () => {
    const section = buildOrchestrationDoctrineSection(task({
      orchestrationMode: 'orchestrated',
      orchestrationProfile: { architect: { model: 'opus' } },
    }));
    for (const part of SPEC_PARTS) expect(section).toContain(`\`${part.label}:\``);
  });

  it('names each role its configured provider/model/effort, and the run default otherwise', () => {
    const section = buildOrchestrationDoctrineSection(task({
      orchestrationMode: 'orchestrated',
      orchestrationProfile: {
        architect: { provider: 'claude-code', model: 'opus', effort: 'xhigh' },
        implementer: { model: 'haiku' },
      },
    }));
    expect(section).toContain('**architect**');
    expect(section).toContain('provider `claude-code`, model `opus`, default reasoning `xhigh`');
    expect(section).toContain('model `haiku`');
    // reviewer is unpinned — it must still be listed, running on the run's own model
    expect(section).toContain('**reviewer**');
    expect(section).toContain('this run’s own provider and model');
  });

  it('states that the reasoning rung is passed through rather than rounded', () => {
    const section = buildOrchestrationDoctrineSection(task({
      orchestrationMode: 'orchestrated',
      orchestrationProfile: { implementer: { model: 'haiku' } },
    }));
    expect(section).toMatch(/never rounded/);
  });
});

describe('fail-closed lane doctrine (#5993)', () => {
  const orchestrated = (profile) => ({
    metadata: { orchestrationMode: 'orchestrated', orchestrationProfile: profile },
  });

  it('tells the architect a pinned lane has no substitute', () => {
    const section = buildOrchestrationDoctrineSection(orchestrated({ implementer: { provider: 'p-cheap' } }));
    expect(section).toContain('the run STOPS — no other provider is substituted for this lane');
  });

  it('names the one alternate a lane may use', () => {
    const section = buildOrchestrationDoctrineSection(orchestrated({
      implementer: { provider: 'p-cheap', fallbackProvider: 'p-cheap-2', fallbackModel: 'm-cheap-2' },
    }));
    expect(section).toContain('the lane may use `p-cheap-2` with model `m-cheap-2` — and nothing else');
    expect(section.split('\n').find(l => l.startsWith('- **implementer**'))).not.toContain('STOPS');
  });

  it('says nothing about substitution for a role that pins nothing', () => {
    const section = buildOrchestrationDoctrineSection(orchestrated({ architect: { provider: 'p1' } }));
    expect(section).toContain('- **reviewer** —');
    expect(section.split('\n').find(l => l.startsWith('- **reviewer**'))).not.toContain('STOPS');
  });
});

describe('the doctrine states fail-closed only for the lanes that are', () => {
  const orchestrated = (profile) => ({
    metadata: { orchestrationMode: 'orchestrated', orchestrationProfile: profile },
  });
  const roleLineFor = (section, role) => section.split('\n').find(l => l.startsWith(`- **${role}**`));

  it('says nothing about substitution for an effort-only role', () => {
    // That role stays on the ordinary fallback chain, so promising the architect
    // the run would stop is false — and reads as nonsense, since its only "pin"
    // is a reasoning rung rather than a provider.
    const section = buildOrchestrationDoctrineSection(orchestrated({
      implementer: { effort: 'high' },
      architect: { provider: 'p1' },
    }));
    expect(roleLineFor(section, 'implementer')).not.toContain('STOPS');
    expect(roleLineFor(section, 'architect')).toContain('STOPS');
  });

  it('names the alternate a model-only lane may use', () => {
    const section = buildOrchestrationDoctrineSection(orchestrated({
      implementer: { model: 'm-cheap', fallbackProvider: 'p-cheap-2', fallbackModel: 'm-cheap-2' },
    }));
    expect(roleLineFor(section, 'implementer')).toContain('the lane may use `p-cheap-2` with model `m-cheap-2` — and nothing else');
  });
});
