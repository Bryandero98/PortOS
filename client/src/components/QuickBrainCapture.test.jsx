import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api', () => ({
  captureBrainThought: vi.fn(),
}));
vi.mock('./ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import { captureBrainThought } from '../services/api';
import toast from './ui/Toast';
import QuickBrainCapture from './QuickBrainCapture';

const renderWidget = () => render(<MemoryRouter><QuickBrainCapture /></MemoryRouter>);

const submit = (text) => {
  fireEvent.change(screen.getByPlaceholderText('Thought, URL, or link...'), { target: { value: text } });
  fireEvent.click(screen.getByLabelText('Capture'));
};

describe('QuickBrainCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    captureBrainThought.mockResolvedValue({ message: 'Saved to Links!' });
  });

  it('captures both thoughts and URLs through the same endpoint', async () => {
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][0]).toBe('https://example.com');
  });

  it('surfaces the server message so a URL reads as saved to Links', async () => {
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved to Links!'));
  });

  it('does not flag a URL as creative even when the sticky flag is on', async () => {
    localStorage.setItem('brain.captureCreative', 'true');
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toEqual({ creative: false });
  });

  it('still flags ordinary text as creative when the flag is on', async () => {
    localStorage.setItem('brain.captureCreative', 'true');
    renderWidget();
    submit('a city that dreams');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toEqual({ creative: true });
  });

  it('hints which way the capture will go', () => {
    renderWidget();
    const input = screen.getByPlaceholderText('Thought, URL, or link...');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    expect(screen.getByText('Will save as link')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'call mom' } });
    expect(screen.getByText('Will capture as thought')).toBeInTheDocument();
  });
});
