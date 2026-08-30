import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../ThemePickerPanel', () => ({
  default: () => <div>Theme picker</div>,
}));

import { getSettings, updateSettings } from '../../services/api';
import { GeneralTab } from './GeneralTab';

const SETTINGS = {
  timezone: 'UTC',
  location: { lat: 37.7749, lon: -122.4194 },
};
const CONFIRM = 'Discard your unsaved General settings changes?';

const timezoneCard = () => screen.getByRole('heading', { name: 'Timezone' }).parentElement;
const locationCard = () => screen.getByRole('heading', { name: 'Location' }).parentElement;

const renderTab = async () => {
  const router = createMemoryRouter([
    { path: '/settings/general', element: <GeneralTab /> },
    { path: '/settings/security', element: <div>Security settings</div> },
  ], { initialEntries: ['/settings/general'] });
  render(<RouterProvider router={router} />);
  await screen.findByDisplayValue('UTC');
  return router;
};

const navigate = (router, to) => act(async () => { await router.navigate(to); });

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(SETTINGS);
  updateSettings.mockResolvedValue({});
});

describe('GeneralTab unsaved changes', () => {
  it('marks each edited section dirty, arms beforeunload, and clears when values are restored', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await renderTab();

    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });
    expect(within(timezoneCard()).getByText('Unsaved changes')).toBeInTheDocument();
    expect(within(locationCard()).queryByText('Unsaved changes')).toBeNull();

    fireEvent.change(screen.getByLabelText('Latitude (-90 to 90)'), {
      target: { value: '40.7128' },
    });
    expect(within(locationCard()).getByText('Unsaved changes')).toBeInTheDocument();
    await waitFor(() => {
      expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: SETTINGS.timezone },
    });
    fireEvent.change(screen.getByLabelText('Latitude (-90 to 90)'), {
      target: { value: String(SETTINGS.location.lat) },
    });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await waitFor(() => {
      expect(remove.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    });
  });

  it('keeps the current route and draft when navigation is canceled', async () => {
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByText(CONFIRM)).toBeNull());
    expect(router.state.location.pathname).toBe('/settings/general');
    expect(screen.getByLabelText('Timezone (IANA)')).toHaveValue('America/New_York');
  });

  it('discards the draft and runs the parked Settings navigation', async () => {
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Longitude (-180 to 180)'), {
      target: { value: '-74.006' },
    });

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(await screen.findByText('Security settings')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/security');
  });

  it('advances only the successful section baseline', async () => {
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });
    fireEvent.change(screen.getByLabelText('Latitude (-90 to 90)'), {
      target: { value: '40.7128' },
    });

    await act(async () => {
      fireEvent.click(within(timezoneCard()).getByRole('button', { name: 'Save' }));
    });
    expect(updateSettings).toHaveBeenCalledWith(
      { timezone: 'America/New_York' },
      { silent: true },
    );
    expect(within(timezoneCard()).queryByText('Unsaved changes')).toBeNull();
    expect(within(locationCard()).getByText('Unsaved changes')).toBeInTheDocument();

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await act(async () => {
      fireEvent.click(within(locationCard()).getByRole('button', { name: 'Save' }));
    });
    expect(updateSettings).toHaveBeenLastCalledWith(
      { location: { lat: 40.7128, lon: SETTINGS.location.lon } },
      { silent: true },
    );
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('keeps a failed timezone save dirty and guarded', async () => {
    updateSettings.mockRejectedValueOnce(new Error('timezone offline'));
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });

    await act(async () => {
      fireEvent.click(within(timezoneCard()).getByRole('button', { name: 'Save' }));
    });
    expect(within(timezoneCard()).getByText('Unsaved changes')).toBeInTheDocument();

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  });

  it('keeps a failed location save dirty and guarded', async () => {
    updateSettings.mockRejectedValueOnce(new Error('location offline'));
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Longitude (-180 to 180)'), {
      target: { value: '-74.006' },
    });

    await act(async () => {
      fireEvent.click(within(locationCard()).getByRole('button', { name: 'Save' }));
    });
    expect(within(locationCard()).getByText('Unsaved changes')).toBeInTheDocument();

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  });
});
