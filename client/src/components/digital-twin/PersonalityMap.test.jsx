import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import PersonalityMap from './PersonalityMap';

const PROVIDERS = [
  { id: 'example-provider', name: 'Example Provider', defaultModel: 'example-model', models: [] }
];

describe('PersonalityMap provider picker', () => {
  it('labels the provider/model select so screen readers announce it', () => {
    render(<PersonalityMap traits={null} confidence={null} providers={PROVIDERS} />);

    const select = screen.getByLabelText('AI Provider & Model');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('example-provider:example-model');
  });
});
