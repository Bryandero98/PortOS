import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ModelTermsGate from './ModelTermsGate.jsx';

const GATE = {
  id: 'example-license-v1',
  title: 'Territory and terms',
  summary: 'This model is available only in its applicable territory.',
  acknowledgement: 'I confirm I am eligible and accept the license.',
  licenseUrl: 'https://example.com/license',
};

describe('ModelTermsGate', () => {
  it('renders the server-authored terms and reports an acceptance', () => {
    const onChange = vi.fn();
    render(
      <ModelTermsGate termsGate={GATE} accepted={false} onAcceptedChange={onChange} descriptionId="model-terms" />,
    );
    const gate = screen.getByLabelText('Model terms acceptance');
    // The id is what a blocked Generate/Download button points its
    // aria-describedby at, so a screen reader gets the reason it's disabled.
    expect(gate).toHaveAttribute('id', 'model-terms');
    expect(within(gate).getByText(GATE.summary)).toBeInTheDocument();
    expect(within(gate).getByText(/cannot determine your location or legal eligibility/i)).toBeInTheDocument();
    expect(within(gate).getByRole('link', { name: /Community License/i }))
      .toHaveAttribute('href', GATE.licenseUrl);
    fireEvent.click(within(gate).getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('locks the checkbox while the acceptance is being persisted', () => {
    render(<ModelTermsGate termsGate={GATE} accepted onAcceptedChange={vi.fn()} disabled />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('renders nothing for an ungated model', () => {
    const { container } = render(<ModelTermsGate termsGate={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
