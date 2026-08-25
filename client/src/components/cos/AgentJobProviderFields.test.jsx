import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AgentJobProviderFields from './AgentJobProviderFields';

const PROVIDERS = [
  {
    id: 'claude-code',
    name: 'Claude',
    type: 'cli',
    enabled: true,
    defaultModel: 'claude-sonnet',
    models: ['claude-sonnet']
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'cli',
    enabled: true,
    defaultModel: 'gpt-5',
    models: ['gpt-5']
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity',
    type: 'cli',
    enabled: true,
    defaultModel: 'gemini-3.6-flash',
    models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-high']
  }
];

describe('AgentJobProviderFields', () => {
  it('resolves inherited controls against the active provider and clears incompatible pins on provider change', () => {
    const onChange = vi.fn();
    render(
      <AgentJobProviderFields
        data={{ providerId: '', model: '', effort: '' }}
        providers={PROVIDERS}
        activeProviderId="claude-code"
        onChange={onChange}
      />
    );

    expect(screen.getByRole('option', { name: 'claude-sonnet' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });

    expect(onChange).toHaveBeenCalledWith({ providerId: 'codex', model: '', effort: '' });
  });

  it('keeps a legacy Antigravity model pin visible while it is being edited', () => {
    render(
      <AgentJobProviderFields
        data={{ providerId: 'antigravity-cli', model: 'gemini-3.6-flash-high', effort: '' }}
        providers={PROVIDERS}
        activeProviderId="claude-code"
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Model')).toHaveValue('gemini-3.6-flash-high');
    expect(screen.getByRole('option', { name: 'gemini-3.6-flash-high' })).toBeInTheDocument();
  });
});
