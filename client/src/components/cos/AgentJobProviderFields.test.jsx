import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AgentJobProviderFields, { filterRunnableProviders } from './AgentJobProviderFields';

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
  it('resolves inherited controls against the active provider and clears incompatible pins on provider change', async () => {
    const onChange = vi.fn();
    render(
      <AgentJobProviderFields
        data={{ providerId: '', model: '', effort: '' }}
        providers={PROVIDERS}
        activeProviderId="claude-code"
        onChange={onChange}
      />
    );
    await act(async () => {});

    expect(screen.getByRole('option', { name: 'claude-sonnet' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });

    expect(onChange).toHaveBeenCalledWith({ providerId: 'codex', model: '', effort: '' });
  });

  it('keeps a legacy Antigravity model pin visible while it is being edited', async () => {
    render(
      <AgentJobProviderFields
        data={{ providerId: 'antigravity-cli', model: 'gemini-3.6-flash-high', effort: '' }}
        providers={PROVIDERS}
        activeProviderId="claude-code"
        onChange={vi.fn()}
      />
    );
    await act(async () => {});

    expect(screen.getByLabelText('Model')).toHaveValue('gemini-3.6-flash-high');
    expect(screen.getByRole('option', { name: 'gemini-3.6-flash-high' })).toBeInTheDocument();
  });

  it('offers only coding providers while retaining an existing API pin so it can be cleared', async () => {
    const apiProvider = {
      id: 'ollama',
      name: 'Ollama API',
      type: 'api',
      enabled: true,
      defaultModel: 'qwen3.6:35b',
      models: ['qwen3.6:35b']
    };
    const providers = [...PROVIDERS, apiProvider];

    expect(filterRunnableProviders(providers).map(provider => provider.id)).not.toContain('ollama');
    expect(filterRunnableProviders(providers, ['ollama']).map(provider => provider.id)).toContain('ollama');

    render(
      <AgentJobProviderFields
        data={{ providerId: 'ollama', model: 'qwen3.6:35b', effort: '' }}
        providers={filterRunnableProviders(providers, ['ollama'])}
        activeProviderId="claude-code"
        onChange={vi.fn()}
      />
    );
    await act(async () => {});

    expect(screen.getByRole('option', { name: 'Ollama API' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument();
  });
});
