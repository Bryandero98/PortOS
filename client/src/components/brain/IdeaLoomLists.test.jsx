import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../services/api', () => ({
  getIdeaLoomLists: vi.fn(), getIdeaLoomSettings: vi.fn(),
  createIdeaLoomList: vi.fn(), updateIdeaLoomList: vi.fn(), deleteIdeaLoomList: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import * as api from '../../services/api';
import IdeaLoomLists from './IdeaLoomLists';

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPanel() {
  return render(<MemoryRouter initialEntries={['/brain/ideas']}><IdeaLoomLists /><Location /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getIdeaLoomLists.mockResolvedValue([]);
  api.getIdeaLoomSettings.mockResolvedValue({ enabled: false });
});

describe('IdeaLoomLists', () => {
  it('keeps local list editing available while vault sync is disabled', async () => {
    api.createIdeaLoomList.mockResolvedValue({ id: 'list-1', title: 'Launch ideas', status: 'draft', ideas: ['One'] });
    renderPanel();

    expect(await screen.findByText('Vault sync is disabled. Local lists remain available.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Create IdeaLoom list'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Launch ideas' } });
    fireEvent.change(screen.getByLabelText('New idea'), { target: { value: 'One' } });
    fireEvent.click(screen.getByLabelText('Add idea'));
    fireEvent.click(screen.getByText('Save list'));

    await waitFor(() => expect(api.createIdeaLoomList).toHaveBeenCalledWith(expect.objectContaining({ title: 'Launch ideas', ideas: ['One'] }), { silent: true }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('?list=list-1'));
  });

  it('reorders a selected list locally before saving its ordered items', async () => {
    api.getIdeaLoomLists.mockResolvedValue([{ id: 'list-1', title: 'Launch ideas', status: 'draft', ideas: ['First', 'Second'] }]);
    api.updateIdeaLoomList.mockResolvedValue({ id: 'list-1', title: 'Launch ideas', status: 'draft', ideas: ['Second', 'First'] });
    renderPanel();

    fireEvent.click(await screen.findByText('Launch ideas'));
    await screen.findByLabelText('Move idea 2 up');
    fireEvent.click(screen.getByLabelText('Move idea 2 up'));
    fireEvent.click(screen.getByText('Save list'));

    await waitFor(() => expect(api.updateIdeaLoomList).toHaveBeenCalledWith('list-1', expect.objectContaining({ ideas: ['Second', 'First'] }), { silent: true }));
    expect(screen.getByTestId('location').textContent).toBe('?list=list-1');
  });
});
