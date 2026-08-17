import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RhetoricTrainer from './RhetoricTrainer';

vi.mock('../../../services/api', () => ({
  submitTrainingEntry: vi.fn(() => Promise.resolve()),
}));

describe('RhetoricTrainer', () => {
  const props = { onBack: vi.fn(), onSelectMode: vi.fn(), onExitMode: vi.fn(), onContinue: vi.fn() };

  it('shows the rhetoric exercise choices', () => {
    render(<RhetoricTrainer {...props} />);
    expect(screen.getByText('Iambic Pentameter')).toBeInTheDocument();
    expect(screen.getByText('Diacope')).toBeInTheDocument();
    expect(screen.getByText('Chiasmus')).toBeInTheDocument();
    expect(screen.getByText('Progressia')).toBeInTheDocument();
    expect(screen.getByText('Rhetorical Brainstorm')).toBeInTheDocument();
  });

  it('requires an attempt and self-rating before advancing', () => {
    render(<RhetoricTrainer {...props} mode="diacope" />);
    const save = screen.getByRole('button', { name: /save attempt/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your attempt'), { target: { value: 'Stay, until the storm passes. Stay.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 out of 5' }));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(screen.getByText('Prompt 2')).toBeInTheDocument();
  });

  it('offers a chiasmus prompt and craft checklist', () => {
    render(<RhetoricTrainer {...props} mode="chiasmus" />);
    expect(screen.getByText('Chiasmus')).toBeInTheDocument();
    expect(screen.getByText(/reverses its key terms/i)).toBeInTheDocument();
    expect(screen.getByText(/reverse order/i)).toBeInTheDocument();
  });
});
